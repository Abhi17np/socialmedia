/**
 * Marketing Hub Phase 7: SMS. Provider connection (encrypted at rest,
 * same pattern as routes/marketingEmail.js), and campaigns (plain-text,
 * merge-tags-only — no block editor, SMS has no HTML). Consent enforced
 * exactly once, authoritatively, right before enqueueing — same
 * lib/consent.js/lib/audience.js machinery every other channel uses, so
 * "who gets texted" and "who may legally be texted" can never diverge.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped, updateScopedWithVersion } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { requireHub } = require('../middleware/hubs');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { sendViaTenantProvider } = require('../lib/sms/providerRegistry');
const { sendCampaign } = require('../lib/sms/campaignSender');
const smsQueue = require('../lib/sms/smsQueue');
const crypto = require('../social/crypto');
const { smsConnectionSchema, smsCampaignSchema } = require('../lib/schemas');

const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

// ---------------------------------------------------------------- Provider connection

router.get('/marketing/sms/connection', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'sms_provider_connections').select('id, provider, from_number, config, status, created_at, updated_at').maybeSingle();
  if (error) throw error;
  res.json({ connection: data || null });
}));

router.put('/marketing/sms/connection', requireHub('marketing'), requireRole('admin'), validate(smsConnectionSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { provider, fromNumber, config, secret } = req.body;
  const { data: existing } = await scoped(client, req.tenantId, 'sms_provider_connections').select('id').maybeSingle();
  const patch = { provider, from_number: fromNumber, config, status: 'active', updated_at: new Date().toISOString() };
  if (secret) patch.secret_encrypted = crypto.encrypt(secret);
  else if (!existing) patch.secret_encrypted = null;

  let data, error;
  if (existing) ({ data, error } = await client.from('sms_provider_connections').update(patch).eq('id', existing.id).select('id, provider, from_number, config, status').single());
  else ({ data, error } = await client.from('sms_provider_connections').insert({ tenant_id: req.tenantId, created_by: req.userId, ...patch }).select('id, provider, from_number, config, status').single());
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.sms_connection_saved', targetType: 'sms_provider_connection', targetId: data.id, metadata: { provider } });
  res.json({ connection: data });
}));

router.delete('/marketing/sms/connection', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'sms_provider_connections').delete();
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.sms_connection_removed' });
  res.json({ success: true });
}));

router.post('/marketing/sms/connection/test', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  if (!req.body.to || typeof req.body.to !== 'string') return res.status(400).json({ error: '"to" phone number is required.' });
  try {
    const result = await sendViaTenantProvider(client, req.tenantId, { to: req.body.to, body: 'Test SMS from your Marketing Hub connection.' });
    res.json({ success: true, provider: result.provider, externalId: result.externalId });
  } catch (err) {
    res.status(502).json({ error: `Test send failed: ${err.message}` });
  }
}));

// ---------------------------------------------------------------- Campaigns

router.get('/marketing/sms/campaigns', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'sms_campaigns').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ campaigns: data });
}));

router.post('/marketing/sms/campaigns', requireHub('marketing'), requireRole('member'), validate(smsCampaignSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, body, segmentId } = req.body;
  const { data: segment } = await scoped(client, req.tenantId, 'audience_segments').select('id').eq('id', segmentId).maybeSingle();
  if (!segment) return res.status(400).json({ error: 'Segment not found.' });

  const { data, error } = await client.from('sms_campaigns').insert({ tenant_id: req.tenantId, name, body, segment_id: segmentId, status: 'draft', created_by: req.userId }).select('*').single();
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.sms_campaign_created', targetType: 'sms_campaign', targetId: data.id, metadata: { name } });
  res.status(201).json({ campaign: data });
}));

router.get('/marketing/sms/campaigns/:id', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: campaign, error } = await scoped(client, req.tenantId, 'sms_campaigns').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  const { data: recipients, error: recError } = await scoped(client, req.tenantId, 'sms_campaign_recipients').select('*').eq('campaign_id', req.params.id).limit(500);
  if (recError) throw recError;
  res.json({ campaign, recipients });
}));

router.patch('/marketing/sms/campaigns/:id', requireHub('marketing'), requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const patch = {};
  for (const [bodyKey, column] of [['name', 'name'], ['body', 'body']]) {
    if (req.body[bodyKey] !== undefined) patch[column] = req.body[bodyKey];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  const result = await updateScopedWithVersion(client, req.tenantId, 'sms_campaigns', req.params.id, { ...patch, updated_at: new Date().toISOString() }, req.body.version);
  if (result.notFound) return res.status(404).json({ error: 'Campaign not found.' });
  if (result.conflict) return res.status(409).json({ error: 'This campaign was changed by someone else since you loaded it. Reload to see the latest version.', code: 'VERSION_CONFLICT', currentVersion: result.currentVersion });
  if (result.error) throw result.error;
  res.json({ campaign: result.data });
}));

router.delete('/marketing/sms/campaigns/:id', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'sms_campaigns').delete().eq('id', req.params.id);
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.sms_campaign_deleted', targetType: 'sms_campaign', targetId: req.params.id });
  res.json({ success: true });
}));

router.post('/marketing/sms/campaigns/:id/send', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  try {
    const result = await sendCampaign(client, req.tenantId, req.params.id, { actorUserId: req.userId });
    res.json({ success: true, queued: result.queued, suppressed: result.suppressed });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    throw err;
  }
}));

router.post('/marketing/sms/campaigns/:id/cancel', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: campaign, error: fetchError } = await scoped(client, req.tenantId, 'sms_campaigns').select('*').eq('id', req.params.id).maybeSingle();
  if (fetchError) throw fetchError;
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  if (campaign.status !== 'sending') return res.status(409).json({ error: `Campaign status is "${campaign.status}" — only a sending campaign can be canceled.` });

  const { data: recipients, error: recError } = await scoped(client, req.tenantId, 'sms_campaign_recipients').select('id').eq('campaign_id', campaign.id).eq('status', 'pending');
  if (recError) throw recError;
  await smsQueue.cancelCampaign(campaign, recipients);
  await client.from('sms_campaigns').update({ status: 'canceled', updated_at: new Date().toISOString() }).eq('id', campaign.id);
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.sms_campaign_canceled', targetType: 'sms_campaign', targetId: campaign.id });
  res.json({ success: true });
}));

module.exports = router;
