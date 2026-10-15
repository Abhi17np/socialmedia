const test = require('node:test');
const assert = require('node:assert/strict');
const { erf, normalCdf, twoProportionZTest, evaluateExperiment } = require('../lib/experimentStats');

test('erf() is 0 at 0 and odd (erf(-x) = -erf(x))', () => {
  assert.ok(Math.abs(erf(0)) < 1e-9);
  assert.ok(Math.abs(erf(-1.5) + erf(1.5)) < 1e-6);
});

test('normalCdf() matches well-known standard normal critical values', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 0.001, `expected ~0.975, got ${normalCdf(1.96)}`);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 0.001);
  assert.ok(Math.abs(normalCdf(2.576) - 0.995) < 0.001, `expected ~0.995, got ${normalCdf(2.576)}`);
});

test('twoProportionZTest() returns z=0, p=1 for two identical rates', () => {
  const { z, pValue } = twoProportionZTest(50, 1000, 50, 1000);
  assert.ok(Math.abs(z) < 1e-9);
  // Tolerance matches the Abramowitz & Stegun erf approximation's own
  // documented accuracy (~1.5e-7), not an arbitrary looser bound.
  assert.ok(Math.abs(pValue - 1) < 1e-6, `expected ~1, got ${pValue}`);
});

test('twoProportionZTest() finds an obviously large difference significant (low p-value)', () => {
  const { pValue } = twoProportionZTest(100, 200, 20, 200); // 50% vs 10%, 200 each
  assert.ok(pValue < 0.001, `expected a tiny p-value for a 50% vs 10% difference, got ${pValue}`);
});

test('twoProportionZTest() does not find a small, noisy difference significant', () => {
  const { pValue } = twoProportionZTest(50, 1000, 52, 1000); // 5.0% vs 5.2%
  assert.ok(pValue > 0.05, `expected a near-identical rate difference to NOT be significant at 95%, got p=${pValue}`);
});

test('twoProportionZTest() never throws or returns NaN for zero-rate variants', () => {
  const { z, pValue } = twoProportionZTest(0, 500, 0, 500);
  assert.ok(Number.isFinite(z) && Number.isFinite(pValue));
});

test('twoProportionZTest() never throws for a zero-trials input', () => {
  const { pValue } = twoProportionZTest(0, 0, 10, 100);
  assert.equal(pValue, 1);
});

test('evaluateExperiment() refuses to decide when either variant is below the minimum sample size', () => {
  const result = evaluateExperiment(
    [{ key: 'A', engagements: 40, audience: 50 }, { key: 'B', engagements: 10, audience: 500 }],
    { minSampleSize: 100, confidenceLevel: 0.95 }
  );
  assert.equal(result.decision, 'insufficient_data');
  assert.match(result.note, /A/);
  assert.match(result.note, /fewer than the configured minimum of 100/);
});

test('evaluateExperiment() refuses even when BOTH variants are below the minimum, naming both', () => {
  const result = evaluateExperiment(
    [{ key: 'A', engagements: 4, audience: 20 }, { key: 'B', engagements: 5, audience: 30 }],
    { minSampleSize: 100, confidenceLevel: 0.95 }
  );
  assert.equal(result.decision, 'insufficient_data');
  assert.match(result.note, /A and B/);
});

test('evaluateExperiment() declares a winner when both variants clear the sample minimum AND the difference is significant', () => {
  const result = evaluateExperiment(
    [{ key: 'A', engagements: 100, audience: 200 }, { key: 'B', engagements: 20, audience: 200 }],
    { minSampleSize: 100, confidenceLevel: 0.95 }
  );
  assert.equal(result.decision, 'decided');
  assert.equal(result.winnerKey, 'A');
  assert.ok(result.pValue < 0.05);
});

test('evaluateExperiment() reports "not significant" rather than guessing a winner from noise, even with enough samples', () => {
  const result = evaluateExperiment(
    [{ key: 'A', engagements: 50, audience: 1000 }, { key: 'B', engagements: 52, audience: 1000 }],
    { minSampleSize: 100, confidenceLevel: 0.95 }
  );
  assert.equal(result.decision, 'not_significant');
  assert.equal(result.winnerKey, undefined, 'no winner should be named when the result is not significant');
});

test('evaluateExperiment() respects a stricter confidence level — the same data (p≈0.0498) can be "decided" at 90%/95% but "not significant" at 99%', () => {
  const variants = [{ key: 'A', engagements: 65, audience: 1000 }, { key: 'B', engagements: 45, audience: 1000 }];
  const at90 = evaluateExperiment(variants, { minSampleSize: 100, confidenceLevel: 0.90 });
  const at95 = evaluateExperiment(variants, { minSampleSize: 100, confidenceLevel: 0.95 });
  const at99 = evaluateExperiment(variants, { minSampleSize: 100, confidenceLevel: 0.99 });
  assert.equal(at90.decision, 'decided');
  assert.equal(at95.decision, 'decided');
  assert.equal(at99.decision, 'not_significant', 'a stricter confidence bar must be at least as hard to clear, never easier');
});

test('evaluateExperiment() throws on anything other than exactly two variants', () => {
  assert.throws(() => evaluateExperiment([{ key: 'A', engagements: 1, audience: 100 }], { minSampleSize: 10, confidenceLevel: 0.95 }));
  assert.throws(() => evaluateExperiment([], { minSampleSize: 10, confidenceLevel: 0.95 }));
});
