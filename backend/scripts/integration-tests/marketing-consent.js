/**
 * End-to-end exercise of the consent & preference model (Marketing Hub
 * Phase 1: migrations/025_consent_preferences.sql, backend/lib/consent.js):
 * the public preference-center endpoints, the admin suppression-list and
 * per-contact consent routes in routes/marketing.js, and — the part that
 * actually matters — that an opted-out/suppressed contact is blocked
 * SERVER-SIDE from a real WhatsApp campaign send, not just hidden in a UI.
 *
 * Same setup as whatsapp-routes.js: only the network call to
 * graph.facebook.com is mocked; everything else (routes, DB via
 * PostgREST, BullMQ/Redis) is real. See this directory's README for the
 * one-time local setup.
 *
 * Run: node scripts/integration-tests/marketing-consent.js
 * (needs PostgREST + the rest-proxy + Redis running, same as
 * whatsapp-routes.js; does NOT need a separately running `node server.js`
 * — don't run one alongside this, see README's BullMQ-worker-race note)
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

// Same mock shape as whatsapp-routes.js: only graph.facebook.com is
// stubbed, every other fetch (PostgREST) passes through for real.
const realFetch = global.fetch;
const sendCallsByPhone = {};
global.fetch = async (url, opts) => {
  if (!String(url).includes('graph.facebook.com')) return realFetch(url, opts);
  if (url.includes('/message_templates') && (!opts || opts.method !== 'POST')) {
    return { ok: true, json: async () => ({ data: [{ id: 'meta-tpl-consent-1', name: 'order_update', language: 'en_US', status: 'APPROVED' }] }) };
  }
  if (url.includes('/message_templates') && opts.method === 'POST') {
    return { ok: true, json: async () => ({ id: 'meta-tpl-consent-1', status: 'APPROVED' }) };
  }
  if (url.includes('fields=whatsapp_business_account')) {
    return { ok: true, json: async () => ({ whatsapp_business_account: { id: 'waba-consent-1' } }) };
  }
  if (url.includes('/messages')) {
    const body = JSON.parse(opts.body);
    sendCallsByPhone[body.to] = (sendCallsByPhone[body.to] || 0) + 1;
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
  let r = await client.from('tenants').insert({ id: TENANT_ID, name: 'Consent Test Tenant', slug: 'consent-test-' + Date.now() });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: USER_ID, tenant_id: TENANT_ID, email: `owner-${Date.now()}@consent-test.com`, password_hash: 'x', role: 'owner' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  // Marketing Hub's admin routes (suppression list, consent overrides)
  // live behind requireHub('marketing') — flip it the same way
  // marketing-routes.js does, via the platform-admin API. Assumes a
  // platform_admins row already exists, same assumption marketing-routes.js
  // makes (see this directory's README for one-time setup).
  const { data: admin } = await client.from('platform_admins').select('id').limit(1).single();
  const jwt = require(path.join(BACKEND, 'node_modules/jsonwebtoken'));
  const platformToken = jwt.sign({ adminId: admin.id, scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  let res = await request(app).patch(`/api/v1/platform/tenants/${TENANT_ID}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  console.log('✓ Marketing Hub enabled for the test tenant');

  // --- Preference center (public, token-gated, no auth) ---

  const { data: contact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Priya Sharma', phone: '919999911111', email: 'priya@example.com', tags: ['newsletter'] }).select('*').single();

  res = await request(app).get(`/api/v1/marketing/preferences/${randomUUID()}`);
  assert.strictEqual(res.status, 404);
  console.log('✓ an unknown preference token 404s, not 500 or a data leak');

  res = await request(app).get(`/api/v1/marketing/preferences/${contact.preference_token}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.channels.whatsapp.status, 'unknown');
  console.log('✓ preference center resolves a real contact by token, no auth required');

  res = await request(app).post(`/api/v1/marketing/preferences/${contact.preference_token}`).send({ channels: { whatsapp: 'opted_out' } });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.channels.whatsapp.status, 'opted_out');
  console.log('✓ contact self-service opt-out via preference center, no login');

  const { data: consentRow } = await client.from('contact_consents').select('*').eq('contact_id', contact.id).eq('channel', 'whatsapp').single();
  assert.strictEqual(consentRow.status, 'opted_out');
  assert.strictEqual(consentRow.source, 'preference_center');
  console.log('✓ real contact_consents row written, attributed to the preference center');

  // --- Suppression list (admin-managed) ---

  res = await request(app).get('/api/v1/marketing/suppression-list').set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200);
  console.log('✓ viewer can read the suppression list');

  res = await request(app).post('/api/v1/marketing/suppression-list').set('Authorization', `Bearer ${token('member')}`).send({ channel: 'whatsapp', identifier: '919999922222', reason: 'manual' });
  assert.strictEqual(res.status, 403);
  console.log('✓ member blocked from adding a suppression entry (admin+ only)');

  res = await request(app).post('/api/v1/marketing/suppression-list').set('Authorization', `Bearer ${token('admin')}`).send({ channel: 'whatsapp', identifier: '919999922222', reason: 'manual' });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const suppressionEntry = res.body.entry;
  console.log('✓ admin added a manual suppression entry');

  res = await request(app).delete(`/api/v1/marketing/suppression-list/${suppressionEntry.id}`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200);
  res = await request(app).get('/api/v1/marketing/suppression-list').set('Authorization', `Bearer ${token('admin')}`);
  assert.ok(!res.body.entries.some((e) => e.id === suppressionEntry.id));
  console.log('✓ admin removed the suppression entry, confirmed gone');

  // --- Per-contact consent admin view + manual override ---

  res = await request(app).get(`/api/v1/marketing/contacts/${contact.id}/consent`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.channels.whatsapp.status, 'opted_out');
  console.log('✓ admin UI can read a contact\'s real consent state');

  res = await request(app).patch(`/api/v1/marketing/contacts/${contact.id}/consent`).set('Authorization', `Bearer ${token('member')}`).send({ channel: 'email', status: 'opted_out' });
  assert.strictEqual(res.status, 403);
  console.log('✓ member blocked from manually overriding consent (admin+ only)');

  // --- THE critical assertion: server-side send-blocking enforcement ---

  const { data: account } = await client.from('social_accounts').insert({
    tenant_id: TENANT_ID, platform: 'whatsapp', external_account_id: 'phone-consent-' + Date.now(), access_token: tokenCrypto.encrypt('real-looking-access-token')
  }).select('*').single();

  res = await request(app).post('/api/v1/whatsapp/templates').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'order_update', language: 'en_US', category: 'utility', bodyText: 'Hi {{1}}, your order {{2}} shipped.',
    variableSamples: ['Jane', 'ORD-42'], socialAccountId: account.id
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const template = res.body.template;
  res = await request(app).post(`/api/v1/whatsapp/templates/${template.id}/submit`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  // Three contacts matching the same segment: one with no consent record
  // (must still send — see lib/consent.js's header for why), one who
  // already self-service opted out above, one freshly globally
  // unsubscribed. Only the first should ever reach the Meta API.
  const { data: consentedContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Consented Contact', phone: '919999933333', tags: ['blast'] }).select('*').single();
  const { data: optedOutContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Opted Out Contact', phone: '919999944444', tags: ['blast'] }).select('*').single();
  await client.from('contact_consents').insert({ tenant_id: TENANT_ID, contact_id: optedOutContact.id, channel: 'whatsapp', status: 'opted_out', source: 'manual', opted_out_at: new Date().toISOString() });
  const { data: globallyUnsubscribedContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Globally Unsubscribed', phone: '919999955555', tags: ['blast'], global_opt_out_at: new Date().toISOString() }).select('*').single();

  res = await request(app).post('/api/v1/whatsapp/segments').set('Authorization', `Bearer ${token('member')}`).send({ name: 'Blast segment', filter: { tags: ['blast'], hasPhone: true } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const segment = res.body.segment;

  res = await request(app).get(`/api/v1/whatsapp/segments/${segment.id}/preview`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.whatsappEligibleCount, 1, 'preview should already exclude the opted-out and globally-unsubscribed contacts, not just hide them client-side');
  assert.strictEqual(res.body.suppressedCount, 2);
  console.log('✓ segment preview count is consent-aware (1 eligible, 2 suppressed), not just the raw tag match');

  res = await request(app).post('/api/v1/whatsapp/campaigns').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Consent-gated blast', socialAccountId: account.id, templateId: template.id, segmentId: segment.id, variableValues: ['Jane', 'ORD-42']
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const campaign = res.body.campaign;

  res = await request(app).post(`/api/v1/whatsapp/campaigns/${campaign.id}/send`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.queued, 1, 'only the consented contact should be queued');
  assert.strictEqual(res.body.suppressed, 2, 'the response must say how many were blocked, not silently drop them');
  console.log('✓ POST /campaigns/:id/send only queued the one consented contact, reported 2 suppressed');

  // Give the (real) BullMQ worker a moment to actually process the one
  // real job and confirm it really reached the (mocked) Meta API.
  const deadline = Date.now() + 15000;
  let sentRow = null;
  while (Date.now() < deadline) {
    const { data } = await client.from('whatsapp_campaign_recipients').select('*').eq('campaign_id', campaign.id).eq('contact_id', consentedContact.id).maybeSingle();
    if (data && data.status === 'sent') { sentRow = data; break; }
    await new Promise((r2) => setTimeout(r2, 300));
  }
  assert.ok(sentRow, 'expected the consented contact to actually be sent');
  console.log('✓ the consented contact was actually sent (real BullMQ job, mocked Meta call)');

  assert.strictEqual(sendCallsByPhone['919999933333'] || 0, 1, 'the consented contact should have exactly one real send attempt');
  assert.strictEqual(sendCallsByPhone['919999944444'] || 0, 0, 'the opted-out contact must NEVER reach the Meta API, not even once');
  assert.strictEqual(sendCallsByPhone['919999955555'] || 0, 0, 'the globally-unsubscribed contact must NEVER reach the Meta API, not even once');
  console.log('✓ the two blocked contacts never reached graph.facebook.com — this is enforced server-side, not just hidden in a UI');

  // Segment-backed sends never insert a recipient row for a contact
  // filtered out before the upsert in the first place (nothing to mark
  // "suppressed" — it was never queued), unlike an explicit-contactIds
  // campaign's pre-existing rows, which DO get relabeled (see
  // routes/whatsapp.js's send handler) since those existed before this
  // send attempt reconfirmed consent.
  const { data: optedOutRow } = await client.from('whatsapp_campaign_recipients').select('*').eq('campaign_id', campaign.id).eq('contact_id', optedOutContact.id).maybeSingle();
  assert.strictEqual(optedOutRow, null, 'a segment-backed send should never create a recipient row for a contact that was filtered out before the upsert');
  console.log('✓ the opted-out contact never got a recipient row at all for this segment-backed send');

  // --- Global unsubscribe cascades to a real suppression-list entry ---

  res = await request(app).post(`/api/v1/marketing/preferences/${consentedContact.preference_token}`).send({ globalOptOut: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const { data: cascadedSuppression } = await client.from('suppression_list').select('*').eq('tenant_id', TENANT_ID).eq('channel', 'whatsapp').eq('identifier', '919999933333').maybeSingle();
  assert.ok(cascadedSuppression, 'a global unsubscribe should also suppress the WhatsApp identifier outright');
  assert.strictEqual(cascadedSuppression.reason, 'global_unsubscribe');
  console.log('✓ global unsubscribe via the preference center cascades into a real suppression_list entry');

  console.log('\nALL CONSENT & PREFERENCE ASSERTIONS PASSED');
  await broadcastQueue.stop();
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
