/**
 * Marketing attribution (Phase 6): which marketing touchpoints led to a
 * won deal's revenue, and how much credit each gets under first-touch,
 * last-touch, or linear models. Computed live from the real event
 * tables Phases 3-5 already write — no second "touchpoints" table to
 * keep in sync and risk drifting from the events themselves, same
 * reasoning as routes/journeys.js's analytics endpoint.
 *
 * Four channels are tracked (email opens/clicks, form submissions,
 * journey completions, WhatsApp delivery) — every channel this app
 * actually has per-contact, timestamped records for. Social Hub posts
 * are broadcast, not addressed to an individual contact, so a like/
 * comment can't be attributed to a specific deal's buyer journey; see
 * docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 6 scope decision.
 *
 * Currency-grouped, never summed across currencies — the same rule
 * Sales Hub's own dashboard/forecast rollups already follow.
 */

const ATTRIBUTION_MODELS = ['first_touch', 'last_touch', 'linear'];
const CHANNEL_LABELS = { email: 'Email', form: 'Form', journey: 'Journey', whatsapp: 'WhatsApp' };

/**
 * Batch-fetches every touchpoint for a SET of contacts in exactly 4
 * queries total (one per channel), regardless of how many contacts or
 * deals are being attributed — the same no-N+1 discipline
 * lib/segmentCompiler.js's header calls out. Returns a Map<contactId,
 * touchpoint[]>, each touchpoint { channel, sourceId, sourceName, occurredAt }.
 */
async function getTouchpointsForContacts(client, tenantId, contactIds) {
  const byContact = new Map(contactIds.map((id) => [id, []]));
  if (contactIds.length === 0) return byContact;

  const push = (contactId, touchpoint) => {
    const list = byContact.get(contactId);
    if (list) list.push(touchpoint);
  };

  const [emailRows, formRows, journeyRows, whatsappRows] = await Promise.all([
    client.from('email_campaign_recipients').select('contact_id, opened_at, clicked_at, email_campaigns(name)').eq('tenant_id', tenantId).in('contact_id', contactIds),
    client.from('lead_form_submissions').select('contact_id, created_at, lead_forms(name)').eq('tenant_id', tenantId).in('contact_id', contactIds).is('spam_flagged', false),
    client.from('workflow_enrollments').select('contact_id, completed_at, workflow_definitions(name)').eq('tenant_id', tenantId).in('contact_id', contactIds).in('status', ['completed', 'goal_met']),
    client.from('whatsapp_campaign_recipients').select('contact_id, delivered_at, read_at, whatsapp_campaigns(name)').eq('tenant_id', tenantId).in('contact_id', contactIds)
  ]);

  for (const row of emailRows.data || []) {
    const name = row.email_campaigns?.name || 'Email campaign';
    if (row.opened_at) push(row.contact_id, { channel: 'email', sourceName: `${name} (opened)`, occurredAt: row.opened_at });
    if (row.clicked_at) push(row.contact_id, { channel: 'email', sourceName: `${name} (clicked)`, occurredAt: row.clicked_at });
  }
  for (const row of formRows.data || []) {
    push(row.contact_id, { channel: 'form', sourceName: row.lead_forms?.name || 'Lead form', occurredAt: row.created_at });
  }
  for (const row of journeyRows.data || []) {
    if (row.completed_at) push(row.contact_id, { channel: 'journey', sourceName: row.workflow_definitions?.name || 'Journey', occurredAt: row.completed_at });
  }
  for (const row of whatsappRows.data || []) {
    const name = row.whatsapp_campaigns?.name || 'WhatsApp campaign';
    const at = row.read_at || row.delivered_at;
    if (at) push(row.contact_id, { channel: 'whatsapp', sourceName: name, occurredAt: at });
  }

  for (const list of byContact.values()) list.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  return byContact;
}

async function getContactTouchpoints(client, tenantId, contactId) {
  const map = await getTouchpointsForContacts(client, tenantId, [contactId]);
  return map.get(contactId) || [];
}

