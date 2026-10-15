const test = require('node:test');
const assert = require('node:assert/strict');
const { jaccardSimilarity, findDuplicateWarning, mediaRequirementWarnings } = require('../lib/repurposing');

test('jaccardSimilarity() returns 1 for identical text', () => {
  assert.equal(jaccardSimilarity('Our new feature ships today', 'Our new feature ships today'), 1);
});

test('jaccardSimilarity() returns 0 for completely unrelated text', () => {
  assert.equal(jaccardSimilarity('Our new feature ships today', 'Rainy weather in the mountains'), 0);
});

test('jaccardSimilarity() is case- and punctuation-insensitive', () => {
  assert.equal(jaccardSimilarity('Our new feature!', 'our new feature'), 1);
});

test('jaccardSimilarity() returns a partial score for partially overlapping text', () => {
  const score = jaccardSimilarity('our new feature ships today', 'our new feature ships next week');
  assert.ok(score > 0 && score < 1, `expected a partial score, got ${score}`);
});

test('findDuplicateWarning() flags a near-verbatim repost over the threshold', () => {
  const recentPosts = [{ id: 'post-1', content: 'Our new feature ships today — check it out!' }];
  const warning = findDuplicateWarning('Our new feature ships today — check it out', recentPosts);
  assert.ok(warning, 'expected a duplicate warning for near-identical text');
  assert.equal(warning.scheduledPostId, 'post-1');
});

test('findDuplicateWarning() does not flag merely related content under the threshold', () => {
  const recentPosts = [{ id: 'post-1', content: 'We just launched our new mobile app for iOS and Android.' }];
  const warning = findDuplicateWarning('Big sale this weekend — 20% off everything in store.', recentPosts);
  assert.equal(warning, null);
});

test('findDuplicateWarning() returns null for an empty recent-posts list', () => {
  assert.equal(findDuplicateWarning('anything', []), null);
  assert.equal(findDuplicateWarning('anything', undefined), null);
});

test('mediaRequirementWarnings() flags YouTube when no media is attached', () => {
  const warnings = mediaRequirementWarnings(['youtube', 'facebook'], false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].platform, 'youtube');
});

test('mediaRequirementWarnings() returns no warnings when media is attached', () => {
  assert.deepEqual(mediaRequirementWarnings(['youtube', 'facebook'], true), []);
});

test('mediaRequirementWarnings() returns no warnings for platforms with no hard media requirement', () => {
  assert.deepEqual(mediaRequirementWarnings(['facebook', 'linkedin'], false), []);
});
