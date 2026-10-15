/**
 * Crisis Intelligence (migration 041): a REAL end-to-end run of
 * social/crisisSweep.js's surge-detection sweep against seeded
 * inbox_messages/mentions rows in live Postgres — proving the actual
 * z-score math in lib/crisisDetection.js decides from real stored data,
 * not hand-fed numbers (same discipline as social-experiments.js's own
 * end-to-end run) — plus the alert lifecycle (acknowledge/resolve), the
 * "never double-alert while one's open, but do alert again after
 * resolution" rule, tenant isolation, role gating, and the AI summary
 * endpoint's fail-closed 503.
 *
 * Run: node scripts/integration-tests/social-crisis.js
 * (needs PostgREST + the rest-proxy running; does NOT need Redis or a
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
const crisisSweep = require(path.join(BACKEND, 'social/crisisSweep'));

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ACCOUNT_A = randomUUID();
const ADMIN_A = randomUUID();
const MEMBER_A = randomUUID();
const adminTokenA = signToken({ userId: ADMIN_A, tenantId: TENANT_A, role: 'admin' });
const memberTokenA = signToken({ userId: MEMBER_A, tenantId: TENANT_A, role: 'member' });
const viewerTokenA = signToken({ userId: randomUUID(), tenantId: TENANT_A, role: 'viewer' });
const viewerTokenB = signToken({ userId: randomUUID(), tenantId: TENANT_B, role: 'viewer' });

const WINDOW_MS = 3 * 60 * 60 * 1000; // matches crisisSweep.js's WINDOW_HOURS
// A timestamp safely inside the middle of the bucket `bucketsAgo` windows back from now.
const tsFor = (bucketsAgo) => new Date(Date.now() - bucketsAgo * WINDOW_MS - WINDOW_MS / 2).toISOString();

async function insertInboxMessages(client, tenantId, count, bucketsAgo) {
  if (count === 0) return;
  const rows = Array.from({ length: count }, () => ({
    tenant_id: tenantId, social_account_id: ACCOUNT_A, platform: 'facebook',
    external_thread_id: 'thread-' + randomUUID(), external_message_id: 'msg-' + randomUUID(),
    sender: 'angry_customer', message: 'Why is this broken?!', direction: 'inbound',
    received_at: tsFor(bucketsAgo)
  }));
  const { error } = await client.from('inbox_messages').insert(rows);
  if (error) throw new Error('inbox_messages insert failed: ' + JSON.stringify(error));
}

async function insertMentions(client, tenantId, count, bucketsAgo) {
  if (count === 0) return;
  const rows = Array.from({ length: count }, () => ({
    tenant_id: tenantId, social_account_id: ACCOUNT_A, platform: 'facebook',
    external_id: 'mention-' + randomUUID(), author: 'frustrated_fan', text: 'Seeing a lot of complaints about this today.',
    url: 'https://facebook.com/post/fake', captured_at: tsFor(bucketsAgo)
  }));
  const { error } = await client.from('mentions').insert(rows);
  if (error) throw new Error('mentions insert failed: ' + JSON.stringify(error));
}

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert([
    { id: TENANT_A, name: 'Crisis Tenant A', slug: 'crisis-a-' + Date.now() },
    { id: TENANT_B, name: 'Crisis Tenant B', slug: 'crisis-b-' + Date.now() }
  ]);
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert([
    { id: ADMIN_A, tenant_id: TENANT_A, email: `admin-${Date.now()}@crisis-test.com`, password_hash: 'x', role: 'admin' },
    { id: MEMBER_A, tenant_id: TENANT_A, email: `member-${Date.now()}@crisis-test.com`, password_hash: 'x', role: 'member' }
  ]);
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));
  // crisisSweep.js discovers tenants to evaluate from active social_accounts — it never
  // decrypts this account's token (no outbound API call happens in this feature at all).
  r = await client.from('social_accounts').insert({
    id: ACCOUNT_A, tenant_id: TENANT_A, platform: 'facebook', account_label: 'Crisis Test Page', external_account_id: 'ext-crisis', access_token: 'enc-not-real', status: 'active'
  });
  if (r.error) throw new Error('social_accounts insert failed: ' + JSON.stringify(r.error));

  // --- Baseline: 14 trailing 3h buckets alternating 1/3 messages each (mean=2, stddev=1) ---
  for (let bucketsAgo = 1; bucketsAgo <= 14; bucketsAgo++) {
    await insertInboxMessages(client, TENANT_A, bucketsAgo % 2 === 1 ? 1 : 3, bucketsAgo);
  }

  // --- Before the sweep runs, there should be no alert yet ---
  let res = await request(app).get('/api/v1/social/crisis-alerts').set('Authorization', `Bearer ${viewerTokenA}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.alerts.length, 0);
  console.log('✓ no alert exists before the sweep has run, even with baseline data seeded');

  // --- The current window: a real surge — 15 inbox messages + 5 mentions = 20, vs. a baseline mean of 2 ---
  await insertInboxMessages(client, TENANT_A, 15, 0);
  await insertMentions(client, TENANT_A, 5, 0);

  await crisisSweep.sweep(); // the real sweep, against the real DB — not a mock

  res = await request(app).get('/api/v1/social/crisis-alerts').set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.alerts.length, 1, JSON.stringify(res.body.alerts));
  const alert = res.body.alerts[0];
  assert.strictEqual(alert.status, 'open');
  assert.strictEqual(alert.message_count, 20, JSON.stringify(alert));
  assert.strictEqual(Number(alert.baseline_mean), 2, JSON.stringify(alert));
  assert.strictEqual(Number(alert.baseline_stddev), 1, JSON.stringify(alert));
  assert.strictEqual(Number(alert.z_score), 18, JSON.stringify(alert)); // (20-2)/1
  console.log('✓ the real sweep, against real seeded inbox_messages/mentions, correctly computes a 20-vs-baseline-2 surge with z=18 and opens an alert');

  // --- Re-running the sweep with no new data must not open a second alert ---
  await crisisSweep.sweep();
  res = await request(app).get('/api/v1/social/crisis-alerts').set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.body.alerts.length, 1, 'a second sweep tick must not open a duplicate alert while one is already open');
  console.log('✓ re-running the sweep while an alert is open does not create a duplicate');

  // --- The detail view's real evidence: the actual 20 messages, from both sources ---
  res = await request(app).get(`/api/v1/social/crisis-alerts/${alert.id}`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.messages.length, 20, JSON.stringify(res.body.messages.length));
  assert.strictEqual(res.body.messages.filter((m) => m.source === 'inbox').length, 15);
  assert.strictEqual(res.body.messages.filter((m) => m.source === 'mention').length, 5);
  console.log('✓ the detail view resolves the alert\'s window to the real 15 inbox messages + 5 mentions that made it up');

  // --- Tenant isolation ---
  res = await request(app).get(`/api/v1/social/crisis-alerts/${alert.id}`).set('Authorization', `Bearer ${viewerTokenB}`);
  assert.strictEqual(res.status, 404, 'a different tenant must not see this alert');
  console.log('✓ crisis alerts are tenant-isolated — a real 404, not a leak');

  // --- Acknowledge is member+, resolve is admin+ ---
  res = await request(app).patch(`/api/v1/social/crisis-alerts/${alert.id}/acknowledge`).set('Authorization', `Bearer ${viewerTokenA}`);
  assert.strictEqual(res.status, 403, 'a viewer cannot acknowledge an alert');
  res = await request(app).patch(`/api/v1/social/crisis-alerts/${alert.id}/acknowledge`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.alert.status, 'acknowledged');
  res = await request(app).patch(`/api/v1/social/crisis-alerts/${alert.id}/acknowledge`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 409, 'acknowledging an already-acknowledged alert conflicts rather than silently succeeding');
  console.log('✓ acknowledge is member+ gated, really persists, and is not re-triggerable once acknowledged');

  res = await request(app).patch(`/api/v1/social/crisis-alerts/${alert.id}/resolve`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 403, 'a member cannot resolve an alert');
  res = await request(app).patch(`/api/v1/social/crisis-alerts/${alert.id}/resolve`).set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.alert.status, 'resolved');
  res = await request(app).patch(`/api/v1/social/crisis-alerts/${alert.id}/resolve`).set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.status, 409, 'resolving an already-resolved alert conflicts rather than silently succeeding');
  console.log('✓ resolve is admin+ gated, really persists, and is not re-triggerable once resolved');

  // --- After resolution, a NEW surge should open a fresh alert (resolved doesn't block future detection) ---
  await insertInboxMessages(client, TENANT_A, 15, 0);
  await insertMentions(client, TENANT_A, 5, 0);
  await crisisSweep.sweep();
  res = await request(app).get('/api/v1/social/crisis-alerts').set('Authorization', `Bearer ${adminTokenA}`);
  const openAlerts = res.body.alerts.filter((a) => a.status === 'open');
  assert.strictEqual(openAlerts.length, 1, 'a fresh surge after resolution should open a new alert');
  assert.strictEqual(res.body.alerts.length, 2, 'the resolved alert should still exist alongside the new one');
  console.log('✓ a new surge after the previous alert was resolved opens a fresh alert, rather than staying silent forever');

  // --- AI summary endpoint fails closed with no ANTHROPIC_API_KEY ---
  res = await request(app).post(`/api/v1/ai/crisis-alerts/${openAlerts[0].id}/summarize`).set('Authorization', `Bearer ${viewerTokenA}`);
  assert.strictEqual(res.status, 503, JSON.stringify(res.body));
  console.log('✓ POST /ai/crisis-alerts/:id/summarize fails closed (503) with no ANTHROPIC_API_KEY configured');

  console.log('\nALL CRISIS INTELLIGENCE ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('CRISIS INTELLIGENCE TEST FAILED:', err);
  process.exit(1);
});
