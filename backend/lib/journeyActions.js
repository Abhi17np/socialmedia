/**
 * Journey action executors — a deliberately separate registry from
 * lib/automation.js's runRule(), not a shared one, even though 4 of
 * these (add_tag/remove_tag/create_task/assign_owner) overlap in what
 * they do. Documented tradeoff (see docs/MARKETING_HUB_IMPLEMENTATION.md's
 * Phase 4 entry): consolidating them into one shared module was
 * considered and deferred — lib/automation.js is small, stable, and
 * already shipped/tested Sales Hub behavior; refactoring it to share
 * code with a brand-new engine in the same round that introduces the
 * engine is exactly the kind of change that risks a regression for a
 * benefit (avoiding ~40 lines of duplication) that doesn't justify the
 * risk here. A future consolidation pass is reasonable, not required.
 *
 * Every executor: async (client, tenantId, config, { contact, dealId }) -> result.
 * "notify a team member" is deliberately NOT a separate action type —
 * this app has no notification feed (confirmed: `NotificationsMenu.jsx`
 * only shows live counts, never a message), so the honest way to notify
 * someone is the action that already does that: create_task assigned to
 * them, which surfaces in their Sales Hub workspace. Documented here so
 * "notify_team" isn't quietly missing without a reason on record.
 */

const { filterConsentedContacts } = require('./consent');
const { renderEmailForRecipient } = require('./email/sendPipeline');
const emailQueue = require('./email/emailQueue');
const broadcastQueue = require('../social/broadcastQueue');
const smsQueue = require('./sms/smsQueue');
const { applyMergeTags, mergeContextFromContact } = require('./emailRenderer');

async function addTag(client, tenantId, config, { contact }) {
  if (!config.tag) throw new Error('add_tag requires a tag.');
  const nextTags = Array.from(new Set([...(contact.tags || []), config.tag]));
  const { error } = await client.from('contacts').update({ tags: nextTags }).eq('id', contact.id).eq('tenant_id', tenantId);
  if (error) throw error;
  return { tags: nextTags };
}

async function removeTag(client, tenantId, config, { contact }) {
  if (!config.tag) throw new Error('remove_tag requires a tag.');
  const nextTags = (contact.tags || []).filter((t) => t !== config.tag);
  const { error } = await client.from('contacts').update({ tags: nextTags }).eq('id', contact.id).eq('tenant_id', tenantId);
  if (error) throw error;
  return { tags: nextTags };
}

async function createTask(client, tenantId, config, { contact, dealId }) {
  const { data: task, error } = await client.from('sales_activities').insert({
    tenant_id: tenantId, type: 'task', subject: config.subject || 'Journey follow-up', notes: config.notes || null,
    contact_id: contact.id, deal_id: dealId || null, assigned_to: config.assignedTo || null
  }).select('id').single();
  if (error) throw error;
  return { activityId: task.id };
}

async function assignOwner(client, tenantId, config, { contact, dealId }) {
  if (!config.ownerId) throw new Error('assign_owner requires an ownerId.');
  if (dealId) {
    const { error } = await client.from('deals').update({ owner_id: config.ownerId }).eq('id', dealId).eq('tenant_id', tenantId);
    if (error) throw error;
    return { dealId, ownerId: config.ownerId };
  }
  const { error } = await client.from('contacts').update({ owner_id: config.ownerId }).eq('id', contact.id).eq('tenant_id', tenantId);
  if (error) throw error;
  return { contactId: contact.id, ownerId: config.ownerId };
}

async function updateField(client, tenantId, config, { contact }) {
  const ALLOWED = ['lead_status', 'lifecycle_stage'];
  if (!ALLOWED.includes(config.field)) throw new Error(`update_field only supports ${ALLOWED.join(', ')}.`);
  const { error } = await client.from('contacts').update({ [config.field]: config.value }).eq('id', contact.id).eq('tenant_id', tenantId);
  if (error) throw error;
  return { field: config.field, value: config.value };
}

async function createDeal(client, tenantId, config, { contact }) {
  if (!config.pipelineId || !config.stageId || !config.name) throw new Error('create_deal requires pipelineId, stageId and name.');
  const { data: deal, error } = await client.from('deals').insert({
    tenant_id: tenantId, pipeline_id: config.pipelineId, stage_id: config.stageId, name: config.name,
    amount: config.amount || 0, currency: config.currency || 'INR', contact_id: contact.id, owner_id: config.ownerId || null
  }).select('id').single();
  if (error) throw error;
  await client.from('deal_contacts').insert({ tenant_id: tenantId, deal_id: deal.id, contact_id: contact.id, is_primary: true });
  return { dealId: deal.id };
}

async function moveDealStage(client, tenantId, config, { dealId }) {
  if (!dealId) throw new Error('move_deal_stage requires a deal in context (enroll via a deal trigger, or run create_deal first in this journey).');
  if (!config.stageId) throw new Error('move_deal_stage requires a stageId.');
  const { error } = await client.from('deals').update({ stage_id: config.stageId }).eq('id', dealId).eq('tenant_id', tenantId);
  if (error) throw error;
  return { dealId, stageId: config.stageId };
}

