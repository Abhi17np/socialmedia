/**
 * The journey executor — walks a workflow_definitions.graph_json for one
 * enrollment, one tick at a time, re-reading all state from the DB
 * (never trusting in-memory data across a pause), so a process restart
 * mid-journey is safe: lib/email/scheduledSendSweep.js-style restart
 * safety applied to journeys (see lib/journeySweep.js for the delay-
 * resume half of this).
 *
 * A "tick" runs synchronously through action/condition/split nodes
 * until it hits a delay node (pauses, schedules resume), a terminal
 * node (no outgoing edge — marks the enrollment completed), the goal
 * condition becomes true (marks goal_met), or a safety cap on steps per
 * tick is hit (a cyclic graph with no delay would otherwise spin
 * forever — this is an authoring bug, not a runtime condition to retry).
 *
 * Idempotency: before executing an action node, this checks
 * workflow_enrollment_events for an existing 'completed' event on that
 * exact (enrollment_id, node_id) — re-running a tick that crashed after
 * the action succeeded but before advancing current_node_id will skip
 * re-executing the action and just advance, rather than e.g. sending a
 * duplicate email.
 */

const { scoped } = require('./query');
const { findNode, nextNodeId, validateGraph, evaluateCondition, conditionEdge, pickSplitEdge, outgoingEdges } = require('./journeyGraph');
const { ACTION_EXECUTORS } = require('./journeyActions');

const MAX_STEPS_PER_TICK = 50;

async function logEvent(client, tenantId, enrollmentId, nodeId, nodeType, eventType, result) {
  await client.from('workflow_enrollment_events').insert({ tenant_id: tenantId, enrollment_id: enrollmentId, node_id: nodeId, node_type: nodeType, event_type: eventType, result: result || {} })
    .then(({ error }) => { if (error) console.error('[journeyEngine] could not log enrollment event:', error.message); });
}

async function alreadyCompleted(client, enrollmentId, nodeId) {
  const { data } = await client.from('workflow_enrollment_events').select('id').eq('enrollment_id', enrollmentId).eq('node_id', nodeId).eq('event_type', 'completed').limit(1);
  return !!(data && data.length > 0);
}

async function evaluateGoal(client, tenantId, goalConfig, contact) {
  if (!goalConfig) return false;
  return evaluateCondition(goalConfig, contact);
}

async function finishEnrollment(client, enrollmentId, status) {
  await client.from('workflow_enrollments').update({ status, completed_at: new Date().toISOString(), next_action_at: null }).eq('id', enrollmentId);
}

/** Runs one enrollment forward as far as it can go right now. Never throws — a broken journey step must not crash the trigger/sweep that called this. */
async function runEnrollmentTick(client, tenantId, enrollment) {
  try {
    const { data: workflow } = await scoped(client, tenantId, 'workflow_definitions').select('*').eq('id', enrollment.workflow_id).maybeSingle();
    if (!workflow || !workflow.is_active) { await finishEnrollment(client, enrollment.id, 'exited'); return; }

    const graph = workflow.graph_json;
    const { data: contact } = await scoped(client, tenantId, 'contacts').select('*').eq('id', enrollment.contact_id).maybeSingle();
    if (!contact) { await finishEnrollment(client, enrollment.id, 'exited'); return; }

    let currentNodeId = enrollment.current_node_id;
    let dealId = enrollment.deal_id;
    let steps = 0;

    while (currentNodeId) {
      if (steps++ > MAX_STEPS_PER_TICK) {
        console.error(`[journeyEngine] enrollment ${enrollment.id} exceeded ${MAX_STEPS_PER_TICK} steps in one tick — likely a cyclic graph with no delay. Pausing, not failing, so it can be fixed and resumed.`);
        await client.from('workflow_enrollments').update({ current_node_id: currentNodeId }).eq('id', enrollment.id);
        return;
      }

      const node = findNode(graph, currentNodeId);
      if (!node) { await finishEnrollment(client, enrollment.id, 'failed'); return; }

      if (node.type === 'delay') {
        const dueAt = new Date(Date.now() + delayMs(node.config)).toISOString();
        const target = nextNodeId(graph, node.id);
        await client.from('workflow_enrollments').update({ current_node_id: target, next_action_at: dueAt }).eq('id', enrollment.id);
        await logEvent(client, tenantId, enrollment.id, node.id, 'delay', 'completed', { dueAt });
        return; // pause — lib/journeySweep.js resumes this when dueAt passes
      }

      if (node.type === 'condition') {
        const result = evaluateCondition(node.config, contact);
        await logEvent(client, tenantId, enrollment.id, node.id, 'condition', 'completed', { result });
        const edge = conditionEdge(graph, node.id, result);
        currentNodeId = edge ? edge.target : null;
        continue;
      }

      if (node.type === 'split') {
        const edge = pickSplitEdge(graph, node.id, contact.id);
        await logEvent(client, tenantId, enrollment.id, node.id, 'split', 'completed', { chose: edge?.target });
        currentNodeId = edge ? edge.target : null;
        continue;
      }

      if (node.type === 'action') {
        const executor = ACTION_EXECUTORS[node.actionType];
        if (!executor) { await logEvent(client, tenantId, enrollment.id, node.id, 'action', 'failed', { error: `unknown actionType "${node.actionType}"` }); }
        else if (await alreadyCompleted(client, enrollment.id, node.id)) { /* crash-recovery: don't re-run a completed action */ }
        else {
          try {
            const result = await executor(client, tenantId, node.config || {}, { contact, dealId });
            if (result && result.dealId) dealId = result.dealId; // create_deal feeds dealId forward for a later move_deal_stage node
            await logEvent(client, tenantId, enrollment.id, node.id, 'action', 'completed', result);
          } catch (err) {
            await logEvent(client, tenantId, enrollment.id, node.id, 'action', 'failed', { error: err.message });
          }
        }
        if (dealId !== enrollment.deal_id) await client.from('workflow_enrollments').update({ deal_id: dealId }).eq('id', enrollment.id);
        currentNodeId = nextNodeId(graph, node.id);
        continue;
      }

      // 'trigger' node — just the entry point, advance past it.
      currentNodeId = nextNodeId(graph, node.id);
    }

    // Ran off the end of the graph (no more outgoing edges) — re-check
    // the goal once more against the final state before closing out, so
    // "the last action happened to satisfy the goal" still counts.
    const { data: finalContact } = await scoped(client, tenantId, 'contacts').select('*').eq('id', enrollment.contact_id).maybeSingle();
    if (await evaluateGoal(client, tenantId, workflow.goal_config, finalContact)) await finishEnrollment(client, enrollment.id, 'goal_met');
    else await finishEnrollment(client, enrollment.id, 'completed');
  } catch (err) {
    console.error(`[journeyEngine] enrollment ${enrollment.id} tick failed:`, err.message);
  }
}

