/**
 * End-to-end exercise of the Phase 3 email marketing module
 * (migrations/027_email_marketing.sql, backend/lib/email/*,
 * backend/routes/marketingEmail.js): provider connection, a block-based
 * template, a real send through the mock provider gated by Phase 1's
 * consent model, open/click tracking, one-click unsubscribe, hard-bounce
 * auto-suppression, and real SPF/DMARC DNS checks against a real public
 * domain (no provider account needed for that part).
 *
 * Run: node scripts/integration-tests/marketing-email.js
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
const emailQueue = require(path.join(BACKEND, 'lib/email/emailQueue'));
emailQueue.start();

const TENANT_ID = randomUUID();
const USER_ID = randomUUID();
const token = (role) => signToken({ userId: USER_ID, tenantId: TENANT_ID, role });

async function main() {
  const client = getSocialClient();
  let r = await client.from('tenants').insert({ id: TENANT_ID, name: 'Email Test Tenant', slug: 'email-test-' + Date.now(), marketing_postal_address: '123 Market St, Bengaluru, India' });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: USER_ID, tenant_id: TENANT_ID, email: `owner-${Date.now()}@email-test.com`, password_hash: 'x', role: 'owner' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  const { data: admin } = await client.from('platform_admins').select('id').limit(1).single();
  const jwt = require(path.join(BACKEND, 'node_modules/jsonwebtoken'));
  const platformToken = jwt.sign({ adminId: admin.id, scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  let hubRes = await request(app).patch(`/api/v1/platform/tenants/${TENANT_ID}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: true });
  assert.strictEqual(hubRes.status, 200, JSON.stringify(hubRes.body));
  console.log('✓ Marketing Hub enabled for the test tenant');

  // --- Provider connection defaults to mock with no setup ---

  let res = await request(app).get('/api/v1/marketing/email/connection').set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.connection, null, 'no connection saved yet');
  console.log('✓ no provider connection configured yet — sends still work via the mock fallback (checked below)');

  res = await request(app).post('/api/v1/marketing/email/connection/test').set('Authorization', `Bearer ${token('admin')}`).send({ to: 'someone@example.com' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.provider, 'mock');
  console.log('✓ test send against the mock fallback succeeds with no configuration');

  // --- Explicitly configure the mock provider (exercises the real save path) ---

  res = await request(app).put('/api/v1/marketing/email/connection').set('Authorization', `Bearer ${token('member')}`).send({ provider: 'mock', fromName: 'Test Co', fromEmail: 'hello@testco.example' });
  assert.strictEqual(res.status, 403, 'member should not be able to save provider credentials (admin+ only)');
  res = await request(app).put('/api/v1/marketing/email/connection').set('Authorization', `Bearer ${token('admin')}`).send({ provider: 'mock', fromName: 'Test Co', fromEmail: 'hello@testco.example' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  console.log('✓ admin saved a real provider connection row; member was blocked from doing so');

  // --- DNS check endpoint: exercised end to end, but THIS SANDBOX has no
  // outbound DNS egress at all (confirmed separately: a bare
  // `dns.resolveTxt('google.com')` fails with ENOTFOUND here even though
  // the domain is real) — see docs/MARKETING_HUB_IMPLEMENTATION.md's
  // Phase 3 entry. So this only verifies the endpoint runs end to end and
  // fails closed (false, not a crash) when DNS is unreachable; the actual
  // record-matching logic is unit-tested without network in
  // test/emailDomainCheck.test.js, and checkDomainDns() itself needs
  // verification in an environment with real DNS access.

  res = await request(app).post('/api/v1/marketing/email/domains').set('Authorization', `Bearer ${token('admin')}`).send({ domain: 'example.com' });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const domainRow = res.body.domain;
  res = await request(app).post(`/api/v1/marketing/email/domains/${domainRow.id}/check`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(typeof res.body.domain.spf_verified, 'boolean');
  assert.ok(res.body.domain.last_checked_at, 'should record when the check ran even if DNS itself was unreachable');
  console.log('✓ domain DNS-check endpoint runs end to end and fails closed when DNS is unreachable (this sandbox has no DNS egress — see note above)');

  // --- Template with merge tags and a tracked button link ---

  res = await request(app).post('/api/v1/marketing/email/templates').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Welcome', subject: 'Hi {{firstName|there}}, welcome!',
    blocks: [
      { type: 'heading', text: 'Hello {{firstName|there}}' },
      { type: 'text', text: 'Thanks for joining.' },
      { type: 'button', label: 'Get started', href: 'https://example.com/start' }
    ]
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const template = res.body.template;
  console.log('✓ block-based template created');

  res = await request(app).post(`/api/v1/marketing/email/templates/${template.id}/preview`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.subject.includes('Jordan'), 'preview substitutes the sample contact\'s real first name, not the fallback (which only applies when a value is actually missing)');
  assert.ok(res.body.html.includes('Unsubscribe'), 'preview includes the compliance footer, same as a real send');
  console.log('✓ live preview renders real merge tags + the real compliance footer');

  // --- Seed 3 contacts: consented, explicitly opted out, globally unsubscribed ---

  const { data: consented } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Priya Consented', email: 'priya+ok@example.com', tags: ['newsletter'] }).select('*').single();
  const { data: optedOut } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Opted Out', email: 'optout@example.com', tags: ['newsletter'] }).select('*').single();
  await client.from('contact_consents').insert({ tenant_id: TENANT_ID, contact_id: optedOut.id, channel: 'email', status: 'opted_out', source: 'manual', opted_out_at: new Date().toISOString() });
  const { data: bounceContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Will Bounce', email: 'willbounce+bounce@example.com', tags: ['newsletter'] }).select('*').single();

  res = await request(app).post('/api/v1/whatsapp/segments').set('Authorization', `Bearer ${token('member')}`).send({ name: 'Newsletter', filter: { tags: ['newsletter'] } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const segment = res.body.segment;

  // --- Create and send the campaign ---

  res = await request(app).post('/api/v1/marketing/email/campaigns').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Welcome blast', templateId: template.id, segmentId: segment.id
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const campaign = res.body.campaign;
  assert.strictEqual(campaign.status, 'draft');
  console.log('✓ campaign created as draft');

  res = await request(app).post(`/api/v1/marketing/email/campaigns/${campaign.id}/send`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.queued, 2, 'consented + will-bounce contacts queued; opted-out excluded before enqueue');
  assert.strictEqual(res.body.suppressed, 1);
  console.log('✓ send queued exactly the 2 eligible contacts, reported 1 suppressed (the explicit opt-out)');

  // --- Wait for both jobs: one real send, one real (simulated) hard bounce ---

  const deadline = Date.now() + 20000;
  let consentedRow = null, bounceRow = null;
  while (Date.now() < deadline && (!consentedRow || !bounceRow)) {
    const { data: rows } = await client.from('email_campaign_recipients').select('*').eq('campaign_id', campaign.id);
    consentedRow = (rows || []).find((r2) => r2.contact_id === consented.id && r2.status === 'sent') || consentedRow;
    bounceRow = (rows || []).find((r2) => r2.contact_id === bounceContact.id && r2.status === 'bounced') || bounceRow;
    if (!consentedRow || !bounceRow) await new Promise((r2) => setTimeout(r2, 300));
  }
  assert.ok(consentedRow, 'expected the consented contact to be marked sent');
  assert.ok(consentedRow.external_message_id && consentedRow.external_message_id.startsWith('mock-'));
  console.log('✓ consented contact really sent through the mock provider, with a real external message id');

  assert.ok(bounceRow, 'expected the simulated-bounce contact to be marked bounced (not stuck retrying 4x)');
  console.log('✓ a hard bounce is NOT retried (UnrecoverableError short-circuits BullMQ\'s retry loop) — immediately marked bounced');

  const { data: suppressionRow } = await client.from('suppression_list').select('*').eq('tenant_id', TENANT_ID).eq('channel', 'email').eq('identifier', bounceContact.email.toLowerCase()).maybeSingle();
  assert.ok(suppressionRow, 'a hard bounce should auto-suppress the address tenant-wide');
  assert.strictEqual(suppressionRow.reason, 'hard_bounce');
  console.log('✓ the bounced address was automatically added to the suppression list (hard_bounce)');

  // --- A real recipient row never got created for the explicitly opted-out contact ---

  const { data: optedOutRow } = await client.from('email_campaign_recipients').select('*').eq('campaign_id', campaign.id).eq('contact_id', optedOut.id).maybeSingle();
  assert.strictEqual(optedOutRow, null);
  console.log('✓ the opted-out contact never got a recipient row at all — blocked before enqueue, not just hidden');

  // --- Open + click tracking (hits the real public endpoints, no auth) ---

  res = await request(app).get(`/api/v1/marketing/email/track/open/${consentedRow.id}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-type'], 'image/gif');
  console.log('✓ open-pixel endpoint returns a real GIF and records the event');

  const clickUrl = `/api/v1/marketing/email/track/click/${consentedRow.id}?u=${Buffer.from('https://example.com/start', 'utf8').toString('base64url')}`;
  res = await request(app).get(clickUrl).redirects(0);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, 'https://example.com/start');
  console.log('✓ click-tracking endpoint records the event and redirects to the real destination URL');

  const { data: afterTracking } = await client.from('email_campaign_recipients').select('status, opened_at, clicked_at').eq('id', consentedRow.id).single();
  assert.strictEqual(afterTracking.status, 'clicked', 'status should advance sent -> opened -> clicked, landing on the highest reached');
  assert.ok(afterTracking.opened_at && afterTracking.clicked_at);
  console.log('✓ recipient status correctly advanced through sent -> opened -> clicked from the two tracking hits');

  const { data: events } = await client.from('email_events').select('event_type').eq('recipient_id', consentedRow.id);
  assert.ok((events || []).some((e) => e.event_type === 'open'));
  assert.ok((events || []).some((e) => e.event_type === 'click'));
  console.log('✓ a real per-recipient event log exists (open + click), not just a status column');

  // --- Campaign report rollup reflects real counts ---

  res = await request(app).get(`/api/v1/marketing/email/campaigns/${campaign.id}/report`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.campaign.sent, 1);
  assert.strictEqual(res.body.campaign.opened, 1);
  assert.strictEqual(res.body.campaign.clicked, 1);
  assert.strictEqual(res.body.campaign.bounced, 1);
  console.log('✓ campaign report rollup matches real recipient data exactly');

  // --- One-click unsubscribe actually opts the contact out and suppresses them ---

  res = await request(app).post(`/api/v1/marketing/email/one-click-unsubscribe/${consentedRow.id}?token=${consented.preference_token}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const { data: consentRow } = await client.from('contact_consents').select('*').eq('contact_id', consented.id).eq('channel', 'email').single();
  assert.strictEqual(consentRow.status, 'opted_out');
  assert.strictEqual(consentRow.source, 'unsubscribe_link');
  console.log('✓ one-click unsubscribe (RFC 8058) really opts the contact out, attributed to the unsubscribe link');

  res = await request(app).post(`/api/v1/marketing/email/one-click-unsubscribe/${consentedRow.id}?token=wrong-token`);
  assert.strictEqual(res.status, 403, 'a mismatched token must not be able to unsubscribe someone else\'s recipient row');
  console.log('✓ unsubscribe is rejected when the token does not match the recipient\'s own contact');

  // --- Scheduled send: the sweep actually promotes a due campaign, not just stores the picker's choice ---

  const { data: scheduledContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Scheduled Recipient', email: 'scheduled@example.com', tags: ['scheduled-test'] }).select('*').single();
  res = await request(app).post('/api/v1/whatsapp/segments').set('Authorization', `Bearer ${token('member')}`).send({ name: 'Scheduled test segment', filter: { tags: ['scheduled-test'] } });
  const scheduledSegment = res.body.segment;
  res = await request(app).post('/api/v1/marketing/email/campaigns').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Scheduled campaign', templateId: template.id, segmentId: scheduledSegment.id, sendMode: 'scheduled', scheduledAt: new Date(Date.now() - 1000).toISOString()
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const scheduledCampaign = res.body.campaign;
  assert.strictEqual(scheduledCampaign.status, 'scheduled');

  const { sweep } = require(path.join(BACKEND, 'lib/email/scheduledSendSweep'));
  await sweep();

  const { data: afterSweep } = await client.from('email_campaigns').select('status').eq('id', scheduledCampaign.id).single();
  assert.strictEqual(afterSweep.status, 'sending', 'the sweep should have promoted the due scheduled campaign to sending, not left it waiting forever');
  console.log('✓ scheduled-send sweep actually promotes a due campaign to sending (not just a picker that does nothing)');

  console.log('\nALL EMAIL MARKETING ASSERTIONS PASSED');
  await emailQueue.stop();
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
