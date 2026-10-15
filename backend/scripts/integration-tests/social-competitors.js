/**
 * Competitor Opportunity Radar (migration 040): platform validation
 * (only instagram/youtube have a real fetchCompetitor()), viewer-account
 * ownership/platform matching, duplicate-handle conflict, role gating,
 * tenant isolation, a REAL end-to-end run of
 * social/competitorSweep.js's sweep() against a stubbed adapter call
 * (proving the real DB upsert + lib/competitorRadar.js math, not just
 * hand-fed numbers), the GET detail route's own-vs-competitor
 * comparison sourced from real seeded post_analytics/analytics_snapshots,
 * and the AI gap-analysis endpoint's fail-closed 503 with no
 * ANTHROPIC_API_KEY.
 *
 * Run: node scripts/integration-tests/social-competitors.js
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
const competitorSweep = require(path.join(BACKEND, 'social/competitorSweep'));
const ADAPTERS = require(path.join(BACKEND, 'social/adapters'));
const tokenCrypto = require(path.join(BACKEND, 'social/crypto'));

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const MEMBER_A = randomUUID();
const ADMIN_A = randomUUID();
const memberTokenA = signToken({ userId: MEMBER_A, tenantId: TENANT_A, role: 'member' });
const adminTokenA = signToken({ userId: ADMIN_A, tenantId: TENANT_A, role: 'admin' });
const viewerTokenA = signToken({ userId: randomUUID(), tenantId: TENANT_A, role: 'viewer' });
const viewerTokenB = signToken({ userId: randomUUID(), tenantId: TENANT_B, role: 'viewer' });

const SNAPSHOT_DATE = new Date().toISOString().slice(0, 10);

// Stub the real Instagram/YouTube API calls — this test proves the
// sweep's own DB math and the route's comparison math, not Meta's or
// Google's live APIs (those are covered by the adapters having been
// written against each provider's real, documented endpoint shape —
// see instagram.js's and youtube.js's own fetchCompetitor() headers).
const REAL_IG_FETCH_COMPETITOR = ADAPTERS.instagram.fetchCompetitor;
function stubFetchCompetitor(followersCount, posts) {
  ADAPTERS.instagram.fetchCompetitor = async () => ({ followersCount, mediaCount: posts.length, posts });
}
function restoreFetchCompetitor() {
  ADAPTERS.instagram.fetchCompetitor = REAL_IG_FETCH_COMPETITOR;
}

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert([
    { id: TENANT_A, name: 'Competitors Tenant A', slug: 'competitors-a-' + Date.now() },
    { id: TENANT_B, name: 'Competitors Tenant B', slug: 'competitors-b-' + Date.now() }
  ]);
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert([
    { id: MEMBER_A, tenant_id: TENANT_A, email: `member-${Date.now()}@comp-test.com`, password_hash: 'x', role: 'member' },
    { id: ADMIN_A, tenant_id: TENANT_A, email: `admin-${Date.now()}@comp-test.com`, password_hash: 'x', role: 'admin' }
  ]);
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  const igAccountId = randomUUID();
  const fbAccountId = randomUUID();
  r = await client.from('social_accounts').insert([
    // getUsableAccount() (used by both the sweep and the AI endpoint)
    // really decrypts this column — unlike other integration tests that
    // never exercise that path, this one needs a genuinely decryptable
    // token, not the usual placeholder 'enc-not-real'.
    { id: igAccountId, tenant_id: TENANT_A, platform: 'instagram', account_label: 'Our IG', external_account_id: 'ext-ig', access_token: tokenCrypto.encrypt('fake-ig-token') },
    { id: fbAccountId, tenant_id: TENANT_A, platform: 'facebook', account_label: 'Our FB', external_account_id: 'ext-fb', access_token: 'enc-not-real' }
  ]);
  if (r.error) throw new Error('social_accounts insert failed: ' + JSON.stringify(r.error));

  // --- Platform validation: facebook has no fetchCompetitor() ---
  let res = await request(app).post('/api/v1/social/competitors').set('Authorization', `Bearer ${memberTokenA}`).send({
    platform: 'facebook', handle: 'rival', viewerAccountId: fbAccountId
  });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  console.log('✓ a schema-level platform not in {instagram,youtube} is rejected (zod enum)');

  // --- viewerAccountId must belong to this tenant ---
  res = await request(app).post('/api/v1/social/competitors').set('Authorization', `Bearer ${memberTokenA}`).send({
    platform: 'instagram', handle: 'rival', viewerAccountId: randomUUID()
  });
  assert.strictEqual(res.status, 404);
  console.log('✓ a nonexistent/foreign viewerAccountId 404s rather than a generic 500');

  // --- viewerAccountId must match the declared platform ---
  res = await request(app).post('/api/v1/social/competitors').set('Authorization', `Bearer ${memberTokenA}`).send({
    platform: 'instagram', handle: 'rival', viewerAccountId: fbAccountId
  });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /must be a connected instagram account/);
  console.log('✓ viewerAccountId must actually be an account on the declared platform');

  // --- Role gating: a viewer cannot track a competitor ---
  res = await request(app).post('/api/v1/social/competitors').set('Authorization', `Bearer ${viewerTokenA}`).send({
    platform: 'instagram', handle: 'rival', viewerAccountId: igAccountId
  });
  assert.strictEqual(res.status, 403);
  console.log('✓ POST /social/competitors is member+ gated');

  // --- A real, valid create ---
  res = await request(app).post('/api/v1/social/competitors').set('Authorization', `Bearer ${memberTokenA}`).send({
    platform: 'instagram', handle: 'rivalbrand', label: 'Rival Brand', viewerAccountId: igAccountId
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const competitorId = res.body.competitor.id;
  console.log('✓ a valid instagram competitor is tracked');

  // --- Duplicate handle on the same platform conflicts ---
  res = await request(app).post('/api/v1/social/competitors').set('Authorization', `Bearer ${memberTokenA}`).send({
    platform: 'instagram', handle: 'rivalbrand', viewerAccountId: igAccountId
  });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  console.log('✓ tracking the same handle+platform twice conflicts (409), not a generic 500');

  // --- Tenant isolation ---
  res = await request(app).get(`/api/v1/social/competitors/${competitorId}`).set('Authorization', `Bearer ${viewerTokenB}`);
  assert.strictEqual(res.status, 404, 'a different tenant must not see this tracked competitor');
  console.log('✓ tracked competitors are tenant-isolated — a real 404, not a leak');

  // --- Delete is admin+ only ---
  res = await request(app).delete(`/api/v1/social/competitors/${competitorId}`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 403, 'a member cannot untrack a competitor');
  console.log('✓ DELETE /social/competitors/:id is admin+ only');

  // --- THE REAL END-TO-END SWEEP: stub the adapter, run the real sweep against the real DB ---
  const now = new Date();
  const recentPost = (likes, comments, daysAgo) => ({
    caption: `Post from ${daysAgo} days ago`, likes, comments,
    createdTime: new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    permalinkUrl: 'https://instagram.com/p/fake'
  });
  stubFetchCompetitor(2000, [recentPost(100, 20, 1), recentPost(50, 10, 5), recentPost(10, 2, 40)]);
  try {
    await competitorSweep.sweep(); // the real sweep, against the real DB — not a mock
  } finally {
    restoreFetchCompetitor();
  }

  res = await request(app).get(`/api/v1/social/competitors/${competitorId}`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.competitorLatest.followers, 2000);
  assert.strictEqual(res.body.competitorLatest.mediaCount, 3);
  // Only 2 of the 3 stubbed posts fall inside the 30-day window.
  assert.strictEqual(res.body.competitorLatest.postsInWindow, 2);
  // avg engagement rate = (100+20+50+10+10+2)/3 posts/2000 followers = 192/3/2000 = 0.032
  assert.ok(Math.abs(res.body.competitorLatest.avgEngagementRate - 0.032) < 1e-9, JSON.stringify(res.body.competitorLatest));
  console.log('✓ the real sweep, against the real DB, correctly computes followers/mediaCount/postsInWindow/avgEngagementRate from stubbed adapter data');

  // --- The detail route's own-side comparison, from real seeded post_analytics/analytics_snapshots ---
  await client.from('analytics_snapshots').insert({
    tenant_id: TENANT_A, social_account_id: igAccountId, platform: 'instagram', metric: 'follower_count', value: 1000, captured_date: SNAPSHOT_DATE
  });
  const ownPostId = randomUUID();
  await client.from('scheduled_posts').insert({
    id: ownPostId, tenant_id: TENANT_A, content: 'our own recent post', target_platforms: ['instagram'], target_account_ids: [igAccountId],
    scheduled_at: new Date().toISOString(), status: 'published'
  });
  await client.from('post_analytics').insert([
    { tenant_id: TENANT_A, scheduled_post_id: ownPostId, social_account_id: igAccountId, platform: 'instagram', external_post_id: 'own-ext', metric: 'likes', value: 40, captured_date: SNAPSHOT_DATE },
    { tenant_id: TENANT_A, scheduled_post_id: ownPostId, social_account_id: igAccountId, platform: 'instagram', external_post_id: 'own-ext', metric: 'comments', value: 10, captured_date: SNAPSHOT_DATE }
  ]);

  res = await request(app).get(`/api/v1/social/competitors/${competitorId}`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.body.own.followers, 1000, JSON.stringify(res.body.own));
  // (40+10)/1 post/1000 followers = 0.05
  assert.ok(Math.abs(res.body.own.avgEngagementRate - 0.05) < 1e-9, JSON.stringify(res.body.own));
  console.log('✓ the detail route computes a real own-account comparison from this tenant\'s own stored post_analytics/analytics_snapshots, not a live call');

  // --- A real delete, fetch-then-404-then-delete ---
  res = await request(app).delete(`/api/v1/social/competitors/${competitorId}`).set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  res = await request(app).get(`/api/v1/social/competitors/${competitorId}`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 404, 'deleted competitor should really be gone');
  res = await request(app).delete(`/api/v1/social/competitors/${competitorId}`).set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.status, 404, 'deleting an already-deleted competitor 404s, not a generic 500');
  console.log('✓ DELETE really removes the row (fetch-then-404-check-then-delete), and is idempotently a 404 on a second call');

  // --- AI gap-analysis endpoint fails closed with no ANTHROPIC_API_KEY ---
  const secondCompetitor = await request(app).post('/api/v1/social/competitors').set('Authorization', `Bearer ${memberTokenA}`).send({
    platform: 'instagram', handle: 'anotherrival', viewerAccountId: igAccountId
  });
  res = await request(app).post('/api/v1/ai/compose/competitor-gaps').set('Authorization', `Bearer ${memberTokenA}`).send({
    trackedCompetitorId: secondCompetitor.body.competitor.id
  });
  assert.strictEqual(res.status, 503, JSON.stringify(res.body));
  console.log('✓ POST /ai/compose/competitor-gaps fails closed (503) with no ANTHROPIC_API_KEY configured');

  console.log('\nALL COMPETITOR OPPORTUNITY RADAR ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('COMPETITOR OPPORTUNITY RADAR TEST FAILED:', err);
  process.exit(1);
});
