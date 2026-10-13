/**
 * The automation engine migrations/014_marketing_hub.sql's
 * automation_rules/automation_runs tables describe: a small, declarative
 * "when X happens, do Y" evaluator, called directly from the exact route
 * handlers where each trigger genuinely occurs (not a poller — these are
 * real-time, in-request side effects of an action that already
 * happened).
 *
 * Deliberately only four action types, all backed by real tables this
 * app already has: add_tag/remove_tag (contacts.tags), create_task
 * (sales_activities), and assign_owner (contacts.owner_id /
 * deals.owner_id — Zoho's "workflow rule on creation" pattern: auto-
 * assign an owner when a lead comes in or a deal reaches some stage).
 * An earlier draft included "add_to_segment", but audience_segments
 * are dynamic/filter-evaluated (lib/audience.js) with no membership
 * table to add a row to — rather than fake that action with a no-op,
 * it was dropped from the schema entirely.
 *
 * Every firing is recorded in automation_runs, success or failure, so
 * "why didn't this run" is answerable from the data, not by re-running
 * anything.
 */

// Idempotency guard: nothing in this codebase calls fireTrigger() twice
// for the same event today (each trigger type has exactly one call
// site), but a rule firing twice for the literal same occurrence — a
// future bug adding a second call site, a retried request — would
// double-tag a contact or create a duplicate follow-up task. This
// window is deliberately short: it must not block a rule's legitimate
// NEXT firing when the same entity triggers it again later (a tag
// re-added after removal, a deal moving through another stage), only
// a near-instant re-invocation for the same event.
const IDEMPOTENCY_WINDOW_MS = 10 * 1000;

async function ranRecently(client, ruleId, refId) {
  if (!refId) return false;
  const since = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS).toISOString();
  const { data } = await client.from('automation_runs').select('id').eq('rule_id', ruleId).eq('trigger_ref_id', refId).gte('ran_at', since).limit(1);
  return !!(data && data.length > 0);
}

// Rebuilds enough of fireTrigger()'s context to re-run a rule's action
// from just (trigger_ref_type, trigger_ref_id) — what's stored on an
// automation_runs row — so a failed run can be retried without having
// persisted the full original context. Every action type only ever
// needs contactId and/or dealId, and both are derivable from the ref
// alone (a deal's own contact_id covers the contactId side for a deal
// trigger).
async function reconstructContext(client, tenantId, refType, refId) {
  if (refType === 'contact') return { refType, refId, contactId: refId };
  if (refType === 'deal') {
    const { data: deal } = await client.from('deals').select('contact_id').eq('id', refId).eq('tenant_id', tenantId).maybeSingle();
    return { refType, refId, dealId: refId, contactId: deal?.contact_id || null };
  }
  return { refType, refId };
}

// Re-executes a previously failed (or any) automation_runs row's rule
// against the same entity — the manual "Recovery" path the brief asks
// for, since nothing here retries automatically (these are real-time,
// in-request side effects, not a queue with its own retry policy).
async function retryRun(client, tenantId, runId) {
  const { data: run, error: runError } = await client.from('automation_runs').select('*').eq('tenant_id', tenantId).eq('id', runId).maybeSingle();
  if (runError) throw runError;
  if (!run) throw new Error('Automation run not found.');

  const { data: rule, error: ruleError } = await client.from('automation_rules').select('*').eq('tenant_id', tenantId).eq('id', run.rule_id).maybeSingle();
  if (ruleError) throw ruleError;
  if (!rule) throw new Error('The rule this run belongs to no longer exists.');

  const context = await reconstructContext(client, tenantId, run.trigger_ref_type, run.trigger_ref_id);
  await runRule(client, tenantId, rule, context);
}

