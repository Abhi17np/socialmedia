/**
 * End-to-end exercise of Sales Hub Stage 1's CRM/automation parity pass
 * (migration 016 + routes/sales.js additions): pipeline rename/delete,
 * stage CRUD + reorder, lost-reason enforcement on a deal move, the
 * stale-deal flag, and an activity completion touching its deal's
 * updated_at. Companion to sales-routes.js, which already covers the
 * pre-existing company/contact/deal/activity routes — this file only
 * covers what Stage 1 added. See this directory's README for setup.
 *
 * Run: node scripts/integration-tests/sales-stage1.js
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

  await client.from('tenants').insert({ id: tenantId, name: 'Sales Stage1 Test Tenant', slug: 'sales-stage1-' + Date.now(), hubs_enabled: { sales: true, marketing: false } });
  await client.from('users').insert({ id: ownerId, tenant_id: tenantId, email: `owner-${Date.now()}@sales-stage1-test.com`, password_hash: 'x', role: 'owner' });

  const adminToken = token(tenantId, ownerId, 'admin');
  const memberToken = token(tenantId, ownerId, 'member');

  // --- Pipeline create / rename / stage create / reorder ---

  let r = await api('/api/v1/sales/pipelines', { method: 'POST', auth: adminToken, body: { name: 'Pipeline A' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const pipeline = r.data.pipeline;
  assert.strictEqual(pipeline.stages.length, 5);
  console.log('✓ pipeline created with 5 default stages');

  r = await api(`/api/v1/sales/pipelines/${pipeline.id}`, { method: 'PATCH', auth: adminToken, body: { name: 'Renamed Pipeline' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.pipeline.name, 'Renamed Pipeline');
  console.log('✓ pipeline renamed');

  r = await api(`/api/v1/sales/pipelines/${pipeline.id}/stages`, { method: 'POST', auth: adminToken, body: { name: 'Negotiation', probability: 75 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const negotiationStage = r.data.stage;
  assert.strictEqual(negotiationStage.position, 5, 'new stage should append at the end');
  console.log('✓ stage created and appended at the end of the pipeline');

  r = await api(`/api/v1/sales/stages/${negotiationStage.id}`, { method: 'PATCH', auth: adminToken, body: { staleAfterDays: 1, probability: 80 } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.stage.stale_after_days, 1);
  assert.strictEqual(r.data.stage.probability, 80);
  console.log('✓ stage updated (stale_after_days, probability)');

  // member (not admin) must not be able to touch pipeline/stage config
  r = await api(`/api/v1/sales/pipelines/${pipeline.id}/stages`, { method: 'POST', auth: memberToken, body: { name: 'Should fail' } });
  assert.strictEqual(r.status, 403, JSON.stringify(r.data));
  console.log('✓ member cannot create a stage (admin-only, RBAC enforced)');

  r = await api('/api/v1/sales/pipelines', { auth: memberToken });
  const allStages = r.data.pipelines.find((p) => p.id === pipeline.id).stages;
  const newStage = allStages.find((s) => s.name === 'New');
  const qualifiedStage = allStages.find((s) => s.name === 'Qualified');
  const lostStage = allStages.find((s) => s.is_lost);
  const wonStage = allStages.find((s) => s.is_won);

  // swap New (0) and Qualified (1) — exercises the collision-avoiding
  // two-pass reorder against the unique(pipeline_id, position) constraint
  const reorderBody = {
    stages: allStages.map((s) => {
      if (s.id === newStage.id) return { id: s.id, position: qualifiedStage.position };
      if (s.id === qualifiedStage.id) return { id: s.id, position: newStage.position };
      return { id: s.id, position: s.position };
    })
  };
  r = await api(`/api/v1/sales/pipelines/${pipeline.id}/stages/reorder`, { method: 'POST', auth: adminToken, body: reorderBody });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const reordered = r.data.stages;
  assert.strictEqual(reordered.find((s) => s.id === newStage.id).position, qualifiedStage.position);
  assert.strictEqual(reordered.find((s) => s.id === qualifiedStage.id).position, newStage.position);
  console.log('✓ stages reordered without a unique-constraint collision');

  r = await api(`/api/v1/sales/pipelines/${pipeline.id}/stages/reorder`, { method: 'POST', auth: adminToken, body: { stages: [{ id: newStage.id, position: 0 }] } });
  assert.strictEqual(r.status, 400, JSON.stringify(r.data));
  console.log('✓ reorder rejects a partial stage list');

  // --- Lost-reason enforcement on deal move ---

  r = await api('/api/v1/sales/deals', { method: 'POST', auth: memberToken, body: { name: 'Deal needing a reason', pipelineId: pipeline.id, stageId: newStage.id, amount: 1000 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const dealToLose = r.data.deal;

  r = await api(`/api/v1/sales/deals/${dealToLose.id}/move`, { method: 'POST', auth: memberToken, body: { stageId: lostStage.id } });
  assert.strictEqual(r.status, 400, JSON.stringify(r.data));
  console.log('✓ moving a deal to a lost stage without lostReason is rejected');

  r = await api(`/api/v1/sales/deals/${dealToLose.id}/move`, { method: 'POST', auth: memberToken, body: { stageId: lostStage.id, lostReason: 'Budget cut' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.deal.status, 'lost');
  assert.strictEqual(r.data.deal.lost_reason, 'Budget cut');
  console.log('✓ moving a deal to a lost stage with lostReason records it');

  // --- Stale-deal flag ---

  r = await api('/api/v1/sales/deals', { method: 'POST', auth: memberToken, body: { name: 'Fresh deal', pipelineId: pipeline.id, stageId: negotiationStage.id, amount: 2000 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const freshDeal = r.data.deal;

  r = await api('/api/v1/sales/deals', { method: 'POST', auth: memberToken, body: { name: 'Rotting deal', pipelineId: pipeline.id, stageId: negotiationStage.id, amount: 3000 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const rottingDeal = r.data.deal;
  // back-date it past the stage's 1-day stale_after_days threshold —
  // the only way to simulate inactivity without actually waiting a day
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
  await client.from('deals').update({ updated_at: twoDaysAgo }).eq('id', rottingDeal.id);

  r = await api(`/api/v1/sales/deals?pipelineId=${pipeline.id}`, { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const freshDealOut = r.data.deals.find((d) => d.id === freshDeal.id);
  const rottingDealOut = r.data.deals.find((d) => d.id === rottingDeal.id);
  assert.strictEqual(freshDealOut.isStale, false, 'a freshly created deal must not be flagged stale');
  assert.strictEqual(rottingDealOut.isStale, true, 'a deal untouched past its stage stale_after_days must be flagged stale');
  console.log('✓ GET /sales/deals computes the stale flag per stage.stale_after_days');

  // --- Activity completion resets the deal's rotting timer ---

  r = await api('/api/v1/sales/activities', { method: 'POST', auth: memberToken, body: { type: 'call', subject: 'Check-in call', dealId: rottingDeal.id } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const activity = r.data.activity;

  r = await api(`/api/v1/sales/activities/${activity.id}`, { method: 'PATCH', auth: memberToken, body: { status: 'completed' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));

  r = await api(`/api/v1/sales/deals?pipelineId=${pipeline.id}`, { auth: memberToken });
  const rottingDealAfter = r.data.deals.find((d) => d.id === rottingDeal.id);
  assert.strictEqual(rottingDealAfter.isStale, false, 'completing an activity against a deal must touch updated_at and clear the stale flag');
  console.log('✓ completing a logged activity against a deal resets its stale flag (Pipedrive-style rotting reset)');

  // --- Delete guards ---

  r = await api(`/api/v1/sales/stages/${negotiationStage.id}`, { method: 'DELETE', auth: adminToken });
  assert.strictEqual(r.status, 409, JSON.stringify(r.data));
  console.log('✓ deleting a stage with deals in it is rejected (409)');

  r = await api(`/api/v1/sales/pipelines/${pipeline.id}`, { method: 'DELETE', auth: adminToken });
  assert.strictEqual(r.status, 409, JSON.stringify(r.data));
  console.log('✓ deleting a pipeline with deals in it is rejected (409)');

  // clean up deals so the empty-pipeline/stage delete paths can be proven too
  await client.from('deals').delete().eq('pipeline_id', pipeline.id);

  r = await api(`/api/v1/sales/stages/${negotiationStage.id}`, { method: 'DELETE', auth: adminToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  console.log('✓ deleting an empty stage succeeds');

  r = await api(`/api/v1/sales/pipelines/${pipeline.id}`, { method: 'DELETE', auth: adminToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  console.log('✓ deleting an empty pipeline succeeds');

  console.log('\nALL SALES STAGE-1 ROUTE ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
