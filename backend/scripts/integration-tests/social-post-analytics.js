/**
 * Social Hub: per-post analytics pipeline (migration 036). Covers the
 * one thing a forged-JWT supertest call against a DB-free mock can't
 * prove — that GET /social/posts/:id/analytics reads real rows out of
 * Postgres through the real tenant-scoping chain (scoped() + PostgREST),
 * correctly 404s a post that belongs to a different tenant rather than
 * leaking its post_analytics rows, and computes the per-platform
 * `availability` map from the real adapter registry (facebook/instagram/
 * youtube export fetchPostAnalytics; linkedin/google_business/whatsapp
 * deliberately don't — see each adapter's header).
 *
 * This does NOT call a live Facebook/Instagram/YouTube API — there are
 * no real OAuth credentials in this environment, and per this build's
 * own rule against faking production success, the right thing is to
 * test this app's own code (storage + route + tenant isolation) against
 * rows seeded directly into Postgres, the same posture
 * social-approval.js already takes with a fake, never-actually-published
 * targetAccountIds.
 *
 * Run: node scripts/integration-tests/social-post-analytics.js
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
const { externalPostIdFor } = require(path.join(BACKEND, 'social/pollers'));

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();
const tokenA = signToken({ userId: USER_A, tenantId: TENANT_A, role: 'member' });
const tokenB = signToken({ userId: USER_B, tenantId: TENANT_B, role: 'member' });

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert([
    { id: TENANT_A, name: 'Post Analytics Tenant A', slug: 'post-analytics-a-' + Date.now() },
    { id: TENANT_B, name: 'Post Analytics Tenant B', slug: 'post-analytics-b-' + Date.now() }
  ]);
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));

  r = await client.from('users').insert([
    { id: USER_A, tenant_id: TENANT_A, email: `a-${Date.now()}@pa-test.com`, password_hash: 'x', role: 'member' },
    { id: USER_B, tenant_id: TENANT_B, email: `b-${Date.now()}@pa-test.com`, password_hash: 'x', role: 'member' }
  ]);
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  const accountFbId = randomUUID();
  const accountLiId = randomUUID();
  r = await client.from('social_accounts').insert([
    { id: accountFbId, tenant_id: TENANT_A, platform: 'facebook', account_label: 'Test FB Page', external_account_id: 'ext-fb-page', access_token: 'enc-not-real' },
    { id: accountLiId, tenant_id: TENANT_A, platform: 'linkedin', account_label: 'Test LinkedIn Profile', external_account_id: 'ext-li-profile', access_token: 'enc-not-real' }
  ]);
  if (r.error) throw new Error('social_accounts insert failed: ' + JSON.stringify(r.error));

  // A published post targeting both a platform with per-post analytics
  // (facebook) and one without (linkedin) — exercises the availability
  // map's "mixed" case, not just all-true or all-false.
  const postId = randomUUID();
  r = await client.from('scheduled_posts').insert({
    id: postId,
    tenant_id: TENANT_A,
    content: 'Analytics pipeline test post',
    target_platforms: ['facebook', 'linkedin'],
    target_account_ids: [accountFbId, accountLiId],
    scheduled_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    status: 'published',
    platform_results: {
      [accountFbId]: { status: 'published', externalPostId: 'ext-post-123', url: 'https://facebook.com/ext-post-123' },
      [accountLiId]: { status: 'published', externalPostId: 'ext-li-456', url: null }
    }
  });
  if (r.error) throw new Error('scheduled_posts insert failed: ' + JSON.stringify(r.error));

  // Seed post_analytics as if social/pollers.js's sweep had already run
  // for the facebook account (never for linkedin — no adapter support).
  r = await client.from('post_analytics').insert([
    { tenant_id: TENANT_A, scheduled_post_id: postId, social_account_id: accountFbId, platform: 'facebook', external_post_id: 'ext-post-123', metric: 'likes', value: 12, captured_date: '2026-10-14' },
    { tenant_id: TENANT_A, scheduled_post_id: postId, social_account_id: accountFbId, platform: 'facebook', external_post_id: 'ext-post-123', metric: 'likes', value: 20, captured_date: '2026-10-15' },
    { tenant_id: TENANT_A, scheduled_post_id: postId, social_account_id: accountFbId, platform: 'facebook', external_post_id: 'ext-post-123', metric: 'comments', value: 3, captured_date: '2026-10-15' }
  ]);
  if (r.error) throw new Error('post_analytics seed failed: ' + JSON.stringify(r.error));

  // --- Owning tenant sees the metrics, the latest likes value, and a correct mixed availability map ---
  let res = await request(app).get(`/api/v1/social/posts/${postId}/analytics`).set('Authorization', `Bearer ${tokenA}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.metrics.length, 3, 'all three seeded rows come back');
  assert.strictEqual(res.body.availability.facebook, true, 'facebook adapter exports fetchPostAnalytics');
  assert.strictEqual(res.body.availability.linkedin, false, 'linkedin adapter deliberately does not — see its header');
  const likeRows = res.body.metrics.filter((m) => m.metric === 'likes').sort((a, b) => a.captured_date.localeCompare(b.captured_date));
  assert.strictEqual(likeRows[likeRows.length - 1].value, 20, 'the latest day\'s value, not the first, is last in the ordered history');
  console.log('✓ GET /social/posts/:id/analytics returns real stored rows plus a correct per-platform availability map');

  // --- A re-poll upserts in place rather than duplicating (same unique constraint the route relies on to show one row per day) ---
  r = await client.from('post_analytics').upsert(
    [{ tenant_id: TENANT_A, scheduled_post_id: postId, social_account_id: accountFbId, platform: 'facebook', external_post_id: 'ext-post-123', metric: 'likes', value: 25, captured_date: '2026-10-15' }],
    { onConflict: 'scheduled_post_id,social_account_id,metric,captured_date' }
  );
  if (r.error) throw new Error('post_analytics re-poll upsert failed: ' + JSON.stringify(r.error));
  res = await request(app).get(`/api/v1/social/posts/${postId}/analytics`).set('Authorization', `Bearer ${tokenA}`);
  const likesAfterRepoll = res.body.metrics.filter((m) => m.metric === 'likes' && m.captured_date === '2026-10-15');
  assert.strictEqual(likesAfterRepoll.length, 1, 'same-day re-poll updates the existing row, never adds a second one');
  assert.strictEqual(likesAfterRepoll[0].value, 25);
  console.log('✓ a same-day re-poll upserts in place (unique(scheduled_post_id, social_account_id, metric, captured_date) holds)');

  // --- A different tenant gets a 404, not tenant B's view of tenant A's data or an empty 200 ---
  res = await request(app).get(`/api/v1/social/posts/${postId}/analytics`).set('Authorization', `Bearer ${tokenB}`);
  assert.strictEqual(res.status, 404, JSON.stringify(res.body));
  console.log('✓ cross-tenant access to another tenant\'s post analytics is a real 404, not a leak or a silent empty result');

  // --- A post id that never existed at all also 404s (not a 500) ---
  res = await request(app).get(`/api/v1/social/posts/${randomUUID()}/analytics`).set('Authorization', `Bearer ${tokenA}`);
  assert.strictEqual(res.status, 404);
  console.log('✓ a nonexistent post id 404s cleanly');

  // --- externalPostIdFor() (the sweep's own pure selection logic) agrees with what we just seeded ---
  assert.strictEqual(externalPostIdFor({ [accountFbId]: { status: 'published', externalPostId: 'ext-post-123' } }, accountFbId), 'ext-post-123');
  assert.strictEqual(externalPostIdFor({ [accountLiId]: { status: 'failed', error: 'x' } }, accountLiId), null);
  console.log('✓ externalPostIdFor() (unit-tested in isolation too) matches this test\'s seeded platform_results shape');

  console.log('\nALL POST ANALYTICS ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('POST ANALYTICS TEST FAILED:', err.message);
  process.exit(1);
});
