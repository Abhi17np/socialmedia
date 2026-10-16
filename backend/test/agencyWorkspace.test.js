const test = require('node:test');
const assert = require('node:assert/strict');
const { canApprove, canRevoke, linkDirection } = require('../lib/agencyWorkspace');

const AGENCY = 'agency-tenant';
const CLIENT = 'client-tenant';
const OTHER = 'unrelated-tenant';

function linkWith(status) {
  return { agency_tenant_id: AGENCY, client_tenant_id: CLIENT, status };
}

test('canApprove() allows only the agency side, only while pending', () => {
  assert.equal(canApprove(linkWith('pending'), AGENCY), true);
  assert.equal(canApprove(linkWith('pending'), CLIENT), false, 'the client proposing it is not the same as the agency approving it');
  assert.equal(canApprove(linkWith('pending'), OTHER), false);
});

test('canApprove() refuses once already active or revoked', () => {
  assert.equal(canApprove(linkWith('active'), AGENCY), false);
  assert.equal(canApprove(linkWith('revoked'), AGENCY), false);
});

test('canRevoke() allows either side, at any non-revoked status', () => {
  assert.equal(canRevoke(linkWith('pending'), AGENCY), true);
  assert.equal(canRevoke(linkWith('pending'), CLIENT), true);
  assert.equal(canRevoke(linkWith('active'), AGENCY), true);
  assert.equal(canRevoke(linkWith('active'), CLIENT), true);
});

test('canRevoke() refuses a tenant not party to the link, and an already-revoked one', () => {
  assert.equal(canRevoke(linkWith('active'), OTHER), false);
  assert.equal(canRevoke(linkWith('revoked'), AGENCY), false);
  assert.equal(canRevoke(linkWith('revoked'), CLIENT), false);
});

test('linkDirection() reports "as_agency"/"as_client" correctly for each real party', () => {
  const link = linkWith('active');
  assert.equal(linkDirection(link, AGENCY), 'as_agency');
  assert.equal(linkDirection(link, CLIENT), 'as_client');
});

test('linkDirection() returns null for a tenant that is party to neither side, rather than guessing', () => {
  assert.equal(linkDirection(linkWith('active'), OTHER), null);
});