function delayMs(config) {
  const amount = Number(config?.amount) || 0;
  const unitMs = { minutes: 60000, hours: 3600000, days: 86400000 }[config?.unit] || 3600000;
  return Math.max(60000, amount * unitMs); // floor of 1 minute — a 0-length delay would otherwise busy-loop the sweep
}

/** Enrolls a contact into a workflow and runs its first tick immediately. Respects reentry_allowed (skips re-enrolling a contact who already has an active run, unless the workflow explicitly allows it). */
async function enrollContact(client, tenantId, workflowId, contactId, { dealId = null } = {}) {
  const { data: workflow } = await scoped(client, tenantId, 'workflow_definitions').select('*').eq('id', workflowId).maybeSingle();
  if (!workflow) throw new Error('Workflow not found.');
  if (!workflow.is_active) throw new Error('This workflow is not active.');
  validateGraph(workflow.graph_json);

  if (!workflow.reentry_allowed) {
    const { data: existing } = await client.from('workflow_enrollments').select('id').eq('workflow_id', workflowId).eq('contact_id', contactId).eq('status', 'active').maybeSingle();
    if (existing) return { enrollmentId: existing.id, alreadyEnrolled: true };
  }

  const triggerNode = workflow.graph_json.nodes.find((n) => n.type === 'trigger');
  const startNodeId = nextNodeId(workflow.graph_json, triggerNode.id);

  const { data: enrollment, error } = await client.from('workflow_enrollments').insert({
    tenant_id: tenantId, workflow_id: workflowId, contact_id: contactId, current_node_id: startNodeId, deal_id: dealId
  }).select('*').single();
  if (error) throw error;

  await logEvent(client, tenantId, enrollment.id, triggerNode.id, 'trigger', 'completed', {});
  if (startNodeId) await runEnrollmentTick(client, tenantId, enrollment);
  else await finishEnrollment(client, enrollment.id, 'completed');
  return { enrollmentId: enrollment.id, alreadyEnrolled: false };
}

/** Same role as lib/automation.js's fireTrigger() — called from the route handler where a trigger genuinely occurs. Never throws. */
async function fireWorkflowTrigger(client, tenantId, triggerType, context) {
  try {
    const { data: workflows, error } = await client.from('workflow_definitions').select('id, trigger_config').eq('tenant_id', tenantId).eq('trigger_type', triggerType).eq('is_active', true);
    if (error) throw error;
    for (const workflow of workflows || []) {
      const matches = Object.entries(workflow.trigger_config || {}).every(([key, value]) => context[key] === value);
      if (!matches || !context.contactId) continue;
      await enrollContact(client, tenantId, workflow.id, context.contactId, { dealId: context.dealId || null });
    }
  } catch (err) {
    console.error(`[journeyEngine] fireWorkflowTrigger(${triggerType}) failed:`, err.message);
  }
}

module.exports = { runEnrollmentTick, enrollContact, fireWorkflowTrigger, delayMs };
