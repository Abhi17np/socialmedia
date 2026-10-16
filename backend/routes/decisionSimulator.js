/**
 * Marketing Decision Simulator (migration 042). A single, real, owned
 * lever — "what if I post N× as often on this connected account?" —
 * projected from the tenant's OWN historical data, never a fabricated
 * baseline (see lib/decisionSimulator.js's header for why this is
 * scoped to posting frequency and not a general ad-budget allocator:
 * this app tracks no ad spend at all). The baseline is always computed
 * fresh, server-side, from real rows — there is no way for a caller to
 * supply their own baseline numbers.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { createDecisionScenarioSchema } = require('../lib/schemas');
const { computeAccountEngagementRate, latestFollowerCount, FOLLOWER_METRIC } = require('../lib/socialMetrics');
const { computeFollowerGrowthStats, projectScenario } = require('../lib/decisionSimulator');

const router = express.Router();
const DEFAULT_LOOKBACK_WEEKS = 8;

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured.' });
    return null;
  }
  return client;
}

/**
 * Real posting frequency, engagement rate, and follower-growth history
 * for one connected account over the last `lookbackWeeks` — the ONLY
 * input lib/decisionSimulator.js's projectScenario() ever sees. Weekly
 * follower-growth deltas come from the latest analytics_snapshots row
 * per calendar week (oldest to newest); a platform with no follower
 * metric at all (see FOLLOWER_METRIC) honestly reports 0 weeks of data
 * rather than a fabricated flat-zero growth rate.
 */
async function gatherBaseline(client, tenantId, account, lookbackWeeks) {
  const lookbackMs = lookbackWeeks * 7 * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(Date.now() - lookbackMs).toISOString();
  const followerMetricAvailable = Boolean(FOLLOWER_METRIC[account.platform]);

  const [{ data: posts }, engagement, followers] = await Promise.all([
    scoped(client, tenantId, 'scheduled_posts').select('id').eq('status', 'published').gte('scheduled_at', sinceIso).contains('target_account_ids', [account.id]),
    computeAccountEngagementRate(client, tenantId, account.id, account.platform, { windowDays: lookbackWeeks * 7 }),
    latestFollowerCount(client, account.id, account.platform)
  ]);
  const postsPerWeek = (posts || []).length / lookbackWeeks;

  let weekBuckets = new Map();
  if (followerMetricAvailable) {
    const { data: snapshotRows } = await client.from('analytics_snapshots').select('value, captured_date')
      .eq('social_account_id', account.id).eq('metric', FOLLOWER_METRIC[account.platform])
      .gte('captured_date', sinceIso.slice(0, 10)).order('captured_date', { ascending: true });
    const now = Date.now();
    for (const row of snapshotRows || []) {
      const daysAgo = Math.floor((now - new Date(row.captured_date).getTime()) / (24 * 60 * 60 * 1000));
      const weekIndex = Math.floor(daysAgo / 7); // 0 = current week; ascending row order means a later overwrite within the same week keeps the most recent value
      weekBuckets.set(weekIndex, Number(row.value) || 0);
    }
  }
  const chronological = [...weekBuckets.keys()].sort((a, b) => b - a).map((idx) => weekBuckets.get(idx)); // oldest (largest index) to newest
  const deltas = chronological.slice(1).map((v, i) => v - chronological[i]);
  const growthStats = computeFollowerGrowthStats(deltas);

  return {
    postsPerWeek, engagementRate: engagement.rate, followers, followerMetricAvailable,
    followerGrowthPerWeek: { mean: growthStats.mean, stddev: growthStats.stddev, weeksOfData: deltas.length }
  };
}

router.post('/social/decision-simulator/scenarios', requireRole('member'), validate(createDecisionScenarioSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { socialAccountId, frequencyMultiplier, lookbackWeeks = DEFAULT_LOOKBACK_WEEKS } = req.body;

  const { data: account, error: accountErr } = await scoped(client, req.tenantId, 'social_accounts').select('id, platform').eq('id', socialAccountId).maybeSingle();
  if (accountErr) return res.status(500).json({ error: accountErr.message });
  if (!account) return res.status(404).json({ error: 'Connected account not found.' });

  const baseline = await gatherBaseline(client, req.tenantId, account, lookbackWeeks);
  const projection = projectScenario(baseline, frequencyMultiplier);

  const { data, error } = await client.from('decision_scenarios').insert({
    tenant_id: req.tenantId, social_account_id: socialAccountId, created_by: req.userId,
    frequency_multiplier: frequencyMultiplier, lookback_weeks: lookbackWeeks, baseline, projection
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({ scenario: data });
}));

router.get('/social/decision-simulator/scenarios', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'decision_scenarios').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ scenarios: data });
}));

router.get('/social/decision-simulator/scenarios/:id', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'decision_scenarios').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Scenario not found.' });
  res.json({ scenario: data });
}));

router.delete('/social/decision-simulator/scenarios/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: existing, error: fetchError } = await scoped(client, req.tenantId, 'decision_scenarios').select('id').eq('id', req.params.id).maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Scenario not found.' });

  const { error } = await scoped(client, req.tenantId, 'decision_scenarios').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
}));

module.exports = router;
