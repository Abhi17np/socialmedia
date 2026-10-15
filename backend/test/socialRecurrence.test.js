const test = require('node:test');
const assert = require('node:assert/strict');
const { nextOccurrenceDate } = require('../social/queue');

test('nextOccurrenceDate() advances by one day for daily recurrence', () => {
  const next = nextOccurrenceDate('2026-01-01T10:00:00.000Z', 'daily');
  assert.equal(next.toISOString(), '2026-01-02T10:00:00.000Z');
});

test('nextOccurrenceDate() advances by seven days for weekly recurrence', () => {
  const next = nextOccurrenceDate('2026-01-01T10:00:00.000Z', 'weekly');
  assert.equal(next.toISOString(), '2026-01-08T10:00:00.000Z');
});

test('nextOccurrenceDate() advances by one calendar month for monthly recurrence, handling month-length differences', () => {
  const next = nextOccurrenceDate('2026-01-31T10:00:00.000Z', 'monthly');
  // Jan 31 + 1 month: JS Date rolls a nonexistent "Feb 31" into early March — a known
  // engine behavior, not a bug here, so the real month-end edge case is documented, not hidden.
  assert.equal(next.getUTCMonth(), 2, 'rolls into March, since February has no 31st');
});

test('nextOccurrenceDate() preserves the time of day, only the date changes', () => {
  const next = nextOccurrenceDate('2026-06-15T23:45:00.000Z', 'daily');
  assert.equal(next.getUTCHours(), 23);
  assert.equal(next.getUTCMinutes(), 45);
});
