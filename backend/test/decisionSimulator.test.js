const test = require('node:test');
const assert = require('node:assert/strict');
const { computeFollowerGrowthStats, projectScenario, MIN_MULTIPLIER, MAX_MULTIPLIER, MIN_WEEKS_FOR_CONFIDENT_GROWTH } = require('../lib/decisionSimulator');

test('computeFollowerGrowthStats() is just computeBaseline() under this feature\'s own name', () => {
  const stats = computeFollowerGrowthStats([10, 20, 10, 20]);
  assert.equal(stats.mean, 15);
  assert.equal(stats.stddev, 5);
});

function baselineWith(growth, overrides = {}) {
  return {
    postsPerWeek: 4, engagementRate: 0.05,
    followerGrowthPerWeek: { mean: growth.mean, stddev: growth.stddev, weeksOfData: growth.weeksOfData ?? MIN_WEEKS_FOR_CONFIDENT_GROWTH },
    followers: 10000,
    ...overrides
  };
}

test('projectScenario() scales postsPerWeek and followerGrowthPerWeek.mean by the multiplier', () => {
  const baseline = baselineWith({ mean: 100, stddev: 10 });
  const result = projectScenario(baseline, 2);
  assert.equal(result.postsPerWeek, 8);
  assert.equal(result.followerGrowthPerWeek.mean, 200);
  assert.equal(result.appliedMultiplier, 2);
  assert.equal(result.wasClamped, false);
});

test('projectScenario() leaves engagementRate unchanged and states the assumption', () => {
  const baseline = baselineWith({ mean: 100, stddev: 10 });
  const result = projectScenario(baseline, 3);
  assert.equal(result.engagementRate, baseline.engagementRate);
  assert.ok(result.assumptions.some((a) => /engagement rate/i.test(a)));
  assert.ok(result.assumptions.some((a) => /proportionally/i.test(a)));
});

test('projectScenario() builds a 95% interval from the REAL unscaled stddev, not a fabricated margin', () => {
  const baseline = baselineWith({ mean: 100, stddev: 10 });
  const result = projectScenario(baseline, 2);
  // mean=200, margin = 1.96*10 = 19.6
  assert.ok(Math.abs(result.followerGrowthPerWeek.low - 180.4) < 1e-9, JSON.stringify(result.followerGrowthPerWeek));
  assert.ok(Math.abs(result.followerGrowthPerWeek.high - 219.6) < 1e-9, JSON.stringify(result.followerGrowthPerWeek));
});

test('projectScenario() clamps an unreasonable multiplier and reports that it did', () => {
  const baseline = baselineWith({ mean: 100, stddev: 10 });
  const tooHigh = projectScenario(baseline, 50);
  assert.equal(tooHigh.appliedMultiplier, MAX_MULTIPLIER);
  assert.equal(tooHigh.wasClamped, true);

  const tooLow = projectScenario(baseline, 0.01);
  assert.equal(tooLow.appliedMultiplier, MIN_MULTIPLIER);
  assert.equal(tooLow.wasClamped, true);
});

test('projectScenario() does not clamp a reasonable multiplier', () => {
  const baseline = baselineWith({ mean: 100, stddev: 10 });
  const result = projectScenario(baseline, 1.5);
  assert.equal(result.appliedMultiplier, 1.5);
  assert.equal(result.wasClamped, false);
});

test('projectScenario() marks confidence "low" below the minimum weeks of growth history, "normal" at or above it', () => {
  const thin = projectScenario(baselineWith({ mean: 100, stddev: 10, weeksOfData: MIN_WEEKS_FOR_CONFIDENT_GROWTH - 1 }), 1);
  assert.equal(thin.confidence, 'low');

  const enough = projectScenario(baselineWith({ mean: 100, stddev: 10, weeksOfData: MIN_WEEKS_FOR_CONFIDENT_GROWTH }), 1);
  assert.equal(enough.confidence, 'normal');
});

test('projectScenario() never produces NaN/Infinity even with a zero-stddev baseline', () => {
  const result = projectScenario(baselineWith({ mean: 0, stddev: 0 }), 2);
  assert.ok(Number.isFinite(result.followerGrowthPerWeek.mean));
  assert.ok(Number.isFinite(result.followerGrowthPerWeek.low));
  assert.ok(Number.isFinite(result.followerGrowthPerWeek.high));
  assert.equal(result.followerGrowthPerWeek.low, result.followerGrowthPerWeek.high); // zero margin when stddev is 0
});
