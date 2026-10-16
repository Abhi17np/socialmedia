/**
 * Agency Workspace (migration 043): the full mutual-consent lifecycle
 * (propose by slug → approve → revoke → re-propose) with real role
 * gating on each side, plus a REAL end-to-end aggregate overview
 * computed from seeded social_accounts/analytics_snapshots/mentions/
 * inbox_messages/scheduled_posts/crisis_alerts for the client tenant —
 * proving routes/agency.js's gatherClientOverview() reads real rows,
 * not hand-fed numbers. The key property under test throughout: a
 * tenant that is NOT party to a link can never approve/revoke it or see
 * its overview data, and the overview shows NOTHING until a link is
 * actually 'active'.
 *
 * Run: node scripts/integration-tests/social-agency-workspace.js
 * (needs PostgREST + the rest-proxy running; does NOT need Redis or a
 * separately running `node server.js`.)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-integration-tests';
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('hex');
process.env.SUPABASE_URL_SOCIAL = process.env.SUPABASE_URL_SOCIAL || 'http://localhost:3001';
process.env.SUPABASE_KEY_SOCIAL = process.env.SUPABASE_KEY_SOCIAL || '';
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

const TENANT_AGENCY = randomUUID();
const TENANT_CLIENT = randomUUID();
const TENANT_OTHER = randomUUID();
const AGENCY_SLUG = 'agency-ws-' + Date.now();
const CLIENT_SLUG = 'client-ws-' + Date.now();
const OTHER_SLUG = 'other-ws-' + Date.now();

const ADMIN_AGENCY_ID = randomUUID();
const MEMBER_AGENCY_ID = randomUUID();
const ADMIN_CLIENT_ID = randomUUID();
const VIEWER_CLIENT_ID = randomUUID();
const ADMIN_OTHER_ID = randomUUID();
const adminAgency = signToken({ userId: ADMIN_AGENCY_ID, tenantId: TENANT_AGENCY, role: 'admin' });
const memberAgency = signToken({ userId: MEMBER_AGENCY_ID, tenantId: TENANT_AGENCY, role: 'member' });
const adminClient = signToken({ userId: ADMIN_CLIENT_ID, tenantId: TENANT_CLIENT, role: 'admin' });
const viewerClient = signToken({ userId: VIEWER_CLIENT_ID, tenantId: TENANT_CLIENT, role: 'viewer' });
const adminOther = signToken({ userId: ADMIN_OTHER_ID, tenantId: TENANT_OTHER, role: 'admin' });

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert([
    { id: TENANT_AGENCY, name: 'Agency WS Tenant', slug: AGENCY_SLUG },
    { id: TENANT_CLIENT, name: 'Client WS Tenant', slug: CLIENT_SLUG },
    { id: TENANT_OTHER, name: 'Other WS Tenant', slug: OTHER_SLUG }
  ]);
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert([
    { id: ADMIN_AGENCY_ID, tenant_id: TENANT_AGENCY, email: `admin-${Date.now()}@agency-ws-test.com`, password_hash: 'x', role: 'admin' },
    { id: MEMBER_AGENCY_ID, tenant_id: TENANT_AGENCY, email: `member-${Date.now()}@agency-ws-test.com`, password_hash: 'x', role: 'member' },
    { id: ADMIN_CLIENT_ID, tenant_id: TENANT_CLIENT, email: `admin-${Date.now()}@client-ws-test.com`, password_hash: 'x', role: 'admin' },
    { id: VIEWER_CLIENT_ID, tenant_id: TENANT_CLIENT, email: `viewer-${Date.now()}@client-ws-test.com`, password_hash: 'x', role: 'viewer' },
    { id: ADMIN_OTHER_ID, tenant_id: TENANT_OTHER, email: `admin-${Date.now()}@other-ws-test.com`, password_hash: 'x', role: 'admin' }
  ]);
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  // --- Seed the CLIENT's real data: 2 active accounts with follower snapshots, 3 open interactions, 1 pending-approval post, 1 open crisis alert ---
  const igAccount = randomUUID();
  const fbAccount = randomUUID();
  r = await client.from('social_accounts').insert([
    { id: igAccount, tenant_id: TENANT_CLIENT, platform: 'instagram', account_label: 'Client IG', external_account_id: 'ext-ig', access_token: 'enc-not-real', status: 'active' },
    { id: fbAccount, tenant_id: TENANT_CLIENT, platform: 'facebook', account_label: 'Client FB', external_account_id: 'ext-fb', access_token: 'enc-not-real', status: 'active' }
  ]);
  if (r.error) throw new Error('social_accounts insert failed: ' + JSON.stringify(r.error));
  r = await client.from('analytics_snapshots').insert([
    { tenant_id: TENANT_CLIENT, social_account_id: igAccount, platform: 'instagram', metric: 'follower_count', value: 2000, captured_date: new Date().toISOString().slice(0, 10) },
    { tenant_id: TENANT_CLIENT, social_account_id: fbAccount, platform: 'facebook', metric: 'fans', value: 500, captured_date: new Date().toISOString().slice(0, 10) }
  ]);
  if (r.error) throw new Error('analytics_snapshots insert failed: ' + JSON.stringify(r.error));
  r = await client.from('mentions').insert([
    { tenant_id: TENANT_CLIENT, social_account_id: igAccount, platform: 'instagram', external_id: 'm1-' + randomUUID(), author: 'a', text: 'open mention', interaction_status: 'open' },
    { tenant_id: TENANT_CLIENT, social_account_id: igAccount, platform: 'instagram', external_id: 'm2-' + randomUUID(), author: 'b', text: 'closed mention', interaction_status: 'closed' }
  ]);
  if (r.error) throw new Error('mentions insert failed: ' + JSON.stringify(r.error));
  r = await client.from('inbox_messages').insert([
    { tenant_id: TENANT_CLIENT, social_account_id: igAccount, platform: 'instagram', external_thread_id: 't1-' + randomUUID(), external_message_id: 'im1-' + randomUUID(), sender: 'c', message: 'open dm', direction: 'inbound', interaction_status: 'open' },
    { tenant_id: TENANT_CLIENT, social_account_id: igAccount, platform: 'instagram', external_thread_id: 't2-' + randomUUID(), external_message_id: 'im2-' + randomUUID(), sender: 'd', message: 'another open dm', direction: 'inbound', interaction_status: 'open' }
  ]);
  if (r.error) throw new Error('inbox_messages insert failed: ' + JSON.stringify(r.error));
  r = await client.from('scheduled_posts').insert({
    id: randomUUID(), tenant_id: TENANT_CLIENT, content: 'awaiting review', target_platforms: ['instagram'], target_account_ids: [igAccount],
    scheduled_at: new Date(Date.now() + 3600 * 1000).toISOString(), status: 'pending_review'
  });
  if (r.error) throw new Error('scheduled_posts insert failed: ' + JSON.stringify(r.error));
  r = await client.from('crisis_alerts').insert({
    tenant_id: TENANT_CLIENT, window_start: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), window_end: new Date().toISOString(),
    message_count: 20, baseline_mean: 2, baseline_stddev: 0.5, z_score: 10, status: 'open'
  });
  if (r.error) throw new Error('crisis_alerts insert failed: ' + JSON.stringify(r.error));

  // --- Validation ---
  let res = await request(app).post('/api/v1/social/agency/links').set('Authorization', `Bearer ${adminClient}`).send({ agencySlug: 'no-such-slug-' + Date.now() });
  assert.strictEqual(res.status, 404, JSON.stringify(res.body));
  console.log('✓ proposing a link to an unknown slug 404s rather than a generic 500');

  res = await request(app).post('/api/v1/social/agency/links').set('Authorization', `Bearer ${adminClient}`).send({ agencySlug: CLIENT_SLUG });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  console.log('✓ a tenant cannot propose itself as its own agency');

  res = await request(app).post('/api/v1/social/agency/links').set('Authorization', `Bearer ${viewerClient}`).send({ agencySlug: AGENCY_SLUG });
  assert.strictEqual(res.status, 403);
  console.log('✓ POST /social/agency/links is admin+ gated');

  // --- A real proposal ---
  res = await request(app).post('/api/v1/social/agency/links').set('Authorization', `Bearer ${adminClient}`).send({ agencySlug: AGENCY_SLUG });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const linkId = res.body.link.id;
  assert.strictEqual(res.body.link.status, 'pending');
  console.log('✓ a valid link proposal is created with status "pending"');

  res = await request(app).post('/api/v1/social/agency/links').set('Authorization', `Bearer ${adminClient}`).send({ agencySlug: AGENCY_SLUG });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  console.log('✓ proposing the same agency link twice while pending conflicts (409), not a generic 500');

  // --- Both sides can see it, correctly directioned ---
  res = await request(app).get('/api/v1/social/agency/links').set('Authorization', `Bearer ${adminClient}`);
  assert.strictEqual(res.body.links.find((l) => l.id === linkId).direction, 'as_client', JSON.stringify(res.body.links));
  res = await request(app).get('/api/v1/social/agency/links').set('Authorization', `Bearer ${adminAgency}`);
  assert.strictEqual(res.body.links.find((l) => l.id === linkId).direction, 'as_agency', JSON.stringify(res.body.links));
  assert.strictEqual(res.body.links.find((l) => l.id === linkId).otherTenant.slug, CLIENT_SLUG);
  console.log('✓ GET /social/agency/links shows the correct direction and other-tenant info for each real side');

  // --- No data is shared before approval ---
  res = await request(app).get('/api/v1/social/agency/overview').set('Authorization', `Bearer ${adminAgency}`);
  assert.strictEqual(res.body.clients.length, 0, JSON.stringify(res.body.clients));
  console.log('✓ the agency overview shows nothing at all while the link is still pending');

  // --- Approve is agency-side admin+ only ---
  res = await request(app).patch(`/api/v1/social/agency/links/${linkId}/approve`).set('Authorization', `Bearer ${adminClient}`);
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  console.log('✓ the client side cannot approve its own proposal — only the agency side can');

  res = await request(app).patch(`/api/v1/social/agency/links/${linkId}/approve`).set('Authorization', `Bearer ${memberAgency}`);
  assert.strictEqual(res.status, 403, 'a member on the agency side cannot approve either');
  console.log('✓ PATCH /social/agency/links/:id/approve is admin+ gated on the agency side');

  res = await request(app).patch(`/api/v1/social/agency/links/${linkId}/approve`).set('Authorization', `Bearer ${adminAgency}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.link.status, 'active');
  console.log('✓ the agency admin can approve, flipping the link to "active"');

  // --- THE REAL END-TO-END AGGREGATE: proves gatherClientOverview() reads real seeded rows ---
  res = await request(app).get('/api/v1/social/agency/overview').set('Authorization', `Bearer ${adminAgency}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.clients.length, 1, JSON.stringify(res.body.clients));
  const overview = res.body.clients[0].overview;
  assert.strictEqual(res.body.clients[0].tenant.slug, CLIENT_SLUG);
  assert.strictEqual(overview.connectedAccounts, 2, JSON.stringify(overview));
  assert.strictEqual(overview.totalFollowers, 2500, JSON.stringify(overview)); // 2000 (IG) + 500 (FB)
  assert.strictEqual(overview.openInteractions, 3, JSON.stringify(overview)); // 1 open mention + 2 open DMs (the closed mention excluded)
  assert.strictEqual(overview.pendingApprovalPosts, 1, JSON.stringify(overview));
  assert.strictEqual(overview.openCrisisAlerts, 1, JSON.stringify(overview));
  console.log('✓ the real overview, computed from seeded data, is exactly right: 2 accounts, 2500 followers, 3 open interactions, 1 pending-approval post, 1 open crisis alert');

  // --- Tenant isolation: an unrelated tenant sees and can touch none of this ---
  res = await request(app).get('/api/v1/social/agency/overview').set('Authorization', `Bearer ${adminOther}`);
  assert.strictEqual(res.body.clients.length, 0, 'an unrelated tenant must see no client data at all');
  res = await request(app).patch(`/api/v1/social/agency/links/${linkId}/revoke`).set('Authorization', `Bearer ${adminOther}`);
  assert.strictEqual(res.status, 404, 'an unrelated tenant cannot even see this link to revoke it');
  console.log('✓ an unrelated third tenant has zero visibility into this link or the client\'s aggregate data');

  // --- Revoke, by the client side this time ---
  res = await request(app).patch(`/api/v1/social/agency/links/${linkId}/revoke`).set('Authorization', `Bearer ${adminClient}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.link.status, 'revoked');
  res = await request(app).get('/api/v1/social/agency/overview').set('Authorization', `Bearer ${adminAgency}`);
  assert.strictEqual(res.body.clients.length, 0, 'a revoked link must stop sharing data immediately');
  console.log('✓ the client side can revoke, and sharing stops immediately — the agency overview goes back to empty');

  res = await request(app).patch(`/api/v1/social/agency/links/${linkId}/revoke`).set('Authorization', `Bearer ${adminClient}`);
  assert.strictEqual(res.status, 409, 'revoking an already-revoked link conflicts rather than silently succeeding');
  console.log('✓ revoking an already-revoked link 409s');

  // --- Re-proposing after a revoke reuses the same row, not a duplicate ---
  res = await request(app).post('/api/v1/social/agency/links').set('Authorization', `Bearer ${adminClient}`).send({ agencySlug: AGENCY_SLUG });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.link.id, linkId, 'a re-proposal after revoke should reuse the same (agency,client) row, not create a duplicate');
  assert.strictEqual(res.body.link.status, 'pending');
  console.log('✓ re-proposing after a revoke flips the same row back to "pending" rather than creating a duplicate');

  console.log('\nALL AGENCY WORKSPACE ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('AGENCY WORKSPACE TEST FAILED:', err);
  process.exit(1);
});
