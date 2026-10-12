/**
 * Integration tests — boot the real Express app (server.js, which
 * exports `app` rather than calling listen() when require()'d — see its
 * require.main guard) and hit real routes with supertest and forged
 * JWTs. Unlike test/plans.test.js and test/query.test.js, which test
 * pure functions in isolation, these prove the actual role-gating
 * middleware chain behaves correctly end to end — specifically, that
 * the privilege-escalation bug (POST /social/posts and
 * /social/media/upload had no requireRole at all) stays fixed. No real
 * Supabase project is available in CI, so these only assert on what
 * happens BEFORE a route reaches the database: requireRole runs ahead
 * of every handler body, so a 403 proves the gate fired and anything
 * else (402/404/503/500) proves it let the request through to try the
 * database — which is all these tests need to know.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-integration-tests';
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.PORT = process.env.PORT || '0'; // unused — require.main guard means server.js never calls listen() here anyway

const request = require('supertest');
const app = require('../server');
const { signToken, signPlatformToken } = require('../lib/auth');

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const token = (role) => signToken({ userId: `u-${role}`, tenantId: TENANT_ID, role });

test('viewer cannot publish a post — POST /social/posts requires member+', async () => {
  const res = await request(app)
    .post('/api/v1/social/posts')
    .set('Authorization', `Bearer ${token('viewer')}`)
    .send({ content: 'hi', targetPlatforms: ['facebook'], targetAccountIds: ['11111111-1111-1111-1111-111111111111'], scheduledAt: '2030-01-01T00:00:00Z' });
  assert.equal(res.status, 403);
});

test('member can attempt to publish a post — role gate lets it through to the handler', async () => {
  const res = await request(app)
    .post('/api/v1/social/posts')
    .set('Authorization', `Bearer ${token('member')}`)
    .send({ content: 'hi', targetPlatforms: ['facebook'], targetAccountIds: ['11111111-1111-1111-1111-111111111111'], scheduledAt: '2030-01-01T00:00:00Z' });
  assert.notEqual(res.status, 403);
});

test('viewer cannot upload media — POST /social/media/upload requires member+', async () => {
  const res = await request(app)
    .post('/api/v1/social/media/upload')
    .set('Authorization', `Bearer ${token('viewer')}`);
  assert.equal(res.status, 403);
});

test('viewer cannot read billing/usage — owner-only, matching the Billing nav item', async () => {
  const res = await request(app)
    .get('/api/v1/billing/usage')
    .set('Authorization', `Bearer ${token('viewer')}`);
  assert.equal(res.status, 403);
});

test('owner can read billing/usage — role gate lets it through', async () => {
  const res = await request(app)
    .get('/api/v1/billing/usage')
    .set('Authorization', `Bearer ${token('owner')}`);
  assert.notEqual(res.status, 403);
});

test('viewer cannot start an OAuth connect flow — admin-only', async () => {
  const res = await request(app)
    .get('/api/v1/social/connect/facebook')
    .set('Authorization', `Bearer ${token('viewer')}`);
  assert.equal(res.status, 403);
});

test('team roster stays open to every role — Inbox assignee dropdown needs it, per routes/team.js\'s own comment', async () => {
  const res = await request(app)
    .get('/api/v1/team/members')
    .set('Authorization', `Bearer ${token('viewer')}`);
  assert.notEqual(res.status, 403);
  assert.notEqual(res.status, 401);
});

test('a platform-admin token is rejected by tenant routes', async () => {
  const res = await request(app)
    .get('/api/v1/social/accounts')
    .set('Authorization', `Bearer ${signPlatformToken({ adminId: 'admin-1' })}`);
  assert.equal(res.status, 401);
});

test('a tenant token is rejected by platform-admin routes', async () => {
  const res = await request(app)
    .get('/api/v1/platform/tenants')
    .set('Authorization', `Bearer ${token('owner')}`);
  assert.equal(res.status, 401);
});

test('no token at all is rejected', async () => {
  const res = await request(app).get('/api/v1/social/accounts');
  assert.equal(res.status, 401);
});

test('a bad interactionStatus value is rejected by zod before it reaches the database', async () => {
  const res = await request(app)
    .patch('/api/v1/social/interactions/message/11111111-1111-1111-1111-111111111111')
    .set('Authorization', `Bearer ${token('member')}`)
    .send({ interactionStatus: 'not-a-real-status' });
  assert.equal(res.status, 400);
});

test('CORS reflects only the configured FRONTEND_URL origin', async () => {
  const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example.com');
  assert.notEqual(res.headers['access-control-allow-origin'], 'https://evil.example.com');
});

test('helmet security headers are present', async () => {
  const res = await request(app).get('/api/v1/health');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

// --- WhatsApp outbound (routes/whatsapp.js) — same no-DB-needed
// reasoning as the rest of this file: requireRole runs before any
// database call, so these are safe without a real Supabase project.
test('viewer cannot create a WhatsApp template — requires member+', async () => {
  const res = await request(app)
    .post('/api/v1/whatsapp/templates')
    .set('Authorization', `Bearer ${token('viewer')}`)
    .send({ name: 'x', bodyText: 'y', socialAccountId: '11111111-1111-1111-1111-111111111111' });
  assert.equal(res.status, 403);
});

test('member cannot submit a WhatsApp template for approval — requires admin+', async () => {
  const res = await request(app)
    .post('/api/v1/whatsapp/templates/11111111-1111-1111-1111-111111111111/submit')
    .set('Authorization', `Bearer ${token('member')}`);
  assert.equal(res.status, 403);
});

test('member cannot send a WhatsApp campaign — requires admin+ (sends to real recipients)', async () => {
  const res = await request(app)
    .post('/api/v1/whatsapp/campaigns/11111111-1111-1111-1111-111111111111/send')
    .set('Authorization', `Bearer ${token('member')}`);
  assert.equal(res.status, 403);
});

// --- Sales Hub / Marketing Hub (routes/sales.js, routes/marketing.js)
// — requireHub() runs before requireRole and needs a real database to
// check tenants.hubs_enabled, so a role-gate assertion like the ones
// above can't run without a live Supabase project (it would always see
// hub-check failure first). What IS safe to assert without a database:
// requireAuth's own checks, which run before either gate.
test('a platform-admin token is rejected by Sales Hub routes', async () => {
  const res = await request(app)
    .get('/api/v1/sales/companies')
    .set('Authorization', `Bearer ${signPlatformToken({ adminId: 'admin-1' })}`);
  assert.equal(res.status, 401);
});

test('a platform-admin token is rejected by Marketing Hub routes', async () => {
  const res = await request(app)
    .get('/api/v1/marketing/campaigns')
    .set('Authorization', `Bearer ${signPlatformToken({ adminId: 'admin-1' })}`);
  assert.equal(res.status, 401);
});

test('no token at all is rejected by Sales Hub routes', async () => {
  const res = await request(app).get('/api/v1/sales/companies');
  assert.equal(res.status, 401);
});

test('no token at all is rejected by Marketing Hub routes', async () => {
  const res = await request(app).get('/api/v1/marketing/campaigns');
  assert.equal(res.status, 401);
});

// Regression guard for a real bug: routes/sales.js and routes/marketing.js
// originally had `router.use(requireHub(...))` as a blanket mount on the
// router object itself. Since both routers are mounted bare (no path
// prefix) on tenantRouter, that blanket middleware ran for EVERY request
// that reached that router — including requests meant for the OTHER
// Hub's routes, or any route mounted after it — before Express ever
// tried to match a specific path pattern. Same bug class as the
// authLimiter/requireRole mounting mistakes this app hit earlier; see
// routes/sales.js's and routes/marketing.js's git history for the fix.
// Guard it structurally so it can't silently come back: requireHub must
// only ever appear as a per-route argument, never as a bare router.use().
test('requireHub is never blanket-mounted on the Sales/Marketing Hub routers (regression guard)', () => {
  const fs = require('node:fs');
  for (const file of ['../routes/sales.js', '../routes/marketing.js']) {
    const source = fs.readFileSync(require.resolve(file), 'utf8');
    assert.doesNotMatch(
      source,
      /router\.use\(\s*requireHub\(/,
      `${file} must apply requireHub() per-route (as a middleware argument on each router.get/post/patch/delete call), never as a blanket router.use() — a bare router.use(requireHub(...)) runs for every request reaching that router object, including ones meant for other routes mounted alongside it.`
    );
  }
});

test('the auth rate limiter returns real JSON, not express-rate-limit\'s plain-text default', async () => {
  // authLimiter's cap is 20 — exhaust it on an isolated endpoint
  // (platform login, also under authLimiter) so this doesn't affect
  // other tests' requests against tenant routes under apiLimiter.
  let last;
  for (let i = 0; i < 21; i++) {
    last = await request(app).post('/api/v1/platform/login').send({ email: 'x@x.com', password: 'wrongpassword' });
  }
  assert.equal(last.status, 429);
  assert.equal(last.headers['content-type'].includes('application/json'), true);
  assert.equal(typeof last.body.error, 'string');
});
