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
const { requireRole } = require('../middleware/tenant');
const { requireHub } = require('../middleware/hubs');
const { asyncHandler } = require('../lib/asyncHandler');
const { getAttributionReport, computeDealAttribution, ATTRIBUTION_MODELS } = require('../lib/attribution');

const router = express.Router();

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

module.exports = router;
