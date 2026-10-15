const test = require('node:test');
const assert = require('node:assert/strict');
const { pickWinner } = require('../lib/email/abWinnerSweep');

const VARIANTS = [{ key: 'A', subject: 'x' }, { key: 'B', subject: 'y' }];

test('pickWinner() picks the variant with the higher rate for the configured metric', () => {
  const byVariant = { A: { sent: 100, opened: 20, clicked: 5 }, B: { sent: 100, opened: 40, clicked: 2 } };
  assert.equal(pickWinner(byVariant, VARIANTS, 'opens'), 'B');
  assert.equal(pickWinner(byVariant, VARIANTS, 'clicks'), 'A');
});

test('pickWinner() compares rates, not raw counts — a smaller, better-performing variant still wins', () => {
  const byVariant = { A: { sent: 10, opened: 8, clicked: 0 }, B: { sent: 1000, opened: 100, clicked: 0 } };
  assert.equal(pickWinner(byVariant, VARIANTS, 'opens'), 'A', '80% open rate beats 10%, even with 100x fewer sends');
});

test('pickWinner() treats a variant with zero sends as a 0% rate, never divides by zero', () => {
  const byVariant = { A: { sent: 0, opened: 0, clicked: 0 }, B: { sent: 50, opened: 10, clicked: 0 } };
  assert.doesNotThrow(() => pickWinner(byVariant, VARIANTS, 'opens'));
  assert.equal(pickWinner(byVariant, VARIANTS, 'opens'), 'B');
});

test('pickWinner() returns a key even when no recipient rows exist yet for a variant missing from byVariant', () => {
  assert.equal(pickWinner({}, VARIANTS, 'opens'), 'A', 'first variant wins a 0%-vs-0% tie deterministically');
});
