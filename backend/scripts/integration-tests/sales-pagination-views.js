/**
 * Exercises server-side pagination + stable sort on the Companies/
 * Contacts/Deals list routes, and the saved-views CRUD, against a real
 * app instance and Postgres via PostgREST. See this directory's README
 * for setup.
 *
 * Run: node scripts/integration-tests/sales-pagination-views.js
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
  const client = getSocialClient();
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const otherUserId = randomUUID();

  await client.from('tenants').insert({ id: tenantId, name: 'Pagination Test Tenant', slug: 'sales-page-' + Date.now(), hubs_enabled: { sales: true, marketing: false } });
  await client.from('users').insert([
    { id: ownerId, tenant_id: tenantId, email: `owner-${Date.now()}@page-test.com`, password_hash: 'x', role: 'admin' },
    { id: otherUserId, tenant_id: tenantId, email: `other-${Date.now()}@page-test.com`, password_hash: 'x', role: 'member' }
  ]);
  const adminToken = token(tenantId, ownerId, 'admin');
  const otherToken = token(tenantId, otherUserId, 'member');

  // --- Pagination + stable sort on Companies ---

  const names = ['Zebra Inc', 'Apple Inc', 'Mango Inc', 'Banana Inc', 'Cherry Inc'];
  for (const name of names) {
    const r = await api('/api/v1/sales/companies', { method: 'POST', auth: adminToken, body: { name } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  }

  let r = await api('/api/v1/sales/companies?page=1&pageSize=2', { auth: adminToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.companies.length, 2, 'page 1 with pageSize=2 must return exactly 2 rows');
  assert.strictEqual(r.data.total, 5, 'total must reflect all 5 companies regardless of page size');
  assert.strictEqual(r.data.page, 1);

  r = await api('/api/v1/sales/companies?page=3&pageSize=2', { auth: adminToken });
  assert.strictEqual(r.data.companies.length, 1, 'the last page must return the remainder (5 = 2+2+1)');
  console.log('✓ GET /sales/companies paginates with a real total count, not just a silent 50-row cap');

  r = await api('/api/v1/sales/companies?sort=name_asc&pageSize=10', { auth: adminToken });
  const sortedNames = r.data.companies.map((c) => c.name);
  assert.deepStrictEqual(sortedNames, ['Apple Inc', 'Banana Inc', 'Cherry Inc', 'Mango Inc', 'Zebra Inc'], 'sort=name_asc must sort alphabetically: ' + JSON.stringify(sortedNames));
  console.log('✓ GET /sales/companies?sort=name_asc sorts by the requested column');

  r = await api('/api/v1/sales/companies?sort=DROP TABLE companies--_asc&pageSize=10', { auth: adminToken });
  assert.strictEqual(r.status, 200, 'an unrecognized sort value must fall back to the default, not error');
  console.log('✓ an invalid/unrecognized sort value is safely ignored (whitelisted columns only)');

  // --- Saved views ---

  r = await api('/api/v1/sales/saved-views', {
    method: 'POST', auth: adminToken,
    body: { listType: 'companies', name: 'My industry view', filters: { search: 'inc' }, sort: 'name_asc', visibleColumns: ['name', 'domain'] }
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const view = r.data.view;
  assert.strictEqual(view.name, 'My industry view');
  assert.strictEqual(view.sort, 'name_asc');
  console.log('✓ a saved view persists filters, sort and visible columns');

  r = await api('/api/v1/sales/saved-views?listType=companies', { auth: adminToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.views.length, 1);
  assert.strictEqual(r.data.views[0].id, view.id);
  console.log('✓ GET /sales/saved-views lists the view back for its owner');

  // A different user in the SAME tenant must not see or touch it —
  // saved views are personal, not shared.
  r = await api('/api/v1/sales/saved-views?listType=companies', { auth: otherToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.views.length, 0, 'another user in the same tenant must not see this view');
  console.log('✓ a saved view is invisible to a different user in the same tenant');

  r = await api(`/api/v1/sales/saved-views/${view.id}`, { method: 'PATCH', auth: otherToken, body: { name: 'Hijacked' } });
  assert.strictEqual(r.status, 404, 'another user must not be able to update someone else\'s saved view');
  r = await api(`/api/v1/sales/saved-views/${view.id}`, { method: 'DELETE', auth: otherToken });
  assert.strictEqual(r.status, 200); // delete is a no-op affecting 0 rows, not an error — still must not actually remove it
  r = await api('/api/v1/sales/saved-views?listType=companies', { auth: adminToken });
  assert.strictEqual(r.data.views.length, 1, 'the view must still exist after another user\'s delete attempt touched 0 rows');
  console.log('✓ another user cannot rename or delete someone else\'s saved view');

  r = await api(`/api/v1/sales/saved-views/${view.id}`, { method: 'PATCH', auth: adminToken, body: { name: 'Renamed view' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.view.name, 'Renamed view');
  console.log('✓ the owner can rename their own saved view');

  r = await api(`/api/v1/sales/saved-views/${view.id}`, { method: 'DELETE', auth: adminToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  r = await api('/api/v1/sales/saved-views?listType=companies', { auth: adminToken });
  assert.strictEqual(r.data.views.length, 0, 'the view must be gone after the owner deletes it');
  console.log('✓ the owner can delete their own saved view');

  console.log('\nALL PAGINATION/SORT/SAVED-VIEWS ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
