/**
 * Social Hub: Brand Memory (migration 037) CRUD + brand-aware AI
 * wiring. Covers what a forged-JWT supertest call against a DB-free
 * mock can't prove: GET /social/brand-memory returns real defaults for
 * an unconfigured tenant, PATCH is admin+ only and really persists
 * (verified by a second GET through the real PostgREST round trip),
 * writes a real audit_log row, and is tenant-isolated — plus a
 * regression check that wiring getBrandProfile() into the three
 * existing AI endpoints didn't change their fail-closed 503 behavior
 * (no ANTHROPIC_API_KEY in this environment, same posture as every
 * other AI integration test).
 *
 * Run: node scripts/integration-tests/social-brand-memory.js
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
const ADMIN_A = randomUUID();
const MEMBER_A = randomUUID();
const adminTokenA = signToken({ userId: ADMIN_A, tenantId: TENANT_A, role: 'admin' });
const memberTokenA = signToken({ userId: MEMBER_A, tenantId: TENANT_A, role: 'member' });
const viewerTokenB = signToken({ userId: randomUUID(), tenantId: TENANT_B, role: 'viewer' });

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert([
    { id: TENANT_A, name: 'Brand Memory Tenant A', slug: 'brand-memory-a-' + Date.now() },
    { id: TENANT_B, name: 'Brand Memory Tenant B', slug: 'brand-memory-b-' + Date.now() }
  ]);
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert([
    { id: ADMIN_A, tenant_id: TENANT_A, email: `admin-${Date.now()}@bm-test.com`, password_hash: 'x', role: 'admin' },
    { id: MEMBER_A, tenant_id: TENANT_A, email: `member-${Date.now()}@bm-test.com`, password_hash: 'x', role: 'member' }
  ]);
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  // --- An unconfigured tenant gets real, usable defaults, not an error or a null ---
  let res = await request(app).get('/api/v1/social/brand-memory').set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.profile, { tone: null, audience: null, preferred_terms: [], banned_terms: [], prohibited_claims: [], approved_messaging: [] });
  console.log('✓ GET /social/brand-memory returns real, usable defaults for an unconfigured tenant');

  // --- A member cannot write it ---
  res = await request(app).patch('/api/v1/social/brand-memory').set('Authorization', `Bearer ${memberTokenA}`).send({ tone: 'should not save' });
  assert.strictEqual(res.status, 403, 'a member cannot edit brand memory');
  console.log('✓ PATCH /social/brand-memory is admin+ only');

  // --- An admin can write it, and it really persists through a second GET ---
  res = await request(app).patch('/api/v1/social/brand-memory').set('Authorization', `Bearer ${adminTokenA}`).send({
    tone: 'warm and concise',
    audience: 'small business owners',
    preferredTerms: ['teammate'],
    bannedTerms: ['synergy'],
    prohibitedClaims: ['guaranteed results'],
    approvedMessaging: ['We ship real, working software.']
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.profile.tone, 'warm and concise');

  res = await request(app).get('/api/v1/social/brand-memory').set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.body.profile.audience, 'small business owners');
  assert.deepEqual(res.body.profile.banned_terms, ['synergy']);
  assert.deepEqual(res.body.profile.prohibited_claims, ['guaranteed results']);
  console.log('✓ a PATCH by an admin really persists — a second GET sees it through the real PostgREST round trip');

  // --- Real audit_log row, not just a UI-only action ---
  const { data: auditRows } = await client.from('audit_log').select('*').eq('tenant_id', TENANT_A).eq('action', 'social.brand_memory.updated');
  assert.ok(auditRows && auditRows.length === 1, 'expected exactly one brand_memory.updated audit row');
  assert.strictEqual(auditRows[0].actor_user_id, ADMIN_A);
  console.log('✓ updating brand memory writes a real audit_log row');

  // --- Tenant isolation: a different tenant sees its own (unconfigured) defaults, never tenant A's data ---
  res = await request(app).get('/api/v1/social/brand-memory').set('Authorization', `Bearer ${viewerTokenB}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.profile.tone, null, 'tenant B must not see tenant A\'s brand memory');
  console.log('✓ brand memory is tenant-isolated — a different tenant never sees another tenant\'s profile');

  // --- Regression: wiring getBrandProfile() into the AI endpoints didn't break their fail-closed 503 ---
  res = await request(app).post('/api/v1/ai/compose/draft').set('Authorization', `Bearer ${memberTokenA}`).send({ brief: 'test', platforms: ['facebook'] });
  assert.strictEqual(res.status, 503, 'draft should still fail closed without ANTHROPIC_API_KEY');
  res = await request(app).post('/api/v1/ai/compose/hashtags').set('Authorization', `Bearer ${memberTokenA}`).send({ content: 'test', platforms: ['facebook'] });
  assert.strictEqual(res.status, 503);
  res = await request(app).post('/api/v1/ai/compose/repurpose').set('Authorization', `Bearer ${memberTokenA}`).send({ sourceContent: 'test', targetPlatforms: ['facebook'] });
  assert.strictEqual(res.status, 503, 'repurpose should fail closed the same way as every other AI endpoint');
  console.log('✓ /ai/compose/{draft,hashtags,repurpose} all still fail closed with 503 now that they read brand memory first');

  // --- /ai/compose/repurpose is member+ gated and schema-validated, same bar as /compose/draft ---
  const viewerTokenA = signToken({ userId: randomUUID(), tenantId: TENANT_A, role: 'viewer' });
  res = await request(app).post('/api/v1/ai/compose/repurpose').set('Authorization', `Bearer ${viewerTokenA}`).send({ sourceContent: 'test', targetPlatforms: ['facebook'] });
  assert.strictEqual(res.status, 403, 'a viewer cannot call repurpose');
  res = await request(app).post('/api/v1/ai/compose/repurpose').set('Authorization', `Bearer ${memberTokenA}`).send({ sourceContent: 'test' });
  assert.strictEqual(res.status, 400, 'targetPlatforms is required');
  console.log('✓ /ai/compose/repurpose is member+ gated and schema-validated');

  console.log('\nALL BRAND MEMORY ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('BRAND MEMORY TEST FAILED:', err.message);
  process.exit(1);
});
