/**
 * Consent & preference model (Marketing Hub Phase 1,
 * migrations/025_consent_preferences.sql). Three layers, checked in this
 * order, any one of which blocks a send:
 *
 *   1. contacts.global_opt_out_at — a contact who globally unsubscribed,
 *      overriding every channel at once.
 *   2. suppression_list — keyed by the raw identifier (email/phone), not
 *      contact_id, so a hard-bounce/complaint/manual suppression survives
 *      a contact being deleted, merged, or re-imported.
 *   3. contact_consents — per-contact, per-channel explicit opt-out.
 *
 * Existing contacts with no row in contact_consents are NOT blocked —
 * see docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 1 entry for why this
 * is a deliberate decision, not an oversight: requiring explicit opt-in
 * retroactively for every tenant's entire pre-existing audience would
 * silently stop every current sender on upgrade day. What this module
 * guarantees is that an explicit opt-out, bounce, complaint, or global
 * unsubscribe is ALWAYS honored server-side, never just hidden in a UI.
 *
 * Every bulk check here is written to run in a fixed, small number of
 * queries regardless of audience size (no N+1) — see
 * filterConsentedContacts.
 */

const { scoped, updateScopedWithVersion } = require('./query');

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function normalizePhone(phone) {
  return (phone || '').replace(/[^0-9]/g, '');
}

function normalizeIdentifier(channel, raw) {
  return channel === 'email' ? normalizeEmail(raw) : normalizePhone(raw);
}

function identifierForContact(channel, contact) {
  return channel === 'email' ? contact.email : contact.phone;
}

const CHANNELS = ['email', 'whatsapp', 'sms'];

/**
 * Bulk-filters a list of contacts (each needs at least {id, email|phone,
 * and ideally global_opt_out_at already selected — if it isn't, this
 * re-fetches it in one extra query) down to the ones allowed to receive
 * `channel`. Three queries total (global flag, suppression, consents),
 * not three-per-contact.
 */
