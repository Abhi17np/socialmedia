const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBaseline, detectSpike } = require('../lib/crisisDetection');

test('computeBaseline() computes mean and population stddev', () => {
  const { mean, stddev } = computeBaseline([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(mean, 5);
  assert.equal(stddev, 2);
});

test('computeBaseline() returns {mean:0, stddev:0} for an empty or missing list', () => {
  assert.deepEqual(computeBaseline([]), { mean: 0, stddev: 0 });
  assert.deepEqual(computeBaseline(undefined), { mean: 0, stddev: 0 });
});

test('computeBaseline() returns stddev 0 when every count is identical', () => {
  assert.deepEqual(computeBaseline([3, 3, 3, 3]), { mean: 3, stddev: 0 });
});

test('detectSpike() refuses below the minCount floor even with a huge z-score', () => {
  // baseline is consistently ~0, current is only 2 — a real relative
  // jump, but not enough absolute volume to call it a crisis.
  const result = detectSpike({ currentCount: 2, baselineMean: 0, baselineStddev: 0, minCount: 5 });
  assert.equal(result.isSpike, false);
  assert.equal(result.zScore, null);
});

test('detectSpike() flags a real z-score anomaly above threshold', () => {
  const result = detectSpike({ currentCount: 50, baselineMean: 10, baselineStddev: 5, minCount: 5, zThreshold: 3 });
  assert.equal(result.isSpike, true);
  assert.equal(result.zScore, 8);
});

test('detectSpike() does not flag a count within normal variance', () => {
  const result = detectSpike({ currentCount: 15, baselineMean: 10, baselineStddev: 5, minCount: 5, zThreshold: 3 });
  assert.equal(result.isSpike, false, JSON.stringify(result));
  assert.equal(result.zScore, 1);
});

test('detectSpike() falls back to a floor-based check when baselineStddev is 0, never NaN/Infinity', () => {
  // exactly at the margin (baseline 0 + minCount 5 = 5) is NOT a spike — must clear it, not just reach it.
  const atMargin = detectSpike({ currentCount: 5, baselineMean: 0, baselineStddev: 0, minCount: 5 });
  assert.equal(atMargin.isSpike, false);
  assert.equal(atMargin.zScore, null);

  const spike = detectSpike({ currentCount: 20, baselineMean: 0, baselineStddev: 0, minCount: 5 });
  assert.equal(spike.isSpike, true); // 20 clears baseline(0) + minCount(5) by a wide margin
  assert.equal(spike.zScore, null);
});

test('detectSpike() treats a count exactly at the z-threshold as a spike (>=, not >)', () => {
  const result = detectSpike({ currentCount: 25, baselineMean: 10, baselineStddev: 5, minCount: 5, zThreshold: 3 });
  assert.equal(result.zScore, 3);
  assert.equal(result.isSpike, true);
});
