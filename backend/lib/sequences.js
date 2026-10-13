/**
 * A real, persistent multi-step follow-up engine (migrations/018's
 * sequences/sequence_steps/sequence_enrollments) — HubSpot/Salesforce
 * "sequences" scoped to the two action types this app can execute for
 * real right now: creating a follow-up task and tagging a contact. No
 * send_email step type exists because nothing can send email as the
 * rep until a mailbox is connected (see SALES_HUB_IMPLEMENTATION.md's
 * "Blocked: Email & Calendar") — adding that step type later is a
 * config addition to this same engine, not a rewrite.
 *
 * Deliberately NOT built on setTimeout/setInterval-per-enrollment (the
 * "unreliable browser timer" anti-pattern the brief calls out, and
 * just as wrong server-side — one process restart would lose every
 * pending step). Instead every enrollment carries its own persisted
 * next_run_at, and lib/sequenceScheduler.js sweeps for due rows on an
 * interval, the same reconciliation-sweep shape social/scheduler.js
 * already established for scheduled posts.
 */

async function executeStep(client, tenantId, step, enrollment) {
  switch (step.action_type) {
    case 'create_task': {
      const { error } = await client.from('sales_activities').insert({
        tenant_id: tenantId,
        type: 'task',
        subject: step.action_config.subject || 'Sequence follow-up',
        notes: step.action_config.notes || null,
        contact_id: enrollment.contact_id,
        deal_id: enrollment.deal_id || null,
        assigned_to: step.action_config.assignedTo || enrollment.enrolled_by || null
      });
      if (error) throw error;
      return;
    }
    case 'add_tag':
    case 'remove_tag': {
      if (!step.action_config.tag) throw new Error(`${step.action_type} requires a tag in action_config.`);
      const { data: contact, error: fetchError } = await client.from('contacts').select('tags').eq('id', enrollment.contact_id).eq('tenant_id', tenantId).single();
      if (fetchError) throw fetchError;
      const nextTags = step.action_type === 'add_tag'
        ? Array.from(new Set([...(contact.tags || []), step.action_config.tag]))
        : (contact.tags || []).filter((t) => t !== step.action_config.tag);
      const { error } = await client.from('contacts').update({ tags: nextTags }).eq('id', enrollment.contact_id);
      if (error) throw error;
      return;
    }
    default:
      throw new Error(`Unknown sequence step action_type "${step.action_type}".`);
  }
}

// Runs exactly one enrollment forward by one step, recording the
// outcome on the enrollment row itself (last_error on failure, cleared
// on success) rather than a separate per-step log — the brief's
// "execution history" need here is "why is this contact stuck",
// answerable from one row, not a full audit trail of every step ever
// run (automation_runs already covers that need for rule-based
// automation).
async function processEnrollment(client, enrollment) {
  const { data: steps, error: stepsError } = await client.from('sequence_steps')
    .select('*').eq('sequence_id', enrollment.sequence_id).eq('tenant_id', enrollment.tenant_id).order('step_order');
  if (stepsError) throw stepsError;
  if (!steps || steps.length === 0) return;

  const nextStep = steps[enrollment.current_step]; // current_step is a count of steps already run — 0-indexed into this array
  if (!nextStep) {
    await client.from('sequence_enrollments').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', enrollment.id);
    return;
  }

  try {
    await executeStep(client, enrollment.tenant_id, nextStep, enrollment);
    const completedCount = enrollment.current_step + 1;
    const followingStep = steps[completedCount];
    if (followingStep) {
      const nextRunAt = new Date(Date.now() + followingStep.delay_days * 86400000).toISOString();
      await client.from('sequence_enrollments').update({ current_step: completedCount, next_run_at: nextRunAt, last_error: null }).eq('id', enrollment.id);
    } else {
      await client.from('sequence_enrollments').update({ current_step: completedCount, status: 'completed', completed_at: new Date().toISOString(), last_error: null }).eq('id', enrollment.id);
    }
  } catch (err) {
    // A failed step is retried on the next sweep (next_run_at left
    // alone would mean "due right now" forever and hammer a broken
    // step every tick, so push it out a short, fixed backoff instead)
    // rather than silently stalling the enrollment.
    const retryAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await client.from('sequence_enrollments').update({ next_run_at: retryAt, last_error: err.message }).eq('id', enrollment.id);
    throw err;
  }
}

// The sweep entrypoint — processes every tenant's due enrollments.
// One enrollment's failure must not stop the rest from running.
async function processDueEnrollments(client) {
  const { data: due, error } = await client.from('sequence_enrollments')
    .select('*').eq('status', 'active').lte('next_run_at', new Date().toISOString()).limit(200);
  if (error) {
    console.error('[sequences] Could not query due enrollments:', error.message);
    return;
  }
  for (const enrollment of due || []) {
    await processEnrollment(client, enrollment).catch((err) => {
      console.error(`[sequences] enrollment ${enrollment.id} step failed:`, err.message);
    });
  }
}

module.exports = { executeStep, processEnrollment, processDueEnrollments };
