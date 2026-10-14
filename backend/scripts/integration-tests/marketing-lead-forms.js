/**
 * End-to-end exercise of the Phase 5 lead-capture-forms upgrade
 * (migrations/029_lead_forms.sql, lib/leadForms.js, routes/leadForms.js)
 * against a real Postgres/PostgREST/Redis stack: authoring CRUD, the
 * public hosted-form endpoints (no login), honeypot spam handling,
 * double opt-in consent, contact resolution/dedup, the real handoff
 * into Sales Hub (a form lead is a real `contacts` row, not a shadow
 * record), the new 'form_submitted' journey trigger, and cross-tenant
 * isolation.
 *
 * Run: node scripts/integration-tests/marketing-lead-forms.js
 * (needs PostgREST + the rest-proxy + Redis running; does NOT need a
 * separately running `node server.js` — see this directory's README.
 * Assumes a platform_admins row already exists, same as
 * marketing-consent.js/marketing-journeys.js.)
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
const TENANT_B_ID = randomUUID();
const USER_ID = randomUUID();
const token = (role) => signToken({ userId: USER_ID, tenantId: TENANT_ID, role });
const tokenB = (role) => signToken({ userId: randomUUID(), tenantId: TENANT_B_ID, role });

const FIELDS = [
  { key: 'name', label: 'Full name', type: 'text', required: true },
  { key: 'email', label: 'Work email', type: 'email', required: true },
  { key: 'company', label: 'Company', type: 'text', required: false }
];

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert({ id: TENANT_ID, name: 'Lead Forms Test Tenant', slug: 'lead-forms-test-' + Date.now() });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('tenants').insert({ id: TENANT_B_ID, name: 'Lead Forms Test Tenant B', slug: 'lead-forms-test-b-' + Date.now() });
  if (r.error) throw new Error('tenant B insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: USER_ID, tenant_id: TENANT_ID, email: `owner-${Date.now()}@lead-forms-test.com`, password_hash: 'x', role: 'owner' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  const { data: admin } = await client.from('platform_admins').select('id').limit(1).single();
  const jwt = require(path.join(BACKEND, 'node_modules/jsonwebtoken'));
  const platformToken = jwt.sign({ adminId: admin.id, scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  let res = await request(app).patch(`/api/v1/platform/tenants/${TENANT_ID}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  res = await request(app).patch(`/api/v1/platform/tenants/${TENANT_B_ID}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  console.log('✓ Marketing Hub enabled for both test tenants');

  // A 'form_submitted' journey, created and activated up front — before
  // any submission below — so the later assertions can tell apart "fires
  // immediately on submit" (no consent gate) from "fires only once
  // confirmed" (double opt-in): both require the journey to already
  // exist at submission/confirmation time, not created retroactively.
  res = await request(app).post('/api/v1/marketing/journeys').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Form follow-up', triggerType: 'form_submitted', triggerConfig: {},
    graph: { nodes: [{ id: 't', type: 'trigger' }, { id: 'n0', type: 'action', actionType: 'add_tag', config: { tag: 'form-nurture' } }], edges: [{ id: 'e0', source: 't', target: 'n0' }] }
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const journey = res.body.journey;
  await request(app).patch(`/api/v1/marketing/journeys/${journey.id}/activate`).set('Authorization', `Bearer ${token('admin')}`);
  console.log('✓ a form_submitted journey exists and is active before any submission');

  // --- 0. Role gating + field validation on the authoring surface ---

  res = await request(app).post('/api/v1/marketing/forms').set('Authorization', `Bearer ${token('viewer')}`).send({ name: 'x', fields: FIELDS });
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  console.log('✓ viewer blocked from creating a form (member+ only)');

  res = await request(app).post('/api/v1/marketing/forms').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'No identifier field', fields: [{ key: 'name', label: 'Name', type: 'text' }]
  });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  assert.ok(/email or phone/.test(res.body.error), 'should name the missing identifier field, not a generic 500');
  console.log('✓ a form with no email/phone field is rejected with a clean 400');

  // --- 1. Create, activate, and fetch the public definition ---

  res = await request(app).post('/api/v1/marketing/forms').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Newsletter signup', description: 'Join our list', fields: FIELDS, consentRequired: true
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const form = res.body.form;
  assert.strictEqual(form.is_active, false, 'a new form starts inactive, never publicly live by default');

  res = await request(app).get(`/api/v1/public/forms/${form.id}`);
  assert.strictEqual(res.status, 404, 'an inactive form must not be publicly reachable');
  console.log('✓ an inactive form is not publicly reachable (404)');

  res = await request(app).patch(`/api/v1/marketing/forms/${form.id}/activate`).set('Authorization', `Bearer ${token('member')}`);
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  res = await request(app).patch(`/api/v1/marketing/forms/${form.id}/activate`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  console.log('✓ form activation is admin+ only');

  res = await request(app).get(`/api/v1/public/forms/${form.id}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.fields.length, 3);
  assert.strictEqual(res.body.consentRequired, true);
  console.log('✓ an active form\'s definition is publicly readable (name/fields/consent text only — no tenant internals)');

  // --- 2. A real submission, with double opt-in required: creates a pending contact, no consent yet ---

  res = await request(app).post(`/api/v1/public/forms/${form.id}/submit`).send({
    data: { name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines Inc' }, hp: ''
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.consentPending, true);
  console.log('✓ submission with consent required returns consentPending=true');

  const { data: adaContact } = await client.from('contacts').select('*').eq('tenant_id', TENANT_ID).eq('email', 'ada@example.com').maybeSingle();
  assert.ok(adaContact, 'a real contacts row must exist — a form lead is a real Sales Hub lead, not a shadow record');
  assert.strictEqual(adaContact.lead_source, 'web_form');
  assert.strictEqual(adaContact.display_name, 'Ada Lovelace');
  assert.ok(adaContact.tags.includes(`form:${form.name}`));
  console.log('✓ a real contact was created with lead_source=web_form and the form tag');

  const { data: pendingConsent } = await client.from('contact_consents').select('*').eq('tenant_id', TENANT_ID).eq('contact_id', adaContact.id).eq('channel', 'email').maybeSingle();
  assert.strictEqual(pendingConsent, null, 'consent must NOT be granted yet — only after the visitor confirms');
  console.log('✓ no email consent recorded yet while confirmation is pending (not opted in before confirming)');

  const { data: pendingSubmission } = await client.from('lead_form_submissions').select('*').eq('form_id', form.id).eq('contact_id', adaContact.id).single();
  assert.strictEqual(pendingSubmission.consent_status, 'pending');
  assert.ok(pendingSubmission.confirm_token, 'a confirm token must exist for a pending double opt-in submission');
  console.log('✓ the submission row is real, consent_status=pending, with a real confirm token');

  // --- 3. Confirming consent: the real public confirm link completes the double opt-in ---

  res = await request(app).get(`/api/v1/public/forms/confirm/${pendingSubmission.confirm_token}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.alreadyConfirmed, false);

  const { data: confirmedConsent } = await client.from('contact_consents').select('*').eq('tenant_id', TENANT_ID).eq('contact_id', adaContact.id).eq('channel', 'email').maybeSingle();
  assert.ok(confirmedConsent && confirmedConsent.status === 'opted_in', 'confirming must actually grant real, checked-at-send-time email consent');
  const { data: confirmedSubmission } = await client.from('lead_form_submissions').select('consent_status, confirmed_at').eq('id', pendingSubmission.id).single();
  assert.strictEqual(confirmedSubmission.consent_status, 'confirmed');
  assert.ok(confirmedSubmission.confirmed_at);
  console.log('✓ confirming the double opt-in link grants real email consent and marks the submission confirmed');

  res = await request(app).get(`/api/v1/public/forms/confirm/${pendingSubmission.confirm_token}`);
  assert.strictEqual(res.body.alreadyConfirmed, true, 'confirming twice is a safe no-op, not an error');
  console.log('✓ re-confirming an already-confirmed token is a safe no-op');

  // --- 4. A second submission with the SAME email resolves to the same contact, no duplicate ---

  res = await request(app).post(`/api/v1/public/forms/${form.id}/submit`).send({
    data: { name: 'Ada L.', email: 'ADA@example.com', company: 'Updated Co' }, hp: ''
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const { count: adaContactCount } = await client.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', TENANT_ID).ilike('email', 'ada@example.com');
  assert.strictEqual(adaContactCount, 1, 'a re-submission with the same (case-insensitive) email must resolve to the SAME contact, not create a duplicate');
  console.log('✓ resubmitting with the same email (different case) dedupes onto the existing contact');

  // --- 5. Honeypot: a filled-in hidden field is treated as spam, silently excluded ---

  const beforeSpamContactCount = (await client.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', TENANT_ID)).count;
  res = await request(app).post(`/api/v1/public/forms/${form.id}/submit`).send({
    data: { name: 'Bot', email: 'bot@spam.com' }, hp: 'i-am-a-bot'
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body), 'a tripped honeypot must still look like a normal success to the bot');
  const afterSpamContactCount = (await client.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', TENANT_ID)).count;
  assert.strictEqual(afterSpamContactCount, beforeSpamContactCount, 'a honeypot-tripped submission must NOT create a contact');
  const { data: spamRow } = await client.from('lead_form_submissions').select('spam_flagged').eq('form_id', form.id).is('contact_id', null).maybeSingle();
  assert.ok(spamRow && spamRow.spam_flagged, 'the spam submission must still be recorded, visibly flagged, not silently dropped');
  console.log('✓ honeypot-tripped submissions create no contact but are recorded and flagged for visibility');

  // --- 6. Missing required field is rejected with a clear, field-naming 400 ---

  res = await request(app).post(`/api/v1/public/forms/${form.id}/submit`).send({ data: { name: 'No Email' }, hp: '' });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  assert.ok(/required/i.test(res.body.error));
  console.log('✓ a missing required field is rejected with a clear 400, not a crash');

  // --- 7. A form with consent NOT required enrolls into the journey (created up front, above) immediately ---

  res = await request(app).post('/api/v1/marketing/forms').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'No-gate form', fields: FIELDS, consentRequired: false
  });
  const noGateForm = res.body.form;
  await request(app).patch(`/api/v1/marketing/forms/${noGateForm.id}/activate`).set('Authorization', `Bearer ${token('admin')}`);

  res = await request(app).post(`/api/v1/public/forms/${noGateForm.id}/submit`).send({ data: { name: 'Instant Lead', email: 'instant@example.com' }, hp: '' });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.consentPending, false);

  const { data: instantContact } = await client.from('contacts').select('id').eq('tenant_id', TENANT_ID).eq('email', 'instant@example.com').single();
  const { data: instantConsent } = await client.from('contact_consents').select('status').eq('tenant_id', TENANT_ID).eq('contact_id', instantContact.id).eq('channel', 'email').maybeSingle();
  assert.strictEqual(instantConsent?.status, 'opted_in', 'a form that does not require double opt-in should still record real opted-in consent immediately');
  const { data: instantEnrollment } = await client.from('workflow_enrollments').select('id').eq('workflow_id', journey.id).eq('contact_id', instantContact.id).maybeSingle();
  assert.ok(instantEnrollment, 'a no-consent-gate submission must fire the form_submitted journey trigger immediately');
  console.log('✓ a form without a consent gate opts the contact in and fires the journey trigger immediately on submit');

  const { data: adaEnrollment } = await client.from('workflow_enrollments').select('id').eq('workflow_id', journey.id).eq('contact_id', adaContact.id).maybeSingle();
  assert.ok(adaEnrollment, 'a double-opt-in form must fire the journey trigger once consent is confirmed');
  console.log('✓ a double-opt-in form fires the journey trigger only after the confirm link is clicked');

  // --- 8. Deactivating Marketing Hub makes a previously-active form unreachable (defense in depth) ---

  res = await request(app).patch(`/api/v1/platform/tenants/${TENANT_ID}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: false });
  assert.strictEqual(res.status, 200);
  res = await request(app).get(`/api/v1/public/forms/${noGateForm.id}`);
  assert.strictEqual(res.status, 404, 'a form must stop accepting public traffic the moment its tenant loses Marketing Hub access');
  await request(app).patch(`/api/v1/platform/tenants/${TENANT_ID}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: true });
  console.log('✓ revoking Marketing Hub access makes an active form\'s public endpoints immediately unreachable');

  // --- 9. Submissions list (paginated, joined to the real contact) ---

  res = await request(app).get(`/api/v1/marketing/forms/${form.id}/submissions?page=1&pageSize=25`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.total >= 3);
  const withContact = res.body.submissions.find((s) => s.contact_id);
  assert.ok(withContact && withContact.contacts, 'a submission tied to a real contact should carry its joined contact (display_name/email/phone)');
  const spamSubmission = res.body.submissions.find((s) => s.spam_flagged);
  assert.ok(spamSubmission && !spamSubmission.contact_id, 'the honeypot-flagged submission should show up here too (visible, not hidden) with no contact attached');
  console.log('✓ submissions list is paginated and joins the real contact');

  // --- 10. Optimistic concurrency on edit ---

  res = await request(app).patch(`/api/v1/marketing/forms/${form.id}`).set('Authorization', `Bearer ${token('member')}`).send({ name: 'Renamed', fields: FIELDS, version: 1 });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  assert.strictEqual(res.body.code, 'VERSION_CONFLICT');
  console.log('✓ editing with a stale version is rejected with 409 VERSION_CONFLICT');

  // --- 11. Cross-tenant isolation ---

  res = await request(app).get(`/api/v1/marketing/forms/${form.id}`).set('Authorization', `Bearer ${tokenB('owner')}`);
  assert.strictEqual(res.status, 404, 'tenant B must get 404, never another tenant\'s form');
  res = await request(app).get(`/api/v1/marketing/forms/${form.id}/submissions`).set('Authorization', `Bearer ${tokenB('owner')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.submissions.length, 0, 'scoped() must return zero rows, never another tenant\'s submissions');
  console.log('✓ cross-tenant isolation: tenant B gets 404s and empty results for tenant A\'s forms');

  // --- 12. Destructive delete is admin+ only and audit-logged ---

  res = await request(app).delete(`/api/v1/marketing/forms/${noGateForm.id}`).set('Authorization', `Bearer ${token('member')}`);
  assert.strictEqual(res.status, 403);
  res = await request(app).delete(`/api/v1/marketing/forms/${noGateForm.id}`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200);
  const { data: auditRow } = await client.from('audit_log').select('*').eq('tenant_id', TENANT_ID).eq('action', 'marketing.lead_form_deleted').eq('target_id', noGateForm.id).maybeSingle();
  assert.ok(auditRow, 'deleting a form must be audit-logged');
  console.log('✓ form deletion is admin+ only and recorded in the audit log');

  console.log('\nALL LEAD-FORM ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
