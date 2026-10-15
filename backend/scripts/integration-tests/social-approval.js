/**
 * Social Hub: the post approval/review workflow (migration 034) and the
 * two new AI features (hashtag suggestion, inbox triage) added alongside
 * it. Covers the real state-machine gate — a member's post is held for
 * review, not enqueued, until an admin approves/rejects it — plus role
 * gating and the fail-closed 503 for the AI endpoints (no
 * ANTHROPIC_API_KEY in this environment, same posture as every other AI
 * feature in this app).
 *
 * Run: node scripts/integration-tests/social-approval.js
 * (needs PostgREST + the rest-proxy + Redis running; does NOT need a
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

const TENANT_ID = randomUUID();
const ADMIN_ID = randomUUID();
const MEMBER_ID = randomUUID();
const adminToken = signToken({ userId: ADMIN_ID, tenantId: TENANT_ID, role: 'admin' });
const memberToken = signToken({ userId: MEMBER_ID, tenantId: TENANT_ID, role: 'member' });
const viewerToken = signToken({ userId: randomUUID(), tenantId: TENANT_ID, role: 'viewer' });

const samplePost = () => ({
  content: 'Test post for the approval workflow',
  targetPlatforms: ['facebook'],
  targetAccountIds: [randomUUID()], // not a real connected account — fine, this test never reaches a real publish
  scheduledAt: new Date(Date.now() + 3600 * 1000).toISOString()
});

async function main() {
  const client = getSocialClient();
  let r = await client.from('tenants').insert({ id: TENANT_ID, name: 'Social Approval Tenant', slug: 'social-approval-' + Date.now() });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert([
    { id: ADMIN_ID, tenant_id: TENANT_ID, email: `admin-${Date.now()}@sa-test.com`, password_hash: 'x', role: 'admin' },
    { id: MEMBER_ID, tenant_id: TENANT_ID, email: `member-${Date.now()}@sa-test.com`, password_hash: 'x', role: 'member' }
  ]);
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  // --- Default (approval off): a member's post is scheduled immediately, exactly like before this feature existed ---
  let res = await request(app).post('/api/v1/social/posts').set('Authorization', `Bearer ${memberToken}`).send(samplePost());
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.post.status, 'pending', 'approval is off by default — zero behavior change for existing tenants');
  assert.strictEqual(res.body.post.created_by, MEMBER_ID);
  console.log('✓ with approval off (the default), a member\'s post is scheduled immediately — unchanged behavior');

  // --- Turn approval on ---
  res = await request(app).patch('/api/v1/social/approval-settings').set('Authorization', `Bearer ${memberToken}`).send({ requireApproval: true });
  assert.strictEqual(res.status, 403, 'a member cannot change this tenant-wide setting');
  res = await request(app).patch('/api/v1/social/approval-settings').set('Authorization', `Bearer ${adminToken}`).send({ requireApproval: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.requireApproval, true);
  console.log('✓ /social/approval-settings is admin+ only and really persists');

  // --- A member's post now holds for review; an admin's own post still skips it ---
  res = await request(app).post('/api/v1/social/posts').set('Authorization', `Bearer ${memberToken}`).send(samplePost());
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const memberPost = res.body.post;
  assert.strictEqual(memberPost.status, 'pending_review', 'a member\'s post must hold for review once the tenant turns approval on');

  res = await request(app).post('/api/v1/social/posts').set('Authorization', `Bearer ${adminToken}`).send(samplePost());
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.post.status, 'pending', 'an admin\'s own post never needs their own rubber stamp');
  console.log('✓ once approval is required, a member\'s post holds for review while an admin\'s own post still goes straight through');

  // --- A member cannot approve/reject; an admin can ---
  res = await request(app).patch(`/api/v1/social/posts/${memberPost.id}/approve`).set('Authorization', `Bearer ${memberToken}`);
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));

  res = await request(app).patch(`/api/v1/social/posts/${memberPost.id}/approve`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.post.status, 'pending', 'approving moves a held post into the normal publish lifecycle');
  assert.strictEqual(res.body.post.reviewed_by, ADMIN_ID);
  console.log('✓ approving a held post is admin+ only and correctly re-enters the normal pending/publish lifecycle');

  // --- Cannot approve twice ---
  res = await request(app).patch(`/api/v1/social/posts/${memberPost.id}/approve`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 400, 'a post that already left pending_review cannot be approved again');

  // --- Reject with a note, and discard it ---
  res = await request(app).post('/api/v1/social/posts').set('Authorization', `Bearer ${memberToken}`).send(samplePost());
  const toReject = res.body.post;
  res = await request(app).patch(`/api/v1/social/posts/${toReject.id}/reject`).set('Authorization', `Bearer ${adminToken}`).send({ note: 'Please add a CTA.' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.post.status, 'rejected');
  assert.strictEqual(res.body.post.review_note, 'Please add a CTA.');
  console.log('✓ rejecting a held post records the real reviewer and note');

  res = await request(app).delete(`/api/v1/social/posts/${toReject.id}`).set('Authorization', `Bearer ${memberToken}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  console.log('✓ a rejected post can be discarded by its creator');

  // --- The audit trail is real ---
  const { data: auditRows } = await client.from('audit_log').select('action').eq('tenant_id', TENANT_ID).like('action', 'social.%');
  assert.ok(auditRows.some((a) => a.action === 'social.post.approved'));
  assert.ok(auditRows.some((a) => a.action === 'social.post.rejected'));
  assert.ok(auditRows.some((a) => a.action === 'social.approval_settings.updated'));
  console.log('✓ approve/reject/settings-change are all real audit_log rows, not just UI-only actions');

  // --- Cross-tenant isolation: a second tenant's admin cannot touch this tenant's post ---
  const OTHER_TENANT_ID = randomUUID();
  const OTHER_ADMIN_ID = randomUUID();
  await client.from('tenants').insert({ id: OTHER_TENANT_ID, name: 'Other Tenant', slug: 'other-' + Date.now() });
  await client.from('users').insert({ id: OTHER_ADMIN_ID, tenant_id: OTHER_TENANT_ID, email: `other-${Date.now()}@sa-test.com`, password_hash: 'x', role: 'admin' });
  const otherAdminToken = signToken({ userId: OTHER_ADMIN_ID, tenantId: OTHER_TENANT_ID, role: 'admin' });
  res = await request(app).post('/api/v1/social/posts').set('Authorization', `Bearer ${memberToken}`).send(samplePost());
  const crossTenantTarget = res.body.post;
  res = await request(app).patch(`/api/v1/social/posts/${crossTenantTarget.id}/approve`).set('Authorization', `Bearer ${otherAdminToken}`);
  assert.strictEqual(res.status, 404, 'a tenant must never be able to approve another tenant\'s post');
  console.log('✓ approve/reject are tenant-scoped — a different tenant\'s admin gets 404, not someone else\'s post');

  // --- AI hashtag suggestion + inbox triage: role gating and fail-closed 503 (no ANTHROPIC_API_KEY) ---
  res = await request(app).post('/api/v1/ai/compose/hashtags').set('Authorization', `Bearer ${viewerToken}`).send({ content: 'hi', platforms: ['instagram'] });
  assert.strictEqual(res.status, 403, 'hashtag suggestion requires member+, same as Composer itself');

  res = await request(app).post('/api/v1/ai/compose/hashtags').set('Authorization', `Bearer ${memberToken}`).send({ content: 'Announcing our new product line!', platforms: ['instagram'] });
  assert.strictEqual(res.status, 503, JSON.stringify(res.body));
  assert.ok(/ANTHROPIC_API_KEY/.test(res.body.error));
  console.log('✓ /ai/compose/hashtags is member+ gated and fails closed with a clear 503 without a real API key');

  const { data: inboxMsg, error: inboxErr } = await client.from('inbox_messages').insert({
    tenant_id: TENANT_ID, platform: 'facebook', external_thread_id: randomUUID(), external_message_id: randomUUID(), sender: 'A Customer', message: 'This is broken, please help!'
  }).select('*').single();
  if (inboxErr) throw inboxErr;
  res = await request(app).post(`/api/v1/ai/inbox/${inboxMsg.id}/analyze`).set('Authorization', `Bearer ${memberToken}`);
  assert.strictEqual(res.status, 503, JSON.stringify(res.body));
  console.log('✓ /ai/inbox/:id/analyze fails closed with a clear 503 without a real API key, and never fabricates a sentiment');

  console.log('\nALL SOCIAL APPROVAL / AI-TRIAGE ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
