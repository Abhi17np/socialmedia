const test = require('node:test');
const assert = require('node:assert/strict');
const { externalPostIdFor } = require('../social/pollers');

test('externalPostIdFor() returns the externalPostId for an account whose publish succeeded', () => {
  const platformResults = { 'acc-1': { status: 'published', externalPostId: 'ext-1', url: 'https://example.com/1' } };
  assert.equal(externalPostIdFor(platformResults, 'acc-1'), 'ext-1');
});

test('externalPostIdFor() returns null for an account that failed to publish', () => {
  const platformResults = { 'acc-1': { status: 'failed', error: 'boom' } };
  assert.equal(externalPostIdFor(platformResults, 'acc-1'), null);
});

test('externalPostIdFor() returns null for an account not yet represented in platform_results', () => {
  const platformResults = { 'acc-1': { status: 'published', externalPostId: 'ext-1' } };
  assert.equal(externalPostIdFor(platformResults, 'acc-2'), null);
});

test('externalPostIdFor() returns null when platform_results itself is missing', () => {
  assert.equal(externalPostIdFor(undefined, 'acc-1'), null);
  assert.equal(externalPostIdFor(null, 'acc-1'), null);
});

test('externalPostIdFor() returns null for a "published" entry with no externalPostId', () => {
  const platformResults = { 'acc-1': { status: 'published' } };
  assert.equal(externalPostIdFor(platformResults, 'acc-1'), null);
});