async function runRule(client, tenantId, rule, context) {
  let result;
  try {
    switch (rule.action_type) {
      case 'add_tag': {
        if (!context.contactId || !rule.action_config.tag) throw new Error('add_tag requires a contactId in context and a tag in action_config.');
        const { data: contact, error: fetchError } = await client.from('contacts').select('tags').eq('id', context.contactId).eq('tenant_id', tenantId).single();
        if (fetchError) throw fetchError;
        const nextTags = Array.from(new Set([...(contact.tags || []), rule.action_config.tag]));
        const { error } = await client.from('contacts').update({ tags: nextTags }).eq('id', context.contactId);
        if (error) throw error;
        result = { tags: nextTags };
        break;
      }
      case 'remove_tag': {
        if (!context.contactId || !rule.action_config.tag) throw new Error('remove_tag requires a contactId in context and a tag in action_config.');
        const { data: contact, error: fetchError } = await client.from('contacts').select('tags').eq('id', context.contactId).eq('tenant_id', tenantId).single();
        if (fetchError) throw fetchError;
        const nextTags = (contact.tags || []).filter((t) => t !== rule.action_config.tag);
        const { error } = await client.from('contacts').update({ tags: nextTags }).eq('id', context.contactId);
        if (error) throw error;
        result = { tags: nextTags };
        break;
      }
      case 'create_task': {
        const { data: task, error } = await client.from('sales_activities').insert({
          tenant_id: tenantId,
          type: 'task',
          subject: rule.action_config.subject || `Follow up (rule: ${rule.name})`,
          notes: rule.action_config.notes || null,
          contact_id: context.contactId || null,
          deal_id: context.dealId || null,
          assigned_to: rule.action_config.assignedTo || null
        }).select('id').single();
        if (error) throw error;
        result = { activityId: task.id };
        break;
      }
      case 'assign_owner': {
        if (!rule.action_config.ownerId) throw new Error('assign_owner requires an ownerId in action_config.');
        if (context.contactId) {
          const { error } = await client.from('contacts').update({ owner_id: rule.action_config.ownerId }).eq('id', context.contactId).eq('tenant_id', tenantId);
          if (error) throw error;
          result = { contactId: context.contactId, ownerId: rule.action_config.ownerId };
        } else if (context.dealId) {
          const { error } = await client.from('deals').update({ owner_id: rule.action_config.ownerId }).eq('id', context.dealId).eq('tenant_id', tenantId);
          if (error) throw error;
          result = { dealId: context.dealId, ownerId: rule.action_config.ownerId };
        } else {
          throw new Error('assign_owner requires a contactId or dealId in context.');
        }
        break;
      }
      default:
        throw new Error(`Unknown action_type "${rule.action_type}".`);
    }

    await client.from('automation_runs').insert({
      tenant_id: tenantId, rule_id: rule.id, trigger_ref_type: context.refType, trigger_ref_id: context.refId, status: 'success', result
    });
  } catch (err) {
    await client.from('automation_runs').insert({
      tenant_id: tenantId, rule_id: rule.id, trigger_ref_type: context.refType, trigger_ref_id: context.refId, status: 'failed', error: err.message
    });
  }
}

/**
 * Matches trigger_config against context — deliberately simple (exact
 * equality on whatever keys the rule specifies), not a general query
 * language. An empty trigger_config matches every event of that
 * triggerType.
 */
function matchesConfig(triggerConfig, context) {
  return Object.entries(triggerConfig || {}).every(([key, value]) => context[key] === value);
}

/**
 * Called from the route handler where a trigger genuinely occurs.
 * context shape depends on triggerType:
 *   contact_created: { refType: 'contact', refId, contactId }
 *   contact_tag_added: { refType: 'contact', refId, contactId, tag }
 *   deal_stage_changed / deal_won / deal_lost: { refType: 'deal', refId, dealId, fromStageId, toStageId, stageName }
 * Never throws — a misconfigured rule must not break the action that
 * triggered it (creating the contact/moving the deal already succeeded
 * by the time this runs).
 */
async function fireTrigger(client, tenantId, triggerType, context) {
  try {
    const { data: rules, error } = await client.from('automation_rules').select('*').eq('tenant_id', tenantId).eq('trigger_type', triggerType).eq('is_active', true);
    if (error) throw error;
    for (const rule of rules || []) {
      if (!matchesConfig(rule.trigger_config, context)) continue;
      if (await ranRecently(client, rule.id, context.refId)) continue;
      await runRule(client, tenantId, rule, context);
    }
  } catch (err) {
    console.error(`[automation] fireTrigger(${triggerType}) failed:`, err.message);
  }
}

module.exports = { fireTrigger, retryRun };
