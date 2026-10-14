const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidSpfRecord, isValidDkimRecord, isValidDmarcRecord } = require('../lib/emailDomainCheck');

test('isValidSpfRecord() recognizes a real-shaped SPF record', () => {
  assert.equal(isValidSpfRecord(['v=spf1 include:_spf.google.com ~all']), true);
});

test('isValidSpfRecord() is case-insensitive', () => {
  assert.equal(isValidSpfRecord(['V=SPF1 -all']), true);
});

test('isValidSpfRecord() rejects an unrelated TXT record', () => {
  assert.equal(isValidSpfRecord(['google-site-verification=abc123']), false);
});

test('isValidSpfRecord() finds the SPF record among several unrelated TXT records', () => {
  assert.equal(isValidSpfRecord(['some-other-verification=xyz', 'v=spf1 include:_spf.example.com ~all']), true);
});

test('isValidSpfRecord() handles no records at all', () => {
  assert.equal(isValidSpfRecord([]), false);
  assert.equal(isValidSpfRecord(undefined), false);
});

test('isValidDkimRecord() recognizes a real-shaped DKIM record', () => {
  assert.equal(isValidDkimRecord(['v=DKIM1; k=rsa; p=MIGfMA0GCSq...']), true);
});

test('isValidDkimRecord() rejects an unrelated record', () => {
  assert.equal(isValidDkimRecord(['v=spf1 -all']), false);
});

test('isValidDmarcRecord() recognizes a real-shaped DMARC record', () => {
  assert.equal(isValidDmarcRecord(['v=DMARC1; p=reject; rua=mailto:dmarc@example.com']), true);
});

test('isValidDmarcRecord() rejects an unrelated record', () => {
  assert.equal(isValidDmarcRecord(['v=spf1 -all']), false);
});
