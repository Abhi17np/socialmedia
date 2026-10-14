/**
 * Marketing Hub Phase 5: lead capture forms. `protectedRouter` is the
 * tenant-authenticated authoring/management surface (CRUD, activate/
 * pause, submissions list) behind requireHub('marketing'), same shape as
 * routes/journeys.js. `publicRouter` is the hosted form itself — no
 * login, keyed by the form's own uuid, reachable from any website that
 * embeds it (see lib/leadForms.js's header for why this, not a separate
 * API-key system, is this round's "public API").
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { getSocialClient } = require('../social/db');
const { scoped, updateScopedWithVersion } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { requireHub } = require('../middleware/hubs');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { fireTrigger } = require('../lib/automation');
const { fireWorkflowTrigger } = require('../lib/journeyEngine');
const { recomputeLeadScore } = require('../lib/leadScoring');
const { upsertConsent } = require('../lib/consent');
const { leadFormSchema } = require('../lib/schemas');
const { LeadFormError, validateFieldDefinitions, validateSubmission, resolveContact, generateConfirmToken, sendConfirmationEmail } = require('../lib/leadForms');

const router = express.Router();
const publicRouter = express.Router();

const rateLimited = { error: 'Too many requests — please try again in a few minutes.' };
// A hosted form's thank-you/confirm flow needs no login — the uuid in
// the URL is 122 bits of randomness, same access-control model as every
// other public token link in this app (preference center, email
// unsubscribe). These limiters blunt scraping/spam without blocking a
// real visitor who double-submits or retries a flaky connection.
const formViewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: rateLimited });
const formSubmitLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: rateLimited });

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

function validateFieldsOr400(res, fields) {
  try {
    validateFieldDefinitions(fields);
    return true;
  } catch (err) {
    if (err instanceof LeadFormError) { res.status(err.statusCode).json({ error: err.message }); return false; }
    throw err;
  }
}

// ---------------------------------------------------------------- Authoring (tenant-authenticated)

router.get('/marketing/forms', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'lead_forms').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ forms: data });
}));

router.post('/marketing/forms', requireHub('marketing'), requireRole('member'), validate(leadFormSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  if (!validateFieldsOr400(res, req.body.fields)) return;

  const { name, description, fields, consentRequired, consentText, thankYouMessage, redirectUrl } = req.body;
  const insert = { tenant_id: req.tenantId, name, description: description || null, fields, consent_required: consentRequired, is_active: false, created_by: req.userId };
  if (consentText !== undefined) insert.consent_text = consentText;
  if (thankYouMessage !== undefined) insert.thank_you_message = thankYouMessage;
  if (redirectUrl !== undefined) insert.redirect_url = redirectUrl;

  const { data, error } = await client.from('lead_forms').insert(insert).select('*').single();
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.lead_form_created', targetType: 'lead_form', targetId: data.id, metadata: { name } });
  res.status(201).json({ form: data });
}));

router.get('/marketing/forms/:id', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'lead_forms').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Form not found.' });
  res.json({ form: data });
}));

router.patch('/marketing/forms/:id', requireHub('marketing'), requireRole('member'), validate(leadFormSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  if (!validateFieldsOr400(res, req.body.fields)) return;

  const { name, description, fields, consentRequired, consentText, thankYouMessage, redirectUrl, version } = req.body;
  const result = await updateScopedWithVersion(client, req.tenantId, 'lead_forms', req.params.id, {
    name, description: description || null, fields, consent_required: consentRequired,
    consent_text: consentText, thank_you_message: thankYouMessage, redirect_url: redirectUrl || null, updated_at: new Date().toISOString()
  }, version);
  if (result.notFound) return res.status(404).json({ error: 'Form not found.' });
  if (result.conflict) return res.status(409).json({ error: 'This form was changed by someone else since you loaded it. Reload to see the latest version.', code: 'VERSION_CONFLICT', currentVersion: result.currentVersion });
  if (result.error) throw result.error;
  res.json({ form: result.data });
}));

router.patch('/marketing/forms/:id/activate', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: form } = await scoped(client, req.tenantId, 'lead_forms').select('id, fields').eq('id', req.params.id).maybeSingle();
  if (!form) return res.status(404).json({ error: 'Form not found.' });
  if (!validateFieldsOr400(res, form.fields)) return;

  const { data, error } = await client.from('lead_forms').update({ is_active: true, updated_at: new Date().toISOString() }).eq('id', form.id).select('*').single();
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.lead_form_activated', targetType: 'lead_form', targetId: form.id });
  res.json({ form: data });
}));

router.patch('/marketing/forms/:id/pause', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'lead_forms').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Form not found.' });
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.lead_form_paused', targetType: 'lead_form', targetId: req.params.id });
  res.json({ form: data });
}));

router.delete('/marketing/forms/:id', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'lead_forms').delete().eq('id', req.params.id);
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.lead_form_deleted', targetType: 'lead_form', targetId: req.params.id });
  res.json({ success: true });
}));

router.get('/marketing/forms/:id/submissions', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  const { data, error, count } = await scoped(client, req.tenantId, 'lead_form_submissions').select('*, contacts(display_name, email, phone)', { count: 'exact' })
    .eq('form_id', req.params.id).order('created_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw error;
  res.json({ submissions: data, page, pageSize, total: count });
}));

// ---------------------------------------------------------------- Hosted form (public, unauthenticated)

publicRouter.get('/public/forms/:id', formViewLimiter, asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: form } = await client.from('lead_forms').select('id, tenant_id, name, description, fields, consent_required, consent_text').eq('id', req.params.id).eq('is_active', true).maybeSingle();
  if (!form) return res.status(404).json({ error: 'This form is not available.' });

  // Defense in depth: a tenant whose Marketing Hub access was revoked
  // after this form went live shouldn't keep silently collecting leads
  // nobody can act on.
  const { data: tenant } = await client.from('tenants').select('hubs_enabled').eq('id', form.tenant_id).maybeSingle();
  if (!tenant || !tenant.hubs_enabled?.marketing) return res.status(404).json({ error: 'This form is not available.' });

  res.json({ id: form.id, name: form.name, description: form.description, fields: form.fields, consentRequired: form.consent_required, consentText: form.consent_text });
}));

publicRouter.post('/public/forms/:id/submit', formSubmitLimiter, asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: form } = await client.from('lead_forms').select('*').eq('id', req.params.id).eq('is_active', true).maybeSingle();
  if (!form) return res.status(404).json({ error: 'This form is not available.' });

  const { data: tenant } = await client.from('tenants').select('hubs_enabled').eq('id', form.tenant_id).maybeSingle();
  if (!tenant || !tenant.hubs_enabled?.marketing) return res.status(404).json({ error: 'This form is not available.' });

  // Honeypot: a hidden field real visitors never see or fill, bots
  // filling every input do. A tripped honeypot still gets a normal-
  // looking success response (never tips off the bot) but the
  // submission row is flagged and excluded from contact
  // creation/journey triggers — visible to the tenant for transparency,
  // never silently dropped.
  const spamFlagged = !!(req.body.hp && String(req.body.hp).trim());

  let cleaned;
  try {
    cleaned = validateSubmission(form.fields, req.body.data);
  } catch (err) {
    if (err instanceof LeadFormError) return res.status(err.statusCode).json({ error: err.message });
    throw err;
  }

  const utm = {
    utm_source: req.body.utmSource ? String(req.body.utmSource).slice(0, 200) : null,
    utm_medium: req.body.utmMedium ? String(req.body.utmMedium).slice(0, 200) : null,
    utm_campaign: req.body.utmCampaign ? String(req.body.utmCampaign).slice(0, 200) : null,
    utm_term: req.body.utmTerm ? String(req.body.utmTerm).slice(0, 200) : null,
    utm_content: req.body.utmContent ? String(req.body.utmContent).slice(0, 200) : null
  };

  if (spamFlagged) {
    await client.from('lead_form_submissions').insert({ tenant_id: form.tenant_id, form_id: form.id, data: cleaned, ...utm, ip_address: req.ip, user_agent: req.get('user-agent') || null, spam_flagged: true, consent_status: 'not_required' });
    return res.status(201).json({ success: true, message: form.thank_you_message, redirectUrl: form.redirect_url || null });
  }

  const { contact, created } = await resolveContact(client, form.tenant_id, form, cleaned);
  const hasEmail = form.fields.some((f) => f.type === 'email') && cleaned[form.fields.find((f) => f.type === 'email')?.key];
  const consentStatus = !form.consent_required ? 'not_required' : hasEmail ? 'pending' : 'not_required';
  const confirmToken = consentStatus === 'pending' ? generateConfirmToken() : null;

  const { error } = await client.from('lead_form_submissions').insert({
    tenant_id: form.tenant_id, form_id: form.id, contact_id: contact.id, data: cleaned, ...utm,
    ip_address: req.ip, user_agent: req.get('user-agent') || null, consent_status: consentStatus, confirm_token: confirmToken
  });
  if (error) throw error;

  await client.from('lead_forms').update({ submit_count: form.submit_count + 1 }).eq('id', form.id);

  if (created) {
    Object.assign(contact, await recomputeLeadScore(client, form.tenant_id, contact.id));
    await fireTrigger(client, form.tenant_id, 'contact_created', { refType: 'contact', refId: contact.id, contactId: contact.id });
  }
  await recordAudit(client, { tenantId: form.tenant_id, actorUserId: null, action: 'marketing.lead_form_submitted', targetType: 'contact', targetId: contact.id, metadata: { formId: form.id, formName: form.name, created } });

  // The journey trigger — and, below, opted-in consent — only fire once
  // consent is actually secured (immediately if the form doesn't require
  // it, or after the visitor clicks the confirm link if it does). Firing
  // a nurture journey into someone's inbox before they've confirmed
  // they want to hear from this tenant would defeat the point of
  // requiring consent at all.
  if (consentStatus !== 'pending') {
    if (hasEmail) await upsertConsent(client, form.tenant_id, contact.id, 'email', 'opted_in', { source: 'lead_form' });
    await fireWorkflowTrigger(client, form.tenant_id, 'form_submitted', { contactId: contact.id, formId: form.id });
  } else {
    const { data: tenantRow } = await client.from('tenants').select('name').eq('id', form.tenant_id).maybeSingle();
    await sendConfirmationEmail(client, form.tenant_id, { to: contact.email, formName: form.name, confirmToken, tenantName: tenantRow?.name });
  }

  res.status(201).json({ success: true, consentPending: consentStatus === 'pending', message: form.thank_you_message, redirectUrl: form.redirect_url || null });
}));

publicRouter.get('/public/forms/confirm/:token', formViewLimiter, asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: submission } = await client.from('lead_form_submissions').select('*').eq('confirm_token', req.params.token).maybeSingle();
  if (!submission) return res.status(404).json({ error: 'This confirmation link is invalid or has already been used.' });
  if (submission.consent_status === 'confirmed') return res.json({ alreadyConfirmed: true });

  const { data: contact } = await client.from('contacts').select('id, email').eq('id', submission.contact_id).maybeSingle();
  if (contact?.email) await upsertConsent(client, submission.tenant_id, contact.id, 'email', 'opted_in', { source: 'lead_form_double_optin' });

  await client.from('lead_form_submissions').update({ consent_status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', submission.id);
  await recordAudit(client, { tenantId: submission.tenant_id, actorUserId: null, action: 'marketing.lead_form_consent_confirmed', targetType: 'contact', targetId: submission.contact_id, metadata: { formId: submission.form_id } });

  if (contact) await fireWorkflowTrigger(client, submission.tenant_id, 'form_submitted', { contactId: contact.id, formId: submission.form_id });
  res.json({ alreadyConfirmed: false });
}));

module.exports = { router, publicRouter };
