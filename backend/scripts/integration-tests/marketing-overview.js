/**
 * End-to-end exercise of the Phase 8 cross-channel overview + marketing
 * audit-log endpoints (backend/routes/attribution.js's GET /marketing/overview
 * and GET /marketing/audit-log): real aggregate counts summed from each
 * channel's own existing columns/tables, and a role-gated, action-
 * prefix-filtered view over the shared audit_log table.
 *
 * Run: node scripts/integration-tests/marketing-overview.js
 * (needs PostgREST + the rest-proxy + Redis running; does NOT need a
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

const TENANT_ID = randomUUID();
const USER_ID = randomUUID();
const token = (role) => signToken({ userId: USER_ID, tenantId: TENANT_ID, role });

async function main() {
  const client = getSocialClient();
  let r = await client.from('tenants').insert({ id: TENANT_ID, name: 'Overview Test Tenant', slug: 'overview-test-' + Date.now() });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: USER_ID, tenant_id: TENANT_ID, email: `owner-${Date.now()}@overview-test.com`, password_hash: 'x', role: 'owner' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  const { data: admin } = await client.from('platform_admins').select('id').limit(1).single();
  const jwt = require(path.join(BACKEND, 'node_modules/jsonwebtoken'));
  const platformToken = jwt.sign({ adminId: admin.id, scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  let res = await request(app).patch(`/api/v1/platform/tenants/${TENANT_ID}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  // Seed real rows across every channel — the overview must be a true sum of these, not invented numbers.
  await client.from('email_campaigns').insert([
    { tenant_id: TENANT_ID, name: 'E1', sent_count: 10, opened_count: 4, clicked_count: 2 },
    { tenant_id: TENANT_ID, name: 'E2', sent_count: 5, opened_count: 1, clicked_count: 0 }
  ]);
  const { data: socialAccount } = await client.from('social_accounts').insert({ tenant_id: TENANT_ID, platform: 'whatsapp', access_token: 'enc:test' }).select('id').single();
  const { data: waTemplate } = await client.from('whatsapp_templates').insert({ tenant_id: TENANT_ID, name: 'overview_template', body_text: 'Hi {{1}}', approval_status: 'approved' }).select('id').single();
  r = await client.from('whatsapp_campaigns').insert({ tenant_id: TENANT_ID, name: 'W1', social_account_id: socialAccount.id, template_id: waTemplate.id, sent_count: 8, delivered_count: 7, read_count: 3 });
  if (r.error) throw new Error('whatsapp_campaigns seed failed: ' + JSON.stringify(r.error));
  await client.from('sms_campaigns').insert({ tenant_id: TENANT_ID, name: 'S1', body: 'hi', sent_count: 6, failed_count: 1 });

  const { data: form } = await client.from('lead_forms').insert({ tenant_id: TENANT_ID, name: 'F1', fields: [{ key: 'email', label: 'Email', type: 'email', required: true }] }).select('id').single();
  const { data: formContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Form Contact', email: 'overview-form@example.com' }).select('id').single();
  await client.from('lead_form_submissions').insert([
    { tenant_id: TENANT_ID, form_id: form.id, contact_id: formContact.id, data: {}, spam_flagged: false },
    { tenant_id: TENANT_ID, form_id: form.id, contact_id: formContact.id, data: {}, spam_flagged: true } // must be excluded
  ]);

  res = await request(app).post('/api/v1/marketing/journeys').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Overview journey', triggerType: 'contact_created', graph: { nodes: [{ id: 't', type: 'trigger' }, { id: 'n0', type: 'action', actionType: 'add_tag', config: { tag: 'x' } }], edges: [{ id: 'e0', source: 't', target: 'n0' }] }
  });
  const journey = res.body.journey;
  await request(app).patch(`/api/v1/marketing/journeys/${journey.id}/activate`).set('Authorization', `Bearer ${token('admin')}`);
  const { enrollContact } = require(path.join(BACKEND, 'lib/journeyEngine'));
  const { data: journeyContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Journey Contact' }).select('id').single();
  await enrollContact(client, TENANT_ID, journey.id, journeyContact.id); // single-action, no-delay graph completes immediately

  // --- Overview: real sums, nothing invented ---

  res = await request(app).get('/api/v1/marketing/overview').set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.email.campaigns, 2);
  assert.strictEqual(res.body.email.sent, 15, '10 + 5 — a real sum, not a per-campaign number');
  assert.strictEqual(res.body.email.opened, 5);
  assert.strictEqual(res.body.whatsapp.sent, 8);
  assert.strictEqual(res.body.whatsapp.read, 3);
  assert.strictEqual(res.body.sms.sent, 6);
  assert.strictEqual(res.body.sms.failed, 1);
  assert.strictEqual(res.body.forms.submissions, 1, 'the spam-flagged submission must be excluded');
  assert.strictEqual(res.body.journeys.active, 1);
  assert.strictEqual(res.body.journeys.completedEnrollments, 1);
  assert.ok(Array.isArray(res.body.revenue.byChannel), 'attribution is folded into the same overview, not a separate call');
  console.log('✓ /marketing/overview sums real counts across every channel (email/WhatsApp/SMS/forms/journeys/revenue), none invented');

  // --- Audit log: filtered to marketing.* only, admin-only ---

  res = await request(app).get('/api/v1/marketing/audit-log').set('Authorization', `Bearer ${token('member')}`);
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  res = await request(app).get('/api/v1/marketing/audit-log').set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.total > 0, 'this tenant has real marketing.* audit rows from the journey activation above');
  assert.ok(res.body.entries.every((e) => e.action.startsWith('marketing.')), 'must never leak a non-marketing audit row');
  console.log('✓ /marketing/audit-log is admin+ only and filtered to marketing.* actions only');

  console.log('\nALL OVERVIEW/AUDIT-LOG ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
