/**
 * End-to-end exercise of Sales Hub Stage 1's remaining pieces:
 * custom field definitions CRUD + wiring into contact/company/deal
 * create & update, the GET /sales/audit-log read, the assign_owner
 * automation action, and the sales-hub-gated automation-rules CRUD
 * (routes/sales.js + lib/automation.js) against a real app instance
 * and Postgres via PostgREST. See this directory's README for setup.
 *
 * Run: node scripts/integration-tests/sales-custom-fields.js
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
  const repId = randomUUID();

  await client.from('tenants').insert({ id: tenantId, name: 'Custom Fields Test Tenant', slug: 'custom-fields-' + Date.now(), hubs_enabled: { sales: true, marketing: false } });
  await client.from('users').insert([
    { id: ownerId, tenant_id: tenantId, email: `owner-${Date.now()}@custom-fields-test.com`, password_hash: 'x', role: 'owner' },
    { id: repId, tenant_id: tenantId, email: `rep-${Date.now()}@custom-fields-test.com`, password_hash: 'x', role: 'member' }
  ]);

  const adminToken = token(tenantId, ownerId, 'admin');
  const memberToken = token(tenantId, repId, 'member');

  // --- Custom field definitions CRUD ---

  let r = await api('/api/v1/sales/custom-fields', { method: 'POST', auth: memberToken, body: { entityType: 'contact', fieldKey: 'industry_segment', label: 'Industry Segment' } });
  assert.strictEqual(r.status, 403, JSON.stringify(r.data));
  console.log('✓ member cannot create a custom field definition (admin-only, RBAC enforced)');

  r = await api('/api/v1/sales/custom-fields', { method: 'POST', auth: adminToken, body: { entityType: 'deal', fieldKey: 'renewal_type', label: 'Renewal Type', fieldType: 'select' } });
  assert.strictEqual(r.status, 400, JSON.stringify(r.data));
  console.log('✓ a select field with no options is rejected');

  r = await api('/api/v1/sales/custom-fields', { method: 'POST', auth: adminToken, body: { entityType: 'contact', fieldKey: 'industry_segment', label: 'Industry Segment' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));

  r = await api('/api/v1/sales/custom-fields', { method: 'POST', auth: adminToken, body: { entityType: 'deal', fieldKey: 'renewal_type', label: 'Renewal Type', fieldType: 'select', options: ['annual', 'monthly'] } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const renewalField = r.data.field;

  r = await api('/api/v1/sales/custom-fields', { method: 'POST', auth: adminToken, body: { entityType: 'contact', fieldKey: 'industry_segment', label: 'Duplicate key' } });
  assert.strictEqual(r.status, 409, JSON.stringify(r.data));
  console.log('✓ duplicate (entityType, fieldKey) is rejected with 409');

  r = await api('/api/v1/sales/custom-fields?entityType=deal', { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.fields.length, 1);
  assert.strictEqual(r.data.fields[0].field_key, 'renewal_type');
  console.log('✓ GET /sales/custom-fields filters by entityType');

  // --- Wiring into contact/company/deal create+update ---

  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Custom Field Contact', customFields: { industry_segment: 'fintech' } } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.contact.custom_fields.industry_segment, 'fintech');
  const customContact = r.data.contact;
  console.log('✓ POST /sales/contacts stores customFields into contacts.custom_fields');

  r = await api(`/api/v1/sales/contacts/${customContact.id}`, { method: 'PATCH', auth: memberToken, body: { jobTitle: 'Director' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.contact.custom_fields.industry_segment, 'fintech', 'a PATCH that omits customFields must not wipe existing values');
  console.log('✓ PATCH /sales/contacts without customFields preserves existing custom field values');

  r = await api(`/api/v1/sales/contacts/${customContact.id}`, { method: 'PATCH', auth: memberToken, body: { customFields: { industry_segment: 'healthcare' } } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.contact.custom_fields.industry_segment, 'healthcare');
  console.log('✓ PATCH /sales/contacts with customFields updates the value');

  r = await api('/api/v1/sales/companies', { method: 'POST', auth: memberToken, body: { name: 'Custom Field Co', customFields: { tier: 'enterprise' } } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.company.custom_fields.tier, 'enterprise');
  const customCompany = r.data.company;
  console.log('✓ POST /sales/companies stores customFields into companies.custom_fields');

  r = await api(`/api/v1/sales/companies/${customCompany.id}`, { method: 'PATCH', auth: memberToken, body: { name: 'Custom Field Co' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.company.custom_fields.tier, 'enterprise', 'a PATCH that omits customFields must not wipe existing values');
  console.log('✓ PATCH /sales/companies without customFields preserves existing custom field values');

  r = await api('/api/v1/sales/pipelines', { method: 'POST', auth: adminToken, body: { name: 'Custom Field Pipeline' } });
  const pipeline = r.data.pipeline;
  const newStage = pipeline.stages.find((s) => s.name === 'New');

  r = await api('/api/v1/sales/deals', { method: 'POST', auth: memberToken, body: { name: 'Custom Field Deal', pipelineId: pipeline.id, stageId: newStage.id, amount: 500, customFields: { [renewalField.field_key]: 'annual' } } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.deal.custom_fields.renewal_type, 'annual');
  console.log('✓ POST /sales/deals stores customFields into deals.custom_fields');

  // --- assign_owner automation action + sales-hub automation-rules CRUD ---

  r = await api('/api/v1/sales/automation-rules', { method: 'POST', auth: memberToken, body: { name: 'Auto-assign new leads', triggerType: 'contact_created', actionType: 'assign_owner', actionConfig: { ownerId: repId } } });
  assert.strictEqual(r.status, 403, JSON.stringify(r.data));
  console.log('✓ member cannot create a sales automation rule (admin-only, RBAC enforced)');

  r = await api('/api/v1/sales/automation-rules', { method: 'POST', auth: adminToken, body: { name: 'Auto-assign new leads', triggerType: 'contact_created', actionType: 'assign_owner', actionConfig: { ownerId: repId } } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  console.log('✓ admin created an assign_owner automation rule via the sales-hub-gated route (previously only reachable behind Marketing Hub)');

  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Auto Assigned Lead' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const autoAssignedContact = r.data.contact;

  await new Promise((res) => setTimeout(res, 300));
  const { data: afterTrigger } = await client.from('contacts').select('owner_id').eq('id', autoAssignedContact.id).single();
  assert.strictEqual(afterTrigger.owner_id, repId, 'assign_owner must have set the new contact\'s owner_id: ' + JSON.stringify(afterTrigger));
  console.log('✓ assign_owner automation action fired for real: new contact auto-assigned to the configured owner');

  r = await api('/api/v1/sales/automation-rules', { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.rules.length, 1);
  console.log('✓ GET /sales/automation-rules lists the rule');

  // --- Audit log ---

  r = await api('/api/v1/sales/audit-log', { auth: memberToken });
  assert.strictEqual(r.status, 403, JSON.stringify(r.data));
  console.log('✓ member cannot read the audit log (admin-only)');

  r = await api('/api/v1/sales/audit-log', { auth: adminToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.entries.length > 0, 'audit log must have entries from the contact/company/deal/rule creates above');
  assert.ok(r.data.entries.every((e) => e.action.startsWith('sales.')), 'audit log must be scoped to sales.* actions: ' + JSON.stringify(r.data.entries.map((e) => e.action)));
  const contactCreatedEntry = r.data.entries.find((e) => e.action === 'sales.contact_created' && e.target_id === customContact.id);
  assert.ok(contactCreatedEntry, 'expected an audit entry for the custom-field contact creation');
  console.log('✓ GET /sales/audit-log surfaces real recorded entries, scoped to sales.* actions');

  console.log('\nALL SALES CUSTOM-FIELDS/AUDIT-LOG/ASSIGN-OWNER ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
