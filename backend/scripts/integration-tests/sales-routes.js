/**
 * End-to-end exercise of routes/sales.js + the hub gate
 * (middleware/hubs.js) + the automation engine (lib/automation.js),
 * against a real app instance, a real Postgres via PostgREST, and the
 * platform-admin hub toggle. See this directory's README for setup.
 *
 * Run: node scripts/integration-tests/sales-routes.js
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
const bcrypt = require(path.join(BACKEND, 'node_modules/bcryptjs'));
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

  await client.from('tenants').insert({ id: tenantId, name: 'Sales Test Tenant', slug: 'sales-test-' + Date.now() });
  await client.from('users').insert({ id: ownerId, tenant_id: tenantId, email: `owner-${Date.now()}@sales-test.com`, password_hash: 'x', role: 'owner' });

  const adminToken = token(tenantId, ownerId, 'admin');
  const memberToken = token(tenantId, ownerId, 'member');
  const viewerToken = token(tenantId, ownerId, 'viewer');

  let r = await api('/api/v1/sales/companies', { auth: viewerToken });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.code, 'HUB_NOT_ENABLED');
  console.log('✓ Sales Hub routes return 403 HUB_NOT_ENABLED before the gate is flipped');

  let { data: admin } = await client.from('platform_admins').select('id').limit(1).maybeSingle();
  if (!admin) {
    const hash = await bcrypt.hash('platformpass123', 10);
    const created = await client.from('platform_admins').insert({ email: `padmin-${Date.now()}@test.com`, password_hash: hash }).select('id').single();
    admin = created.data;
  }
  const platformToken = jwt.sign({ adminId: admin.id, scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  r = await api(`/api/v1/platform/tenants/${tenantId}/hubs`, { method: 'PATCH', auth: platformToken, body: { sales: true } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  console.log('✓ Platform admin enabled Sales Hub for the tenant');

  r = await api('/api/v1/sales/companies', { auth: viewerToken });
  assert.strictEqual(r.status, 200);
  console.log('✓ Sales Hub routes now reachable after the gate is flipped');

  r = await api('/api/v1/sales/companies', { method: 'POST', auth: memberToken, body: { name: 'Acme Corp' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const company = r.data.company;
  console.log('✓ company created (member+)');

  r = await api('/api/v1/sales/pipelines', { method: 'POST', auth: adminToken, body: { name: 'Main Pipeline' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const pipeline = r.data.pipeline;
  assert.strictEqual(pipeline.stages.length, 5);
  const newStage = pipeline.stages.find((s) => s.name === 'New');
  const wonStage = pipeline.stages.find((s) => s.is_won);
  console.log('✓ pipeline created with 5 default stages');

  await client.from('automation_rules').insert({ tenant_id: tenantId, name: 'Tag on win', trigger_type: 'deal_won', action_type: 'add_tag', action_config: { tag: 'customer-won' } });
  console.log('✓ automation rule seeded (deal_won -> add_tag customer-won)');

  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Jane Prospect', phone: '919999900002', companyId: company.id } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const contact = r.data.contact;

  r = await api('/api/v1/sales/deals', { method: 'POST', auth: memberToken, body: { name: 'Acme — Annual plan', pipelineId: pipeline.id, stageId: newStage.id, amount: 50000, contactId: contact.id, companyId: company.id } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const deal = r.data.deal;
  console.log('✓ contact and deal created');

  // No ownerId was sent above (the Kanban quick-create form never offers
  // one) — it must default to the creating rep, not sit unassigned, or
  // this deal is invisible in Team performance / Workspace's "your deals".
  assert.strictEqual(deal.owner_id, ownerId, 'a deal created without an explicit ownerId defaults to the creating user');
  console.log('✓ a deal created without an ownerId defaults to the creating rep, not unassigned');

  r = await api(`/api/v1/sales/deals/${deal.id}/move`, { method: 'POST', auth: memberToken, body: { stageId: wonStage.id } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.deal.status, 'won');
  console.log('✓ deal moved to Won via move_deal_stage RPC');

  await new Promise((res) => setTimeout(res, 300));
  const { data: updatedContact } = await client.from('contacts').select('tags').eq('id', contact.id).single();
  assert.ok(updatedContact.tags.includes('customer-won'), 'expected automation to have tagged the contact: ' + JSON.stringify(updatedContact.tags));
  console.log('✓ automation rule fired for real: contact tagged "customer-won" on deal_won');

  r = await api('/api/v1/sales/activities', { method: 'POST', auth: memberToken, body: { type: 'call', subject: 'Kickoff call', dealId: deal.id, contactId: contact.id } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  console.log('✓ sales activity logged against the deal');

  r = await api(`/api/v1/sales/companies/${company.id}`, { auth: viewerToken });
  assert.strictEqual(r.data.contacts.length, 1);
  assert.strictEqual(r.data.deals.length, 1);
  console.log('✓ company detail rolls up its contact and deal');

  console.log('\nALL SALES ROUTE ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
