/**
 * The actual "send this campaign" logic — extracted from
 * routes/marketingEmail.js's POST /campaigns/:id/send so
 * lib/email/scheduledSendSweep.js can call the exact same path for a
 * scheduled campaign's due time, rather than a second, drifting
 * reimplementation. Errors carry `.statusCode`/`.code` the same way
 * lib/entitlements.js's plan-limit errors do, so the route can translate
 * them straight into an HTTP response; the sweep just logs them.
 */
const { scoped } = require('../query');
const { getTenantPlan, currentUsage } = require('../entitlements');
const { limitsFor } = require('../plans');
const { resolveSegmentContacts } = require('../audience');
const { renderEmailForRecipient } = require('./sendPipeline');
const { recordAudit } = require('../audit');
const emailQueue = require('./emailQueue');

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/** Deterministic, even split across the configured A/B variant keys — same recipient always lands in the same variant if this is ever recomputed (hash of the recipient's contact id, not Math.random()). */
function pickVariant(abTest, contactId) {
  if (!abTest) return null;
  let hash = 0;
  for (let i = 0; i < contactId.length; i++) hash = (hash * 31 + contactId.charCodeAt(i)) >>> 0;
  const pct = hash % 100;
  const splitPoint = abTest.splitPercent || 50;
  return pct < splitPoint ? abTest.variants[0].key : (abTest.variants[1] ? abTest.variants[1].key : abTest.variants[0].key);
}

/** `actorUserId` is null for a scheduler-driven send (no human clicked anything) — recordAudit already treats a null actor as valid. */
async function sendCampaign(client, tenantId, campaignId, { actorUserId = null } = {}) {
  const { data: campaign, error: fetchError } = await scoped(client, tenantId, 'email_campaigns').select('*').eq('id', campaignId).maybeSingle();
  if (fetchError) throw fetchError;
  if (!campaign) throw httpError(404, 'NOT_FOUND', 'Campaign not found.');
  if (!['draft', 'scheduled'].includes(campaign.status)) throw httpError(409, 'INVALID_STATUS', `Campaign status is "${campaign.status}" — only a draft or scheduled campaign can be sent.`);

  const { data: template, error: tplError } = await scoped(client, tenantId, 'email_templates').select('*').eq('id', campaign.template_id).single();
  if (tplError || !template) throw httpError(404, 'TEMPLATE_MISSING', 'The campaign\'s template no longer exists.');

  const { contacts, suppressed } = await resolveSegmentContacts(client, tenantId, campaign.segment_id, { consentChannel: 'email' });
  const withEmail = contacts.filter((c) => c.email);
  if (withEmail.length === 0) {
    throw httpError(400, 'ALL_RECIPIENTS_SUPPRESSED',
      suppressed.length > 0
        ? `All ${suppressed.length} matched contact(s) have opted out of email, globally unsubscribed, or are on the suppression list — nothing to send.`
        : 'This campaign has no eligible recipients (no matched contact has an email address).');
  }

  const plan = await getTenantPlan(client, tenantId);
  const used = await currentUsage(client, tenantId, 'emailSendsPerMonth');
  const limit = limitsFor(plan).emailSendsPerMonth;
  const remaining = limit === Infinity ? Infinity : Math.max(0, limit - used);
  if (withEmail.length > remaining) {
    throw httpError(402, 'PLAN_LIMIT_REACHED', `This campaign's ${withEmail.length} recipients exceed your plan's remaining email send allowance (${remaining} left this month, ${limit}/month total). Upgrade or shrink the audience.`);
  }

  const { data: tenant } = await client.from('tenants').select('marketing_postal_address').eq('id', tenantId).maybeSingle();

  const { error: insertError } = await client.from('email_campaign_recipients').upsert(
    withEmail.map((c) => ({ tenant_id: tenantId, campaign_id: campaign.id, contact_id: c.id, email: c.email, variant: pickVariant(campaign.ab_test, c.id) })),
    { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true }
  );
  if (insertError) throw insertError;

  const { data: recipientRows, error: rowsError } = await scoped(client, tenantId, 'email_campaign_recipients').select('id, contact_id, email, variant').eq('campaign_id', campaign.id).eq('status', 'pending');
  if (rowsError) throw rowsError;

  const contactById = new Map(withEmail.map((c) => [c.id, c]));
  const rendered = new Map();
  for (const recipient of recipientRows) {
    const contact = contactById.get(recipient.contact_id);
    if (!contact) continue;
    const variantSubject = campaign.ab_test && recipient.variant ? campaign.ab_test.variants.find((v) => v.key === recipient.variant)?.subject : null;
    rendered.set(recipient.id, renderEmailForRecipient({
      template, campaign: { subject: variantSubject || campaign.subject, preheader: campaign.preheader }, contact, recipientId: recipient.id, tenant
    }));
  }

  await client.from('email_campaigns').update({ status: 'sending', total_recipients: recipientRows.length, updated_at: new Date().toISOString() }).eq('id', campaign.id);

  await emailQueue.enqueueCampaign(campaign, recipientRows, rendered);

  await recordAudit(client, { tenantId, actorUserId, action: 'marketing.email_campaign_sent', targetType: 'email_campaign', targetId: campaign.id, metadata: { recipientCount: recipientRows.length, suppressedCount: suppressed.length, scheduled: !actorUserId } });
  return { queued: recipientRows.length, suppressed: suppressed.length };
}

module.exports = { sendCampaign };
