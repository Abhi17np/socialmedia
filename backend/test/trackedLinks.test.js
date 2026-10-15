const test = require('node:test');
const assert = require('node:assert/strict');
const { appendUtmParams, parseUtmParams, shortUrlFor } = require('../lib/trackedLinks');

test('appendUtmParams() adds UTM params to a clean URL', () => {
  const result = appendUtmParams('https://example.com/pricing', { utm_source: 'facebook', utm_medium: 'social', utm_content: 'link-123' });
  const url = new URL(result);
  assert.equal(url.searchParams.get('utm_source'), 'facebook');
  assert.equal(url.searchParams.get('utm_medium'), 'social');
  assert.equal(url.searchParams.get('utm_content'), 'link-123');
});

test('appendUtmParams() preserves existing, non-UTM query params', () => {
  const result = appendUtmParams('https://example.com/pricing?ref=newsletter', { utm_source: 'facebook', utm_medium: 'social' });
  const url = new URL(result);
  assert.equal(url.searchParams.get('ref'), 'newsletter');
  assert.equal(url.searchParams.get('utm_source'), 'facebook');
});

test('appendUtmParams() overwrites a utm param the URL already had, rather than duplicating it', () => {
  const result = appendUtmParams('https://example.com/pricing?utm_source=old', { utm_source: 'facebook' });
  const url = new URL(result);
  assert.equal(url.searchParams.getAll('utm_source').length, 1);
  assert.equal(url.searchParams.get('utm_source'), 'facebook');
});

test('appendUtmParams() skips params that are not provided, leaving them unset', () => {
  const result = appendUtmParams('https://example.com/pricing', { utm_source: 'instagram' });
  const url = new URL(result);
  assert.equal(url.searchParams.has('utm_campaign'), false);
});

test('appendUtmParams() throws on an invalid URL rather than silently returning garbage', () => {
  assert.throws(() => appendUtmParams('not a url', { utm_source: 'facebook' }));
});

test('parseUtmParams() extracts all five UTM params when present', () => {
  const result = parseUtmParams('https://example.com/landing?utm_source=linkedin&utm_medium=social&utm_campaign=launch&utm_content=link-42&utm_term=awareness');
  assert.deepEqual(result, { utm_source: 'linkedin', utm_medium: 'social', utm_campaign: 'launch', utm_content: 'link-42', utm_term: 'awareness' });
});

test('parseUtmParams() returns null (not an empty string) for any missing param', () => {
  const result = parseUtmParams('https://example.com/landing?utm_source=linkedin');
  assert.equal(result.utm_source, 'linkedin');
  assert.equal(result.utm_medium, null);
  assert.equal(result.utm_campaign, null);
});

test('parseUtmParams() returns all-null for a URL with no UTM params at all', () => {
  const result = parseUtmParams('https://example.com/landing');
  assert.deepEqual(result, { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null });
});

test('parseUtmParams() returns all-null for an unparseable URL rather than throwing', () => {
  assert.doesNotThrow(() => parseUtmParams('not a url'));
  assert.deepEqual(parseUtmParams('not a url'), { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null });
});

test('shortUrlFor() builds a redirect URL under the given API base', () => {
  assert.equal(shortUrlFor('abc-123', 'https://api.example.com/api/v1'), 'https://api.example.com/api/v1/t/abc-123');
});
