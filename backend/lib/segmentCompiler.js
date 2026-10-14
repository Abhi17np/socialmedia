/**
 * Segment rule compiler (Marketing Hub Phase 2,
 * migrations/026_segmentation.sql). Compiles an AND/OR condition tree
 * into ONE PostgREST filter string, executed as a single query against
 * `contacts` — no per-contact application-level filtering, no N+1, and
 * no full-table scan: every leaf condition becomes a normal indexed SQL
 * predicate, and the handful of genuinely cross-table conditions
 * (channel identity, consent, deal data) are pre-resolved to a small,
 * bounded id list (bounded by how many matching deals/identities/consent
 * rows exist, never by the total contact count) and folded into the same
 * single final query as an `id.in.(...)` leaf.
 *
 * Two filter_json shapes are supported, auto-detected:
 *   v1 (legacy, every segment created before this phase): the flat
 *     {tags, hasPhone, hasEmail, leadStatus, search} shape
 *     lib/audience.js's applyFilter() already handled — untouched here,
 *     every existing segment keeps working exactly as before.
 *   v2: { version: 2, root: <node> } where a node is either
 *     { logic: 'AND'|'OR', children: [<node>, ...] } (a group) or
 *     { field, operator, value } (a condition leaf) — see FIELD_DEFS
 *     below for the exact supported (field, operator) pairs.
 *
 * Deliberately NOT supported yet (would need data this app doesn't
 * collect until later phases — listed here so the gap is a documented
 * decision, not a silent omission): behavioral events (email opened/
 * clicked, WhatsApp replied, page visited, form submitted — Phase 3/5),
 * and "consent status = unknown" (the no-explicit-preference-yet state —
 * supporting it would require enumerating every contact with NO
 * consent_status row, which is exactly the full-table-scan-in-disguise
 * this module exists to avoid; "opted_in"/"opted_out" are directly,
 * boundedly queryable and are supported).
 */

const { scoped } = require('./query');

const GROUP_LOGICS = ['AND', 'OR'];
const MAX_TREE_NODES = 60; // guards against a pathological client-built tree, not a real use case

// -------------------------------------------------------------------
// Field registry. `kind: 'native'` fields translate straight into a
// PostgREST predicate fragment against the `contacts` table itself.
// `kind: 'cross'` fields are resolved to a Set<contactId> by a small,
// separately-indexed query (see CROSS_RESOLVERS) before the tree is
// turned into a filter string.
// -------------------------------------------------------------------

const NATIVE_OPERATORS = {
  tags: ['contains_any', 'contains_all', 'not_contains'],
  lead_status: ['eq', 'neq', 'in'],
  lifecycle_stage: ['eq', 'neq', 'in'],
  lead_score: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  email: ['is_set', 'not_set'],
  phone: ['is_set', 'not_set'],
  owner_id: ['eq', 'is_set', 'not_set'],
  company_id: ['eq', 'is_set', 'not_set'],
  created_at: ['after', 'before'],
  display_name: ['contains'],
  global_opt_out: ['eq']
};

const CROSS_OPERATORS = {
  channel_identity: ['has', 'not_has'],
  consent_status: ['eq'], // value: { channel: 'email'|'whatsapp'|'sms', status: 'opted_in'|'opted_out' }
  deal_stage_id: ['eq', 'neq'],
  deal_status: ['eq'], // 'open' | 'won' | 'lost'
  has_open_deal: ['eq'], // boolean
  deal_amount: ['gte', 'lte']
};

const ALL_FIELDS = { ...Object.fromEntries(Object.keys(NATIVE_OPERATORS).map((f) => [f, 'native'])), ...Object.fromEntries(Object.keys(CROSS_OPERATORS).map((f) => [f, 'cross'])) };

function fieldKind(field) {
  return ALL_FIELDS[field];
}

function validOperatorsFor(field) {
  return NATIVE_OPERATORS[field] || CROSS_OPERATORS[field] || [];
}

// -------------------------------------------------------------------
// Pure tree validation — no DB, fully unit-testable. Throws a
// SegmentValidationError with a message safe to show a user (becomes a
// 400), never a generic crash.
// -------------------------------------------------------------------

class SegmentValidationError extends Error {}

function isGroup(node) {
  return node && typeof node === 'object' && Array.isArray(node.children);
}

