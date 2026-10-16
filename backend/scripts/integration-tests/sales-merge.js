/**
 * Exercises the transactional duplicate-merge RPCs (merge_contacts,
 * merge_companies — migration 022) through their routes, against a
 * real app instance and Postgres via PostgREST. See this directory's
 * README for setup.
 *
 * Run: node scripts/integration-tests/sales-merge.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-integration-tests';
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('hex');
process.env.SUPABASE_URL_SOCIAL = process.env.SUPABASE_URL_SOCIAL || 'http://localhost:3001';
process.env.SUPABASE_KEY_SOCIAL = process.env.SUPABASE_KEY_SOCIAL || '';
process.env.PORT = '0';

if (!process.env.SUPABASE_KEY_SOCIAL) {
  console.error('SUPABASE_KEY_SOCIAL is not set — see this directory\'s README.');
  process.exit(1);
}

const path = require('path');
const assert = require('assert');
const { randomUUID } = require('crypto');
const request = require('supertest');
const BACKEND = path.join(__dirname, '..', '..');

const app = require(path.join(BACKEND, 'server.js'));
const jwt = require(path.join(BACKEND, 'node_modules/jsonwebtoken'));
const { getSocialClient } = require(path.join(BACKEND, 'social/db'));

const token = (tenantId, userId, role) => jwt.sign({ userId, tenantId, role }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(path_, { method = 'GET', body, auth } = {}) {
  let req = request(app)[method.toLowerCase()](path_);
  if (auth) req = req.set('Authorization', `Bearer ${auth}`);
  if (body) req = req.send(body);
  const res = await req;
  return { status: res.status, data: res.body };
}

async function main() {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const client = getSocialClient();
  await client.from('tenants').insert({ id: tenantId, name: 'Merge Test Tenant', slug: 'sales-merge-' + Date.now(), hubs_enabled: { sales: true, marketing: false } });
  await client.from('users').insert({ id: userId, tenant_id: tenantId, email: `admin-${Date.now()}@merge-test.com`, password_hash: 'x', role: 'admin' });
  const adminToken = token(tenantId, userId, 'admin');
  const memberToken = token(tenantId, userId, 'member');

  // --- Company merge ---

  let r = await api('/api/v1/sales/companies', { method: 'POST', auth: adminToken, body: { name: 'Acme Corp', industry: 'Software', domain: 'acme.com' } });
  const survivorCompany = r.data.company;
  r = await api('/api/v1/sales/companies', { method: 'POST', auth: adminToken, body: { name: 'Acme Corporation', phone: '555-123-4567' } });
  const loserCompany = r.data.company;

  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: adminToken, body: { displayName: 'Jane Doe', companyId: loserCompany.id } });
  const contactOnLoserCompany = r.data.contact;

  r = await api('/api/v1/sales/pipelines', { method: 'POST', auth: adminToken, body: { name: 'Merge Pipeline' } });
  const pipeline = r.data.pipeline;
  const newStage = pipeline.stages.find((s) => s.name === 'New');
  r = await api('/api/v1/sales/deals', { method: 'POST', auth: adminToken, body: { name: 'Deal on loser company', pipelineId: pipeline.id, stageId: newStage.id, amount: 1000, companyId: loserCompany.id } });
  const dealOnLoserCompany = r.data.deal;

  r = await api('/api/v1/sales/companies/merge', { method: 'POST', auth: memberToken, body: { survivorId: survivorCompany.id, loserId: loserCompany.id } });
  assert.strictEqual(r.status, 403, 'a member must not be able to merge companies (admin-only, destructive)');
  console.log('✓ member cannot merge companies (admin-only, RBAC enforced)');

  r = await api('/api/v1/sales/companies/merge', {
    method: 'POST', auth: adminToken,
    body: { survivorId: survivorCompany.id, loserId: loserCompany.id, mergedFields: { phone: '555-123-4567' } }
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.company.name, 'Acme Corp', 'survivor keeps its own name unless explicitly overridden');
  assert.strictEqual(r.data.company.phone, '555-123-4567', 'an explicitly chosen mergedFields value must win');
  console.log('✓ admin merges two companies; survivor keeps its fields except explicit overrides');

  r = await api(`/api/v1/sales/companies/${loserCompany.id}`, { auth: adminToken });
  assert.strictEqual(r.status, 404, 'the loser company must actually be gone after merging');
  console.log('✓ the loser company row no longer exists after merge');

  r = await api(`/api/v1/sales/contacts/${contactOnLoserCompany.id}`, { auth: adminToken });
  assert.strictEqual(r.data.contact.company_id, survivorCompany.id, 'a contact linked to the loser company must be reassigned to the survivor');
  console.log('✓ a contact linked to the merged-away company is reassigned, not orphaned');

  r = await api(`/api/v1/sales/deals/${dealOnLoserCompany.id}`, { auth: adminToken });
  assert.strictEqual(r.data.deal.company_id, survivorCompany.id, 'a deal linked to the loser company must be reassigned to the survivor');
  console.log('✓ a deal linked to the merged-away company is reassigned, not orphaned');

  // --- Contact merge, including the dual-linkage conflict path ---

  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: adminToken, body: { displayName: 'Survivor Contact', email: 'survivor@example.com', tags: ['vip'] } });
  const survivorContact = r.data.contact;
  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: adminToken, body: { displayName: 'Loser Contact', phone: '9998887777', tags: ['imported'] } });
  const loserContact = r.data.contact;

  // A deal where the LOSER is the primary contact and the survivor has
  // no link at all — must reassign cleanly.
  r = await api('/api/v1/sales/deals', { method: 'POST', auth: adminToken, body: { name: 'Solo deal', pipelineId: pipeline.id, stageId: newStage.id, amount: 500, contactId: loserContact.id } });
  const soloDeal = r.data.deal;

  // A SECOND deal where BOTH survivor (secondary) and loser (primary)
  // are already linked — the real conflict path unique(deal_id,
  // contact_id) would otherwise reject.
  r = await api('/api/v1/sales/deals', { method: 'POST', auth: adminToken, body: { name: 'Shared deal', pipelineId: pipeline.id, stageId: newStage.id, amount: 750, contactId: loserContact.id } });
  const sharedDeal = r.data.deal;
  r = await api(`/api/v1/sales/deals/${sharedDeal.id}/contacts`, { method: 'POST', auth: adminToken, body: { contactId: survivorContact.id, role: 'secondary' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));

  r = await api('/api/v1/sales/contacts/merge', {
    method: 'POST', auth: adminToken,
    body: { survivorId: survivorContact.id, loserId: loserContact.id, mergedFields: { phone: '9998887777' } }
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.contact.email, 'survivor@example.com', 'survivor keeps its own email unless overridden');
  assert.strictEqual(r.data.contact.phone, '9998887777', 'an explicit mergedFields override must win');
  assert.deepStrictEqual([...r.data.contact.tags].sort(), ['imported', 'vip'], 'tags from both contacts must be unioned, not dropped');
  console.log('✓ contact merge keeps survivor fields except explicit overrides, and unions tags');

  r = await api(`/api/v1/sales/contacts/${loserContact.id}`, { auth: adminToken });
  assert.strictEqual(r.status, 404, 'the loser contact must actually be gone after merging');

  r = await api(`/api/v1/sales/deals/${soloDeal.id}`, { auth: adminToken });
  assert.strictEqual(r.data.deal.contact_id, survivorContact.id, 'the solo deal\'s primary contact must be reassigned to the survivor');
  console.log('✓ a deal where only the loser was linked is reassigned to the survivor');

  r = await api(`/api/v1/sales/deals/${sharedDeal.id}`, { auth: adminToken });
  const linkedContactIds = r.data.contacts.map((c) => c.contactId);
  assert.ok(linkedContactIds.includes(survivorContact.id), 'the survivor must still be linked to the shared deal');
  assert.strictEqual(linkedContactIds.filter((id) => id === survivorContact.id).length, 1, 'merging must not create a duplicate deal_contacts row for the survivor');
  const survivorLink = r.data.contacts.find((c) => c.contactId === survivorContact.id);
  assert.strictEqual(survivorLink.isPrimary, true, 'the survivor must be promoted to primary (the loser was primary on this deal)');
  console.log('✓ a deal where BOTH survivor and loser were already linked merges into one row, survivor promoted to primary — no unique-constraint violation');

  // --- Safety checks ---

  r = await api('/api/v1/sales/contacts/merge', { method: 'POST', auth: adminToken, body: { survivorId: survivorContact.id, loserId: survivorContact.id } });
  assert.strictEqual(r.status, 400, 'merging a contact into itself must be rejected');
  console.log('✓ merging a record into itself is rejected');

  r = await api('/api/v1/sales/contacts/merge', { method: 'POST', auth: adminToken, body: { survivorId: survivorContact.id, loserId: randomUUID() } });
  assert.strictEqual(r.status, 400, 'merging a nonexistent loser must fail cleanly, not 500');
  console.log('✓ merging a nonexistent record fails cleanly instead of crashing');

  console.log('\nALL MERGE ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
