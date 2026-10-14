const test = require('node:test');
const assert = require('node:assert/strict');
const { ruleMatches, isEligibleForMqlPromotion, CONDITION_TYPES, STATIC_CONDITION_TYPES, BEHAVIORAL_CONDITION_TYPES, LIFECYCLE_RANK } = require('../lib/leadScoring');

test('CONDITION_TYPES is the union of static and behavioral types, with no overlap', () => {
  assert.equal(CONDITION_TYPES.length, STATIC_CONDITION_TYPES.length + BEHAVIORAL_CONDITION_TYPES.length);
  for (const t of BEHAVIORAL_CONDITION_TYPES) assert.ok(!STATIC_CONDITION_TYPES.includes(t));
});

test('ruleMatches() evaluates static conditions against the contact, ignoring behavioral facts', () => {
  const contact = { email: 'a@b.com', tags: ['vip'] };
  assert.equal(ruleMatches({ condition_type: 'has_email' }, contact, null), true);
  assert.equal(ruleMatches({ condition_type: 'has_phone' }, contact, null), false);
  assert.equal(ruleMatches({ condition_type: 'tag_equals', condition_value: 'vip' }, contact, null), true);
});

test('ruleMatches() evaluates behavioral conditions from the behavioral facts object, not the contact row', () => {
  const contact = {};
  const behavioral = { emailOpened: true, emailClicked: false, formSubmitted: true, journeyCompleted: false };
  assert.equal(ruleMatches({ condition_type: 'email_opened_any' }, contact, behavioral), true);
  assert.equal(ruleMatches({ condition_type: 'email_clicked_any' }, contact, behavioral), false);
  assert.equal(ruleMatches({ condition_type: 'form_submitted_any' }, contact, behavioral), true);
  assert.equal(ruleMatches({ condition_type: 'journey_completed_any' }, contact, behavioral), false);
});

test('ruleMatches() fails safe (false) for a behavioral condition with no behavioral facts supplied', () => {
  assert.equal(ruleMatches({ condition_type: 'email_opened_any' }, {}, null), false);
});

test('ruleMatches() fails safe (false) for an unknown condition type', () => {
  assert.equal(ruleMatches({ condition_type: 'not_a_real_type' }, { email: 'a@b.com' }, null), false);
});

test('LIFECYCLE_RANK orders stages so mql sits above subscriber/lead and below sql/opportunity/customer', () => {
  assert.ok(LIFECYCLE_RANK.subscriber < LIFECYCLE_RANK.mql);
  assert.ok(LIFECYCLE_RANK.lead < LIFECYCLE_RANK.mql);
  assert.ok(LIFECYCLE_RANK.mql < LIFECYCLE_RANK.sql);
  assert.ok(LIFECYCLE_RANK.sql < LIFECYCLE_RANK.customer);
});

test('isEligibleForMqlPromotion() allows only subscriber and lead', () => {
  assert.equal(isEligibleForMqlPromotion('subscriber'), true);
  assert.equal(isEligibleForMqlPromotion('lead'), true);
});

test('isEligibleForMqlPromotion() rejects a contact already at or past mql', () => {
  for (const stage of ['mql', 'sql', 'opportunity', 'customer', 'evangelist']) {
    assert.equal(isEligibleForMqlPromotion(stage), false, `${stage} must not be auto-promoted`);
  }
});

test('isEligibleForMqlPromotion() rejects "other" even though its numeric rank (-1) is less than mql\'s — the exact bug class this guards against', () => {
  assert.ok(LIFECYCLE_RANK.other < LIFECYCLE_RANK.mql, 'sanity check: this is the trap a naive rank<mql comparison falls into');
  assert.equal(isEligibleForMqlPromotion('other'), false);
});

test('isEligibleForMqlPromotion() fails safe (false) for an unrecognized lifecycle stage', () => {
  assert.equal(isEligibleForMqlPromotion('not_a_real_stage'), false);
  assert.equal(isEligibleForMqlPromotion(undefined), false);
});