function validateTree(node, depth = 0, counter = { n: 0 }) {
  counter.n += 1;
  if (counter.n > MAX_TREE_NODES) throw new SegmentValidationError(`A segment's rule tree can have at most ${MAX_TREE_NODES} conditions/groups.`);
  if (depth > 8) throw new SegmentValidationError('Segment rule nesting is too deep (max 8 levels).');
  if (!node || typeof node !== 'object') throw new SegmentValidationError('Invalid segment rule node.');

  if (isGroup(node)) {
    if (!GROUP_LOGICS.includes(node.logic)) throw new SegmentValidationError(`Group logic must be one of ${GROUP_LOGICS.join(', ')}.`);
    if (node.children.length === 0) throw new SegmentValidationError('A group needs at least one condition.');
    for (const child of node.children) validateTree(child, depth + 1, counter);
    return;
  }

  const { field, operator } = node;
  const kind = fieldKind(field);
  if (!kind) throw new SegmentValidationError(`Unknown segment field "${field}".`);
  const allowedOps = validOperatorsFor(field);
  if (!allowedOps.includes(operator)) throw new SegmentValidationError(`Operator "${operator}" is not valid for field "${field}" (expected one of ${allowedOps.join(', ')}).`);
  if (node.value === undefined && !['is_set', 'not_set'].includes(operator)) throw new SegmentValidationError(`Field "${field}" with operator "${operator}" needs a value.`);
}

// -------------------------------------------------------------------
// PostgREST filter-string generation for native fields — pure, no DB.
// -------------------------------------------------------------------

function pgArrayLiteral(values) {
  return `{${values.map((v) => String(v).replace(/[{}",]/g, '')).join(',')}}`;
}

function pgInList(values) {
  return `(${values.map((v) => String(v).replace(/[(),]/g, '')).join(',')})`;
}

