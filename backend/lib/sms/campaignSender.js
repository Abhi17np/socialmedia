/**
 * The actual "send this SMS campaign" logic — same role as
 * lib/email/campaignSender.js's sendCampaign(), condensed for SMS's
 * simpler shape (plain text body, no template/A-B test).
 */
const { scoped } = require('../query');
const { getTenantPlan, currentUsage } = require('../entitlements');
const { limitsFor } = require('../plans');
const { resolveSegmentContacts } = require('../audience');
const { applyMergeTags, mergeContextFromContact } = require('../emailRenderer');
const { recordAudit } = require('../audit');
const smsQueue = require('./smsQueue');

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

async function sendCampaign(client, tenantId, campaignId, { actorUserId = null } = {}) {
  const { data: campaign, error: fetchError } = await scoped(client, tenantId, 'sms_campaigns').select('*').eq('id', campaignId).maybeSingle();
  if (fetchError) throw fetchError;
  if (!campaign) throw httpError(404, 'NOT_FOUND', 'Campaign not found.');
  if (campaign.status !== 'draft') throw httpError(409, 'INVALID_STATUS', `Campaign status is "${campaign.status}" — only a draft campaign can be sent.`);

  const { contacts, suppressed } = await resolveSegmentContacts(client, tenantId, campaign.segment_id, { consentChannel: 'sms' });
  const withPhone = contacts.filter((c) => c.phone);
  if (withPhone.length === 0) {
    throw httpError(400, 'ALL_RECIPIENTS_SUPPRESSED',
      suppressed.length > 0
        ? `All ${suppressed.length} matched contact(s) have opted out of SMS, globally unsubscribed, or are on the suppression list — nothing to send.`
        : 'This campaign has no eligible recipients (no matched contact has a phone number).');
  }

  const plan = await getTenantPlan(client, tenantId);
  const used = await currentUsage(client, tenantId, 'smsSendsPerMonth');
  const limit = limitsFor(plan).smsSendsPerMonth;
  const remaining = limit === Infinity ? Infinity : Math.max(0, limit - used);
  if (withPhone.length > remaining) {
    throw httpError(402, 'PLAN_LIMIT_REACHED', `This campaign's ${withPhone.length} recipients exceed your plan's remaining SMS send allowance (${remaining} left this month, ${limit}/month total). Upgrade or shrink the audience.`);
  }

  const { error: insertError } = await client.from('sms_campaign_recipients').upsert(
    withPhone.map((c) => ({ tenant_id: tenantId, campaign_id: campaign.id, contact_id: c.id, phone: c.phone })),
    { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true }
  );
  if (insertError) throw insertError;

  const { data: recipientRows, error: rowsError } = await scoped(client, tenantId, 'sms_campaign_recipients').select('id, contact_id, phone').eq('campaign_id', campaign.id).eq('status', 'pending');
  if (rowsError) throw rowsError;

  const contactById = new Map(withPhone.map((c) => [c.id, c]));
  const bodyByRecipient = new Map();
  for (const recipient of recipientRows) {
    const contact = contactById.get(recipient.contact_id);
    if (!contact) continue;
    bodyByRecipient.set(recipient.id, applyMergeTags(campaign.body, mergeContextFromContact(contact)));
  }

  await client.from('sms_campaigns').update({ status: 'sending', total_recipients: recipientRows.length, updated_at: new Date().toISOString() }).eq('id', campaign.id);
  await smsQueue.enqueueCampaign(campaign, recipientRows, bodyByRecipient);
  await recordAudit(client, { tenantId, actorUserId, action: 'marketing.sms_campaign_sent', targetType: 'sms_campaign', targetId: campaign.id, metadata: { recipientCount: recipientRows.length, suppressedCount: suppressed.length } });
  return { queued: recipientRows.length, suppressed: suppressed.length };
}

module.exports = { sendCampaign };
