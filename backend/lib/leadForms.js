/**
 * Lead capture forms (Marketing Hub Phase 5,
 * migrations/029_lead_forms.sql): a tenant-defined, dynamically-shaped
 * form (fields aren't a fixed schema — each tenant picks their own), a
 * public hosted submission endpoint (routes/leadForms.js), and the real
 * handoff into Sales Hub: every genuine submission resolves or creates a
 * real `contacts` row with attribution, exactly the same table and
 * exactly the same lead-scoring/automation/journey triggers a manually-
 * created contact gets — a form lead is a real lead, not a second-class
 * shadow record only Marketing Hub can see.
 *
 * Because the field set is per-tenant and dynamic, submission validation
 * is hand-written here against the form's own `fields` definition rather
 * than a static zod schema (see routes/leadForms.js's own schema for the
 * one static, structural part: the shape of a field DEFINITION itself).
 */

const { randomBytes } = require('crypto');
const { normalizeEmail, normalizePhone } = require('./consent');
const { sendViaTenantProvider } = require('./email/providerRegistry');
const { escapeHtml } = require('./emailRenderer');

const FIELD_TYPES = ['text', 'email', 'phone', 'textarea', 'select', 'checkbox'];
const MAX_FIELDS = 20;
const KEY_RE = /^[a-z][a-z0-9_]{0,49}$/;

class LeadFormError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Validates a form's field DEFINITIONS (the authoring shape), not a submission against them. Throws LeadFormError with a user-safe message. */
function validateFieldDefinitions(fields) {
  if (!Array.isArray(fields) || fields.length === 0) throw new LeadFormError('A form needs at least one field.');
  if (fields.length > MAX_FIELDS) throw new LeadFormError(`A form can have at most ${MAX_FIELDS} fields.`);

  const keys = new Set();
  let hasIdentifierField = false;
  for (const field of fields) {
    if (!field || typeof field.key !== 'string' || !KEY_RE.test(field.key)) throw new LeadFormError(`Field key "${field?.key}" must be lowercase letters, numbers, and underscores, starting with a letter.`);
    if (keys.has(field.key)) throw new LeadFormError(`Duplicate field key "${field.key}".`);
    keys.add(field.key);
    if (!field.label || typeof field.label !== 'string' || !field.label.trim()) throw new LeadFormError(`Field "${field.key}" needs a label.`);
    if (!FIELD_TYPES.includes(field.type)) throw new LeadFormError(`Field "${field.key}" has an unknown type "${field.type}".`);
    if (field.type === 'select' && (!Array.isArray(field.options) || field.options.length === 0)) throw new LeadFormError(`Field "${field.key}" is a select field but has no options.`);
    if (field.type === 'email' || field.type === 'phone') hasIdentifierField = true;
  }
  if (!hasIdentifierField) throw new LeadFormError('A form needs at least one email or phone field — a submission with neither can\'t be resolved into a contact.');
}

/** Validates a visitor's SUBMISSION against the form's own field definitions. Returns the cleaned { [key]: value } map. Throws LeadFormError. */
function validateSubmission(fields, data) {
  if (!data || typeof data !== 'object') throw new LeadFormError('Missing submission data.');
  const cleaned = {};
  for (const field of fields) {
    const raw = data[field.key];
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (field.required && (value === undefined || value === null || value === '')) {
      throw new LeadFormError(`"${field.label}" is required.`);
    }
    if (value === undefined || value === null || value === '') continue;
    if (field.type === 'email' && typeof value === 'string' && !/^\S+@\S+\.\S+$/.test(value)) throw new LeadFormError(`"${field.label}" must be a valid email address.`);
    if (field.type === 'select' && !field.options.includes(value)) throw new LeadFormError(`"${field.label}" must be one of the offered options.`);
    cleaned[field.key] = typeof value === 'string' ? value.slice(0, 2000) : value;
  }
  return cleaned;
}

function findIdentifier(fields, data, type) {
  const field = fields.find((f) => f.type === type);
  return field ? data[field.key] : undefined;
}

function findDisplayName(fields, data) {
  const nameField = fields.find((f) => ['name', 'full_name', 'display_name', 'your_name'].includes(f.key));
  if (nameField && data[nameField.key]) return data[nameField.key];
  const email = findIdentifier(fields, data, 'email');
  return email ? email.split('@')[0] : 'New lead';
}

