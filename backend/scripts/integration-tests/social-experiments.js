/**
 * AI Content Experiment Engine (migration 038): creation validation
 * (same-account, single-account-per-post, no reusing a post across
 * experiments), tenant isolation, admin-only cancel, and — the part
 * that matters most — a REAL end-to-end run of
 * lib/experimentSweep.js's sweep() against seeded post_analytics/
 * analytics_snapshots rows in live Postgres, proving the real
 * two-proportion z-test in lib/experimentStats.js actually decides
 * (or correctly refuses to decide) from real stored data, not just
 * from hand-fed numbers in a unit test.
 *
 * Run: node scripts/integration-tests/social-experiments.js
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
const experimentSweep = require(path.join(BACKEND, 'lib/experimentSweep'));

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const MEMBER_A = randomUUID();
const ADMIN_A = randomUUID();
const memberTokenA = signToken({ userId: MEMBER_A, tenantId: TENANT_A, role: 'member' });
const adminTokenA = signToken({ userId: ADMIN_A, tenantId: TENANT_A, role: 'admin' });
const viewerTokenB = signToken({ userId: randomUUID(), tenantId: TENANT_B, role: 'viewer' });

// 48h ago — comfortably past the default 24h min_observation_hours.
const PUBLISHED_AT = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
const SNAPSHOT_DATE = PUBLISHED_AT.slice(0, 10);

async function makePublishedPost(client, tenantId, accountId) {
  const id = randomUUID();
  const { error } = await client.from('scheduled_posts').insert({
    id, tenant_id: tenantId, content: 'variant content', target_platforms: ['facebook'], target_account_ids: [accountId],
    scheduled_at: PUBLISHED_AT, status: 'published',
    platform_results: { [accountId]: { status: 'published', externalPostId: 'ext-' + id, url: null } }
  });
  if (error) throw new Error('post insert failed: ' + JSON.stringify(error));
  return id;
}

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert([
    { id: TENANT_A, name: 'Experiment Tenant A', slug: 'experiments-a-' + Date.now() },
    { id: TENANT_B, name: 'Experiment Tenant B', slug: 'experiments-b-' + Date.now() }
  ]);
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert([
    { id: MEMBER_A, tenant_id: TENANT_A, email: `member-${Date.now()}@exp-test.com`, password_hash: 'x', role: 'member' },
    { id: ADMIN_A, tenant_id: TENANT_A, email: `admin-${Date.now()}@exp-test.com`, password_hash: 'x', role: 'admin' }
  ]);
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  const accountId = randomUUID();
  const otherAccountId = randomUUID();
  r = await client.from('social_accounts').insert([
    { id: accountId, tenant_id: TENANT_A, platform: 'facebook', account_label: 'Main Page', external_account_id: 'ext-main', access_token: 'enc-not-real' },
    { id: otherAccountId, tenant_id: TENANT_A, platform: 'facebook', account_label: 'Other Page', external_account_id: 'ext-other', access_token: 'enc-not-real' }
  ]);
  if (r.error) throw new Error('social_accounts insert failed: ' + JSON.stringify(r.error));

  const postA = await makePublishedPost(client, TENANT_A, accountId);
  const postB = await makePublishedPost(client, TENANT_A, accountId);
  const postOnOtherAccount = await makePublishedPost(client, TENANT_A, otherAccountId);

  // --- Validation: both variants must target the same account ---
  let res = await request(app).post('/api/v1/experiments').set('Authorization', `Bearer ${memberTokenA}`).send({
    name: 'cross-account test', variable: 'hook',
    variants: [{ key: 'A', scheduledPostId: postA }, { key: 'B', scheduledPostId: postOnOtherAccount }]
  });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /same connected account/);
  console.log('✓ creating an experiment across two different accounts is rejected with a clear 400');

  // --- Validation: a nonexistent post 404s ---
  res = await request(app).post('/api/v1/experiments').set('Authorization', `Bearer ${memberTokenA}`).send({
    name: 'missing post test', variable: 'caption',
    variants: [{ key: 'A', scheduledPostId: postA }, { key: 'B', scheduledPostId: randomUUID() }]
  });
  assert.strictEqual(res.status, 404);
  console.log('✓ a nonexistent post id 404s rather than a generic 500');

  // --- A viewer cannot create one ---
  const viewerTokenA = signToken({ userId: randomUUID(), tenantId: TENANT_A, role: 'viewer' });
  res = await request(app).post('/api/v1/experiments').set('Authorization', `Bearer ${viewerTokenA}`).send({
    name: 'should be forbidden', variable: 'cta', variants: [{ key: 'A', scheduledPostId: postA }, { key: 'B', scheduledPostId: postB }]
  });
  assert.strictEqual(res.status, 403);
  console.log('✓ POST /experiments is member+ gated');

  // --- A real, valid experiment creates successfully ---
  res = await request(app).post('/api/v1/experiments').set('Authorization', `Bearer ${memberTokenA}`).send({
    name: 'Hook test: question vs statement', variable: 'hook',
    variants: [{ key: 'A', scheduledPostId: postA }, { key: 'B', scheduledPostId: postB }]
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const experimentId = res.body.experiment.id;
  assert.strictEqual(res.body.experiment.status, 'running');
  console.log('✓ a valid same-account, two-variant experiment is created with status "running"');

  // --- A post already used in one experiment can't be reused in another ---
  const postC = await makePublishedPost(client, TENANT_A, accountId);
  res = await request(app).post('/api/v1/experiments').set('Authorization', `Bearer ${memberTokenA}`).send({
    name: 'reuse attempt', variable: 'caption',
    variants: [{ key: 'A', scheduledPostId: postA }, { key: 'B', scheduledPostId: postC }]
  });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  console.log('✓ a post already used as a variant cannot be reused in a second experiment (409)');

  // --- Tenant isolation ---
  res = await request(app).get(`/api/v1/experiments/${experimentId}`).set('Authorization', `Bearer ${viewerTokenB}`);
  assert.strictEqual(res.status, 404, 'a different tenant must not see this experiment');
  console.log('✓ experiments are tenant-isolated — a real 404, not a leak');

  // --- Cancel is admin+ only ---
  const experimentToCancel = await request(app).post('/api/v1/experiments').set('Authorization', `Bearer ${memberTokenA}`).send({
    name: 'to be cancelled', variable: 'format',
    variants: [{ key: 'A', scheduledPostId: postC }, { key: 'B', scheduledPostId: await makePublishedPost(client, TENANT_A, accountId) }]
  });
  res = await request(app).patch(`/api/v1/experiments/${experimentToCancel.body.experiment.id}/cancel`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 403, 'a member cannot cancel an experiment');
  res = await request(app).patch(`/api/v1/experiments/${experimentToCancel.body.experiment.id}/cancel`).set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.experiment.status, 'cancelled');
  console.log('✓ cancelling an experiment is admin+ only, and really persists');

  // --- THE REAL END-TO-END STATISTICAL DECISION: seed real post_analytics/analytics_snapshots, run the actual sweep ---
  const { data: followerSeed } = await client.from('analytics_snapshots').insert({
    tenant_id: TENANT_A, social_account_id: accountId, platform: 'facebook', metric: 'fans', value: 1000, captured_date: SNAPSHOT_DATE
  }).select().single();
  assert.ok(followerSeed, 'follower snapshot should insert');

  // Variant A: 150 likes on 1000 followers (15%). Variant B: 30 likes on the same 1000 followers (3%) — an unmistakable, real difference.
  await client.from('post_analytics').insert([
    { tenant_id: TENANT_A, scheduled_post_id: postA, social_account_id: accountId, platform: 'facebook', external_post_id: 'ext-' + postA, metric: 'likes', value: 150, captured_date: SNAPSHOT_DATE },
    { tenant_id: TENANT_A, scheduled_post_id: postB, social_account_id: accountId, platform: 'facebook', external_post_id: 'ext-' + postB, metric: 'likes', value: 30, captured_date: SNAPSHOT_DATE }
  ]);

  await experimentSweep.sweep(); // the real sweep, against the real DB — not a mock

  res = await request(app).get(`/api/v1/experiments/${experimentId}`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.body.experiment.status, 'decided', JSON.stringify(res.body.experiment));
  const winningVariant = (res.body.variants || []).find((v) => v.id === res.body.experiment.winner_variant_id);
  assert.ok(winningVariant, 'a winner_variant_id should be set and resolve to a real variant');
  assert.strictEqual(winningVariant.variant_key, 'A', 'variant A (15% engagement) should beat variant B (3%) on the real seeded data');
  assert.ok(res.body.experiment.p_value < 0.05, `expected a significant p-value, got ${res.body.experiment.p_value}`);
  console.log('✓ the real sweep, against real seeded post_analytics/analytics_snapshots data, correctly decides variant A as the winner with a significant p-value');

  // --- Insufficient data: a tiny audience must refuse to decide, even with a huge rate gap ---
  const tinyAccountId = randomUUID();
  await client.from('social_accounts').insert({ id: tinyAccountId, tenant_id: TENANT_A, platform: 'facebook', account_label: 'Tiny Page', external_account_id: 'ext-tiny', access_token: 'enc-not-real' });
  const tinyPostA = await makePublishedPost(client, TENANT_A, tinyAccountId);
  const tinyPostB = await makePublishedPost(client, TENANT_A, tinyAccountId);
  await client.from('analytics_snapshots').insert({ tenant_id: TENANT_A, social_account_id: tinyAccountId, platform: 'facebook', metric: 'fans', value: 20, captured_date: SNAPSHOT_DATE }); // well below the default min_sample_size of 100
  await client.from('post_analytics').insert([
    { tenant_id: TENANT_A, scheduled_post_id: tinyPostA, social_account_id: tinyAccountId, platform: 'facebook', external_post_id: 'ext-' + tinyPostA, metric: 'likes', value: 18, captured_date: SNAPSHOT_DATE },
    { tenant_id: TENANT_A, scheduled_post_id: tinyPostB, social_account_id: tinyAccountId, platform: 'facebook', external_post_id: 'ext-' + tinyPostB, metric: 'likes', value: 1, captured_date: SNAPSHOT_DATE }
  ]);
  const tinyExperiment = await request(app).post('/api/v1/experiments').set('Authorization', `Bearer ${memberTokenA}`).send({
    name: 'tiny audience test', variable: 'cta', variants: [{ key: 'A', scheduledPostId: tinyPostA }, { key: 'B', scheduledPostId: tinyPostB }]
  });
  await experimentSweep.sweep();
  res = await request(app).get(`/api/v1/experiments/${tinyExperiment.body.experiment.id}`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.body.experiment.status, 'insufficient_data', JSON.stringify(res.body.experiment));
  assert.strictEqual(res.body.experiment.winner_variant_id, null, 'no winner may be named when data is insufficient, no matter how large the raw rate gap looks (90% vs 5%)');
  console.log('✓ a tiny audience (20 followers, below the min_sample_size of 100) refuses to declare a winner even with a 90% vs 5% raw rate gap');

  console.log('\nALL CONTENT EXPERIMENT ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('CONTENT EXPERIMENT TEST FAILED:', err.message);
  process.exit(1);
});
