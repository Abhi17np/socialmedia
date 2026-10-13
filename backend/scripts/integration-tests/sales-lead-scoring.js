/**
 * End-to-end exercise of Sales Hub Stage 1's lead scoring engine
 * (lib/leadScoring.js + the lead_scoring_rules CRUD + recompute hooks
 * in routes/sales.js) against a real app instance and Postgres via
 * PostgREST. See this directory's README for setup.
 *
 * Run: node scripts/integration-tests/sales-lead-scoring.js
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

  await client.from('tenants').insert({ id: tenantId, name: 'Lead Scoring Test Tenant', slug: 'lead-scoring-' + Date.now(), hubs_enabled: { sales: true, marketing: false } });
  await client.from('users').insert({ id: ownerId, tenant_id: tenantId, email: `owner-${Date.now()}@lead-scoring-test.com`, password_hash: 'x', role: 'owner' });

  const adminToken = token(tenantId, ownerId, 'admin');
  const memberToken = token(tenantId, ownerId, 'member');

  let r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Scoreless contact' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.contact.lead_score, 0, 'a contact created with no rules active must score 0');
  console.log('✓ contact created with no active rules scores 0');

  r = await api('/api/v1/sales/lead-scoring-rules', { method: 'POST', auth: memberToken, body: { name: 'Has email', conditionType: 'has_email', points: 10 } });
  assert.strictEqual(r.status, 403, JSON.stringify(r.data));
  console.log('✓ member cannot create a lead scoring rule (admin-only, RBAC enforced)');

  r = await api('/api/v1/sales/lead-scoring-rules', { method: 'POST', auth: adminToken, body: { name: 'tag without value', conditionType: 'tag_equals', points: 5 } });
  assert.strictEqual(r.status, 400, JSON.stringify(r.data));
  console.log('✓ tag_equals rule without conditionValue is rejected');

  r = await api('/api/v1/sales/lead-scoring-rules', { method: 'POST', auth: adminToken, body: { name: 'Has email', conditionType: 'has_email', points: 10 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  r = await api('/api/v1/sales/lead-scoring-rules', { method: 'POST', auth: adminToken, body: { name: 'Has phone', conditionType: 'has_phone', points: 15 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  r = await api('/api/v1/sales/lead-scoring-rules', { method: 'POST', auth: adminToken, body: { name: 'VIP tag', conditionType: 'tag_equals', conditionValue: 'vip', points: 25 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const vipRule = r.data.rule;
  r = await api('/api/v1/sales/lead-scoring-rules', { method: 'POST', auth: adminToken, body: { name: 'Unqualified penalty', conditionType: 'lead_status_equals', conditionValue: 'unqualified', points: -20 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  console.log('✓ seeded 4 active scoring rules (email +10, phone +15, vip tag +25, unqualified -20)');

  // matches email + phone + vip tag = 10 + 15 + 25 = 50
  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Hot lead', email: 'hot@example.com', phone: '919999900003', tags: ['vip'] } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.contact.lead_score, 50, 'expected email+phone+vip = 10+15+25=50, got ' + r.data.contact.lead_score);
  const hotLead = r.data.contact;
  console.log('✓ POST /sales/contacts recomputes lead_score from every matching active rule on create');

  // matches only email = 10
  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Cold lead', email: 'cold@example.com' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.contact.lead_score, 10);
  const coldLead = r.data.contact;

  // mark the cold lead unqualified: 10 (email) - 20 (penalty) = -10
  r = await api(`/api/v1/sales/contacts/${coldLead.id}`, { method: 'PATCH', auth: memberToken, body: { leadStatus: 'unqualified' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.contact.lead_score, -10, 'expected email(+10) + unqualified(-20) = -10, got ' + r.data.contact.lead_score);
  console.log('✓ PATCH /sales/contacts recomputes lead_score (negative points dock the score)');

  // deactivate the VIP rule — the hot lead's score must drop by 25 the next time it's touched
  r = await api(`/api/v1/sales/lead-scoring-rules/${vipRule.id}`, { method: 'PATCH', auth: adminToken, body: { isActive: false } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  r = await api(`/api/v1/sales/contacts/${hotLead.id}`, { method: 'PATCH', auth: memberToken, body: { jobTitle: 'VP Sales' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.contact.lead_score, 25, 'expected email+phone only (vip rule deactivated) = 10+15=25, got ' + r.data.contact.lead_score);
  console.log('✓ deactivating a rule changes the score the next time the contact is touched');

  r = await api('/api/v1/sales/lead-scoring-rules', { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.rules.length, 4);
  console.log('✓ GET /sales/lead-scoring-rules lists every rule for the tenant');

  r = await api(`/api/v1/sales/lead-scoring-rules/${vipRule.id}`, { method: 'DELETE', auth: adminToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  r = await api('/api/v1/sales/lead-scoring-rules', { auth: memberToken });
  assert.strictEqual(r.data.rules.length, 3);
  console.log('✓ DELETE /sales/lead-scoring-rules/:id removes the rule');

  console.log('\nALL LEAD SCORING ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
