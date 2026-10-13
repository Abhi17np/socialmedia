/**
 * Exercises optimistic concurrency control on PATCH /sales/companies/:id,
 * /sales/contacts/:id, /sales/deals/:id (migration 023's version column
 * + bump_version() trigger) against a real app instance and Postgres
 * via PostgREST. Simulates two concurrent editors the way the actual
 * backend would see them — two sequential requests, the second one
 * carrying the version the first editor actually loaded (now stale).
 * See this directory's README for setup.
 *
 * Run: node scripts/integration-tests/sales-concurrency.js
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
  await client.from('tenants').insert({ id: tenantId, name: 'Concurrency Test Tenant', slug: 'sales-concurrency-' + Date.now(), hubs_enabled: { sales: true, marketing: false } });
  await client.from('users').insert({ id: userId, tenant_id: tenantId, email: `admin-${Date.now()}@concurrency-test.com`, password_hash: 'x', role: 'admin' });
  const adminToken = token(tenantId, userId, 'admin');

  // --- Company ---

  let r = await api('/api/v1/sales/companies', { method: 'POST', auth: adminToken, body: { name: 'Race Co', industry: 'Original' } });
  const company = r.data.company;
  assert.strictEqual(company.version, 1, 'a freshly created company must start at version 1');

  // Two "browser tabs" both load the same company (same version)...
  r = await api(`/api/v1/sales/companies/${company.id}`, { auth: adminToken });
  const loadedByTabA = r.data.company;
  r = await api(`/api/v1/sales/companies/${company.id}`, { auth: adminToken });
  const loadedByTabB = r.data.company;
  assert.strictEqual(loadedByTabA.version, loadedByTabB.version);

  // Full-form resend, exactly as the real frontend does (PATCH
  // validates the complete companySchema, not a partial patch).
  const bodyFrom = (loaded, industry) => ({ name: loaded.name, ...(loaded.domain ? { domain: loaded.domain } : {}), industry, version: loaded.version });

  // ...Tab A saves first...
  r = await api(`/api/v1/sales/companies/${company.id}`, { method: 'PATCH', auth: adminToken, body: bodyFrom(loadedByTabA, 'Tab A wins') });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.company.version, 2, 'a successful update must bump the version');
  console.log('✓ a company update with a current version succeeds and bumps the version');

  // ...then Tab B tries to save using the version it loaded BEFORE Tab
  // A's change — this must be rejected, not silently overwrite Tab A.
  r = await api(`/api/v1/sales/companies/${company.id}`, { method: 'PATCH', auth: adminToken, body: bodyFrom(loadedByTabB, 'Tab B tries to overwrite') });
  assert.strictEqual(r.status, 409, JSON.stringify(r.data));
  assert.strictEqual(r.data.code, 'VERSION_CONFLICT');
  assert.strictEqual(r.data.currentVersion, 2, 'the conflict response must say what the current version actually is');
  console.log('✓ a stale-version update is rejected with 409 VERSION_CONFLICT, not silently applied');

  r = await api(`/api/v1/sales/companies/${company.id}`, { auth: adminToken });
  assert.strictEqual(r.data.company.industry, 'Tab A wins', 'the rejected write must have had NO effect — Tab A\'s save must still stand');
  console.log('✓ the rejected write had zero effect — no silent partial overwrite');

  // Tab B reloads (gets the current version) and retries — this must now succeed.
  r = await api(`/api/v1/sales/companies/${company.id}`, { auth: adminToken });
  const reloaded = r.data.company;
  r = await api(`/api/v1/sales/companies/${company.id}`, { method: 'PATCH', auth: adminToken, body: bodyFrom(reloaded, 'Tab B after reload') });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.company.industry, 'Tab B after reload');
  console.log('✓ after reloading the current version, the retried update succeeds');

  // Omitting version entirely must not be treated as a conflict — this is
  // the un-migrated-client safety valve, not a way around the check for
  // a client that DOES send a (correct or stale) version.
  r = await api(`/api/v1/sales/companies/${company.id}`, { method: 'PATCH', auth: adminToken, body: { name: 'Race Co', industry: 'No version sent' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  console.log('✓ a request that omits version entirely still succeeds (no unconditional break for older/other callers)');

  r = await api(`/api/v1/sales/companies/${randomUUID()}`, { method: 'PATCH', auth: adminToken, body: { name: 'Ghost', version: 1 } });
  assert.strictEqual(r.status, 404, 'a nonexistent company must 404, never 409 — conflict implies the row exists');
  console.log('✓ PATCHing a nonexistent company 404s, distinct from a real version conflict');

  // --- Contact (same mechanism, different table — confirms it's not company-specific) ---

  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: adminToken, body: { displayName: 'Race Contact' } });
  const contact = r.data.contact;
  // A contact's create response reflects BOTH the insert and the
  // immediate lead-score recompute that follows it (two writes, one
  // request) — version must be the real post-recompute value, or a
  // client that trusted a stale one would 409 on its very next save.
  assert.strictEqual(contact.version, 2, 'the create response must reflect the version AFTER the post-create lead-score recompute, not before it');

  r = await api(`/api/v1/sales/contacts/${contact.id}`, { method: 'PATCH', auth: adminToken, body: { jobTitle: 'First edit', version: contact.version } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const bumpedContact = r.data.contact;
  assert.strictEqual(bumpedContact.version, 4, 'a contact PATCH also triggers a lead-score recompute, so one successful edit bumps version by 2, not 1');

  r = await api(`/api/v1/sales/contacts/${contact.id}`, { method: 'PATCH', auth: adminToken, body: { jobTitle: 'Stale edit', version: contact.version } });
  assert.strictEqual(r.status, 409, JSON.stringify(r.data));
  assert.strictEqual(r.data.code, 'VERSION_CONFLICT');
  assert.strictEqual(r.data.currentVersion, 4, 'the conflict response must report the real current version, consistent with the recompute-inclusive count above');
  console.log('✓ the same version-conflict protection applies to contacts, correctly accounting for the lead-score recompute\'s own version bump');

  // --- Deal ---

  r = await api('/api/v1/sales/pipelines', { method: 'POST', auth: adminToken, body: { name: 'Race Pipeline' } });
  const pipeline = r.data.pipeline;
  const newStage = pipeline.stages.find((s) => s.name === 'New');
  r = await api('/api/v1/sales/deals', { method: 'POST', auth: adminToken, body: { name: 'Race Deal', pipelineId: pipeline.id, stageId: newStage.id, amount: 100 } });
  const deal = r.data.deal;
  assert.strictEqual(deal.version, 1);

  r = await api(`/api/v1/sales/deals/${deal.id}`, { method: 'PATCH', auth: adminToken, body: { amount: 200, version: deal.version } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.deal.version, 2);

  r = await api(`/api/v1/sales/deals/${deal.id}`, { method: 'PATCH', auth: adminToken, body: { amount: 999, version: deal.version } });
  assert.strictEqual(r.status, 409, JSON.stringify(r.data));
  console.log('✓ the same version-conflict protection applies to deals');

  console.log('\nALL CONCURRENCY-CONTROL ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
