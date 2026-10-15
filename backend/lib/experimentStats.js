/**
 * Pure statistics for the AI Content Experiment Engine
 * (routes/experiments.js, lib/experimentSweep.js). No DB, no network —
 * every function here takes plain numbers and is exhaustively unit
 * tested, because this is the one place in the whole app where a bug
 * would make this app LIE about confidence, which rule 3 of this
 * build's own brief treats as a hard line ("never claim causation from
 * insufficient data... state uncertainty").
 *
 * Deliberately scoped to exactly two variants (classic A/B), not
 * arbitrary A/B/C/.../n — comparing more than two variants correctly
 * needs a multiple-comparisons correction (e.g. Bonferroni) this app
 * doesn't implement; shipping an uncorrected multi-variant test would
 * systematically overstate confidence. A named scope cut, not a
 * silently missing feature — see docs/SOCIAL_HUB_GAPS_AND_ADDITIONS.md.
 */

// Abramowitz & Stegun 7.1.26 — a standard, well-known rational
// approximation to the error function, accurate to within 1.5e-7. No
// stats library dependency; this is the entire reason one isn't needed.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const p = 0.3275911;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

/** Standard normal CDF, Φ(z) — P(Z ≤ z) for Z ~ N(0,1). */
function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Two-proportion z-test. x1/x2 = successes (engagements), n1/n2 =
 * trials (audience size — see evaluateExperiment's header for why
 * that's the honest denominator this app has). Returns a two-tailed
 * p-value: the probability of seeing a difference this large (or
 * larger) between the two rates if they were actually identical.
 *
 * Both n1 and n2 must be > 0 — callers are expected to have already
 * refused to run this at all below the configured minimum sample size
 * (see evaluateExperiment); this function itself just returns a
 * non-significant result (p=1) rather than throwing if either pooled
 * variance term is degenerate (both rates exactly 0% or exactly 100%).
 */
function twoProportionZTest(x1, n1, x2, n2) {
  if (n1 <= 0 || n2 <= 0) return { z: 0, pValue: 1 };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, pValue: 1 }; // no variance to detect a difference with (e.g. both rates identical and at 0% or 100%)
  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pValue };
}

/**
 * Decides one experiment from exactly two variants' { key, engagements,
 * audience } — audience is each variant's reach denominator (this app
 * uses the connected account's follower count at post time, the one
 * real audience-size figure available per migration 036's per-post
 * pipeline + the existing analytics_snapshots follower metric — see
 * lib/experimentSweep.js for exactly how that's assembled). Using
 * audience size as the statistical "trials" denominator, rather than a
 * raw engagement count, is what normalizes for different-sized
 * audiences the mission brief calls for: a variant with 10x the
 * followers needs proportionally more engagement to "win," not just
 * more in absolute terms.
 *
 * Refuses to decide (decision: 'insufficient_data') if either variant's
 * audience is below minSampleSize — this is the literal, non-negotiable
 * "refuse to declare a winner on insufficient data" requirement, enforced
 * BEFORE the statistical test even runs, not as an afterthought on its
 * result. A statistically "significant" result from a tiny audience is
 * exactly the false-confidence trap a minimum sample size exists to
 * prevent.
 */
function evaluateExperiment(variants, { minSampleSize, confidenceLevel }) {
  if (!Array.isArray(variants) || variants.length !== 2) {
    throw new Error('evaluateExperiment() requires exactly two variants.');
  }
  const [a, b] = variants;
  const sampleSizes = { [a.key]: a.audience, [b.key]: b.audience };

  const tooSmall = variants.filter((v) => v.audience < minSampleSize);
  if (tooSmall.length > 0) {
    return {
      decision: 'insufficient_data',
      sampleSizes,
      note: `Variant${tooSmall.length > 1 ? 's' : ''} ${tooSmall.map((v) => v.key).join(' and ')} ${tooSmall.length > 1 ? 'have' : 'has'} an audience of fewer than the configured minimum of ${minSampleSize} — refusing to declare a winner until there's enough data.`
    };
  }

  const { z, pValue } = twoProportionZTest(a.engagements, a.audience, b.engagements, b.audience);
  const rates = { [a.key]: a.audience > 0 ? a.engagements / a.audience : 0, [b.key]: b.audience > 0 ? b.engagements / b.audience : 0 };
  const alpha = 1 - confidenceLevel;

  if (pValue > alpha) {
    return {
      decision: 'not_significant',
      z, pValue, rates, sampleSizes,
      note: `The difference between variants isn't statistically significant yet at the ${Math.round(confidenceLevel * 100)}% confidence level (p=${pValue.toFixed(4)}). Keep running or accept there may be no real difference.`
    };
  }

  const winnerKey = rates[a.key] > rates[b.key] ? a.key : b.key;
  return {
    decision: 'decided',
    winnerKey, z, pValue, rates, sampleSizes,
    note: `Variant ${winnerKey} wins at the ${Math.round(confidenceLevel * 100)}% confidence level (p=${pValue.toFixed(4)}).`
  };
}

module.exports = { erf, normalCdf, twoProportionZTest, evaluateExperiment };
