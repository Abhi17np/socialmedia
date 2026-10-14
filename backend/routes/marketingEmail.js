/**
 * Marketing Hub Phase 3: email marketing. Provider connection (encrypted
 * at rest), sender-domain SPF/DKIM/DMARC checks (real DNS lookups, no
 * provider account needed), the block-based template editor's backend,
 * campaigns (one-off/scheduled, basic A/B subject-line split), and the
 * public tracking/unsubscribe endpoints every sent email's links hit.
 *
 * Consent is enforced exactly once, authoritatively, right before
 * enqueueing — same posture as routes/whatsapp.js's send handler, reusing
 * the identical lib/consent.js/lib/audience.js machinery so "who gets
 * emailed" and "who may legally be emailed" can never diverge between
 * channels.
 */

const express = require('express');
const { checkDomainDns } = require('../lib/emailDomainCheck');
const { getSocialClient } = require('../social/db');
const { scoped, updateScopedWithVersion } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { requireHub } = require('../middleware/hubs');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { upsertConsent, addSuppression } = require('../lib/consent');
const { sendViaTenantProvider } = require('../lib/email/providerRegistry');
const { renderEmailForRecipient } = require('../lib/email/sendPipeline');
const { decodeClickDestination, TRANSPARENT_GIF } = require('../lib/email/compliance');
const { sendCampaign } = require('../lib/email/campaignSender');
const emailQueue = require('../lib/email/emailQueue');
const crypto = require('../social/crypto');
const {
  emailConnectionSchema, emailDomainSchema, emailTemplateSchema, emailCampaignSchema, emailSendTestSchema
} = require('../lib/schemas');

const router = express.Router();
const publicRouter = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

// -------------------------------------------------------------
// Provider connection
// -------------------------------------------------------------

router.get('/marketing/email/connection', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'email_provider_connections').select('id, provider, from_name, from_email, reply_to, config, status, created_at, updated_at').maybeSingle();
  if (error) throw error;
  res.json({ connection: data || null });
}));

router.put('/marketing/email/connection', requireHub('marketing'), requireRole('admin'), validate(emailConnectionSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { provider, fromName, fromEmail, replyTo, config, secret } = req.body;

  const { data: existing } = await scoped(client, req.tenantId, 'email_provider_connections').select('id, secret_encrypted').maybeSingle();
  const patch = {
    provider, from_name: fromName, from_email: fromEmail, reply_to: replyTo || null, config, status: 'active', updated_at: new Date().toISOString()
  };
  // A blank secret on an update means "keep the existing one" — never
  // silently wipe a working credential because the UI re-submits the
  // form with the write-only secret field left empty.
  if (secret) patch.secret_encrypted = crypto.encrypt(secret);
  else if (!existing) patch.secret_encrypted = null;

  let data, error;
  if (existing) {
    ({ data, error } = await client.from('email_provider_connections').update(patch).eq('id', existing.id).select('id, provider, from_name, from_email, reply_to, config, status').single());
  } else {
    ({ data, error } = await client.from('email_provider_connections').insert({ tenant_id: req.tenantId, created_by: req.userId, ...patch }).select('id, provider, from_name, from_email, reply_to, config, status').single());
  }
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.email_connection_saved', targetType: 'email_provider_connection', targetId: data.id, metadata: { provider } });
  res.json({ connection: data });
}));

router.delete('/marketing/email/connection', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'email_provider_connections').delete();
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.email_connection_removed' });
  res.json({ success: true });
}));

router.post('/marketing/email/connection/test', requireHub('marketing'), requireRole('admin'), validate(emailSendTestSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  try {
    const result = await sendViaTenantProvider(client, req.tenantId, {
      to: req.body.to, subject: 'Test email from your Marketing Hub connection',
      html: '<p>If you can read this, your email connection is working.</p>', text: 'If you can read this, your email connection is working.'
    });
    res.json({ success: true, provider: result.provider, externalId: result.externalId });
  } catch (err) {
    res.status(502).json({ error: `Test send failed: ${err.message}` });
  }
}));

// -------------------------------------------------------------
// Sender domains — real SPF/DKIM/DMARC checks via DNS, no provider
// account needed (these are public DNS records by design).
// -------------------------------------------------------------

router.get('/marketing/email/domains', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'email_sender_domains').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ domains: data });
}));

