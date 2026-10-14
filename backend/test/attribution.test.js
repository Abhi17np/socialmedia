const test = require('node:test');
const assert = require('node:assert/strict');
const { distributeCredit } = require('../lib/attribution');

const tp = (channel, sourceName, occurredAt) => ({ channel, sourceName, occurredAt });

test('distributeCredit() returns empty for no touchpoints', () => {
  assert.deepEqual(distributeCredit([], 100, 'linear'), []);
});

test('distributeCredit() first_touch credits only the earliest touchpoint with the full amount', () => {
  const touchpoints = [tp('form', 'Signup', '2026-01-01'), tp('email', 'Nurture', '2026-01-05')];
  const result = distributeCredit(touchpoints, 1000, 'first_touch');
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceName, 'Signup');
  assert.equal(result[0].creditedAmount, 1000);
});

test('distributeCredit() last_touch credits only the latest touchpoint with the full amount', () => {
  const touchpoints = [tp('form', 'Signup', '2026-01-01'), tp('email', 'Nurture', '2026-01-05')];
  const result = distributeCredit(touchpoints, 1000, 'last_touch');
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceName, 'Nurture');
  assert.equal(result[0].creditedAmount, 1000);
});

test('distributeCredit() linear splits evenly across every touchpoint', () => {
  const touchpoints = [tp('form', 'A', '2026-01-01'), tp('email', 'B', '2026-01-02'), tp('journey', 'C', '2026-01-03')];
  const result = distributeCredit(touchpoints, 300, 'linear');
  assert.equal(result.length, 3);
  for (const r of result) assert.equal(r.creditedAmount, 100);
});

test('distributeCredit() linear sums exactly to the original amount even when it does not divide evenly', () => {
  const touchpoints = [tp('form', 'A', '2026-01-01'), tp('email', 'B', '2026-01-02'), tp('journey', 'C', '2026-01-03')];
  const result = distributeCredit(touchpoints, 100, 'linear');
  const total = result.reduce((sum, r) => sum + r.creditedAmount, 0);
  assert.equal(Math.round(total * 100) / 100, 100, 'rounding remainder must not silently lose or invent revenue');
});

test('distributeCredit() linear with a single touchpoint credits it the full amount', () => {
  const result = distributeCredit([tp('form', 'Only', '2026-01-01')], 500, 'linear');
  assert.equal(result.length, 1);
  assert.equal(result[0].creditedAmount, 500);
});

test('distributeCredit() preserves the original touchpoint fields alongside creditedAmount', () => {
  const result = distributeCredit([tp('whatsapp', 'Promo', '2026-01-01')], 50, 'first_touch');
  assert.equal(result[0].channel, 'whatsapp');
  assert.equal(result[0].occurredAt, '2026-01-01');
});