async function filterConsentedContacts(client, tenantId, contacts, channel) {
  if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel "${channel}"`);
  if (contacts.length === 0) return { allowed: [], blocked: [], blockedCount: 0 };

  const ids = contacts.map((c) => c.id);

  let globalOptOutIds;
  if (Object.prototype.hasOwnProperty.call(contacts[0], 'global_opt_out_at')) {
    globalOptOutIds = new Set(contacts.filter((c) => c.global_opt_out_at).map((c) => c.id));
  } else {
    const { data, error } = await scoped(client, tenantId, 'contacts').select('id, global_opt_out_at').in('id', ids);
    if (error) throw error;
    globalOptOutIds = new Set((data || []).filter((c) => c.global_opt_out_at).map((c) => c.id));
  }

  const identifiers = [...new Set(contacts.map((c) => normalizeIdentifier(channel, identifierForContact(channel, c))).filter(Boolean))];
  let suppressedSet = new Set();
  if (identifiers.length > 0) {
    const { data, error } = await scoped(client, tenantId, 'suppression_list').select('identifier').eq('channel', channel).in('identifier', identifiers);
    if (error) throw error;
    suppressedSet = new Set((data || []).map((r) => r.identifier));
  }

  const { data: consentRows, error: consentError } = await scoped(client, tenantId, 'contact_consents')
    .select('contact_id, status').eq('channel', channel).eq('status', 'opted_out').in('contact_id', ids);
  if (consentError) throw consentError;
  const optedOutIds = new Set((consentRows || []).map((r) => r.contact_id));

  const allowed = [];
  const blocked = [];
  for (const contact of contacts) {
    const identifier = normalizeIdentifier(channel, identifierForContact(channel, contact));
    const isBlocked = globalOptOutIds.has(contact.id) || optedOutIds.has(contact.id) || (identifier && suppressedSet.has(identifier));
    (isBlocked ? blocked : allowed).push(contact);
  }
  return { allowed, blocked, blockedCount: blocked.length };
}

async function getConsentSummary(client, tenantId, contactId) {
  const { data: contact, error: contactError } = await scoped(client, tenantId, 'contacts')
    .select('id, email, phone, global_opt_out_at, preference_token').eq('id', contactId).maybeSingle();
  if (contactError) throw contactError;
  if (!contact) return null;

  const { data: consentRows, error } = await scoped(client, tenantId, 'contact_consents').select('*').eq('contact_id', contactId);
  if (error) throw error;

  const byChannel = {};
  for (const channel of CHANNELS) {
    const row = (consentRows || []).find((r) => r.channel === channel) || null;
    byChannel[channel] = { status: row ? row.status : 'unknown', source: row?.source || null, optedInAt: row?.opted_in_at || null, optedOutAt: row?.opted_out_at || null, reason: row?.opted_out_reason || null, version: row?.version || null };
  }

  const identifiersByChannel = { email: normalizeEmail(contact.email), whatsapp: normalizePhone(contact.phone), sms: normalizePhone(contact.phone) };
  const identifiers = [...new Set(Object.values(identifiersByChannel).filter(Boolean))];
  let suppressions = [];
  if (identifiers.length > 0) {
    const { data, error: supError } = await scoped(client, tenantId, 'suppression_list').select('*').in('identifier', identifiers);
    if (supError) throw supError;
    suppressions = data || [];
  }
  for (const channel of CHANNELS) {
    const identifier = identifiersByChannel[channel];
    const hit = identifier && suppressions.find((s) => s.channel === channel && s.identifier === identifier);
    if (hit) byChannel[channel].suppressed = { reason: hit.reason, since: hit.created_at };
  }

  return { contactId: contact.id, globalOptOutAt: contact.global_opt_out_at, preferenceToken: contact.preference_token, channels: byChannel };
}

/**
 * `expectedVersion`, when passed, enforces optimistic concurrency
 * (migrations/025's bump_version() trigger + lib/query.js's
 * updateScopedWithVersion) on an update to an EXISTING row — for the
 * admin manual-override route, where two admins editing the same
 * contact's consent in different tabs is a real scenario worth guarding
 * against, same as every other user-editable record in this app. The
 * public preference-center path (a contact toggling their own
 * checkboxes) intentionally omits it: there is no concurrent-editor risk
 * on a single person's own self-service form.
 */
async function upsertConsent(client, tenantId, contactId, channel, status, { source, reason, expectedVersion } = {}) {
  if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel "${channel}"`);
  const now = new Date().toISOString();
  const { data: existing, error: fetchError } = await scoped(client, tenantId, 'contact_consents').select('id, version').eq('contact_id', contactId).eq('channel', channel).maybeSingle();
  if (fetchError) throw fetchError;

  const patch = {
    status,
    source: source || null,
    ...(status === 'opted_in' ? { opted_in_at: now, opted_out_at: null, opted_out_reason: null } : { opted_out_at: now, opted_out_reason: reason || null }),
    updated_at: now
  };

  if (existing) {
    if (expectedVersion !== undefined) {
      const result = await updateScopedWithVersion(client, tenantId, 'contact_consents', existing.id, patch, expectedVersion);
      if (result.conflict) return { conflict: true, currentVersion: result.currentVersion };
      if (result.notFound) throw new Error('contact_consents row disappeared between read and write');
      if (result.error) throw result.error;
      return result.data;
    }
    const { data, error } = await client.from('contact_consents').update(patch).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await client.from('contact_consents').insert({ tenant_id: tenantId, contact_id: contactId, channel, ...patch }).select('*').single();
  if (error) throw error;
  return data;
}

async function setGlobalOptOut(client, tenantId, contactId, optedOut) {
  const { data, error } = await client.from('contacts').update({ global_opt_out_at: optedOut ? new Date().toISOString() : null }).eq('id', contactId).eq('tenant_id', tenantId).select('id, global_opt_out_at').maybeSingle();
  if (error) throw error;
  return data;
}

async function addSuppression(client, tenantId, channel, rawIdentifier, reason, { source, actorUserId } = {}) {
  if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel "${channel}"`);
  const identifier = normalizeIdentifier(channel, rawIdentifier);
  if (!identifier) throw new Error('A non-empty identifier is required.');
  const { data, error } = await client.from('suppression_list')
    .upsert({ tenant_id: tenantId, channel, identifier, reason, source: source || null, created_by: actorUserId || null }, { onConflict: 'tenant_id,channel,identifier' })
    .select('*').single();
  if (error) throw error;
  return data;
}

async function removeSuppression(client, tenantId, id) {
  const { error } = await scoped(client, tenantId, 'suppression_list').delete().eq('id', id);
  if (error) throw error;
}

async function findContactByPreferenceToken(client, token) {
  const { data, error } = await client.from('contacts').select('id, tenant_id, display_name, email, phone, global_opt_out_at').eq('preference_token', token).maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = {
  CHANNELS,
  normalizeEmail,
  normalizePhone,
  filterConsentedContacts,
  getConsentSummary,
  upsertConsent,
  setGlobalOptOut,
  addSuppression,
  removeSuppression,
  findContactByPreferenceToken
};
