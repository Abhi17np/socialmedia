const test = require('node:test');
const assert = require('node:assert/strict');
const { latestEngagementSum } = require('../lib/experimentSweep');

test('latestEngagementSum() sums the latest likes/comments/shares and ignores other metrics', () => {
  const rows = [
    { metric: 'likes', value: 10, captured_date: '2026-10-01' },
    { metric: 'comments', value: 2, captured_date: '2026-10-01' },
    { metric: 'views', value: 500, captured_date: '2026-10-01' } // not an engagement action — must be excluded
  ];
  assert.equal(latestEngagementSum(rows), 12);
});

test('latestEngagementSum() takes the LATEST value per metric, not the first or the sum across days', () => {
  const rows = [
    { metric: 'likes', value: 10, captured_date: '2026-10-01' },
    { metric: 'likes', value: 25, captured_date: '2026-10-02' }, // oldest-first input — the later row wins
    { metric: 'comments', value: 3, captured_date: '2026-10-01' },
    { metric: 'comments', value: 5, captured_date: '2026-10-02' }
  ];
  assert.equal(latestEngagementSum(rows), 30, '25 (latest likes) + 5 (latest comments), not 10+25+3+5');
});

test('latestEngagementSum() returns 0 for no rows', () => {
  assert.equal(latestEngagementSum([]), 0);
});

test('latestEngagementSum() treats a missing shares metric as simply absent, not an error', () => {
  const rows = [{ metric: 'likes', value: 7, captured_date: '2026-10-01' }];
  assert.equal(latestEngagementSum(rows), 7);
});
