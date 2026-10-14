/**
 * Exercises the Sales Hub email/calendar connection scaffolding
 * (routes/salesEmail.js, email/providers/*) against a real app instance
 * and Postgres via PostgREST — see this directory's README for setup.
 *
 * This environment has no real GMAIL_OAUTH_CLIENT_ID/SECRET or
 * MS365_CLIENT_ID/SECRET/TENANT_ID, which is exactly the condition
 * these assertions are about: status/connect must report an honest
 * "not configured" state rather than ever faking a connection. A
 * second pass flips one provider "configured" (fake env vars, just to
 * exercise the code path) to confirm /connect then returns a real,
 * correctly-shaped authorize URL instead of just always 400ing.
 *
 * Run: node scripts/integration-tests/sales-email-integration.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-integration-tests';
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('hex');
process.env.SUPABASE_URL_SOCIAL = process.env.SUPABASE_URL_SOCIAL || 'http://localhost:3001';
process.env.SUPABASE_KEY_SOCIAL = process.env.SUPABASE_KEY_SOCIAL || '';
process.env.PORT = '0';
delete process.env.GMAIL_OAUTH_CLIENT_ID;
delete process.env.GMAIL_OAUTH_CLIENT_SECRET;
delete process.env.MS365_CLIENT_ID;
delete process.env.MS365_CLIENT_SECRET;
delete process.env.MS365_TENANT_ID;

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

  await client.from('tenants').insert({ id: tenantId, name: 'Email Integration Test Tenant', slug: 'sales-email-' + Date.now(), hubs_enabled: { sales: true, marketing: false } });
  await client.from('users').insert({ id: ownerId, tenant_id: tenantId, email: `owner-${Date.now()}@email-test.com`, password_hash: 'x', role: 'member' });
  const memberToken = token(tenantId, ownerId, 'member');

  // --- No credentials configured anywhere in this environment ---

  let r = await api('/api/v1/sales/email/status', { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.providers.length, 2, 'both gmail and microsoft365 must be listed');
  for (const p of r.data.providers) {
    assert.strictEqual(p.configured, false, `${p.provider} must report configured:false with no OAuth env vars set`);
    assert.strictEqual(p.connected, false, `${p.provider} must report connected:false — nothing is ever faked as connected`);
    assert.strictEqual(p.emailAddress, null);
  }
  console.log('✓ GET /sales/email/status reports an honest not-configured, not-connected state for every provider');

  r = await api('/api/v1/sales/email/connect/gmail', { auth: memberToken });
  assert.strictEqual(r.status, 400, JSON.stringify(r.data));
  assert.strictEqual(r.data.code, 'PROVIDER_NOT_CONFIGURED');
  assert.ok(!r.data.url, '/connect must never hand back a redirect url when the provider is not configured');
  console.log('✓ GET /sales/email/connect/gmail refuses with PROVIDER_NOT_CONFIGURED instead of faking a connect flow');

  r = await api('/api/v1/sales/email/connect/not-a-real-provider', { auth: memberToken });
  assert.strictEqual(r.status, 404, JSON.stringify(r.data));
  console.log('✓ an unregistered provider name 404s instead of 500ing');

  // Disconnecting a provider that was never connected must be a clean
  // no-op (same convention as sales_saved_views' cross-user delete) —
  // never a 404/500 for "there was nothing to disconnect".
  r = await api('/api/v1/sales/email/gmail/disconnect', { method: 'POST', auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.success, true);
  console.log('✓ disconnecting a never-connected provider is a clean no-op, not an error');

  // --- Now simulate an administrator having configured Gmail OAuth ---
  // (fake client id/secret — just enough to exercise isConfigured() and
  // buildAuthUrl(); exchangeCode() against a real Google code is exactly
  // the one thing this environment genuinely cannot test, and nothing
  // here tries to fake that part.)

  process.env.GMAIL_OAUTH_CLIENT_ID = 'test-gmail-client-id';
  process.env.GMAIL_OAUTH_CLIENT_SECRET = 'test-gmail-client-secret';

  r = await api('/api/v1/sales/email/status', { auth: memberToken });
  const gmailStatus = r.data.providers.find((p) => p.provider === 'gmail');
  assert.strictEqual(gmailStatus.configured, true, 'status must flip to configured:true once env vars are set');
  console.log('✓ GET /sales/email/status reflects newly-configured credentials');

  r = await api('/api/v1/sales/email/connect/gmail', { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), `must redirect to Google's real authorize endpoint: ${r.data.url}`);
  assert.ok(r.data.url.includes('client_id=test-gmail-client-id'));
  assert.ok(r.data.url.includes('scope='), 'authorize url must request explicit scopes, not a default/unscoped grant');
  assert.ok(r.data.url.includes('state='), 'authorize url must carry a signed state param for CSRF protection on the callback');
  console.log('✓ once configured, GET /sales/email/connect/gmail returns a real, correctly-shaped Google OAuth authorize URL');

  // --- The callback must still fail closed against a forged/garbage state ---

  r = await api('/api/v1/sales/email/callback/gmail?code=whatever&state=not-a-real-signed-state');
  assert.strictEqual(r.status, 400, JSON.stringify(r.text));
  console.log('✓ the OAuth callback rejects an invalid/forged state instead of trusting it');

  console.log('\nALL SALES EMAIL/CALENDAR INTEGRATION ASSERTIONS PASSED');
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