router.post('/marketing/email/domains', requireHub('marketing'), requireRole('admin'), validate(emailDomainSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await client.from('email_sender_domains').insert({
    tenant_id: req.tenantId, domain: req.body.domain, dkim_selector: req.body.dkimSelector || null
  }).select('*').single();
  if (error) throw error;
  res.status(201).json({ domain: data });
}));

router.post('/marketing/email/domains/:id/check', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: domain } = await scoped(client, req.tenantId, 'email_sender_domains').select('*').eq('id', req.params.id).maybeSingle();
  if (!domain) return res.status(404).json({ error: 'Domain not found.' });

  const { spf, dkim, dmarc } = await checkDomainDns(domain.domain, domain.dkim_selector);
  const { data, error } = await client.from('email_sender_domains').update({
    spf_verified: spf, dkim_verified: dkim, dmarc_verified: dmarc, last_checked_at: new Date().toISOString()
  }).eq('id', domain.id).select('*').single();
  if (error) throw error;
  res.json({ domain: data });
}));

router.delete('/marketing/email/domains/:id', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'email_sender_domains').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ success: true });
}));

// Tenant's required physical mailing address footer (CAN-SPAM/DPDP).
router.patch('/marketing/email/settings', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const address = (req.body && req.body.marketingPostalAddress || '').trim().slice(0, 500);
  const { data, error } = await client.from('tenants').update({ marketing_postal_address: address || null }).eq('id', req.tenantId).select('marketing_postal_address').single();
  if (error) throw error;
  res.json({ marketingPostalAddress: data.marketing_postal_address });
}));

router.get('/marketing/email/settings', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await client.from('tenants').select('marketing_postal_address').eq('id', req.tenantId).maybeSingle();
  if (error) throw error;
  res.json({ marketingPostalAddress: data?.marketing_postal_address || null });
}));

// -------------------------------------------------------------
// Templates
// -------------------------------------------------------------

router.get('/marketing/email/templates', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'email_templates').select('*').order('updated_at', { ascending: false });
  if (error) throw error;
  res.json({ templates: data });
}));

router.get('/marketing/email/templates/:id', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'email_templates').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Template not found.' });
  res.json({ template: data });
}));

router.post('/marketing/email/templates', requireHub('marketing'), requireRole('member'), validate(emailTemplateSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, subject, preheader, blocks, brand } = req.body;
  const { data, error } = await client.from('email_templates').insert({
    tenant_id: req.tenantId, name, subject, preheader: preheader || null, blocks, brand, created_by: req.userId
  }).select('*').single();
  if (error) throw error;
  res.status(201).json({ template: data });
}));

router.patch('/marketing/email/templates/:id', requireHub('marketing'), requireRole('member'), validate(emailTemplateSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, subject, preheader, blocks, brand, version } = req.body;
  const result = await updateScopedWithVersion(client, req.tenantId, 'email_templates', req.params.id, {
    name, subject, preheader: preheader || null, blocks, brand, updated_at: new Date().toISOString()
  }, version);
  if (result.notFound) return res.status(404).json({ error: 'Template not found.' });
  if (result.conflict) return res.status(409).json({ error: 'This template was changed by someone else since you loaded it. Reload to see the latest version.', code: 'VERSION_CONFLICT', currentVersion: result.currentVersion });
  if (result.error) throw result.error;
  res.json({ template: result.data });
}));

router.delete('/marketing/email/templates/:id', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'email_templates').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ success: true });
}));

// Live preview for the editor — renders exactly what sendPipeline would
// produce (same functions), against a synthetic sample contact, with
// tracking links left as real-looking placeholders rather than live
// (there is no real recipient row for a preview to track against).
router.post('/marketing/email/templates/:id/preview', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: template } = await scoped(client, req.tenantId, 'email_templates').select('*').eq('id', req.params.id).maybeSingle();
  if (!template) return res.status(404).json({ error: 'Template not found.' });

  const sampleContact = { display_name: 'Jordan Example', email: 'jordan@example.com', phone: '919999900000', preference_token: '00000000-0000-0000-0000-000000000000' };
  const { data: tenant } = await client.from('tenants').select('marketing_postal_address').eq('id', req.tenantId).maybeSingle();
  const rendered = renderEmailForRecipient({ template, campaign: null, contact: sampleContact, recipientId: '00000000-0000-0000-0000-000000000000', tenant });
  res.json({ subject: rendered.subject, html: rendered.html, text: rendered.text });
}));

