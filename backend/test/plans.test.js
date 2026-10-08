const test = require('node:test');
const assert = require('node:assert/strict');
const { limitsFor, checkLimit, PLAN_LIMITS } = require('../lib/plans');

test('limitsFor falls back to the free plan for unknown/missing plans', () => {
  assert.deepEqual(limitsFor('free'), PLAN_LIMITS.free);
  assert.deepEqual(limitsFor('nonexistent-plan'), PLAN_LIMITS.free);
  assert.deepEqual(limitsFor(undefined), PLAN_LIMITS.free);
});

test('checkLimit allows usage strictly below the limit and blocks at/above it', () => {
  assert.equal(checkLimit('free', 'socialAccounts', 0).allowed, true);
  assert.equal(checkLimit('free', 'socialAccounts', 1).allowed, true);
  assert.equal(checkLimit('free', 'socialAccounts', 2).allowed, false); // free plan's limit is 2
  assert.equal(checkLimit('free', 'socialAccounts', 3).allowed, false);
});

test('enterprise plan is unlimited', () => {
  const result = checkLimit('enterprise', 'postsPerMonth', 1_000_000);
  assert.equal(result.allowed, true);
  assert.equal(result.limit, Infinity);
});

test('checkLimit rejects an unknown resource key instead of silently allowing it', () => {
  assert.throws(() => checkLimit('free', 'notARealResource', 0));
});

test('every plan defines the same resource keys', () => {
  const keys = Object.keys(PLAN_LIMITS.free).sort();
  for (const plan of Object.keys(PLAN_LIMITS)) {
    assert.deepEqual(Object.keys(PLAN_LIMITS[plan]).sort(), keys, `plan "${plan}" is missing a resource key other plans define`);
  }
});

test('plan limits are non-decreasing from free to enterprise (no tier pays more for less)', () => {
  const order = ['free', 'starter', 'pro', 'enterprise'];
  for (const resource of Object.keys(PLAN_LIMITS.free)) {
    for (let i = 1; i < order.length; i++) {
      const prev = PLAN_LIMITS[order[i - 1]][resource];
      const curr = PLAN_LIMITS[order[i]][resource];
      assert.ok(curr >= prev, `${order[i]}.${resource} (${curr}) is less than ${order[i - 1]}.${resource} (${prev})`);
    }
  }
});
