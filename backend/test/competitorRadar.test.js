const test = require('node:test');
const assert = require('node:assert/strict');
const { averageEngagementRate, postsInWindow } = require('../lib/competitorRadar');

test('averageEngagementRate() computes (likes+comments)/posts/followers', () => {
  const posts = [{ likes: 100, comments: 20 }, { likes: 50, comments: 10 }];
  // total engagement = 180, / 2 posts = 90 avg, / 1000 followers = 0.09
  assert.equal(averageEngagementRate(posts, 1000), 0.09);
});

test('averageEngagementRate() returns 0 for no posts', () => {
  assert.equal(averageEngagementRate([], 1000), 0);
  assert.equal(averageEngagementRate(null, 1000), 0);
});

test('averageEngagementRate() returns 0 for zero followers, never NaN/Infinity', () => {
  const rate = averageEngagementRate([{ likes: 10, comments: 2 }], 0);
  assert.equal(rate, 0);
  assert.ok(Number.isFinite(rate));
});

test('averageEngagementRate() treats missing likes/comments as 0, not NaN', () => {
  const posts = [{ likes: null, comments: 5 }, { comments: null, likes: 10 }];
  assert.equal(averageEngagementRate(posts, 100), (5 + 10) / 2 / 100);
});

test('postsInWindow() counts only posts within the window', () => {
  const now = new Date('2026-10-15T00:00:00Z');
  const posts = [
    { createdTime: '2026-10-14T00:00:00Z' }, // 1 day ago
    { createdTime: '2026-10-01T00:00:00Z' }, // 14 days ago
    { createdTime: '2026-08-01T00:00:00Z' }  // way outside
  ];
  assert.equal(postsInWindow(posts, 7, now), 1);
  assert.equal(postsInWindow(posts, 20, now), 2);
});

test('postsInWindow() ignores a post with no createdTime rather than crashing', () => {
  const now = new Date('2026-10-15T00:00:00Z');
  assert.equal(postsInWindow([{ createdTime: null }], 7, now), 0);
});

test('postsInWindow() returns 0 for an empty or missing list', () => {
  assert.equal(postsInWindow([], 7), 0);
  assert.equal(postsInWindow(undefined, 7), 0);
});
