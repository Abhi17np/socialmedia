/**
 * End-to-end exercise of Sales Hub Stage 1's Dashboard, Workspace and
 * sales_targets routes (routes/sales.js) — real rollups over real deals/
 * activities/targets rows, no fabricated metrics. Companion to
 * sales-routes.js and sales-stage1.js. See this directory's README for
 * setup.
 *
 * Run: node scripts/integration-tests/sales-dashboard.js
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

function monthRange() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { from, to };
}

async function main() {
  const client = getSocialClient();
  const tenantId = randomUUID();
  const repId = randomUUID();

  await client.from('tenants').insert({ id: tenantId, name: 'Sales Dashboard Test Tenant', slug: 'sales-dash-' + Date.now(), hubs_enabled: { sales: true, marketing: false } });
  await client.from('users').insert({ id: repId, tenant_id: tenantId, email: `rep-${Date.now()}@sales-dash-test.com`, password_hash: 'x', role: 'member' });

  const adminToken = token(tenantId, repId, 'admin');
  const repToken = token(tenantId, repId, 'member');

  let r = await api('/api/v1/sales/pipelines', { method: 'POST', auth: adminToken, body: { name: 'Dashboard Pipeline' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const pipeline = r.data.pipeline;
  const newStage = pipeline.stages.find((s) => s.name === 'New');
  const wonStage = pipeline.stages.find((s) => s.is_won);
  const lostStage = pipeline.stages.find((s) => s.is_lost);

  const { from, to } = monthRange();
  const todayStr = new Date().toISOString().slice(0, 10);

  // one won deal (owned by rep), one lost deal, one open deal — all owned by repId
  r = await api('/api/v1/sales/deals', { method: 'POST', auth: repToken, body: { name: 'Won deal', pipelineId: pipeline.id, stageId: newStage.id, amount: 10000, ownerId: repId, expectedCloseDate: todayStr } });
  const wonDeal = r.data.deal;
  r = await api(`/api/v1/sales/deals/${wonDeal.id}/move`, { method: 'POST', auth: repToken, body: { stageId: wonStage.id } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));

  r = await api('/api/v1/sales/deals', { method: 'POST', auth: repToken, body: { name: 'Lost deal', pipelineId: pipeline.id, stageId: newStage.id, amount: 4000, ownerId: repId } });
  const lostDeal = r.data.deal;
  r = await api(`/api/v1/sales/deals/${lostDeal.id}/move`, { method: 'POST', auth: repToken, body: { stageId: lostStage.id, lostReason: 'No budget' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));

  r = await api('/api/v1/sales/deals', { method: 'POST', auth: repToken, body: { name: 'Open deal', pipelineId: pipeline.id, stageId: newStage.id, amount: 6000, ownerId: repId, expectedCloseDate: todayStr } });
  const openDeal = r.data.deal;
  console.log('✓ seeded one won, one lost, one open deal, all owned by the same rep');

  // --- Dashboard ---

  r = await api(`/api/v1/sales/dashboard?from=${from}&to=${to}`, { auth: repToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.revenue, 10000, 'revenue must equal the won deal amount');
  assert.strictEqual(r.data.lostAmount, 4000);
  assert.strictEqual(r.data.pipelineValue, 6000, 'pipelineValue must equal the one open deal');
  assert.strictEqual(r.data.wonCount, 1);
  assert.strictEqual(r.data.lostCount, 1);
  assert.strictEqual(r.data.conversionRate, 0.5, 'conversionRate = 1 won / (1 won + 1 lost)');
  const repPerf = r.data.teamPerformance.find((p) => p.ownerId === repId);
  assert.ok(repPerf, 'teamPerformance must include the rep');
  assert.strictEqual(repPerf.wonAmount, 10000);
  assert.strictEqual(repPerf.openValue, 6000);
  console.log('✓ GET /sales/dashboard computes revenue, pipelineValue, conversionRate, teamPerformance from real deals');

  // New stage has probability 10% (seeded default) — weightedForecast includes
  // only the open deal with an expectedCloseDate in range: 6000 * 0.10 = 600
  assert.strictEqual(r.data.weightedForecast, 600, 'weightedForecast must be amount * stage probability for in-range open deals');
  console.log('✓ weightedForecast is probability-weighted, not a flat sum');

  // --- Sales targets ---

  r = await api('/api/v1/sales/targets', { method: 'POST', auth: adminToken, body: { periodStart: from, periodEnd: to, targetAmount: 20000 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  console.log('✓ admin created a team-wide sales target');

  r = await api('/api/v1/sales/targets', { method: 'POST', auth: repToken, body: { periodStart: from, periodEnd: to, targetAmount: 1 } });
  assert.strictEqual(r.status, 403, JSON.stringify(r.data));
  console.log('✓ member cannot create a sales target (admin-only, RBAC enforced)');

  r = await api('/api/v1/sales/targets', { method: 'POST', auth: adminToken, body: { periodStart: to, periodEnd: from, targetAmount: 100 } });
  assert.strictEqual(r.status, 400, JSON.stringify(r.data));
  console.log('✓ a target with periodEnd before periodStart is rejected');

  r = await api(`/api/v1/sales/dashboard?from=${from}&to=${to}`, { auth: repToken });
  const target = r.data.targets.find((t) => t.target_amount === '20000.00' || Number(t.target_amount) === 20000);
  assert.ok(target, 'dashboard must surface the seeded target: ' + JSON.stringify(r.data.targets));
  assert.strictEqual(target.actualAmount, 10000, 'actualAmount must equal real won revenue in range');
  assert.strictEqual(target.attainmentPct, 50, '10000 actual / 20000 target = 50%');
  console.log('✓ dashboard target attainment is computed against real won revenue, not hardcoded');

  // --- Workspace ---

  r = await api('/api/v1/sales/activities', { method: 'POST', auth: repToken, body: { type: 'call', subject: 'Overdue follow-up', dealId: openDeal.id, assignedTo: repId, dueAt: new Date(Date.now() - 86400000).toISOString() } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));

  r = await api('/api/v1/sales/workspace', { auth: repToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.overdueActivities.length, 1, 'workspace must surface the overdue activity assigned to this user');
  assert.strictEqual(r.data.overdueActivities[0].subject, 'Overdue follow-up');
  assert.strictEqual(r.data.openDealsCount, 1, 'workspace must count this rep\'s one open deal');
  console.log('✓ GET /sales/workspace surfaces overdue activities and open-deal count for the current user');

  console.log('\nALL SALES DASHBOARD/WORKSPACE/TARGETS ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
