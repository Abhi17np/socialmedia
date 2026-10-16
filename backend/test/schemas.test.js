const test = require('node:test');
const assert = require('node:assert/strict');
const { contactSchema, companySchema } = require('../lib/schemas');

/**
 * Phone validation (lib/schemas.js's optionalPhone()) — added after a
 * real report: a 9-digit phone number was silently accepted on a new
 * lead with no validation at all. contacts.phone doubles as the
 * WhatsApp wa_id (migration 012), so this isn't just a display nit —
 * an under-length number here can silently break a WhatsApp send
 * against that contact later. Tested through the real schemas (not the
 * internal regex directly) so a future refactor of the helper can't
 * quietly break the actual validation contract routes/sales.js relies on.
 */
test('contactSchema rejects a 9-digit phone number — the exact bug reported', () => {
  const result = contactSchema.safeParse({ displayName: 'Test Lead', phone: '908070605' });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join('.') === 'phone'), JSON.stringify(result.error.issues));
});

test('contactSchema accepts a real 10-digit phone number', () => {
  const result = contactSchema.safeParse({ displayName: 'Test Lead', phone: '9080706050' });
  assert.equal(result.success, true, JSON.stringify(result.success ? null : result.error.issues));
});

test('contactSchema accepts an E.164 number with a country code', () => {
  const result = contactSchema.safeParse({ displayName: 'Test Lead', phone: '+919080706050' });
  assert.equal(result.success, true);
});

test('contactSchema accepts a formatted international number (spaces/parens/dashes stripped before counting digits)', () => {
  const result = contactSchema.safeParse({ displayName: 'Test Lead', phone: '+1 (555) 123-4567' });
  assert.equal(result.success, true, JSON.stringify(result.success ? null : result.error.issues));
});

test('contactSchema treats an empty phone as genuinely optional, not a validation failure', () => {
  assert.equal(contactSchema.safeParse({ displayName: 'Test Lead', phone: '' }).success, true);
  assert.equal(contactSchema.safeParse({ displayName: 'Test Lead' }).success, true);
});

test('contactSchema rejects non-numeric garbage and an unrealistically long number', () => {
  assert.equal(contactSchema.safeParse({ displayName: 'Test Lead', phone: 'abc' }).success, false);
  assert.equal(contactSchema.safeParse({ displayName: 'Test Lead', phone: '12345678901234567' }).success, false);
});

test('companySchema applies the identical phone rule — the exact same reported bug existed on Companies too', () => {
  assert.equal(companySchema.safeParse({ name: 'Acme', phone: '555123' }).success, false);
  assert.equal(companySchema.safeParse({ name: 'Acme', phone: '5551234567' }).success, true);
});
