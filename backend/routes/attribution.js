/**
 * Marketing Hub Phase 6: scoring settings + attribution reporting.
 * Lead scoring RULES themselves stay on Sales Hub's existing
 * /sales/lead-scoring-rules surface (routes/sales.js) — this file only
 * adds the one new tenant-level setting Phase 6 introduces (the MQL
 * auto-promotion threshold, lib/leadScoring.js's maybePromoteToMql) and
 * the attribution report (lib/attribution.js), both gated behind
 * Marketing Hub since that's the natural home for "where did this
 * revenue actually come from."
 */

const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { requireHub } = require('../middleware/hubs');
const { asyncHandler } = require('../lib/asyncHandler');
const { getAttributionReport, computeDealAttribution, ATTRIBUTION_MODELS } = require('../lib/attribution');

const router = express.Router();

function sumBy(rows, column) {
  return (rows || []).reduce((total, row) => total + (row[column] || 0), 0);
}

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

router.get('/marketing/scoring-settings', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data } = await client.from('tenants').select('marketing_mql_threshold').eq('id', req.tenantId).maybeSingle();
  res.json({ mqlThreshold: data?.marketing_mql_threshold ?? 50 });
}));

router.patch('/marketing/scoring-settings', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const threshold = Number(req.body.mqlThreshold);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100000) return res.status(400).json({ error: 'mqlThreshold must be a whole number between 0 and 100000.' });
  const { data, error } = await client.from('tenants').update({ marketing_mql_threshold: threshold }).eq('id', req.tenantId).select('marketing_mql_threshold').single();
  if (error) throw error;
  res.json({ mqlThreshold: data.marketing_mql_threshold });
}));

router.get('/marketing/attribution', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const model = req.query.model || 'linear';
  if (!ATTRIBUTION_MODELS.includes(model)) return res.status(400).json({ error: `model must be one of: ${ATTRIBUTION_MODELS.join(', ')}.` });
  const report = await getAttributionReport(client, req.tenantId, { model, dateFrom: req.query.dateFrom || undefined, dateTo: req.query.dateTo || undefined });
  res.json(report);
}));

router.get('/marketing/attribution/deals/:dealId', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const model = req.query.model || 'linear';
  if (!ATTRIBUTION_MODELS.includes(model)) return res.status(400).json({ error: `model must be one of: ${ATTRIBUTION_MODELS.join(', ')}.` });
  const { data: deal } = await client.from('deals').select('id, contact_id, amount, currency, closed_at, status, name').eq('tenant_id', req.tenantId).eq('id', req.params.dealId).maybeSingle();
  if (!deal) return res.status(404).json({ error: 'Deal not found.' });
  const attribution = await computeDealAttribution(client, req.tenantId, deal, model);
  res.json({ deal: { id: deal.id, name: deal.name, amount: deal.amount, currency: deal.currency }, model, ...attribution });
}));

/**
 * Marketing Hub Phase 8: the cross-channel analytics overview — "beyond
 * one campaign rollup" (task brief's Module G) without building a
 * second, parallel reporting engine. Every number here is a straight
 * sum of columns each channel's own send pipeline already maintains
 * (email_campaigns.sent_count, workflow_enrollments rows, etc.) — no new
 * event tracking, no denormalized rollup that could drift from the
 * per-channel numbers a tenant already sees on each channel's own tab.
 * A full custom report builder/saved reports/digests/heatmaps (the rest
 * of Module G) is real, separable future work — see
 * docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 8 scope decision.
 */
router.get('/marketing/overview', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const [emailCampaigns, waCampaigns, smsCampaigns, formSubs, journeys, enrollments] = await Promise.all([
    scoped(client, req.tenantId, 'email_campaigns').select('sent_count, opened_count, clicked_count'),
    scoped(client, req.tenantId, 'whatsapp_campaigns').select('sent_count, delivered_count, read_count'),
    scoped(client, req.tenantId, 'sms_campaigns').select('sent_count, failed_count'),
    scoped(client, req.tenantId, 'lead_form_submissions').select('id', { count: 'exact', head: true }).eq('spam_flagged', false),
    scoped(client, req.tenantId, 'workflow_definitions').select('id', { count: 'exact', head: true }).eq('is_active', true),
    scoped(client, req.tenantId, 'workflow_enrollments').select('status')
  ]);

  const enrollmentCounts = { active: 0, completed: 0, goal_met: 0 };
  for (const e of enrollments.data || []) if (enrollmentCounts[e.status] !== undefined) enrollmentCounts[e.status] += 1;

  const attribution = await getAttributionReport(client, req.tenantId, { model: 'linear' });

  res.json({
    email: { campaigns: (emailCampaigns.data || []).length, sent: sumBy(emailCampaigns.data, 'sent_count'), opened: sumBy(emailCampaigns.data, 'opened_count'), clicked: sumBy(emailCampaigns.data, 'clicked_count') },
    whatsapp: { campaigns: (waCampaigns.data || []).length, sent: sumBy(waCampaigns.data, 'sent_count'), delivered: sumBy(waCampaigns.data, 'delivered_count'), read: sumBy(waCampaigns.data, 'read_count') },
    sms: { campaigns: (smsCampaigns.data || []).length, sent: sumBy(smsCampaigns.data, 'sent_count'), failed: sumBy(smsCampaigns.data, 'failed_count') },
    forms: { submissions: formSubs.count || 0 },
    journeys: { active: journeys.count || 0, activeEnrollments: enrollmentCounts.active, completedEnrollments: enrollmentCounts.completed + enrollmentCounts.goal_met },
    revenue: { wonDeals: attribution.dealCount, attributedDeals: attribution.attributedDealCount, byChannel: attribution.byChannel, unattributed: attribution.unattributedRevenue }
  });
}));

/**
 * The Marketing Hub half of Module H's "audit trail" — the data has
 * existed since Phase 1 (every phase's routes call recordAudit()); the
 * only thing missing was a place to read it back filtered to this hub's
 * own actions, same pattern as routes/sales.js's existing
 * GET /sales/audit-log (filtered to 'sales.%' instead of 'marketing.%').
 */
router.get('/marketing/audit-log', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const from = (page - 1) * pageSize;
  const { data, error, count } = await scoped(client, req.tenantId, 'audit_log')
    .select('*', { count: 'exact' }).ilike('action', 'marketing.%').order('created_at', { ascending: false }).range(from, from + pageSize - 1);
  if (error) throw error;
  res.json({ entries: data, page, pageSize, total: count });
}));

module.exports = router;
