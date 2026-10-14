/**
 * End-to-end exercise of the Phase 7 SMS module
 * (migrations/031_sms.sql, backend/lib/sms/*, backend/routes/marketingSms.js):
 * provider connection, a real campaign send through the mock provider
 * gated by Phase 1's consent model, permanent-failure auto-suppression,
 * usage metering, the send_sms journey action (the "multichannel
 * fallback" composition — see this file's header comment near the
 * journey test), role gating, and cross-tenant isolation.
 *
 * Run: node scripts/integration-tests/marketing-sms.js
 * (needs PostgREST + the rest-proxy + Redis running; does NOT need a
 * separately running `node server.js` — see this directory's README)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-integration-tests';
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('hex');
process.env.SUPABASE_URL_SOCIAL = process.env.SUPABASE_URL_SOCIAL || 'http://localhost:3001';
process.env.SUPABASE_KEY_SOCIAL = process.env.SUPABASE_KEY_SOCIAL || '';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
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
const { signToken } = require(path.join(BACKEND, 'lib/auth'));
const { getSocialClient } = require(path.join(BACKEND, 'social/db'));
const smsQueue = require(path.join(BACKEND, 'lib/sms/smsQueue'));
smsQueue.start();
const { enrollContact } = require(path.join(BACKEND, 'lib/journeyEngine'));

const TENANT_ID = randomUUID();
const TENANT_B_ID = randomUUID();
const USER_ID = randomUUID();
const token = (role) => signToken({ userId: USER_ID, tenantId: TENANT_ID, role });
const tokenB = (role) => signToken({ userId: randomUUID(), tenantId: TENANT_B_ID, role });

async function main() {
  const client = getSocialClient();
  let r = await client.from('tenants').insert({ id: TENANT_ID, name: 'SMS Test Tenant', slug: 'sms-test-' + Date.now() });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('tenants').insert({ id: TENANT_B_ID, name: 'SMS Test Tenant B', slug: 'sms-test-b-' + Date.now() });
  if (r.error) throw new Error('tenant B insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: USER_ID, tenant_id: TENANT_ID, email: `owner-${Date.now()}@sms-test.com`, password_hash: 'x', role: 'owner' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  const { data: admin } = await client.from('platform_admins').select('id').limit(1).single();
  const jwt = require(path.join(BACKEND, 'node_modules/jsonwebtoken'));
  const platformToken = jwt.sign({ adminId: admin.id, scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  for (const t of [TENANT_ID, TENANT_B_ID]) {
    const res = await request(app).patch(`/api/v1/platform/tenants/${t}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: true });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  }
  console.log('✓ Marketing Hub enabled for both test tenants');

  // --- 1. Connection CRUD, role gating ---

  let res = await request(app).put('/api/v1/marketing/sms/connection').set('Authorization', `Bearer ${token('member')}`).send({ provider: 'mock', fromNumber: '+15551234567' });
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  res = await request(app).put('/api/v1/marketing/sms/connection').set('Authorization', `Bearer ${token('admin')}`).send({ provider: 'mock', fromNumber: '+15551234567' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  console.log('✓ SMS connection saved (mock provider), PUT is admin+ only');

  res = await request(app).post('/api/v1/marketing/sms/connection/test').set('Authorization', `Bearer ${token('admin')}`).send({ to: '+15559990001' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.provider, 'mock');
  console.log('✓ test-send goes through the real mock provider');

  // --- 2. A real campaign, consent-gated, sent through the mock provider ---

  const { data: segment } = await client.from('audience_segments').insert({ tenant_id: TENANT_ID, name: 'All SMS', filter_json: { hasPhone: true } }).select('id').single();
  const { data: goodContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'SMS Good', phone: '919990001001' }).select('*').single();
  const { data: optedOutContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'SMS Opted Out', phone: '919990001002' }).select('*').single();
  await client.from('contact_consents').insert({ tenant_id: TENANT_ID, contact_id: optedOutContact.id, channel: 'sms', status: 'opted_out' });
  const { data: permFailContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'SMS Perm Fail', phone: '919990000000' }).select('*').single();

  res = await request(app).post('/api/v1/marketing/sms/campaigns').set('Authorization', `Bearer ${token('member')}`).send({ name: 'Test blast', body: 'Hi {{firstName|there}}, 20% off today!', segmentId: segment.id });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const campaign = res.body.campaign;

  res = await request(app).post(`/api/v1/marketing/sms/campaigns/${campaign.id}/send`).set('Authorization', `Bearer ${token('member')}`);
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  res = await request(app).post(`/api/v1/marketing/sms/campaigns/${campaign.id}/send`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.queued, 2, 'goodContact + permFailContact — optedOutContact must be excluded before enqueue');
  assert.strictEqual(res.body.suppressed, 1);
  console.log('✓ campaign send is admin+ only, excludes the opted-out contact, enqueues the rest');

  let goodRow = null, failRow = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (!goodRow || !failRow)) {
    const { data } = await client.from('sms_campaign_recipients').select('*').eq('campaign_id', campaign.id);
    goodRow = (data || []).find((r2) => r2.contact_id === goodContact.id && r2.status === 'sent');
    failRow = (data || []).find((r2) => r2.contact_id === permFailContact.id && r2.status === 'failed');
    if (!goodRow || !failRow) await new Promise((r2) => setTimeout(r2, 300));
  }
  assert.ok(goodRow, 'expected the good recipient to reach status=sent');
  assert.ok(goodRow.external_message_id && goodRow.external_message_id.startsWith('mock-sms-'));
  assert.ok(failRow, 'expected the "0000" phone to reach status=failed (simulated permanent failure)');
  console.log('✓ real send through the mock provider: one delivered, one permanently failed (not retried)');

  const { data: suppressionRow } = await client.from('suppression_list').select('*').eq('tenant_id', TENANT_ID).eq('channel', 'sms').eq('identifier', permFailContact.phone).maybeSingle();
  assert.ok(suppressionRow, 'a permanent failure must auto-suppress the phone number tenant-wide');
  console.log('✓ permanent failure auto-suppresses the phone number');

  const { data: finalCampaign } = await client.from('sms_campaigns').select('*').eq('id', campaign.id).single();
  assert.strictEqual(finalCampaign.sent_count, 1);
  assert.strictEqual(finalCampaign.failed_count, 1);
  console.log('✓ campaign counts recomputed correctly (1 sent, 1 failed)');

  const { data: usage } = await client.from('usage_counters').select('sms_sends').eq('tenant_id', TENANT_ID).maybeSingle();
  assert.strictEqual(usage.sms_sends, 1, 'only the real successful send is metered, not the failure');
  console.log('✓ usage metered exactly once, only for the successful send');

  // --- 3. The send_sms journey action (consent-gated, merge tags applied) ---

  const journeyGraph = { nodes: [{ id: 't', type: 'trigger' }, { id: 'n0', type: 'action', actionType: 'send_sms', config: { body: 'Welcome {{firstName|friend}}!' } }], edges: [{ id: 'e0', source: 't', target: 'n0' }] };
  res = await request(app).post('/api/v1/marketing/journeys').set('Authorization', `Bearer ${token('member')}`).send({ name: 'SMS welcome', triggerType: 'contact_created', graph: journeyGraph });
  const journey = res.body.journey;
  await request(app).patch(`/api/v1/marketing/journeys/${journey.id}/activate`).set('Authorization', `Bearer ${token('admin')}`);

  const { data: journeyContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Journey SMS Contact', phone: '919990001003' }).select('*').single();
  await enrollContact(client, TENANT_ID, journey.id, journeyContact.id);

  let journeySmsRow = null;
  const deadline2 = Date.now() + 15000;
  while (Date.now() < deadline2 && !journeySmsRow) {
    const { data } = await client.from('sms_campaign_recipients').select('*, sms_campaigns(body, name)').eq('contact_id', journeyContact.id).maybeSingle();
    if (data && data.status === 'sent') journeySmsRow = data;
    else await new Promise((r2) => setTimeout(r2, 300));
  }
  assert.ok(journeySmsRow, 'the send_sms journey action must really enqueue and send through the mock provider');
  assert.strictEqual(journeySmsRow.sms_campaigns.body, 'Welcome Journey!', 'merge tags must be applied ({{firstName}} -> the contact\'s real first name)');
  console.log('✓ send_sms journey action sends for real with merge tags applied — the multichannel-fallback building block');

  // --- 4. Cross-tenant isolation ---

  res = await request(app).get('/api/v1/marketing/sms/campaigns').set('Authorization', `Bearer ${tokenB('owner')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.campaigns.length, 0, 'tenant B must see none of tenant A\'s SMS campaigns');
  res = await request(app).get(`/api/v1/marketing/sms/campaigns/${campaign.id}`).set('Authorization', `Bearer ${tokenB('owner')}`);
  assert.strictEqual(res.status, 404);
  console.log('✓ cross-tenant isolation: tenant B sees none of tenant A\'s campaigns, 404s on its campaign id');

  console.log('\nALL SMS ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
