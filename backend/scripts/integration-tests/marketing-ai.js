/**
 * Phase 9 AI Assist: no ANTHROPIC_API_KEY is configured in this test
 * environment, so these endpoints must fail closed with a clear 503 —
 * exactly like routes/ai.js's existing Compose/Inbox AI does without one.
 * This exercises hub gating, role gating, and request validation (the
 * parts of the stack that run before lib/marketingAi.js ever reaches the
 * Anthropic client), plus the fail-closed 503 itself.
 *
 * Run: node scripts/integration-tests/marketing-ai.js
 * (needs PostgREST + the rest-proxy + Redis running; does NOT need a
 * separately running `node server.js`.)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-integration-tests';
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('hex');
process.env.SUPABASE_URL_SOCIAL = process.env.SUPABASE_URL_SOCIAL || 'http://localhost:3001';
process.env.SUPABASE_KEY_SOCIAL = process.env.SUPABASE_KEY_SOCIAL || '';
process.env.PORT = '0';
delete process.env.ANTHROPIC_API_KEY;

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
const { signToken } = require(path.join(BACKEND, 'lib/auth'));
const { getSocialClient } = require(path.join(BACKEND, 'social/db'));

const TENANT_ID = randomUUID();
const USER_ID = randomUUID();
const NO_HUB_TENANT_ID = randomUUID();
const NO_HUB_USER_ID = randomUUID();
const token = (role) => signToken({ userId: USER_ID, tenantId: TENANT_ID, role });

async function main() {
  const client = getSocialClient();
  let r = await client.from('tenants').insert({ id: TENANT_ID, name: 'AI Test Tenant', slug: 'ai-test-' + Date.now() });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: USER_ID, tenant_id: TENANT_ID, email: `owner-${Date.now()}@ai-test.com`, password_hash: 'x', role: 'owner' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  // A second tenant with marketing hub left OFF — hub gating must still apply to the new routes.
  r = await client.from('tenants').insert({ id: NO_HUB_TENANT_ID, name: 'No Hub Tenant', slug: 'no-hub-' + Date.now() });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: NO_HUB_USER_ID, tenant_id: NO_HUB_TENANT_ID, email: `owner-${Date.now()}@no-hub.com`, password_hash: 'x', role: 'owner' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  const { data: admin } = await client.from('platform_admins').select('id').limit(1).single();
  const jwt = require(path.join(BACKEND, 'node_modules/jsonwebtoken'));
  const platformToken = jwt.sign({ adminId: admin.id, scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  let res = await request(app).patch(`/api/v1/platform/tenants/${TENANT_ID}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const ENDPOINTS = [
    { path: '/marketing/ai/email-copy', body: { brief: 'Announce our autumn sale' } },
    { path: '/marketing/ai/sms-copy', body: { brief: 'Remind about cart' } },
    { path: '/marketing/ai/segment-filter', body: { description: 'contacts with lead score over 50' } },
    { path: '/marketing/ai/insights', body: { overview: { email: { sent: 10 } } } }
  ];

  // --- Hub gating: tenant without marketing hub is rejected before AI is ever reached ---
  const noHubToken = signToken({ userId: NO_HUB_USER_ID, tenantId: NO_HUB_TENANT_ID, role: 'owner' });
  for (const { path: p, body } of ENDPOINTS) {
    res = await request(app).post(`/api/v1/${p}`).set('Authorization', `Bearer ${noHubToken}`).send(body);
    assert.strictEqual(res.status, 403, `${p} should 403 without marketing hub: ${JSON.stringify(res.body)}`);
  }
  console.log('✓ AI Assist endpoints are gated behind the marketing hub');

  // --- Role gating: viewer is below AI Assist's member+ bar ---
  for (const { path: p, body } of ENDPOINTS) {
    res = await request(app).post(`/api/v1/${p}`).set('Authorization', `Bearer ${token('viewer')}`).send(body);
    assert.strictEqual(res.status, 403, `${p} should 403 for viewer: ${JSON.stringify(res.body)}`);
  }
  console.log('✓ AI Assist endpoints require member+ role');

  // --- Validation: missing required field is rejected before metering/AI ---
  res = await request(app).post('/api/v1/marketing/ai/email-copy').set('Authorization', `Bearer ${token('member')}`).send({});
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  console.log('✓ request body is validated');

  // --- Fail-closed: no ANTHROPIC_API_KEY configured, so member+ gets a clear 503, never a silent/invented response ---
  for (const { path: p, body } of ENDPOINTS) {
    res = await request(app).post(`/api/v1/${p}`).set('Authorization', `Bearer ${token('member')}`).send(body);
    assert.strictEqual(res.status, 503, `${p} should fail closed with 503: ${JSON.stringify(res.body)}`);
    assert.ok(/ANTHROPIC_API_KEY/.test(res.body.error), `${p} error must explain why: ${JSON.stringify(res.body)}`);
  }
  console.log('✓ AI Assist fails closed with a clear 503 when ANTHROPIC_API_KEY is not configured (no invented output)');

  console.log('\nALL MARKETING AI ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
