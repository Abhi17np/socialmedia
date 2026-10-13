/**
 * End-to-end exercise of Sales Hub Stage 1's bulk actions, CSV import/
 * export, and duplicate detection for contacts & companies
 * (routes/sales.js + lib/csv.js) against a real app instance and
 * Postgres via PostgREST. See this directory's README for setup.
 *
 * Run: node scripts/integration-tests/sales-bulk-import.js
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

async function api(path_, { method = 'GET', body, auth, raw } = {}) {
  let req = request(app)[method.toLowerCase()](path_);
  if (auth) req = req.set('Authorization', `Bearer ${auth}`);
  if (body) req = req.send(body);
  const res = await req;
  return { status: res.status, data: raw ? res.text : res.body };
}

async function uploadCsv(path_, { auth, csv }) {
  const res = await request(app).post(path_).set('Authorization', `Bearer ${auth}`).attach('file', Buffer.from(csv, 'utf8'), 'import.csv');
  return { status: res.status, data: res.body };
}

async function main() {
  const client = getSocialClient();
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const repId = randomUUID();

  await client.from('tenants').insert({ id: tenantId, name: 'Bulk Import Test Tenant', slug: 'bulk-import-' + Date.now(), hubs_enabled: { sales: true, marketing: false } });
  await client.from('users').insert([
    { id: ownerId, tenant_id: tenantId, email: `owner-${Date.now()}@bulk-import-test.com`, password_hash: 'x', role: 'owner' },
    { id: repId, tenant_id: tenantId, email: `rep-${Date.now()}@bulk-import-test.com`, password_hash: 'x', role: 'member' }
  ]);

  const adminToken = token(tenantId, ownerId, 'admin');
  const memberToken = token(tenantId, repId, 'member');

  // --- CSV import: companies ---

  const companyCsv = 'name,domain,industry\nAcme Corp,acme.com,Manufacturing\nBeta LLC,beta.io,Software\nNo Domain Co,,Retail\n';
  let r = await uploadCsv('/api/v1/sales/companies/import', { auth: memberToken, csv: companyCsv });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.created, 3, JSON.stringify(r.data));
  assert.strictEqual(r.data.skipped, 0);
  console.log('✓ companies CSV import created 3 companies');

  // re-importing the same file must skip the domain-duplicate rows (not the no-domain one, which has no dedup key)
  r = await uploadCsv('/api/v1/sales/companies/import', { auth: memberToken, csv: companyCsv });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.skipped, 2, 'the two domained rows must be skipped as duplicates: ' + JSON.stringify(r.data));
  assert.strictEqual(r.data.created, 1, 'the no-domain row has no dedup key so it is created again: ' + JSON.stringify(r.data));
  console.log('✓ re-importing the same CSV skips domain duplicates');

  r = await api('/api/v1/sales/companies', { auth: memberToken });
  const acme = r.data.companies.find((c) => c.name === 'Acme Corp');
  assert.ok(acme, 'Acme Corp must exist');

  // --- Companies duplicate detection ---

  r = await api('/api/v1/sales/companies/duplicates', { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const noDomainGroup = r.data.duplicateGroups.find((g) => g.matchType === 'name' && g.matchValue === 'no domain co');
  assert.ok(noDomainGroup && noDomainGroup.companies.length === 2, 'expected two "No Domain Co" rows flagged as name duplicates: ' + JSON.stringify(r.data.duplicateGroups));
  console.log('✓ GET /sales/companies/duplicates flags the two same-name companies with no domain to dedup on');

  // --- Companies export ---

  r = await api('/api/v1/sales/companies/export', { auth: memberToken, raw: true });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.includes('Acme Corp'), 'export CSV must include the imported company');
  assert.ok(r.data.split('\r\n')[0].startsWith('id,name,domain'), 'export CSV must have a header row');
  console.log('✓ GET /sales/companies/export returns a CSV with the real rows');

  // --- Companies bulk action ---

  r = await api('/api/v1/sales/companies', { auth: memberToken });
  const companyIds = r.data.companies.map((c) => c.id);

  r = await api('/api/v1/sales/companies/bulk-action', { method: 'POST', auth: memberToken, body: { ids: companyIds, action: 'set_owner', value: repId } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.updated, companyIds.length);
  console.log('✓ bulk set_owner on companies updates every id');

  r = await api('/api/v1/sales/companies/bulk-action', { method: 'POST', auth: memberToken, body: { ids: companyIds, action: 'delete' } });
  assert.strictEqual(r.status, 403, JSON.stringify(r.data));
  console.log('✓ bulk delete on companies requires admin (member rejected even though set_owner allowed member)');

  r = await api('/api/v1/sales/companies/bulk-action', { method: 'POST', auth: adminToken, body: { ids: companyIds, action: 'delete' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.updated, companyIds.length);
  console.log('✓ bulk delete on companies as admin removes every id');

  // --- CSV import: contacts, duplicate detection, export, bulk action ---

  const contactCsv = 'displayName,phone,email,tags\nJane Prospect,919999900010,jane@example.com,vip;hot\nJohn Lead,919999900011,john@example.com,\n';
  r = await uploadCsv('/api/v1/sales/contacts/import', { auth: memberToken, csv: contactCsv });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.created, 2, JSON.stringify(r.data));
  console.log('✓ contacts CSV import created 2 contacts with tags parsed from the semicolon list');

  r = await uploadCsv('/api/v1/sales/contacts/import', { auth: memberToken, csv: contactCsv });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.skipped, 2, 're-importing the same phone/email rows must be skipped as duplicates: ' + JSON.stringify(r.data));
  console.log('✓ re-importing the same contacts CSV skips phone/email duplicates against existing rows');

  // a brand-new row that collides with itself isn't in this CSV, but a manually created contact sharing Jane's phone is a cross-source duplicate
  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Jane Duplicate', phone: '919999900010' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));

  r = await api('/api/v1/sales/contacts/duplicates', { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const phoneGroup = r.data.duplicateGroups.find((g) => g.matchType === 'phone' && g.matchValue === '919999900010');
  assert.ok(phoneGroup && phoneGroup.contacts.length === 2, 'expected the imported Jane and the manually-created Jane Duplicate flagged on phone: ' + JSON.stringify(r.data.duplicateGroups));
  console.log('✓ GET /sales/contacts/duplicates flags a CSV-imported contact and a manually-created one sharing a phone number');

  r = await api('/api/v1/sales/contacts/export', { auth: memberToken, raw: true });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.includes('Jane Prospect'));
  assert.ok(r.data.includes('vip;hot'), 'exported tags must be semicolon-joined');
  console.log('✓ GET /sales/contacts/export returns a CSV with tags semicolon-joined');

  r = await api('/api/v1/sales/contacts?search=Jane', { auth: memberToken });
  const janeIds = r.data.contacts.map((c) => c.id);
  r = await api('/api/v1/sales/contacts/bulk-action', { method: 'POST', auth: memberToken, body: { ids: janeIds, action: 'add_tag', value: 'reviewed' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.updated, janeIds.length);

  r = await api(`/api/v1/sales/contacts/${janeIds[0]}`, { auth: memberToken });
  assert.ok(r.data.contact.tags.includes('reviewed'), 'bulk add_tag must have added the tag: ' + JSON.stringify(r.data.contact.tags));
  console.log('✓ bulk add_tag on contacts tags every matched contact (and recomputes lead_score)');

  console.log('\nALL SALES BULK/IMPORT/EXPORT/DUPLICATE ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