/** Splits `amount` across `touchpoints` (already sorted ascending, already filtered to before the deal closed) per the given model. Returns [] for no touchpoints — the caller decides how to represent unattributed revenue. */
function distributeCredit(touchpoints, amount, model) {
  if (touchpoints.length === 0) return [];
  if (model === 'first_touch') return [{ ...touchpoints[0], creditedAmount: amount }];
  if (model === 'last_touch') return [{ ...touchpoints[touchpoints.length - 1], creditedAmount: amount }];
  // linear: split evenly; the last touchpoint absorbs any rounding
  // remainder so the credited amounts always sum exactly to `amount`
  // (never short or over by a cent from floating-point division).
  const share = Math.round((amount / touchpoints.length) * 100) / 100;
  const credited = touchpoints.map((tp) => ({ ...tp, creditedAmount: share }));
  const remainder = Math.round((amount - share * touchpoints.length) * 100) / 100;
  credited[credited.length - 1].creditedAmount = Math.round((credited[credited.length - 1].creditedAmount + remainder) * 100) / 100;
  return credited;
}

/** Attribution for ONE deal — touchpoints strictly before it closed, so nothing that happened after the sale (a post-purchase onboarding email, say) can wrongly claim credit for having caused it. */
async function computeDealAttribution(client, tenantId, deal, model) {
  if (!deal.contact_id) return { touchpoints: [], unattributed: true };
  const all = await getContactTouchpoints(client, tenantId, deal.contact_id);
  const cutoff = deal.closed_at ? new Date(deal.closed_at) : new Date();
  const eligible = all.filter((tp) => new Date(tp.occurredAt) <= cutoff);
  if (eligible.length === 0) return { touchpoints: [], unattributed: true };
  return { touchpoints: distributeCredit(eligible, Number(deal.amount), model), unattributed: false };
}

/**
 * The tenant-wide attribution report: every won deal with a known
 * contact and a closed_at in range, attributed under one model, rolled
 * up by channel + source + CURRENCY (never summed across currencies —
 * same rule Sales Hub's own forecast/dashboard rollups follow, since a
 * ₹100 deal and a $100 deal are not the same 100 anything).
 */
async function getAttributionReport(client, tenantId, { model = 'linear', dateFrom, dateTo } = {}) {
  if (!ATTRIBUTION_MODELS.includes(model)) throw new Error(`Unknown attribution model "${model}".`);

  let query = client.from('deals').select('id, contact_id, amount, currency, closed_at, name').eq('tenant_id', tenantId).eq('status', 'won').not('contact_id', 'is', null);
  if (dateFrom) query = query.gte('closed_at', dateFrom);
  if (dateTo) query = query.lte('closed_at', dateTo);
  const { data: deals, error } = await query;
  if (error) throw error;

  const contactIds = [...new Set((deals || []).map((d) => d.contact_id))];
  const touchpointsByContact = await getTouchpointsForContacts(client, tenantId, contactIds);

  const rollup = new Map(); // key: `${channel}|${sourceName}|${currency}` -> { channel, sourceName, currency, totalCredited, dealCount }
  let unattributedByCurrency = new Map();
  let attributedDealCount = 0;

  for (const deal of deals || []) {
    const all = touchpointsByContact.get(deal.contact_id) || [];
    const cutoff = deal.closed_at ? new Date(deal.closed_at) : new Date();
    const eligible = all.filter((tp) => new Date(tp.occurredAt) <= cutoff);
    if (eligible.length === 0) {
      unattributedByCurrency.set(deal.currency, (unattributedByCurrency.get(deal.currency) || 0) + Number(deal.amount));
      continue;
    }
    attributedDealCount += 1;
    const credited = distributeCredit(eligible, Number(deal.amount), model);
    for (const tp of credited) {
      const key = `${tp.channel}|${tp.sourceName}|${deal.currency}`;
      const entry = rollup.get(key) || { channel: tp.channel, sourceName: tp.sourceName, currency: deal.currency, totalCredited: 0, dealCount: 0 };
      entry.totalCredited = Math.round((entry.totalCredited + tp.creditedAmount) * 100) / 100;
      entry.dealCount += 1;
      rollup.set(key, entry);
    }
  }

  return {
    model,
    dealCount: (deals || []).length,
    attributedDealCount,
    unattributedDealCount: (deals || []).length - attributedDealCount,
    unattributedRevenue: Array.from(unattributedByCurrency, ([currency, total]) => ({ currency, total: Math.round(total * 100) / 100 })),
    byChannel: Array.from(rollup.values()).sort((a, b) => b.totalCredited - a.totalCredited)
  };
}

module.exports = { ATTRIBUTION_MODELS, CHANNEL_LABELS, getContactTouchpoints, getTouchpointsForContacts, computeDealAttribution, distributeCredit, getAttributionReport };
