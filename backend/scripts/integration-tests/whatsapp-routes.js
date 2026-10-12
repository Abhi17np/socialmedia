/**
 * End-to-end exercise of routes/whatsapp.js + social/adapters/whatsapp.js
 * + social/broadcastQueue.js + the WhatsApp delivery-status webhook,
 * against a real app instance (require()'d, not a running server),
 * a real Postgres via PostgREST, and a real Redis/BullMQ worker. Only
 * the actual network call to graph.facebook.com is mocked — see
 * `rest-proxy.js`/`postgrest.conf.example` and this directory's README
 * for the one-time local setup.
 *
 * Run: node scripts/integration-tests/whatsapp-routes.js
 * (needs PostgREST + the rest-proxy + Redis running; does NOT need a
 * separately running `node server.js` — it requires server.js directly)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-integration-tests';
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('hex');
process.env.SUPABASE_URL_SOCIAL = process.env.SUPABASE_URL_SOCIAL || 'http://localhost:3001';
process.env.SUPABASE_KEY_SOCIAL = process.env.SUPABASE_KEY_SOCIAL || '';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.META_APP_ID = process.env.META_APP_ID || 'test-app-id';
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'test-app-secret';
process.env.PORT = '0';

if (!process.env.SUPABASE_KEY_SOCIAL) {
  console.error('SUPABASE_KEY_SOCIAL is not set — see this directory\'s README for how to mint a service_role JWT for your local PostgREST instance.');
  process.exit(1);
}

const path = require('path');
const assert = require('assert');
const { randomUUID } = require('crypto');
const request = require('supertest');
const BACKEND = path.join(__dirname, '..', '..');

// Mock the Meta Graph API itself (not our own code) — everything from
// the route down through the adapter runs for real; only the actual
// network call to graph.facebook.com is stubbed. Any other fetch
// (supabase-js's own REST calls to the local PostgREST instance) passes
// through to the real fetch — overriding global.fetch wholesale
// silently breaks every DB call otherwise, since supabase-js swallows a
// throwing fetch as a result-shaped {error}, not a thrown exception.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (!String(url).includes('graph.facebook.com')) return realFetch(url, opts);
  if (url.includes('/message_templates') && (!opts || opts.method !== 'POST')) {
    return { ok: true, json: async () => ({ data: [{ id: 'meta-tpl-1', name: 'order_update', language: 'en_US', status: 'APPROVED' }] }) };
  }
  if (url.includes('/message_templates') && opts.method === 'POST') {
    return { ok: true, json: async () => ({ id: 'meta-tpl-1', status: 'APPROVED' }) };
  }
  if (url.includes('fields=whatsapp_business_account')) {
    return { ok: true, json: async () => ({ whatsapp_business_account: { id: 'waba-1' } }) };
  }
  if (url.includes('/messages')) {
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.' + Math.random().toString(36).slice(2) }] }) };
  }
  throw new Error('Unexpected fetch call in test: ' + url);
};

const app = require(path.join(BACKEND, 'server.js'));
const { signToken } = require(path.join(BACKEND, 'lib/auth'));
const { getSocialClient } = require(path.join(BACKEND, 'social/db'));
const tokenCrypto = require(path.join(BACKEND, 'social/crypto'));
const broadcastQueue = require(path.join(BACKEND, 'social/broadcastQueue'));
broadcastQueue.start();

const TENANT_ID = randomUUID();
const USER_ID = randomUUID();
const token = (role) => signToken({ userId: USER_ID, tenantId: TENANT_ID, role });

async function main() {
  const client = getSocialClient();
  let r = await client.from('tenants').insert({ id: TENANT_ID, name: 'WA Test Tenant', slug: 'wa-test-tenant-' + Date.now() });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: USER_ID, tenant_id: TENANT_ID, email: `owner-${Date.now()}@wa-test.com`, password_hash: 'x', role: 'owner' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  const { data: account } = await client.from('social_accounts').insert({
    tenant_id: TENANT_ID, platform: 'whatsapp', external_account_id: 'phone-' + Date.now(), access_token: tokenCrypto.encrypt('real-looking-access-token')
  }).select('*').single();

  let res = await request(app).post('/api/v1/whatsapp/templates').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'order_update', language: 'en_US', category: 'utility', bodyText: 'Hi {{1}}, your order {{2}} shipped.',
    variableSamples: ['Jane', 'ORD-42'], socialAccountId: account.id
  });
  assert.strictEqual(res.status, 201, 'create template: ' + JSON.stringify(res.body));
  const template = res.body.template;
  assert.strictEqual(template.approval_status, 'draft');
  console.log('✓ template created as draft');

  res = await request(app).post('/api/v1/whatsapp/templates').set('Authorization', `Bearer ${token('viewer')}`).send({ name: 'x', bodyText: 'y', socialAccountId: account.id });
  assert.strictEqual(res.status, 403);
  console.log('✓ viewer blocked from creating template');

  res = await request(app).post(`/api/v1/whatsapp/templates/${template.id}/submit`).set('Authorization', `Bearer ${token('member')}`);
  assert.strictEqual(res.status, 403);
  console.log('✓ member blocked from submitting template (admin+ only)');

  res = await request(app).post(`/api/v1/whatsapp/templates/${template.id}/submit`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.template.approval_status, 'approved');
  assert.strictEqual(res.body.template.meta_template_id, 'meta-tpl-1');
  console.log('✓ template submitted and approved (via mocked Meta Graph API)');

  const { data: contact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Jane Doe', phone: '919999900001', tags: ['vip'] }).select('*').single();

  res = await request(app).post('/api/v1/whatsapp/segments').set('Authorization', `Bearer ${token('member')}`).send({ name: 'VIP customers', filter: { tags: ['vip'], hasPhone: true } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const segment = res.body.segment;
  console.log('✓ segment created');

  res = await request(app).get(`/api/v1/whatsapp/segments/${segment.id}/preview`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.whatsappEligibleCount, 1, JSON.stringify(res.body));
  console.log('✓ segment preview resolves real contact count');

  res = await request(app).post('/api/v1/whatsapp/campaigns').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Launch blast', socialAccountId: account.id, templateId: template.id, segmentId: segment.id, variableValues: ['Jane', 'ORD-42']
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const campaign = res.body.campaign;
  assert.strictEqual(campaign.status, 'draft');
  console.log('✓ campaign created as draft');

  res = await request(app).post(`/api/v1/whatsapp/campaigns/${campaign.id}/send`).set('Authorization', `Bearer ${token('member')}`);
  assert.strictEqual(res.status, 403);
  console.log('✓ member blocked from sending campaign (admin+ only)');

  res = await request(app).post(`/api/v1/whatsapp/campaigns/${campaign.id}/send`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.queued, 1);
  console.log('✓ campaign send resolved 1 real recipient and enqueued it');

  let recipientRow = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { data } = await client.from('whatsapp_campaign_recipients').select('*').eq('campaign_id', campaign.id).eq('contact_id', contact.id).maybeSingle();
    if (data && data.status === 'sent') { recipientRow = data; break; }
    await new Promise((r2) => setTimeout(r2, 300));
  }
  assert.ok(recipientRow, 'expected recipient to reach status=sent');
  assert.ok(recipientRow.external_message_id && recipientRow.external_message_id.startsWith('wamid.'));
  console.log('✓ recipient marked sent with a real external_message_id from the (mocked) Meta response');

  const { data: finalCampaign } = await client.from('whatsapp_campaigns').select('*').eq('id', campaign.id).single();
  assert.strictEqual(finalCampaign.sent_count, 1);
  assert.strictEqual(finalCampaign.status, 'completed');
  console.log('✓ campaign counts recomputed, status=completed');

  const crypto = require('crypto');
  const webhookBody = JSON.stringify({
    entry: [{ changes: [{ value: { metadata: { phone_number_id: account.external_account_id }, statuses: [{ id: recipientRow.external_message_id, status: 'delivered' }] } }] }]
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(webhookBody).digest('hex');
  res = await request(app).post('/api/v1/social/webhook/whatsapp').set('Content-Type', 'application/json').set('x-hub-signature-256', sig).send(webhookBody);
  assert.strictEqual(res.status, 200);
  await new Promise((r2) => setTimeout(r2, 500));
  const { data: afterWebhook } = await client.from('whatsapp_campaign_recipients').select('status, delivered_at').eq('id', recipientRow.id).single();
  assert.strictEqual(afterWebhook.status, 'delivered');
  assert.ok(afterWebhook.delivered_at);
  console.log('✓ delivery-status webhook updated recipient to delivered via mark_whatsapp_recipient_status RPC');

  res = await request(app).post('/api/v1/whatsapp/templates').set('Authorization', `Bearer ${token('member')}`).send({ name: 'unapproved_tpl', bodyText: 'Hello there', socialAccountId: account.id });
  const draftTemplate = res.body.template;
  res = await request(app).post('/api/v1/whatsapp/campaigns').set('Authorization', `Bearer ${token('member')}`).send({ name: 'Blocked campaign', socialAccountId: account.id, templateId: draftTemplate.id, segmentId: segment.id });
  const blockedCampaign = res.body.campaign;
  res = await request(app).post(`/api/v1/whatsapp/campaigns/${blockedCampaign.id}/send`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'TEMPLATE_NOT_APPROVED');
  console.log('✓ sending a campaign with an unapproved template is correctly blocked with 409 TEMPLATE_NOT_APPROVED');

  console.log('\nALL WHATSAPP ROUTE ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