/**
 * Resolves an existing contact (matched by the normalized email or phone
 * the submission carries, same normalization lib/consent.js's channel
 * checks use) or creates a new one with lead_source='web_form'. Returns
 * { contact, created }. Never throws for a duplicate — merges the tag
 * and refreshes known fields instead, same spirit as
 * lib/consent.js's "don't punish a contact for re-submitting."
 */
async function resolveContact(client, tenantId, form, data) {
  const email = findIdentifier(form.fields, data, 'email');
  const phone = findIdentifier(form.fields, data, 'phone');
  const normalizedEmail = email ? normalizeEmail(email) : null;
  const normalizedPhone = phone ? normalizePhone(phone) : null;

  let existing = null;
  if (normalizedEmail) {
    const { data: byEmail } = await client.from('contacts').select('*').eq('tenant_id', tenantId).ilike('email', normalizedEmail).maybeSingle();
    existing = byEmail;
  }
  if (!existing && normalizedPhone) {
    const { data: byPhone } = await client.from('contacts').select('*').eq('tenant_id', tenantId).eq('phone', normalizedPhone).maybeSingle();
    existing = byPhone;
  }

  const formTag = `form:${form.name}`.slice(0, 50);
  const customFieldsPatch = { leadForm: { formId: form.id, formName: form.name, submittedAt: new Date().toISOString(), data } };

  if (existing) {
    const nextTags = Array.from(new Set([...(existing.tags || []), formTag]));
    const { data: updated, error } = await client.from('contacts').update({
      tags: nextTags, custom_fields: { ...(existing.custom_fields || {}), ...customFieldsPatch }
    }).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return { contact: updated, created: false };
  }

  const { data: created, error } = await client.from('contacts').insert({
    tenant_id: tenantId, display_name: findDisplayName(form.fields, data), email: email || null, phone: normalizedPhone || null,
    lead_source: 'web_form', lead_status: 'new', tags: [formTag], custom_fields: customFieldsPatch
  }).select('*').single();
  if (error) throw error;
  return { contact: created, created: true };
}

function generateConfirmToken() {
  return randomBytes(32).toString('hex');
}

function frontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:3000';
}

/**
 * The double opt-in confirmation email — the one message this module
 * sends outside the main campaign pipeline (lib/email/sendPipeline.js),
 * because it has to go out BEFORE consent exists, to the one channel
 * (email) that can carry the confirmation link at all. Uses the
 * tenant's own configured provider (falls back to the mock provider,
 * same as every other tenant send) so it's a real, traceable send, not
 * a silent no-op. Never throws into the submit route — a visitor's
 * submission still succeeds and is recorded even if this fails (e.g. no
 * provider reachable); the gap is visible as a 'pending' submission
 * that never gets confirmed, not a 500 on the public form.
 */
async function sendConfirmationEmail(client, tenantId, { to, formName, confirmToken, tenantName }) {
  const confirmUrl = `${frontendUrl()}/forms/confirm/${confirmToken}`;
  const safeFormName = escapeHtml(formName);
  const safeTenantName = escapeHtml(tenantName || 'this company');
  try {
    await sendViaTenantProvider(client, tenantId, {
      to,
      subject: `Please confirm your subscription`,
      html: `<p>Thanks for submitting "${safeFormName}". Please confirm you'd like to hear from ${safeTenantName}:</p><p><a href="${confirmUrl}">Confirm my subscription</a></p><p>If you didn't submit this form, you can ignore this email — nothing will be sent to you unless you click the link above.</p>`,
      text: `Thanks for submitting "${formName}". Please confirm you'd like to hear from ${tenantName || 'this company'}: ${confirmUrl}\n\nIf you didn't submit this form, you can ignore this email — nothing will be sent to you unless you click the link above.`
    });
  } catch (err) {
    console.error(`[leadForms] could not send double opt-in confirmation to a lead-form submitter:`, err.message);
  }
}

module.exports = { FIELD_TYPES, LeadFormError, validateFieldDefinitions, validateSubmission, resolveContact, generateConfirmToken, sendConfirmationEmail };