router.post('/marketing/email/templates/:id/send-test', requireHub('marketing'), requireRole('member'), validate(emailSendTestSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: template } = await scoped(client, req.tenantId, 'email_templates').select('*').eq('id', req.params.id).maybeSingle();
  if (!template) return res.status(404).json({ error: 'Template not found.' });

  const sampleContact = { display_name: 'Test Recipient', email: req.body.to, phone: null, preference_token: '00000000-0000-0000-0000-000000000000' };
  const { data: tenant } = await client.from('tenants').select('marketing_postal_address').eq('id', req.tenantId).maybeSingle();
  const rendered = renderEmailForRecipient({ template, campaign: { subject: `[TEST] ${template.subject}` }, contact: sampleContact, recipientId: '00000000-0000-0000-0000-000000000000', tenant });

  try {
    const result = await sendViaTenantProvider(client, req.tenantId, { to: req.body.to, subject: rendered.subject, html: rendered.html, text: rendered.text, headers: rendered.headers });
    res.json({ success: true, provider: result.provider });
  } catch (err) {
    res.status(502).json({ error: `Test send failed: ${err.message}` });
  }
}));

// -------------------------------------------------------------
// Campaigns
// -------------------------------------------------------------

router.get('/marketing/email/campaigns', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'email_campaigns').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ campaigns: data });
}));

router.post('/marketing/email/campaigns', requireHub('marketing'), requireRole('member'), validate(emailCampaignSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, templateId, segmentId, subject, preheader, fromName, fromEmail, sendMode, scheduledAt, timezone, abTest } = req.body;

  const { data: template } = await scoped(client, req.tenantId, 'email_templates').select('id').eq('id', templateId).maybeSingle();
  if (!template) return res.status(400).json({ error: 'Template not found.' });
  const { data: segment } = await scoped(client, req.tenantId, 'audience_segments').select('id').eq('id', segmentId).maybeSingle();
  if (!segment) return res.status(400).json({ error: 'Segment not found.' });

  const { data, error } = await client.from('email_campaigns').insert({
    tenant_id: req.tenantId, name, template_id: templateId, segment_id: segmentId,
    subject: subject || null, preheader: preheader || null, from_name: fromName || null, from_email: fromEmail || null,
    send_mode: sendMode, scheduled_at: sendMode === 'scheduled' ? scheduledAt : null, timezone,
    ab_test: abTest || null, status: sendMode === 'scheduled' ? 'scheduled' : 'draft', created_by: req.userId
  }).select('*').single();
  if (error) throw error;

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.email_campaign_created', targetType: 'email_campaign', targetId: data.id, metadata: { name } });
  res.status(201).json({ campaign: data });
}));

router.get('/marketing/email/campaigns/:id', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: campaign, error } = await scoped(client, req.tenantId, 'email_campaigns').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  const { data: recipients, error: recError } = await scoped(client, req.tenantId, 'email_campaign_recipients').select('*').eq('campaign_id', req.params.id).order('queued_at', { ascending: false }).limit(500);
  if (recError) throw recError;
  res.json({ campaign, recipients });
}));

router.patch('/marketing/email/campaigns/:id', requireHub('marketing'), requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const patch = {};
  for (const [bodyKey, column] of [['name', 'name'], ['subject', 'subject'], ['preheader', 'preheader'], ['fromName', 'from_name'], ['fromEmail', 'from_email'], ['scheduledAt', 'scheduled_at'], ['timezone', 'timezone']]) {
    if (req.body[bodyKey] !== undefined) patch[column] = req.body[bodyKey];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  const result = await updateScopedWithVersion(client, req.tenantId, 'email_campaigns', req.params.id, { ...patch, updated_at: new Date().toISOString() }, req.body.version);
  if (result.notFound) return res.status(404).json({ error: 'Campaign not found.' });
  if (result.conflict) return res.status(409).json({ error: 'This campaign was changed by someone else since you loaded it. Reload to see the latest version.', code: 'VERSION_CONFLICT', currentVersion: result.currentVersion });
  if (result.error) throw result.error;
  res.json({ campaign: result.data });
}));

router.delete('/marketing/email/campaigns/:id', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'email_campaigns').delete().eq('id', req.params.id);
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.email_campaign_deleted', targetType: 'email_campaign', targetId: req.params.id });
  res.json({ success: true });
}));

