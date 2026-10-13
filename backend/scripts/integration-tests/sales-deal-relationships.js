/**
 * End-to-end exercise of Sales Hub Stage 2's deal-detail enrichment,
 * deal_contacts (multi-contact-per-deal), and forecast categories
 * (migration 018 + routes/sales.js additions) against a real app
 * instance and Postgres via PostgREST. See this directory's README
 * for setup.
 *
 * Run: node scripts/integration-tests/sales-deal-relationships.js
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

  await client.from('tenants').insert({ id: tenantId, name: 'Deal Relationships Test Tenant', slug: 'deal-rel-' + Date.now(), hubs_enabled: { sales: true, marketing: false } });
  await client.from('users').insert({ id: ownerId, tenant_id: tenantId, email: `owner-${Date.now()}@deal-rel-test.com`, password_hash: 'x', role: 'owner' });

  const adminToken = token(tenantId, ownerId, 'admin');
  const memberToken = token(tenantId, ownerId, 'member');

  let r = await api('/api/v1/sales/pipelines', { method: 'POST', auth: adminToken, body: { name: 'Relationships Pipeline' } });
  const pipeline = r.data.pipeline;
  const newStage = pipeline.stages.find((s) => s.name === 'New');

  r = await api('/api/v1/sales/companies', { method: 'POST', auth: memberToken, body: { name: 'Relationship Co' } });
  const company = r.data.company;

  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Primary Contact', companyId: company.id } });
  const primaryContact = r.data.contact;
  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Secondary Contact', companyId: company.id } });
  const secondaryContact = r.data.contact;

  // --- Create a deal with a primary contact + forecastCategory ---

  r = await api('/api/v1/sales/deals', {
    method: 'POST', auth: memberToken,
    body: { name: 'Multi-contact deal', pipelineId: pipeline.id, stageId: newStage.id, amount: 100000, contactId: primaryContact.id, companyId: company.id, forecastCategory: 'commit' }
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.deal.forecast_category, 'commit');
  const deal = r.data.deal;
  console.log('✓ deal created with forecastCategory=commit, persisted');

  // --- Deal detail enrichment ---

  r = await api(`/api/v1/sales/deals/${deal.id}`, { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.company.name, 'Relationship Co', 'deal detail must embed the company object');
  assert.strictEqual(r.data.contacts.length, 1, 'creating a deal with contactId must auto-link it as a primary deal_contacts row');
  assert.strictEqual(r.data.contacts[0].isPrimary, true);
  assert.strictEqual(r.data.contacts[0].display_name, 'Primary Contact');
  console.log('✓ GET /sales/deals/:id embeds company and the auto-linked primary contact');

  // --- Add a second (non-primary) contact ---

  r = await api(`/api/v1/sales/deals/${deal.id}/contacts`, { method: 'POST', auth: memberToken, body: { contactId: secondaryContact.id, role: 'influencer' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));

  r = await api(`/api/v1/sales/deals/${deal.id}`, { auth: memberToken });
  assert.strictEqual(r.data.contacts.length, 2, 'expected both contacts linked: ' + JSON.stringify(r.data.contacts));
  const secondary = r.data.contacts.find((c) => c.contactId === secondaryContact.id);
  assert.strictEqual(secondary.isPrimary, false);
  assert.strictEqual(secondary.role, 'influencer');
  console.log('✓ POST /sales/deals/:id/contacts links an additional, non-primary contact with a role');

  // adding the same contact twice is rejected
  r = await api(`/api/v1/sales/deals/${deal.id}/contacts`, { method: 'POST', auth: memberToken, body: { contactId: secondaryContact.id } });
  assert.strictEqual(r.status, 409, JSON.stringify(r.data));
  console.log('✓ linking the same contact to the same deal twice is rejected with 409');

  // --- Switching the primary contact via PATCH .../deals/:id contactId ---

  r = await api(`/api/v1/sales/deals/${deal.id}`, { method: 'PATCH', auth: memberToken, body: { contactId: secondaryContact.id } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));

  r = await api(`/api/v1/sales/deals/${deal.id}`, { auth: memberToken });
  const primaryNow = r.data.contacts.find((c) => c.isPrimary);
  assert.strictEqual(primaryNow.contactId, secondaryContact.id, 'PATCH contactId must move the primary flag to the new contact');
  assert.strictEqual(r.data.contacts.length, 2, 'switching primary must not create a duplicate link or drop the other contact');
  console.log('✓ PATCH /sales/deals/:id with a new contactId re-points deal_contacts.is_primary (no duplicate, old link kept as secondary)');

  // --- Remove a linked contact ---

  r = await api(`/api/v1/sales/deals/${deal.id}/contacts/${primaryContact.id}`, { method: 'DELETE', auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  r = await api(`/api/v1/sales/deals/${deal.id}`, { auth: memberToken });
  assert.strictEqual(r.data.contacts.length, 1);
  console.log('✓ DELETE /sales/deals/:id/contacts/:contactId unlinks a contact');

  // --- Stage history has readable stage names ---

  const wonStage = pipeline.stages.find((s) => s.is_won);
  await api(`/api/v1/sales/deals/${deal.id}/move`, { method: 'POST', auth: memberToken, body: { stageId: wonStage.id } });
  r = await api(`/api/v1/sales/deals/${deal.id}`, { auth: memberToken });
  assert.ok(r.data.history.length > 0);
  assert.strictEqual(r.data.history[0].to_stage_name, 'Won', 'history entries must carry readable stage names, not just ids: ' + JSON.stringify(r.data.history[0]));
  console.log('✓ deal detail history entries carry readable from/to stage names');

  // --- Dashboard forecast-by-category breakdown ---

  r = await api('/api/v1/sales/deals', {
    method: 'POST', auth: memberToken,
    body: { name: 'Best case deal', pipelineId: pipeline.id, stageId: newStage.id, amount: 40000, contactId: secondaryContact.id, companyId: company.id, ownerId, forecastCategory: 'best_case' }
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const bestCaseDeal = r.data.deal;

  r = await api('/api/v1/sales/activities', { method: 'POST', auth: memberToken, body: { type: 'call', subject: 'Follow up', dealId: bestCaseDeal.id, dueAt: '2026-12-01T10:00:00Z' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));

  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  r = await api(`/api/v1/sales/dashboard?from=${from}&to=${to}`, { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.forecastByCategory.best_case, 40000, 'expected the new best_case deal counted: ' + JSON.stringify(r.data.forecastByCategory));
  console.log('✓ GET /sales/dashboard forecastByCategory reflects real open-deal amounts per category');

  // --- GET /sales/deals list enrichment (company/contact/owner/next activity) ---

  r = await api(`/api/v1/sales/deals?pipelineId=${pipeline.id}`, { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const listedBestCase = r.data.deals.find((d) => d.id === bestCaseDeal.id);
  assert.ok(listedBestCase, 'expected the best-case deal in the list');
  assert.strictEqual(listedBestCase.companyName, 'Relationship Co');
  assert.strictEqual(listedBestCase.contactName, 'Secondary Contact');
  assert.strictEqual(listedBestCase.ownerEmail, (await api('/api/v1/team/members', { auth: adminToken })).data.members.find((m) => m.id === ownerId)?.email);
  assert.strictEqual(listedBestCase.nextActivityDueAt, '2026-12-01T10:00:00+00:00');
  console.log('✓ GET /sales/deals embeds companyName/contactName/ownerEmail/nextActivityDueAt for real deal-card rendering');

  console.log('\nALL SALES DEAL-RELATIONSHIPS/FORECAST-CATEGORY ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
