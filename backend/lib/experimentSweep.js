/**
 * AI Content Experiment Engine — decision sweep (migration 038). Same
 * restart-safe interval-sweep shape as lib/email/abWinnerSweep.js: every
 * tick re-reads `running` experiments from the DB rather than a
 * per-experiment setTimeout a restart would lose, and an experiment
 * only gets decided once (never re-decided).
 *
 * Unlike abWinnerSweep.js's pickWinner() (highest rate wins, no
 * significance or minimum-sample check at all), every decision here
 * goes through lib/experimentStats.js's evaluateExperiment() — a real
 * two-proportion z-test that can and does refuse to decide. This is a
 * deliberately higher bar than the existing Marketing Hub pattern, not
 * a smaller copy of it; see docs/SOCIAL_HUB_GAPS_AND_ADDITIONS.md.
 *
 * "Normalizing for audience size" = using each variant's connected
 * account's follower count (analytics_snapshots, nearest row at or
 * before the post's scheduled_at) as the statistical denominator rather
 * than a raw engagement count — see experimentStats.js's header.
 * "Normalizing for posting conditions" = evaluating each variant
 * min_observation_hours after ITS OWN publish time (approximated here
 * by scheduled_at, since BullMQ fires jobs at that time and there's no
 * separate published_at column), not a shared calendar date — so two
 * variants posted a week apart are each judged on an equal window of
 * their own, not an unequal one favoring whichever posted first.
 */
const { getSocialClient } = require('../social/db');
const { recordAudit } = require('./audit');
const { evaluateExperiment } = require('./experimentStats');
const { FOLLOWER_METRIC } = require('./socialMetrics');
const ADAPTERS = require('../social/adapters');

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // a decision an hour late doesn't matter; every 15 min is plenty, and far cheaper than the 5-min email sweep since this does more per-tick DB work

let intervalHandle = null;

/** Sum of the latest likes/comments/shares post_analytics rows for one (scheduled_post_id, social_account_id) pair — "engagement," deliberately not including `views`, which measures reach/attention, not an engagement action. */
function latestEngagementSum(rows) {
  const latestByMetric = {};
  for (const row of rows) {
    if (['likes', 'comments', 'shares'].includes(row.metric)) latestByMetric[row.metric] = row.value; // rows are ordered oldest-first by the caller's query, so later overwrites win
  }
  return Object.values(latestByMetric).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/**
 * Gathers one variant's { engagements, audience } for evaluateExperiment().
 * Returns null (not a 0) when either figure genuinely isn't available —
 * distinct from "available but below the minimum," so the caller can
 * tell "we don't have data for this platform" apart from "we have data
 * and it's small."
 */
async function gatherVariantStats(client, variant, post) {
  const platform = variant.platform;
  const followerMetric = FOLLOWER_METRIC[platform];
  if (!followerMetric) return null; // this platform has no follower-count metric collected at all (see socialMetrics.js)
  if (!ADAPTERS[platform] || typeof ADAPTERS[platform].fetchPostAnalytics !== 'function') return null; // no per-post data for this platform — see that adapter's own header

  const [{ data: followerRow }, { data: engagementRows }] = await Promise.all([
    client.from('analytics_snapshots').select('value').eq('social_account_id', variant.social_account_id)
      .eq('metric', followerMetric).lte('captured_date', post.scheduled_at.slice(0, 10))
      .order('captured_date', { ascending: false }).limit(1).maybeSingle(),
    client.from('post_analytics').select('metric, value').eq('scheduled_post_id', post.id)
      .eq('social_account_id', variant.social_account_id).order('captured_date', { ascending: true })
  ]);

  if (!followerRow) return null; // no follower-count snapshot exists yet for this account as of the post's publish date
  const audience = Number(followerRow.value) || 0;
  const engagements = latestEngagementSum(engagementRows || []);
  return { audience, engagements };
}

async function evaluateOneExperiment(client, experiment) {
  const { data: variants, error } = await client.from('content_experiment_variants')
    .select('id, variant_key, scheduled_post_id, social_account_id, scheduled_posts(id, status, scheduled_at), social_accounts(platform)')
    .eq('experiment_id', experiment.id);
  if (error || !variants || variants.length !== 2) {
    console.error(`[experimentSweep] experiment ${experiment.id} does not have exactly 2 variants — skipping.`);
    return;
  }

  // Both variants must actually be published, and each must have had at
  // least min_observation_hours since ITS OWN scheduled_at, before this
  // experiment is even eligible to be looked at this tick.
  const now = Date.now();
  for (const v of variants) {
    if (v.scheduled_posts.status !== 'published') return; // one hasn't published yet — try again next tick
    const elapsedHours = (now - new Date(v.scheduled_posts.scheduled_at).getTime()) / 3600000;
    if (elapsedHours < experiment.min_observation_hours) return; // too soon for this variant specifically
  }

  const stats = [];
  for (const v of variants) {
    const platform = v.social_accounts.platform;
    const gathered = await gatherVariantStats(client, { ...v, platform }, v.scheduled_posts);
    if (!gathered) {
      await decide(client, experiment, {
        decision: 'insufficient_data',
        note: `No analytics data is available for variant ${v.variant_key}'s platform (${platform}) — see that platform adapter's fetchPostAnalytics for why. This experiment can't be evaluated.`
      });
      return;
    }
    stats.push({ key: v.variant_key, engagements: gathered.engagements, audience: gathered.audience, variantId: v.id });
  }

  const result = evaluateExperiment(stats, { minSampleSize: experiment.min_sample_size, confidenceLevel: experiment.confidence_level });
  const winnerVariant = result.winnerKey ? stats.find((s) => s.key === result.winnerKey) : null;
  await decide(client, experiment, { ...result, winnerVariantId: winnerVariant ? winnerVariant.variantId : null });
}

async function decide(client, experiment, result) {
  const { error } = await client.from('content_experiments').update({
    status: result.decision,
    winner_variant_id: result.winnerVariantId || null,
    z_score: typeof result.z === 'number' ? result.z : null,
    p_value: typeof result.pValue === 'number' ? result.pValue : null,
    decision_note: result.note,
    decided_at: new Date().toISOString()
  }).eq('id', experiment.id);
  if (error) { console.error(`[experimentSweep] could not record decision for experiment ${experiment.id}:`, error.message); return; }

  await recordAudit(client, {
    tenantId: experiment.tenant_id, actorUserId: null, action: 'social.experiment.decided',
    targetType: 'content_experiment', targetId: experiment.id,
    metadata: { decision: result.decision, winnerVariantId: result.winnerVariantId || null, pValue: result.pValue ?? null }
  });
  console.log(`[experimentSweep] experiment ${experiment.id}: ${result.decision}${result.winnerKey ? ` (variant "${result.winnerKey}" wins)` : ''}.`);
}

async function sweep() {
  const client = getSocialClient();
  if (!client) return;

  const { data: experiments, error } = await client.from('content_experiments').select('*').eq('status', 'running').limit(100);
  if (error) { console.error('[experimentSweep] could not query running experiments:', error.message); return; }

  for (const experiment of experiments || []) {
    await evaluateOneExperiment(client, experiment).catch((err) => console.error(`[experimentSweep] experiment ${experiment.id} failed to evaluate:`, err.message));
  }
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => { sweep().catch((err) => console.error('[experimentSweep] sweep failed:', err.message)); }, SWEEP_INTERVAL_MS);
  sweep().catch((err) => console.error('[experimentSweep] initial sweep failed:', err.message));
  console.log('[experimentSweep] Content experiment decision sweep started (15 min interval).');
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, sweep, latestEngagementSum, gatherVariantStats };
