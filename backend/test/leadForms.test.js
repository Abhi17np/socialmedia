const test = require('node:test');
const assert = require('node:assert/strict');
const { LeadFormError, validateFieldDefinitions, validateSubmission } = require('../lib/leadForms');

test('validateFieldDefinitions() requires at least one field', () => {
  assert.throws(() => validateFieldDefinitions([]), LeadFormError);
});

test('validateFieldDefinitions() requires at least one email or phone field', () => {
  assert.throws(
    () => validateFieldDefinitions([{ key: 'name', label: 'Name', type: 'text' }]),
    /email or phone/
  );
});

test('validateFieldDefinitions() accepts a real form with an email field', () => {
  assert.doesNotThrow(() => validateFieldDefinitions([
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true }
  ]));
});

test('validateFieldDefinitions() rejects a duplicate key', () => {
  assert.throws(() => validateFieldDefinitions([
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'email', label: 'Email again', type: 'text' }
  ]), /Duplicate/);
});

test('validateFieldDefinitions() rejects a bad key shape', () => {
  assert.throws(() => validateFieldDefinitions([{ key: 'Email Address', label: 'Email', type: 'email' }]), LeadFormError);
});

test('validateFieldDefinitions() rejects an unknown field type', () => {
  assert.throws(() => validateFieldDefinitions([{ key: 'email', label: 'Email', type: 'date' }]), /unknown type/);
});

test('validateFieldDefinitions() requires options on a select field', () => {
  assert.throws(() => validateFieldDefinitions([
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'plan', label: 'Plan', type: 'select' }
  ]), /no options/);
});

test('validateFieldDefinitions() caps the number of fields', () => {
  const fields = [{ key: 'email', label: 'Email', type: 'email' }];
  for (let i = 0; i < 25; i++) fields.push({ key: `f${i}`, label: `Field ${i}`, type: 'text' });
  assert.throws(() => validateFieldDefinitions(fields), /at most/);
});

const FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'plan', label: 'Plan', type: 'select', options: ['basic', 'pro'] },
  { key: 'notes', label: 'Notes', type: 'textarea' }
];

test('validateSubmission() accepts a complete, valid submission', () => {
  const cleaned = validateSubmission(FIELDS, { name: 'Ada Lovelace', email: 'ada@example.com', plan: 'pro', notes: 'Interested' });
  assert.deepEqual(cleaned, { name: 'Ada Lovelace', email: 'ada@example.com', plan: 'pro', notes: 'Interested' });
});

test('validateSubmission() rejects a missing required field', () => {
  assert.throws(() => validateSubmission(FIELDS, { email: 'ada@example.com' }), /Name.*required/);
});

test('validateSubmission() rejects a malformed email', () => {
  assert.throws(() => validateSubmission(FIELDS, { name: 'Ada', email: 'not-an-email' }), /valid email/);
});

test('validateSubmission() rejects a select value outside the offered options', () => {
  assert.throws(() => validateSubmission(FIELDS, { name: 'Ada', email: 'ada@example.com', plan: 'enterprise' }), /offered options/);
});

test('validateSubmission() silently drops an optional field left blank', () => {
  const cleaned = validateSubmission(FIELDS, { name: 'Ada', email: 'ada@example.com', notes: '' });
  assert.equal('notes' in cleaned, false);
});

test('validateSubmission() trims whitespace and caps absurdly long values', () => {
  const cleaned = validateSubmission(FIELDS, { name: '  Ada  ', email: 'ada@example.com', notes: 'x'.repeat(5000) });
  assert.equal(cleaned.name, 'Ada');
  assert.equal(cleaned.notes.length, 2000);
});

test('validateSubmission() rejects a completely missing payload', () => {
  assert.throws(() => validateSubmission(FIELDS, null), /Missing submission data/);
});
