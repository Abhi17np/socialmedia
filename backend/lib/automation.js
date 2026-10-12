/**
 * The automation engine migrations/014_marketing_hub.sql's
 * automation_rules/automation_runs tables describe: a small, declarative
 * "when X happens, do Y" evaluator, called directly from the exact route
 * handlers where each trigger genuinely occurs (not a poller — these are
 * real-time, in-request side effects of an action that already
 * happened).
 *
 * Deliberately only three action types, all backed by real tables this
 * app already has: add_tag/remove_tag (contacts.tags) and create_task
 * (sales_activities). An earlier draft included "add_to_segment", but
 * audience_segments are dynamic/filter-evaluated (lib/audience.js) with
 * no membership table to add a row to — rather than fake that action
 * with a no-op, it was dropped from the schema entirely.
 *
 * Every firing is recorded in automation_runs, success or failure, so
 * "why didn't this run" is answerable from the data, not by re-running
 * anything.
 */

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
      if (matchesConfig(rule.trigger_config, context)) {
        await runRule(client, tenantId, rule, context);
      }
    }
  } catch (err) {
    console.error(`[automation] fireTrigger(${triggerType}) failed:`, err.message);
  }
}

module.exports = { fireTrigger };
