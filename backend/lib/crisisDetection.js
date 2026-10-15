/**
 * Pure statistics for Crisis Intelligence (social/crisisSweep.js). No DB,
 * no network — same reasoning as lib/experimentStats.js's header: this
 * is the one place a bug would make the app cry "crisis" over normal
 * noise, or miss a real one, so it's exhaustively unit tested in
 * isolation from the DB-touching sweep that calls it.
 *
 * Deliberately NOT sentiment-based: a real crisis is first and foremost
 * a SURGE in how many people are messaging/mentioning you, which this
 * app can measure honestly from data it already collects (inbox_messages
 * + mentions, every connected platform) with zero AI involved. Sentiment
 * is a second, optional, pull-based step a human triggers afterward
 * (lib/ai.js's summarizeCrisis) — never what decides whether to alert.
 */

/** Mean + population stddev of a trailing set of per-window counts. */
function computeBaseline(counts) {
  if (!counts || counts.length === 0) return { mean: 0, stddev: 0 };
  const mean = counts.reduce((sum, c) => sum + c, 0) / counts.length;
  const variance = counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Is `currentCount` a genuine anomaly against a trailing baseline?
 *
 * - `minCount` is a non-negotiable floor (default 5), checked BEFORE any
 *   statistics: a tenant going from 0 to 2 messages is a 'spike' by
 *   z-score alone but not a crisis by any reasonable reading — same
 *   "refuse below a floor" principle lib/experimentStats.js's
 *   evaluateExperiment() applies to audience size.
 * - When baseline_stddev > 0, a standard z-score against the trailing
 *   mean/stddev, flagged at `zThreshold` (default 3 — ~99.7th percentile
 *   under a normal approximation, the same "big, not marginal" bar a
 *   z-test anomaly detector conventionally uses).
 * - When baseline_stddev is exactly 0 (every trailing window had the
 *   identical count, often 0), there's no variance to divide by — a
 *   z-score would be undefined, not infinite-and-therefore-always-a-spike.
 *   Falls back to "did this clear the baseline by more than one floor's
 *   worth," so one message above a historically-silent channel isn't
 *   itself a 'crisis', but a real jump is still caught. zScore is
 *   reported as null in this branch — an honest "not computed," not a
 *   fabricated number.
 */
function detectSpike({ currentCount, baselineMean, baselineStddev, minCount = 5, zThreshold = 3 }) {
  if (currentCount < minCount) return { isSpike: false, zScore: null };

  if (baselineStddev === 0) {
    return { isSpike: currentCount > baselineMean + minCount, zScore: null };
  }

  const zScore = (currentCount - baselineMean) / baselineStddev;
  return { isSpike: zScore >= zThreshold, zScore };
}

module.exports = { computeBaseline, detectSpike };
