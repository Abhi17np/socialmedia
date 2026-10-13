/**
 * End-to-end exercise of Sales Hub Stage 2's sequence engine
 * (lib/sequences.js + routes/sales.js's sequence CRUD/enroll/pause-
 * resume-stop routes) and the automation idempotency guard + manual
 * retry path (lib/automation.js) against a real app instance and
 * Postgres via PostgREST. See this directory's README for setup.
 *
 * Run: node scripts/integration-tests/sales-sequences.js
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
const { processDueEnrollments } = require(path.join(BACKEND, 'lib/sequences'));
const { fireTrigger } = require(path.join(BACKEND, 'lib/automation'));

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

  await client.from('tenants').insert({ id: tenantId, name: 'Sequences Test Tenant', slug: 'sequences-' + Date.now(), hubs_enabled: { sales: true, marketing: false } });
  await client.from('users').insert({ id: ownerId, tenant_id: tenantId, email: `owner-${Date.now()}@sequences-test.com`, password_hash: 'x', role: 'owner' });

  const adminToken = token(tenantId, ownerId, 'admin');
  const memberToken = token(tenantId, ownerId, 'member');

  // --- Sequence CRUD + steps ---

  let r = await api('/api/v1/sales/sequences', { method: 'POST', auth: adminToken, body: { name: 'New lead nurture', description: 'Task then tag' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const sequence = r.data.sequence;

  r = await api(`/api/v1/sales/sequences/${sequence.id}/steps`, { method: 'POST', auth: adminToken, body: { delayDays: 0, actionType: 'create_task', actionConfig: { subject: 'Welcome call' } } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  r = await api(`/api/v1/sales/sequences/${sequence.id}/steps`, { method: 'POST', auth: adminToken, body: { delayDays: 2, actionType: 'add_tag', actionConfig: { tag: 'nurtured' } } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  console.log('✓ sequence created with 2 steps (create_task immediate, add_tag after 2 days)');

  r = await api('/api/v1/sales/sequences', { auth: memberToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const listed = r.data.sequences.find((s) => s.id === sequence.id);
  assert.strictEqual(listed.stepCount, 2);
  console.log('✓ GET /sales/sequences reports the real step count');

  // --- Enroll a contact ---

  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Sequence Lead' } });
  const contact = r.data.contact;

  r = await api(`/api/v1/sales/sequences/${sequence.id}/enroll`, { method: 'POST', auth: memberToken, body: { contactId: contact.id } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.enrollment.current_step, 0);
  const enrollment = r.data.enrollment;
  console.log('✓ enrolling a contact creates an active enrollment at step 0');

  r = await api(`/api/v1/sales/sequences/${sequence.id}/enroll`, { method: 'POST', auth: memberToken, body: { contactId: contact.id } });
  assert.strictEqual(r.status, 409, JSON.stringify(r.data));
  console.log('✓ enrolling the same contact twice in the same sequence is rejected with 409');

  // --- Sweep processes the first (immediate) step ---

  await processDueEnrollments(client);
  r = await api('/api/v1/sales/activities?type=task', { auth: memberToken });
  const welcomeTask = (r.data.activities || []).find((a) => a.subject === 'Welcome call' && a.contact_id === contact.id);
  assert.ok(welcomeTask, 'expected the sweep to have created the "Welcome call" task: ' + JSON.stringify(r.data.activities));
  console.log('✓ sweep executed the enrollment\'s first (immediate) step — a real task was created');

  const { data: afterStep1 } = await client.from('sequence_enrollments').select('*').eq('id', enrollment.id).single();
  assert.strictEqual(afterStep1.current_step, 1, 'expected current_step to advance to 1');
  assert.strictEqual(afterStep1.status, 'active', 'two-step sequence must still be active, waiting on step 2');
  assert.ok(new Date(afterStep1.next_run_at) > new Date(Date.now() + 1.9 * 86400000), 'next_run_at must be ~2 days out for the delayed second step');
  console.log('✓ enrollment advanced to step 1 with next_run_at ~2 days out, status still active');

  // sweeping again immediately must NOT re-run step 1 (it's not due yet)
  await processDueEnrollments(client);
  r = await api('/api/v1/sales/activities?type=task', { auth: memberToken });
  const welcomeTasks = (r.data.activities || []).filter((a) => a.subject === 'Welcome call' && a.contact_id === contact.id);
  assert.strictEqual(welcomeTasks.length, 1, 'sweeping again before the delay elapses must not create a duplicate task: ' + JSON.stringify(welcomeTasks));
  console.log('✓ re-sweeping before a step is due does not re-execute it');

  // --- Simulate the 2-day delay elapsing, sweep runs step 2 ---

  await client.from('sequence_enrollments').update({ next_run_at: new Date(Date.now() - 1000).toISOString() }).eq('id', enrollment.id);
  await processDueEnrollments(client);

  const { data: contactAfter } = await client.from('contacts').select('tags').eq('id', contact.id).single();
  assert.ok(contactAfter.tags.includes('nurtured'), 'expected step 2 (add_tag) to have tagged the contact: ' + JSON.stringify(contactAfter.tags));

  const { data: afterStep2 } = await client.from('sequence_enrollments').select('*').eq('id', enrollment.id).single();
  assert.strictEqual(afterStep2.status, 'completed', 'expected the enrollment to complete after its last step ran');
  console.log('✓ sweep executed the final step for real and marked the enrollment completed');

  // --- Pause / resume / stop ---

  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Second Sequence Lead' } });
  const contact2 = r.data.contact;
  r = await api(`/api/v1/sales/sequences/${sequence.id}/enroll`, { method: 'POST', auth: memberToken, body: { contactId: contact2.id } });
  const enrollment2 = r.data.enrollment;

  r = await api(`/api/v1/sales/sequence-enrollments/${enrollment2.id}`, { method: 'PATCH', auth: memberToken, body: { status: 'paused' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await processDueEnrollments(client);
  const { data: pausedCheck } = await client.from('sequence_enrollments').select('current_step').eq('id', enrollment2.id).single();
  assert.strictEqual(pausedCheck.current_step, 0, 'a paused enrollment must not advance when swept');
  console.log('✓ pausing an enrollment stops it from advancing on sweep');

  r = await api(`/api/v1/sales/sequence-enrollments/${enrollment2.id}`, { method: 'PATCH', auth: memberToken, body: { status: 'active' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await processDueEnrollments(client);
  const { data: resumedCheck } = await client.from('sequence_enrollments').select('current_step').eq('id', enrollment2.id).single();
  assert.strictEqual(resumedCheck.current_step, 1, 'resuming must let the sweep advance it again');
  console.log('✓ resuming an enrollment lets it advance again');

  r = await api(`/api/v1/sales/sequence-enrollments/${enrollment2.id}`, { method: 'PATCH', auth: memberToken, body: { status: 'stopped' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  console.log('✓ an enrollment can be stopped');

  // --- Automation idempotency ---

  r = await api('/api/v1/sales/lead-scoring-rules', { auth: adminToken }); // just to confirm hub reachable before automation calls
  const { data: ruleRow } = await client.from('automation_rules').insert({
    tenant_id: tenantId, name: 'Idempotency check', trigger_type: 'contact_created', action_type: 'add_tag', action_config: { tag: 'auto-tagged' }, is_active: true
  }).select('*').single();

  r = await api('/api/v1/sales/contacts', { method: 'POST', auth: memberToken, body: { displayName: 'Idempotency Contact' } });
  const idempotencyContact = r.data.contact;

  await new Promise((res) => setTimeout(res, 200));
  // fireTrigger() already ran once from the route handler itself — call it again immediately for the same event, simulating an accidental double-invocation
  await fireTrigger(client, tenantId, 'contact_created', { refType: 'contact', refId: idempotencyContact.id, contactId: idempotencyContact.id });

  const { data: runs } = await client.from('automation_runs').select('*').eq('rule_id', ruleRow.id).eq('status', 'success');
  assert.strictEqual(runs.length, 1, 'a rule must not record two successful runs for the exact same event fired twice in quick succession: ' + JSON.stringify(runs));
  console.log('✓ firing the exact same automation event twice in quick succession only executes and records once');

  // --- Automation manual retry ---

  const { data: failingRule } = await client.from('automation_rules').insert({
    tenant_id: tenantId, name: 'Deliberately broken rule', trigger_type: 'contact_tag_added', action_type: 'assign_owner', action_config: {}, is_active: true
  }).select('*').single();

  r = await api(`/api/v1/sales/contacts/${idempotencyContact.id}`, { method: 'PATCH', auth: memberToken, body: { tags: ['trigger-it'] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await new Promise((res) => setTimeout(res, 200));

  const { data: failedRuns } = await client.from('automation_runs').select('*').eq('rule_id', failingRule.id).eq('status', 'failed');
  assert.strictEqual(failedRuns.length, 1, 'the misconfigured rule (no ownerId) must have recorded a failed run: ' + JSON.stringify(failedRuns));
  console.log('✓ a misconfigured rule records a failed run instead of crashing the request that triggered it');

  await client.from('automation_rules').update({ action_config: { ownerId } }).eq('id', failingRule.id);
  r = await api(`/api/v1/sales/automation-runs/${failedRuns[0].id}/retry`, { method: 'POST', auth: adminToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.run.status, 'success', 'retrying after fixing the rule\'s config must succeed: ' + JSON.stringify(r.data.run));
  console.log('✓ POST /sales/automation-runs/:id/retry re-executes the rule and records a new successful run after the config was fixed');

  const { data: contactAfterRetry } = await client.from('contacts').select('owner_id').eq('id', idempotencyContact.id).single();
  assert.strictEqual(contactAfterRetry.owner_id, ownerId, 'the retried assign_owner action must have actually set the owner');
  console.log('✓ the retried action had a real effect (contact owner actually set)');

  console.log('\nALL SALES SEQUENCES/AUTOMATION-IDEMPOTENCY/RETRY ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
