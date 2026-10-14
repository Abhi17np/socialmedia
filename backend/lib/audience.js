/**
 * Shared audience-segment resolver — one implementation of "which
 * contacts match this segment", used by both WhatsApp broadcast
 * campaigns (routes/whatsapp.js) and Marketing Hub campaigns
 * (routes/marketing.js), so a segment means the same thing everywhere
 * it's referenced instead of each caller re-interpreting filter_json
 * slightly differently.
 *
 * Two segment shapes (migrations/026_segmentation.sql's `segment_type`):
 *   - 'dynamic' (default, and every segment created before Phase 2):
 *     evaluated against contacts at the moment it's read — filter_json is
 *     the only source of truth, see migrations/012_whatsapp_broadcast.sql's
 *     original header for why. filter_json is either the v1 legacy flat
 *     shape (applyFilter below) or a v2 AND/OR tree
 *     (lib/segmentCompiler.js) — isV2Filter() tells them apart.
 *   - 'static': a stored membership list (segment_members) a user builds
 *     by adding/importing specific contacts — evaluated by a plain join,
 *     no filter logic at all.
 */

const { scoped } = require('./query');
const { filterConsentedContacts } = require('./consent');
const { isV2Filter, compileFilterTree } = require('./segmentCompiler');

const MAX_SEGMENT_CONTACTS = 20000; // safety cap — a single campaign send beyond this needs a conversation about pacing, not a silent partial send

function applyFilter(query, filter) {
  const f = filter || {};
  if (Array.isArray(f.tags) && f.tags.length > 0) query = query.overlaps('tags', f.tags);
  if (f.hasPhone) query = query.not('phone', 'is', null);
  if (f.hasEmail) query = query.not('email', 'is', null);
  if (f.leadStatus) query = query.eq('lead_status', f.leadStatus);
  if (f.search) {
    const term = f.search.replace(/[%,]/g, '');
    query = query.or(`display_name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`);
  }
  return query;
}

async function getSegment(client, tenantId, segmentId) {
  const { data, error } = await scoped(client, tenantId, 'audience_segments').select('*').eq('id', segmentId).maybeSingle();
  if (error) throw error;
  return data;
}

const CONTACT_FIELDS = 'id, display_name, phone, email, tags, lead_status, lifecycle_stage, global_opt_out_at';

/** Static-list member contact rows, bounded by `limit` — one query to get the member ids, one to fetch the contacts (never per-member). */
async function resolveStaticMembers(client, tenantId, segmentId, { requirePhone, limit }) {
  const { data: members, error } = await scoped(client, tenantId, 'segment_members').select('contact_id').eq('segment_id', segmentId).limit(limit);
  if (error) throw error;
  const ids = (members || []).map((m) => m.contact_id);
  if (ids.length === 0) return [];
  let query = scoped(client, tenantId, 'contacts').select(CONTACT_FIELDS).in('id', ids);
  if (requirePhone) query = query.not('phone', 'is', null);
  const { data, error: cErr } = await query;
  if (cErr) throw cErr;
  return data || [];
}

/** Dynamic-segment contact rows for either filter_json shape — see this file's header. */
async function resolveDynamicContacts(client, tenantId, segment, { requirePhone, limit }) {
  let query = scoped(client, tenantId, 'contacts').select(CONTACT_FIELDS);
  if (isV2Filter(segment.filter_json)) {
    const fragment = await compileFilterTree(client, tenantId, segment.filter_json.root);
    query = query.or(fragment);
  } else {
    query = applyFilter(query, segment.filter_json);
  }
  if (requirePhone) query = query.not('phone', 'is', null);
  query = query.limit(limit);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function resolveContactsForSegment(client, tenantId, segment, opts) {
  return segment.segment_type === 'static' ? resolveStaticMembers(client, tenantId, segment.id, opts) : resolveDynamicContacts(client, tenantId, segment, opts);
}

/**
 * `consentChannel`, when passed, filters out contacts who are globally
 * unsubscribed, suppressed, or have explicitly opted out of that channel
 * (lib/consent.js) — this is the one call every send-path caller must use
 * so "who gets sent to" and "who may legally be sent to" never diverge.
 * Omitted for callers that only need a count/preview without a channel
 * context yet (e.g. the generic segment-builder UI).
 */
async function resolveSegmentContacts(client, tenantId, segmentId, { requirePhone = false, limit = MAX_SEGMENT_CONTACTS, consentChannel = null } = {}) {
  const segment = await getSegment(client, tenantId, segmentId);
  if (!segment) return { segment: null, contacts: [], suppressedCount: 0 };

  let contacts = await resolveContactsForSegment(client, tenantId, segment, { requirePhone, limit });
  let suppressedCount = 0;
  let suppressed = [];
  if (consentChannel) {
    const { allowed, blocked } = await filterConsentedContacts(client, tenantId, contacts, consentChannel);
    contacts = allowed;
    suppressed = blocked;
    suppressedCount = blocked.length;
  }
  return { segment, contacts, suppressedCount, suppressed };
}

/** Explicit contact-id list variant — a campaign can target an ad hoc list instead of a saved segment. */
async function resolveExplicitContacts(client, tenantId, contactIds, { requirePhone = false, consentChannel = null } = {}) {
  let query = scoped(client, tenantId, 'contacts').select(CONTACT_FIELDS).in('id', contactIds);
  if (requirePhone) query = query.not('phone', 'is', null);
  const { data, error } = await query;
  if (error) throw error;
  let contacts = data || [];
  if (consentChannel) {
    const { allowed } = await filterConsentedContacts(client, tenantId, contacts, consentChannel);
    contacts = allowed;
  }
  return contacts;
}

async function countSegment(client, tenantId, segmentId, { requirePhone = false, consentChannel = null } = {}) {
  const segment = await getSegment(client, tenantId, segmentId);
  if (!segment) return { segment: null, count: 0 };

  // A consent-aware count, or any static-list count that also needs a
  // phone filter, needs the actual rows to check against — still a
  // single bounded query (capped at MAX_SEGMENT_CONTACTS) plus, for a
  // consent check, the fixed 3 queries filterConsentedContacts makes;
  // never N+1 against the audience size.
  if (consentChannel || (segment.segment_type === 'static' && requirePhone)) {
    const { contacts, suppressedCount } = await resolveSegmentContacts(client, tenantId, segmentId, { requirePhone, consentChannel });
    return { segment, count: contacts.length, suppressedCount };
  }

  if (segment.segment_type === 'static') {
    const { count, error } = await scoped(client, tenantId, 'segment_members').select('id', { count: 'exact', head: true }).eq('segment_id', segmentId);
    if (error) throw error;
    return { segment, count: count || 0 };
  }

  let query = scoped(client, tenantId, 'contacts').select('id', { count: 'exact', head: true });
  if (isV2Filter(segment.filter_json)) {
    const fragment = await compileFilterTree(client, tenantId, segment.filter_json.root);
    query = query.or(fragment);
  } else {
    query = applyFilter(query, segment.filter_json);
  }
  if (requirePhone) query = query.not('phone', 'is', null);

  const { count, error } = await query;
  if (error) throw error;
  return { segment, count: count || 0 };
}

module.exports = { resolveSegmentContacts, resolveExplicitContacts, countSegment, getSegment, MAX_SEGMENT_CONTACTS };
