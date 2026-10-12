/**
 * End-to-end exercise of routes/marketing.js: the hub gate, linking real
 * scheduled posts and WhatsApp campaigns, the analytics rollup, and
 * automation-rule CRUD + a rule firing for real on a cross-Hub
 * contact_created event. See this directory's README for setup.
 *
 * Run: node scripts/integration-tests/marketing-routes.js
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

  await client.from('tenants').insert({ id: tenantId, name: 'Marketing Test Tenant', slug: 'mkt-test-' + Date.now() });
  await client.from('users').insert({ id: ownerId, tenant_id: tenantId, email: `owner-${Date.now()}@mkt-test.com`, password_hash: 'x', role: 'owner' });

  const adminToken = token(tenantId, ownerId, 'admin');
  const memberToken = token(tenantId, ownerId, 'member');
  const viewerToken = token(tenantId, ownerId, 'viewer');

  let r = await api('/api/v1/marketing/campaigns', { auth: viewerToken });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.code, 'HUB_NOT_ENABLED');
  console.log('✓ Marketing Hub routes return 403 HUB_NOT_ENABLED before the gate is flipped');

  const { data: admin } = await client.from('platform_admins').select('id').limit(1).single();
  const platformToken = jwt.sign({ adminId: admin.id, scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  r = await api(`/api/v1/platform/tenants/${tenantId}/hubs`, { method: 'PATCH', auth: platformToken, body: { marketing: true, sales: true } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  console.log('✓ Platform admin enabled Marketing Hub (and Sales Hub, for the automation step) for the tenant');

  const { data: contact } = await client.from('contacts').insert({ tenant_id: tenantId, display_name: 'Seed Contact', phone: '919999900003', tags: ['newsletter'] }).select('*').single();
  const { data: segment } = await client.from('audience_segments').insert({ tenant_id: tenantId, name: 'Newsletter', filter_json: { tags: ['newsletter'] } }).select('*').single();
  const { data: account } = await client.from('social_accounts').insert({ tenant_id: tenantId, platform: 'whatsapp', external_account_id: 'phone-mkt-' + Date.now(), access_token: 'enc' }).select('*').single();
  const { data: template } = await client.from('whatsapp_templates').insert({ tenant_id: tenantId, social_account_id: account.id, name: 'mkt_tpl_' + Date.now(), body_text: 'Hello', approval_status: 'approved' }).select('*').single();
  const { data: waCampaign } = await client.from('whatsapp_campaigns').insert({ tenant_id: tenantId, name: 'WA sub-campaign', social_account_id: account.id, template_id: template.id, total_recipients: 1, sent_count: 1, delivered_count: 1, read_count: 0 }).select('*').single();
  const { data: post } = await client.from('scheduled_posts').insert({ tenant_id: tenantId, content: 'Marketing post', target_platforms: ['facebook'], target_account_ids: [account.id], scheduled_at: new Date().toISOString(), status: 'published' }).select('*').single();

  r = await api('/api/v1/marketing/campaigns', { method: 'POST', auth: memberToken, body: { name: 'Spring Launch', segmentId: segment.id } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const campaign = r.data.campaign;
  console.log('✓ marketing campaign created, segmentId validated against a real segment');

  r = await api('/api/v1/marketing/campaigns', { method: 'POST', auth: viewerToken, body: { name: 'x' } });
  assert.strictEqual(r.status, 403);
  console.log('✓ viewer blocked from creating a campaign');

  r = await api(`/api/v1/marketing/campaigns/${campaign.id}/link-post`, { method: 'POST', auth: memberToken, body: { scheduledPostId: post.id } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  r = await api(`/api/v1/marketing/campaigns/${campaign.id}/link-whatsapp`, { method: 'POST', auth: memberToken, body: { whatsappCampaignId: waCampaign.id } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  console.log('✓ linked a real scheduled post and a real WhatsApp campaign');

  r = await api(`/api/v1/marketing/campaigns/${campaign.id}`, { auth: viewerToken });
  assert.strictEqual(r.data.posts.length, 1);
  assert.strictEqual(r.data.whatsappCampaigns.length, 1);
  console.log('✓ campaign detail rolls up the linked post and WhatsApp campaign');

  r = await api(`/api/v1/marketing/campaigns/${campaign.id}/analytics`, { auth: viewerToken });
  assert.strictEqual(r.data.whatsapp.sent, 1);
  assert.strictEqual(r.data.whatsapp.delivered, 1);
  assert.strictEqual(r.data.socialPosts.published, 1);
  console.log('✓ analytics rollup reflects the real linked data, nothing fabricated');

  r = await api('/api/v1/marketing/automation-rules', { method: 'POST', auth: adminToken, body: { name: 'Welcome tag', triggerType: 'contact_created', actionType: 'add_tag', actionConfig: { tag: 'welcomed' } } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const rule = r.data.rule;
  console.log('✓ automation rule created via Marketing Hub API');

  r = await api('/api/v1/marketing/automation-rules', { method: 'POST', auth: memberToken, body: { name: 'x', triggerType: 'contact_created', actionType: 'add_tag', actionConfig: {} } });
  assert.strictEqual(r.status, 403);
  console.log('✓ member blocked from creating an automation rule (admin+ only)');

  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Automation Target' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  await new Promise((res) => setTimeout(res, 300));

  r = await api(`/api/v1/marketing/automation-rules/${rule.id}/runs`, { auth: viewerToken });
  assert.strictEqual(r.data.runs.length, 1);
  assert.strictEqual(r.data.runs[0].status, 'success');
  console.log('✓ automation rule fired for real on a cross-Hub contact_created event, run logged');

  const { data: taggedContact } = await client.from('contacts').select('tags').eq('id', r.data.runs[0].trigger_ref_id).single();
  assert.ok(taggedContact.tags.includes('welcomed'));
  console.log('✓ the new contact was really tagged "welcomed"');

  void contact; // seeded for realism (segment matching) though not asserted on directly
  console.log('\nALL MARKETING ROUTE ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