function escapeForFilter(value) {
  // PostgREST's filter-string grammar uses commas/parens as structural
  // characters — a value containing them must be double-quoted.
  const s = String(value);
  return /[,()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function nativeConditionToFragment(node) {
  const { field, operator, value } = node;
  switch (field) {
    case 'tags':
      if (operator === 'contains_any') return `tags.ov.${pgArrayLiteral(value)}`;
      if (operator === 'contains_all') return `tags.cs.${pgArrayLiteral(value)}`;
      return `tags.not.ov.${pgArrayLiteral(value)}`; // not_contains
    case 'lead_status':
    case 'lifecycle_stage':
      if (operator === 'eq') return `${field}.eq.${escapeForFilter(value)}`;
      if (operator === 'neq') return `${field}.neq.${escapeForFilter(value)}`;
      return `${field}.in.${pgInList(value)}`; // in
    case 'lead_score':
      return `lead_score.${operator}.${Number(value)}`;
    case 'email':
    case 'phone':
      return operator === 'is_set' ? `${field}.not.is.null` : `${field}.is.null`;
    case 'owner_id':
    case 'company_id':
      if (operator === 'eq') return `${field}.eq.${escapeForFilter(value)}`;
      return operator === 'is_set' ? `${field}.not.is.null` : `${field}.is.null`;
    case 'created_at':
      return operator === 'after' ? `created_at.gte.${escapeForFilter(value)}` : `created_at.lt.${escapeForFilter(value)}`;
    case 'display_name':
      return `display_name.ilike.*${escapeForFilter(value).replace(/[%*]/g, '')}*`;
    case 'global_opt_out':
      return value ? 'global_opt_out_at.not.is.null' : 'global_opt_out_at.is.null';
    default:
      throw new SegmentValidationError(`Unhandled native field "${field}".`);
  }
}

// -------------------------------------------------------------------
// Cross-table resolution — each resolver runs ONE small, indexed query
// (never scoped to "all contacts") and returns a Set<contactId>.
// -------------------------------------------------------------------

async function resolveChannelIdentity(client, tenantId, value) {
  const { data, error } = await scoped(client, tenantId, 'contact_identities').select('contact_id').eq('platform', value);
  if (error) throw error;
  return new Set((data || []).map((r) => r.contact_id));
}

async function resolveConsentStatus(client, tenantId, value) {
  const { channel, status } = value || {};
  if (!channel || !status) throw new SegmentValidationError('consent_status needs { channel, status }.');
  const { data, error } = await scoped(client, tenantId, 'contact_consents').select('contact_id').eq('channel', channel).eq('status', status);
  if (error) throw error;
  return new Set((data || []).map((r) => r.contact_id));
}

async function resolveDealContactIds(client, tenantId, dealFilter) {
  let query = scoped(client, tenantId, 'deals').select('id');
  query = dealFilter(query);
  const { data: deals, error } = await query;
  if (error) throw error;
  const dealIds = (deals || []).map((d) => d.id);
  if (dealIds.length === 0) return new Set();
  const { data: links, error: linkErr } = await scoped(client, tenantId, 'deal_contacts').select('contact_id').in('deal_id', dealIds);
  if (linkErr) throw linkErr;
  return new Set((links || []).map((r) => r.contact_id));
}

const CROSS_RESOLVERS = {
  channel_identity: (client, tenantId, node) => resolveChannelIdentity(client, tenantId, node.value),
  consent_status: (client, tenantId, node) => resolveConsentStatus(client, tenantId, node.value),
  deal_stage_id: (client, tenantId, node) => resolveDealContactIds(client, tenantId, (q) => (node.operator === 'eq' ? q.eq('stage_id', node.value) : q.neq('stage_id', node.value))),
  deal_status: (client, tenantId, node) => resolveDealContactIds(client, tenantId, (q) => q.eq('status', node.value)),
  // Always resolves the POSITIVE "has at least one open deal" set,
  // regardless of node.value — isNegatedCross() below is what turns
  // `has_open_deal: false` into a NOT IN against this same set, rather
  // than this resolver needing two different queries.
  has_open_deal: (client, tenantId) => resolveDealContactIds(client, tenantId, (q) => q.eq('status', 'open')),
  deal_amount: (client, tenantId, node) => resolveDealContactIds(client, tenantId, (q) => (node.operator === 'gte' ? q.gte('amount', node.value) : q.lte('amount', node.value)))
};

// Fields/operators whose cross-table set should be negated (NOT IN)
// rather than used directly (IN) when folded into the final query.
function isNegatedCross(node) {
  if (node.field === 'channel_identity' && node.operator === 'not_has') return true;
  if (node.field === 'has_open_deal' && node.value === false) return true;
  return false;
}

/** Walks the tree collecting every cross-table leaf so they can all be resolved in parallel, one query per distinct leaf. */
function collectCrossLeaves(node, out = []) {
  if (isGroup(node)) {
    for (const child of node.children) collectCrossLeaves(child, out);
    return out;
  }
  if (fieldKind(node.field) === 'cross') out.push(node);
  return out;
}

const EMPTY_SET_SENTINEL = 'id.eq.00000000-0000-0000-0000-000000000000'; // a condition matching no real contact — used when a cross-table resolution is empty, rather than emitting invalid empty-list SQL

function crossNodeToFragment(node, resolvedSets) {
  const ids = [...resolvedSets.get(node)];
  const negated = isNegatedCross(node);
  if (ids.length === 0) return negated ? 'id.not.is.null' : EMPTY_SET_SENTINEL; // negated+empty = "everyone" (not.in empty list); positive+empty = "no one"
  const list = pgInList(ids);
  return negated ? `id.not.in.${list}` : `id.in.${list}`;
}

function nodeToFragment(node, resolvedSets) {
  if (isGroup(node)) {
    const inner = node.children.map((c) => nodeToFragment(c, resolvedSets)).join(',');
    return node.logic === 'AND' ? `and(${inner})` : `or(${inner})`;
  }
  return fieldKind(node.field) === 'cross' ? crossNodeToFragment(node, resolvedSets) : nativeConditionToFragment(node);
}

/**
 * Compiles a v2 filter_json into a single PostgREST filter string
 * (suitable for `.or(filterString)` on a `contacts` query — see this
 * file's header for why `.or()` is used even for a top-level AND group).
 * Resolves every cross-table leaf first (in parallel), then builds the
 * string purely in memory.
 */
async function compileFilterTree(client, tenantId, root) {
  validateTree(root);
  const crossLeaves = collectCrossLeaves(root);
  const resolvedSets = new Map();
  await Promise.all(crossLeaves.map(async (leaf) => {
    const resolver = CROSS_RESOLVERS[leaf.field];
    if (!resolver) throw new SegmentValidationError(`No resolver for cross-table field "${leaf.field}".`);
    resolvedSets.set(leaf, await resolver(client, tenantId, leaf));
  }));
  return nodeToFragment(root, resolvedSets);
}

function isV2Filter(filterJson) {
  return !!(filterJson && filterJson.version === 2 && filterJson.root);
}

module.exports = {
  SegmentValidationError,
  validateTree,
  isV2Filter,
  compileFilterTree,
  ALL_FIELDS,
  NATIVE_OPERATORS,
  CROSS_OPERATORS,
  // exported for unit tests only — pure, no DB
  nativeConditionToFragment,
  pgArrayLiteral,
  pgInList
};
