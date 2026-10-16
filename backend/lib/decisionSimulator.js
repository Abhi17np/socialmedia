/**
 * Pure math for the Marketing Decision Simulator (routes/decisionSimulator.js).
 * No DB, no network, no AI — every number here is a deterministic
 * function of a real baseline computed from the tenant's own historical
 * data (see that route for how the baseline is gathered). AI is never
 * involved in computing the projection itself; it's offered as a
 * strictly-optional, separately-metered narrative on top of these
 * already-final numbers (lib/ai.js's explainScenario) — same "AI never
 * decides the number, only comments on it" discipline this app's rule 3
 * (ground in tenant data, show evidence, state uncertainty) calls for.
 *
 * Scoped to exactly ONE lever — posting frequency on one connected
 * account — not a general ad-budget/multi-channel allocator: this app
 * doesn't track ad spend at all (no connected ad platform), so any
 * "reallocate budget across channels" simulator would have to invent
 * numbers it doesn't have. Posting frequency is the one real, owned
 * lever with real historical data behind it. A named scope cut, not an
 * oversight — see docs/SOCIAL_HUB_GAPS_AND_ADDITIONS.md.
 */
const { computeBaseline } = require('./crisisDetection');

const MIN_MULTIPLIER = 0.1;
const MAX_MULTIPLIER = 5; // a simple linear model stops being credible far outside the observed range — see projectScenario()'s own note
const MIN_WEEKS_FOR_CONFIDENT_GROWTH = 4;

/** Mean + population stddev of a tenant's own real week-over-week follower-count deltas — just computeBaseline() under a name that reads correctly for "growth," not "counts." */
function computeFollowerGrowthStats(weeklyDeltas) {
  return computeBaseline(weeklyDeltas);
}

/**
 * Projects ONE scenario from a real baseline. `frequencyMultiplier` is
 * clamped to [MIN_MULTIPLIER, MAX_MULTIPLIER] — a linear extrapolation
 * is a reasonable approximation near the tenant's own observed posting
 * range, not ten times outside it; clamping (and reporting the clamped
 * value back) is the honest alternative to silently producing a
 * confident-looking number a simple model can't actually support.
 *
 * Engagement rate is projected UNCHANGED — this model deliberately does
 * NOT assume posting more automatically improves or dilutes per-post
 * engagement rate (both happen in practice, and this app has no basis
 * to say which for a given tenant); only posting volume and the
 * volume-scaled follower-growth estimate change. This assumption is
 * returned in the result so the caller/UI can state it plainly rather
 * than bury it.
 *
 * Follower growth is scaled by the SAME multiplier as a simple linear
 * assumption (growth scales proportionally with posting activity) —
 * explicitly a simplifying assumption, not a proven causal model. The
 * uncertainty band is the REAL historical week-to-week stddev
 * (unscaled) around that scaled estimate, a 95% interval
 * (mean ± 1.96*stddev) — never a fabricated error margin.
 *
 * confidence is 'low' whenever baseline.followerGrowthPerWeek.weeksOfData
 * is below MIN_WEEKS_FOR_CONFIDENT_GROWTH — the same "refuse/flag below
 * a floor" principle as lib/experimentStats.js's minimum sample size and
 * lib/crisisDetection.js's minCount, applied here to how much history
 * backs the growth estimate specifically (engagement rate and posts/week
 * need no such floor — they're observed facts about the baseline
 * itself, not projected into the future).
 */
function projectScenario(baseline, frequencyMultiplier) {
  const clampedMultiplier = Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, frequencyMultiplier));
  const growth = baseline.followerGrowthPerWeek;
  const projectedGrowthMean = growth.mean * clampedMultiplier;
  const margin = 1.96 * growth.stddev;

  return {
    appliedMultiplier: clampedMultiplier,
    wasClamped: clampedMultiplier !== frequencyMultiplier,
    postsPerWeek: baseline.postsPerWeek * clampedMultiplier,
    engagementRate: baseline.engagementRate, // unchanged — see header
    followerGrowthPerWeek: { mean: projectedGrowthMean, low: projectedGrowthMean - margin, high: projectedGrowthMean + margin },
    confidence: growth.weeksOfData >= MIN_WEEKS_FOR_CONFIDENT_GROWTH ? 'normal' : 'low',
    assumptions: [
      'Engagement rate per post is assumed to stay the same — this model does not predict whether posting more would raise or dilute it.',
      'Follower growth is assumed to scale proportionally with posting frequency — a simplifying assumption, not a proven causal effect for this account.'
    ]
  };
}

module.exports = { computeFollowerGrowthStats, projectScenario, MIN_MULTIPLIER, MAX_MULTIPLIER, MIN_WEEKS_FOR_CONFIDENT_GROWTH };