router.post('/marketing/email/campaigns/:id/send', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
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

router.post('/marketing/email/campaigns/:id/cancel', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: campaign, error: fetchError } = await scoped(client, req.tenantId, 'email_campaigns').select('*').eq('id', req.params.id).maybeSingle();
  if (fetchError) throw fetchError;
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  if (campaign.status !== 'sending') return res.status(409).json({ error: `Campaign status is "${campaign.status}" — only a sending campaign can be canceled.` });

  const { data: recipients, error: recError } = await scoped(client, req.tenantId, 'email_campaign_recipients').select('id').eq('campaign_id', campaign.id).eq('status', 'pending');
  if (recError) throw recError;
  await emailQueue.cancelCampaign(campaign, recipients);
  await client.from('email_campaigns').update({ status: 'canceled', updated_at: new Date().toISOString() }).eq('id', campaign.id);
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.email_campaign_canceled', targetType: 'email_campaign', targetId: campaign.id });
  res.json({ success: true });
}));

router.get('/marketing/email/campaigns/:id/report', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: campaign, error } = await scoped(client, req.tenantId, 'email_campaigns').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

  let byVariant = null;
  if (campaign.ab_test) {
    const { data: rows } = await scoped(client, req.tenantId, 'email_campaign_recipients').select('variant, status').eq('campaign_id', campaign.id);
    byVariant = {};
    for (const row of rows || []) {
      const key = row.variant || 'unassigned';
      byVariant[key] = byVariant[key] || { sent: 0, opened: 0, clicked: 0 };
      if (['sent', 'delivered', 'opened', 'clicked'].includes(row.status)) byVariant[key].sent += 1;
      if (['opened', 'clicked'].includes(row.status)) byVariant[key].opened += 1;
      if (row.status === 'clicked') byVariant[key].clicked += 1;
    }
  }

  res.json({
    campaign: {
      id: campaign.id, name: campaign.name, status: campaign.status, totalRecipients: campaign.total_recipients,
      sent: campaign.sent_count, delivered: campaign.delivered_count, opened: campaign.opened_count, clicked: campaign.clicked_count,
      bounced: campaign.bounced_count, complained: campaign.complained_count, unsubscribed: campaign.unsubscribed_count
    },
    byVariant
  });
}));

// -------------------------------------------------------------
// Public tracking + one-click unsubscribe (no auth — hit by the
// recipient's email client, not an authenticated tenant session)
// -------------------------------------------------------------

publicRouter.get('/marketing/email/track/open/:recipientId', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  if (client) await client.rpc('mark_email_recipient_event', { p_recipient_id: req.params.recipientId, p_event_type: 'open' }).then(() => {}, () => {});
  res.end(TRANSPARENT_GIF);
}));

publicRouter.get('/marketing/email/track/click/:recipientId', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  const destination = decodeClickDestination(req.query.u || '');
  if (!destination || !/^https?:\/\//i.test(destination)) return res.status(400).send('Invalid tracking link.');
  if (client) await client.rpc('mark_email_recipient_event', { p_recipient_id: req.params.recipientId, p_event_type: 'click', p_url: destination }).then(() => {}, () => {});
  res.redirect(302, destination);
}));

publicRouter.post('/marketing/email/one-click-unsubscribe/:recipientId', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const token = req.query.token;
  const { data: recipient } = await client.from('email_campaign_recipients').select('id, tenant_id, contact_id').eq('id', req.params.recipientId).maybeSingle();
  if (!recipient) return res.status(404).json({ error: 'Unknown recipient.' });
  const { data: contact } = await client.from('contacts').select('id, preference_token, email').eq('id', recipient.contact_id).maybeSingle();
  if (!contact || contact.preference_token !== token) return res.status(403).json({ error: 'Invalid or mismatched unsubscribe link.' });

  await upsertConsent(client, recipient.tenant_id, contact.id, 'email', 'opted_out', { source: 'unsubscribe_link' });
  if (contact.email) await addSuppression(client, recipient.tenant_id, 'email', contact.email, 'unsubscribe_link', { source: 'one_click_unsubscribe' });
  await client.rpc('mark_email_recipient_event', { p_recipient_id: recipient.id, p_event_type: 'unsubscribe' }).then(() => {}, () => {});
  res.json({ success: true });
}));

module.exports = { router, publicRouter };
