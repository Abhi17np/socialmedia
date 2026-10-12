/**
 * Shared audience-segment resolver — one implementation of "which
 * contacts match this segment's filter_json", used by both WhatsApp
 * broadcast campaigns (routes/whatsapp.js) and Marketing Hub campaigns
 * (routes/marketing.js), so a segment means the same thing everywhere
 * it's referenced instead of each caller re-interpreting filter_json
 * slightly differently.
 *
 * Segments are dynamic (evaluated against contacts at the moment a
 * campaign is sent), not a stored membership list — filter_json is the
 * only source of truth, see migrations/012_whatsapp_broadcast.sql's
 * header for why.
 */

const { scoped } = require('./query');

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

/** Resolved contact rows for a segment — requirePhone is forced true for any WhatsApp-bound use, since a contact with no phone can never receive one regardless of how the segment itself was defined. */
async function resolveSegmentContacts(client, tenantId, segmentId, { requirePhone = false, limit = MAX_SEGMENT_CONTACTS } = {}) {
  const segment = await getSegment(client, tenantId, segmentId);
  if (!segment) return { segment: null, contacts: [] };

  let query = scoped(client, tenantId, 'contacts').select('id, display_name, phone, email, tags, lead_status');
  query = applyFilter(query, segment.filter_json);
  if (requirePhone) query = query.not('phone', 'is', null);
  query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw error;
  return { segment, contacts: data || [] };
}

/** Explicit contact-id list variant — a campaign can target an ad hoc list instead of a saved segment. */
async function resolveExplicitContacts(client, tenantId, contactIds, { requirePhone = false } = {}) {
  let query = scoped(client, tenantId, 'contacts').select('id, display_name, phone, email, tags, lead_status').in('id', contactIds);
  if (requirePhone) query = query.not('phone', 'is', null);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function countSegment(client, tenantId, segmentId, { requirePhone = false } = {}) {
  const segment = await getSegment(client, tenantId, segmentId);
  if (!segment) return { segment: null, count: 0 };

  let query = scoped(client, tenantId, 'contacts').select('id', { count: 'exact', head: true });
  query = applyFilter(query, segment.filter_json);
  if (requirePhone) query = query.not('phone', 'is', null);

  const { count, error } = await query;
  if (error) throw error;
  return { segment, count: count || 0 };
}

module.exports = { resolveSegmentContacts, resolveExplicitContacts, countSegment, getSegment, MAX_SEGMENT_CONTACTS };
