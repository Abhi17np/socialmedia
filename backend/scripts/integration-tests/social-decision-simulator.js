/**
 * Marketing Decision Simulator (migration 042): a REAL end-to-end run
 * against seeded scheduled_posts/post_analytics/analytics_snapshots in
 * live Postgres — proving lib/decisionSimulator.js's math runs on a
 * baseline actually gathered from real rows (routes/decisionSimulator.js's
 * gatherBaseline), not hand-fed numbers. Covers: deterministic baseline
 * computation (0-variance follower growth, so the projected numbers are
 * exact and checkable), multiplier clamping, the "low confidence" flag
 * below the minimum weeks of growth history, role gating, tenant
 * isolation, fetch-then-404-then-delete, and the AI explain endpoint's
 * fail-closed 503.
 *
 * Run: node scripts/integration-tests/social-decision-simulator.js
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

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ACCOUNT_A = randomUUID(); // 7 weeks of clean, 0-variance follower-growth history — "normal" confidence
const ACCOUNT_THIN = randomUUID(); // only 1 week of history — "low" confidence
const ADMIN_A = randomUUID();
const MEMBER_A = randomUUID();
const adminTokenA = signToken({ userId: ADMIN_A, tenantId: TENANT_A, role: 'admin' });
const memberTokenA = signToken({ userId: MEMBER_A, tenantId: TENANT_A, role: 'member' });
const viewerTokenA = signToken({ userId: randomUUID(), tenantId: TENANT_A, role: 'viewer' });
const viewerTokenB = signToken({ userId: randomUUID(), tenantId: TENANT_B, role: 'viewer' });

const LOOKBACK_WEEKS = 8;
const dayAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const dateAgo = (n) => dayAgo(n).slice(0, 10);

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert([
    { id: TENANT_A, name: 'Simulator Tenant A', slug: 'simulator-a-' + Date.now() },
    { id: TENANT_B, name: 'Simulator Tenant B', slug: 'simulator-b-' + Date.now() }
  ]);
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert([
    { id: ADMIN_A, tenant_id: TENANT_A, email: `admin-${Date.now()}@sim-test.com`, password_hash: 'x', role: 'admin' },
    { id: MEMBER_A, tenant_id: TENANT_A, email: `member-${Date.now()}@sim-test.com`, password_hash: 'x', role: 'member' }
  ]);
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));
  r = await client.from('social_accounts').insert([
    { id: ACCOUNT_A, tenant_id: TENANT_A, platform: 'instagram', account_label: 'Sim Test IG', external_account_id: 'ext-sim', access_token: 'enc-not-real' },
    { id: ACCOUNT_THIN, tenant_id: TENANT_A, platform: 'instagram', account_label: 'Thin History IG', external_account_id: 'ext-thin', access_token: 'enc-not-real' }
  ]);
  if (r.error) throw new Error('social_accounts insert failed: ' + JSON.stringify(r.error));

  // --- ACCOUNT_A: 16 published posts over 8 weeks (2/week), each with likes=10/comments=5 ---
  const posts = [];
  for (let i = 0; i < 16; i++) {
    posts.push({
      id: randomUUID(), tenant_id: TENANT_A, content: `post ${i}`, target_platforms: ['instagram'], target_account_ids: [ACCOUNT_A],
      scheduled_at: dayAgo(i * 3 + 1), status: 'published'
    });
  }
  r = await client.from('scheduled_posts').insert(posts);
  if (r.error) throw new Error('scheduled_posts insert failed: ' + JSON.stringify(r.error));
  const analyticsRows = posts.flatMap((p) => [
    { tenant_id: TENANT_A, scheduled_post_id: p.id, social_account_id: ACCOUNT_A, platform: 'instagram', external_post_id: 'ext-' + p.id, metric: 'likes', value: 10, captured_date: dateAgo(0) },
    { tenant_id: TENANT_A, scheduled_post_id: p.id, social_account_id: ACCOUNT_A, platform: 'instagram', external_post_id: 'ext-' + p.id, metric: 'comments', value: 5, captured_date: dateAgo(0) }
  ]);
  r = await client.from('post_analytics').insert(analyticsRows);
  if (r.error) throw new Error('post_analytics insert failed: ' + JSON.stringify(r.error));

  // --- ACCOUNT_A: 8 weekly follower snapshots, deterministic +50/week (0 variance), latest = 1350 ---
  const snapshotRows = [];
  for (let week = 0; week <= 7; week++) {
    snapshotRows.push({
      tenant_id: TENANT_A, social_account_id: ACCOUNT_A, platform: 'instagram', metric: 'follower_count',
      value: 1000 + (7 - week) * 50, captured_date: dateAgo(week * 7 + 3)
    });
  }
  r = await client.from('analytics_snapshots').insert(snapshotRows);
  if (r.error) throw new Error('analytics_snapshots insert failed: ' + JSON.stringify(r.error));

  // --- ACCOUNT_THIN: only 2 follower snapshots (1 week of history) — below the confidence floor ---
  r = await client.from('analytics_snapshots').insert([
    { tenant_id: TENANT_A, social_account_id: ACCOUNT_THIN, platform: 'instagram', metric: 'follower_count', value: 500, captured_date: dateAgo(10) },
    { tenant_id: TENANT_A, social_account_id: ACCOUNT_THIN, platform: 'instagram', metric: 'follower_count', value: 520, captured_date: dateAgo(3) }
  ]);
  if (r.error) throw new Error('analytics_snapshots (thin) insert failed: ' + JSON.stringify(r.error));

  // --- Validation ---
  let res = await request(app).post('/api/v1/social/decision-simulator/scenarios').set('Authorization', `Bearer ${memberTokenA}`).send({
    socialAccountId: randomUUID(), frequencyMultiplier: 2
  });
  assert.strictEqual(res.status, 404, JSON.stringify(res.body));
  console.log('✓ a nonexistent/foreign socialAccountId 404s rather than a generic 500');

  res = await request(app).post('/api/v1/social/decision-simulator/scenarios').set('Authorization', `Bearer ${memberTokenA}`).send({
    socialAccountId: ACCOUNT_A, frequencyMultiplier: -1
  });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  console.log('✓ a non-positive frequencyMultiplier is rejected at the schema level');

  res = await request(app).post('/api/v1/social/decision-simulator/scenarios').set('Authorization', `Bearer ${viewerTokenA}`).send({
    socialAccountId: ACCOUNT_A, frequencyMultiplier: 2
  });
  assert.strictEqual(res.status, 403);
  console.log('✓ POST /social/decision-simulator/scenarios is member+ gated');

  // --- A real scenario, computed from the real seeded data above ---
  res = await request(app).post('/api/v1/social/decision-simulator/scenarios').set('Authorization', `Bearer ${memberTokenA}`).send({
    socialAccountId: ACCOUNT_A, frequencyMultiplier: 2, lookbackWeeks: LOOKBACK_WEEKS
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const scenario = res.body.scenario;
  assert.strictEqual(scenario.baseline.postsPerWeek, 2, JSON.stringify(scenario.baseline)); // 16 posts / 8 weeks
  assert.strictEqual(scenario.baseline.followers, 1350, JSON.stringify(scenario.baseline));
  assert.strictEqual(scenario.baseline.followerGrowthPerWeek.mean, 50, JSON.stringify(scenario.baseline));
  assert.strictEqual(scenario.baseline.followerGrowthPerWeek.stddev, 0, JSON.stringify(scenario.baseline));
  assert.strictEqual(scenario.baseline.followerGrowthPerWeek.weeksOfData, 7, JSON.stringify(scenario.baseline));
  assert.ok(Math.abs(scenario.baseline.engagementRate - 15 / 1350) < 1e-9, JSON.stringify(scenario.baseline));
  console.log('✓ the real baseline, gathered from seeded scheduled_posts/post_analytics/analytics_snapshots, is exactly right: 2 posts/week, followers=1350, growth mean=50/stddev=0 over 7 weeks, engagement=15/1350');

  assert.strictEqual(scenario.projection.appliedMultiplier, 2);
  assert.strictEqual(scenario.projection.wasClamped, false);
  assert.strictEqual(scenario.projection.postsPerWeek, 4, JSON.stringify(scenario.projection));
  assert.strictEqual(scenario.projection.followerGrowthPerWeek.mean, 100, JSON.stringify(scenario.projection));
  assert.strictEqual(scenario.projection.followerGrowthPerWeek.low, 100, JSON.stringify(scenario.projection)); // 0 stddev -> 0 margin
  assert.strictEqual(scenario.projection.followerGrowthPerWeek.high, 100, JSON.stringify(scenario.projection));
  assert.strictEqual(scenario.projection.confidence, 'normal', JSON.stringify(scenario.projection));
  console.log('✓ the projection correctly doubles posts/week (2→4) and follower growth (50→100/week), with a zero-width interval from the real zero-variance history, and "normal" confidence at 7 weeks of data');

  // --- Clamping an unreasonable multiplier ---
  res = await request(app).post('/api/v1/social/decision-simulator/scenarios').set('Authorization', `Bearer ${memberTokenA}`).send({
    socialAccountId: ACCOUNT_A, frequencyMultiplier: 10, lookbackWeeks: LOOKBACK_WEEKS
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.scenario.projection.appliedMultiplier, 5, JSON.stringify(res.body.scenario.projection));
  assert.strictEqual(res.body.scenario.projection.wasClamped, true);
  console.log('✓ a frequencyMultiplier of 10 is clamped to the model\'s real credible range (5) and reports that it was clamped');

  // --- "Low confidence" below the minimum weeks of growth history ---
  res = await request(app).post('/api/v1/social/decision-simulator/scenarios').set('Authorization', `Bearer ${memberTokenA}`).send({
    socialAccountId: ACCOUNT_THIN, frequencyMultiplier: 1.5, lookbackWeeks: LOOKBACK_WEEKS
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.scenario.baseline.followerGrowthPerWeek.weeksOfData, 1, JSON.stringify(res.body.scenario.baseline));
  assert.strictEqual(res.body.scenario.projection.confidence, 'low', JSON.stringify(res.body.scenario.projection));
  console.log('✓ an account with only 1 week of follower-growth history is honestly flagged "low" confidence, not a falsely-precise range');

  // --- Tenant isolation ---
  res = await request(app).get(`/api/v1/social/decision-simulator/scenarios/${scenario.id}`).set('Authorization', `Bearer ${viewerTokenB}`);
  assert.strictEqual(res.status, 404, 'a different tenant must not see this scenario');
  console.log('✓ scenarios are tenant-isolated — a real 404, not a leak');

  // --- List + delete lifecycle ---
  res = await request(app).get('/api/v1/social/decision-simulator/scenarios').set('Authorization', `Bearer ${viewerTokenA}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.scenarios.length, 3, JSON.stringify(res.body.scenarios.length));
  console.log('✓ GET /social/decision-simulator/scenarios lists all 3 real scenarios created above');

  res = await request(app).delete(`/api/v1/social/decision-simulator/scenarios/${scenario.id}`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 403, 'a member cannot delete a scenario');
  res = await request(app).delete(`/api/v1/social/decision-simulator/scenarios/${scenario.id}`).set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  res = await request(app).get(`/api/v1/social/decision-simulator/scenarios/${scenario.id}`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 404, 'deleted scenario should really be gone');
  res = await request(app).delete(`/api/v1/social/decision-simulator/scenarios/${scenario.id}`).set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.status, 404, 'deleting an already-deleted scenario 404s, not a generic 500');
  console.log('✓ DELETE is admin+ gated, really removes the row, and is idempotently a 404 on a second call');

  // --- AI explain endpoint fails closed with no ANTHROPIC_API_KEY ---
  // the scenario above was just deleted; use a fresh one so this call hits "is AI configured?" before "does this scenario exist?"
  const fresh = await request(app).post('/api/v1/social/decision-simulator/scenarios').set('Authorization', `Bearer ${memberTokenA}`).send({
    socialAccountId: ACCOUNT_A, frequencyMultiplier: 1.2, lookbackWeeks: LOOKBACK_WEEKS
  });
  res = await request(app).post(`/api/v1/ai/decision-simulator/scenarios/${fresh.body.scenario.id}/explain`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 503, JSON.stringify(res.body));
  console.log('✓ POST /ai/decision-simulator/scenarios/:id/explain fails closed (503) with no ANTHROPIC_API_KEY configured');

  console.log('\nALL MARKETING DECISION SIMULATOR ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('MARKETING DECISION SIMULATOR TEST FAILED:', err);
  process.exit(1);
});
