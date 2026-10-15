const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBrandContext, checkBrandViolations, DEFAULT_PROFILE } = require('../lib/brandMemory');

test('buildBrandContext() returns an empty string for a fully unconfigured profile', () => {
  assert.equal(buildBrandContext({ ...DEFAULT_PROFILE }), '');
});

test('buildBrandContext() returns an empty string for a null profile', () => {
  assert.equal(buildBrandContext(null), '');
});

test('buildBrandContext() includes tone and audience when set', () => {
  const ctx = buildBrandContext({ ...DEFAULT_PROFILE, tone: 'warm and concise', audience: 'small business owners' });
  assert.match(ctx, /Brand tone: warm and concise\./);
  assert.match(ctx, /Audience: small business owners\./);
});

test('buildBrandContext() includes preferred/banned terms and prohibited claims when set', () => {
  const ctx = buildBrandContext({
    ...DEFAULT_PROFILE,
    preferred_terms: ['teammate'],
    banned_terms: ['synergy'],
    prohibited_claims: ['guaranteed results'],
    approved_messaging: ['We ship real, working software.']
  });
  assert.match(ctx, /Prefer these terms where relevant: teammate\./);
  assert.match(ctx, /Never use these words or phrases: synergy\./);
  assert.match(ctx, /Never make these claims: guaranteed results\./);
  assert.match(ctx, /We ship real, working software\./);
});

test('checkBrandViolations() flags a banned term used in generated text, case-insensitively', () => {
  const profile = { ...DEFAULT_PROFILE, banned_terms: ['Synergy'] };
  const violations = checkBrandViolations('Let\'s leverage our synergy to grow faster.', profile);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], { type: 'banned_term', term: 'Synergy' });
});

test('checkBrandViolations() flags a prohibited claim repeated verbatim', () => {
  const profile = { ...DEFAULT_PROFILE, prohibited_claims: ['guaranteed results'] };
  const violations = checkBrandViolations('We offer guaranteed results for every customer.', profile);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'prohibited_claim');
});

test('checkBrandViolations() returns no violations for clean text', () => {
  const profile = { ...DEFAULT_PROFILE, banned_terms: ['synergy'], prohibited_claims: ['guaranteed results'] };
  assert.deepEqual(checkBrandViolations('A short, honest update about our new feature.', profile), []);
});

test('checkBrandViolations() does NOT catch a paraphrase of a prohibited claim — a documented limitation, not a bug', () => {
  const profile = { ...DEFAULT_PROFILE, prohibited_claims: ['guaranteed results'] };
  const violations = checkBrandViolations('Every customer is assured of the outcome they want.', profile);
  assert.deepEqual(violations, [], 'substring matching is literal, not semantic — this paraphrase is a known miss');
});

test('checkBrandViolations() returns [] for empty/missing input without throwing', () => {
  assert.deepEqual(checkBrandViolations('', { ...DEFAULT_PROFILE }), []);
  assert.deepEqual(checkBrandViolations('some text', null), []);
  assert.deepEqual(checkBrandViolations(null, { ...DEFAULT_PROFILE }), []);
});