async function sendEmail(client, tenantId, config, { contact }) {
  if (!config.templateId) throw new Error('send_email requires a templateId.');
  if (!contact.email) return { skipped: 'no_email' };
  const { allowed } = await filterConsentedContacts(client, tenantId, [contact], 'email');
  if (allowed.length === 0) return { skipped: 'suppressed_or_opted_out' };

  const { data: template, error } = await client.from('email_templates').select('*').eq('id', config.templateId).eq('tenant_id', tenantId).maybeSingle();
  if (error) throw error;
  if (!template) throw new Error('send_email: template not found.');

  const { data: tenant } = await client.from('tenants').select('marketing_postal_address').eq('id', tenantId).maybeSingle();
  // A journey send has no email_campaigns row of its own (it's one
  // contact, not a batch) — a lightweight synthetic campaign row keeps
  // it visible in reporting and tracking (opens/clicks need a real
  // email_campaign_recipients.id to key off of) without a parallel
  // tracking mechanism just for journey-originated sends.
  const { data: campaign, error: campErr } = await client.from('email_campaigns').insert({
    tenant_id: tenantId, name: `Journey: ${template.name}`, template_id: template.id, status: 'sending', total_recipients: 1
  }).select('id').single();
  if (campErr) throw campErr;
  const { data: recipient, error: recErr } = await client.from('email_campaign_recipients').insert({
    tenant_id: tenantId, campaign_id: campaign.id, contact_id: contact.id, email: contact.email
  }).select('id').single();
  if (recErr) throw recErr;

  const rendered = renderEmailForRecipient({ template, campaign: null, contact, recipientId: recipient.id, tenant });
  await emailQueue.enqueueCampaign({ id: campaign.id, tenant_id: tenantId }, [{ id: recipient.id, email: contact.email }], new Map([[recipient.id, rendered]]));
  return { campaignId: campaign.id, recipientId: recipient.id };
}

async function sendWhatsapp(client, tenantId, config, { contact }) {
  if (!config.templateId || !config.socialAccountId) throw new Error('send_whatsapp requires templateId and socialAccountId.');
  if (!contact.phone) return { skipped: 'no_phone' };
  const { allowed } = await filterConsentedContacts(client, tenantId, [contact], 'whatsapp');
  if (allowed.length === 0) return { skipped: 'suppressed_or_opted_out' };

  const { data: template, error } = await client.from('whatsapp_templates').select('*').eq('id', config.templateId).eq('tenant_id', tenantId).maybeSingle();
  if (error) throw error;
  if (!template || template.approval_status !== 'approved') return { skipped: 'template_not_approved' };

  const { data: campaign, error: campErr } = await client.from('whatsapp_campaigns').insert({
    tenant_id: tenantId, name: `Journey: ${template.name}`, social_account_id: config.socialAccountId, template_id: template.id,
    variable_values: config.variableValues || [], status: 'sending', total_recipients: 1
  }).select('id').single();
  if (campErr) throw campErr;
  const { data: recipient, error: recErr } = await client.from('whatsapp_campaign_recipients').insert({
    tenant_id: tenantId, campaign_id: campaign.id, contact_id: contact.id, phone: contact.phone
  }).select('id, phone').single();
  if (recErr) throw recErr;

  await broadcastQueue.enqueueCampaign({ id: campaign.id, tenant_id: tenantId, social_account_id: config.socialAccountId, variable_values: config.variableValues || [] }, [recipient], template);
  return { campaignId: campaign.id, recipientId: recipient.id };
}

// The "multichannel fallback" half of Phase 7: NOT a separate primitive
// — a tenant composes send_whatsapp -> delay -> condition(on
// delivery/read) -> send_sms using the exact condition/delay nodes
// Phase 4 already built, falling back to SMS only when WhatsApp didn't
// land. See docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 7 entry.
async function sendSms(client, tenantId, config, { contact }) {
  if (!config.body) throw new Error('send_sms requires a body.');
  if (!contact.phone) return { skipped: 'no_phone' };
  const { allowed } = await filterConsentedContacts(client, tenantId, [contact], 'sms');
  if (allowed.length === 0) return { skipped: 'suppressed_or_opted_out' };

  const body = applyMergeTags(config.body, mergeContextFromContact(contact));
  // A lightweight synthetic campaign row, same reasoning as sendEmail's
  // above: one contact, not a batch, but still visible in reporting
  // through the same sms_campaigns/sms_campaign_recipients tables a bulk
  // send uses — no parallel tracking mechanism just for journey sends.
  const { data: campaign, error: campErr } = await client.from('sms_campaigns').insert({
    tenant_id: tenantId, name: 'Journey SMS', body, status: 'sending', total_recipients: 1
  }).select('id').single();
  if (campErr) throw campErr;
  const { data: recipient, error: recErr } = await client.from('sms_campaign_recipients').insert({
    tenant_id: tenantId, campaign_id: campaign.id, contact_id: contact.id, phone: contact.phone
  }).select('id').single();
  if (recErr) throw recErr;

  await smsQueue.enqueueCampaign({ id: campaign.id, tenant_id: tenantId }, [{ id: recipient.id, phone: contact.phone }], new Map([[recipient.id, body]]));
  return { campaignId: campaign.id, recipientId: recipient.id };
}

const ACTION_EXECUTORS = {
  add_tag: addTag,
  remove_tag: removeTag,
  create_task: createTask,
  assign_owner: assignOwner,
  update_field: updateField,
  create_deal: createDeal,
  move_deal_stage: moveDealStage,
  send_email: sendEmail,
  send_whatsapp: sendWhatsapp,
  send_sms: sendSms
};

module.exports = { ACTION_EXECUTORS };
