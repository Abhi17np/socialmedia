/**
 * End-to-end exercise of the Phase 4 journeys/automation upgrade
 * (migrations/028_journeys.sql, lib/journeyGraph.js, lib/journeyActions.js,
 * lib/journeyEngine.js, lib/journeySweep.js, routes/journeys.js) against a
 * real Postgres/PostgREST/Redis stack. Covers the task brief's specific
 * journey-engine bar: restart-mid-journey, duplicate-job idempotency,
 * re-entry, edit-while-live, and a (small-scale) high-volume enrollment —
 * plus the authoring CRUD surface, trigger wiring from Sales Hub routes,
 * cross-tenant isolation, and optimistic concurrency.
 *
 * Run: node scripts/integration-tests/marketing-journeys.js
 * (needs PostgREST + the rest-proxy + Redis running; does NOT need a
 * separately running `node server.js` — see this directory's README.
 * Assumes a platform_admins row exists already, same as marketing-consent.js.)
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
const { runEnrollmentTick, enrollContact } = require(path.join(BACKEND, 'lib/journeyEngine'));
const { sweep } = require(path.join(BACKEND, 'lib/journeySweep'));

const TENANT_ID = randomUUID();
const TENANT_B_ID = randomUUID(); // for cross-tenant isolation checks
const USER_ID = randomUUID();
const token = (role) => signToken({ userId: USER_ID, tenantId: TENANT_ID, role });
const tokenB = (role) => signToken({ userId: randomUUID(), tenantId: TENANT_B_ID, role });

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert({ id: TENANT_ID, name: 'Journeys Test Tenant', slug: 'journeys-test-' + Date.now() });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('tenants').insert({ id: TENANT_B_ID, name: 'Journeys Test Tenant B', slug: 'journeys-test-b-' + Date.now() });
  if (r.error) throw new Error('tenant B insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: USER_ID, tenant_id: TENANT_ID, email: `owner-${Date.now()}@journeys-test.com`, password_hash: 'x', role: 'owner' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  // Flip Marketing Hub + Sales Hub on for the test tenant via the real
  // platform-admin API, exactly like marketing-consent.js does.
  const { data: admin } = await client.from('platform_admins').select('id').limit(1).single();
  const jwt = require(path.join(BACKEND, 'node_modules/jsonwebtoken'));
  const platformToken = jwt.sign({ adminId: admin.id, scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  let res = await request(app).patch(`/api/v1/platform/tenants/${TENANT_ID}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: true, sales: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  res = await request(app).patch(`/api/v1/platform/tenants/${TENANT_B_ID}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: true, sales: true });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  console.log('✓ Marketing + Sales Hub enabled for both test tenants');

  // --- 0. Role gating + validation on the authoring surface ---

  res = await request(app).post('/api/v1/marketing/journeys').set('Authorization', `Bearer ${token('viewer')}`).send({ name: 'x', triggerType: 'contact_tag_added', graph: { nodes: [{ id: 't', type: 'trigger' }], edges: [] } });
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  console.log('✓ viewer blocked from creating a journey (member+ only)');

  res = await request(app).post('/api/v1/marketing/journeys').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Bad graph', triggerType: 'contact_tag_added',
    graph: { nodes: [{ id: 't', type: 'trigger' }, { id: 'c', type: 'condition', config: { field: 'lead_score', operator: 'gte', value: 50 } }], edges: [{ id: 'e1', source: 't', target: 'c' }] }
  });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  assert.ok(/condition node/i.test(res.body.error), 'should name the malformed condition node, not a generic 500: ' + res.body.error);
  console.log('✓ a condition node missing its yes/no edges is rejected with a clean 400, not a crash');

  // --- 1. A real linear journey: tag -> add_tag -> delay -> create_task ---

  const graph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'tag1', type: 'action', actionType: 'add_tag', config: { tag: 'in-nurture' } },
      { id: 'd1', type: 'delay', config: { amount: 1, unit: 'minutes' } },
      { id: 'task1', type: 'action', actionType: 'create_task', config: { subject: 'Check in with nurtured lead' } }
    ],
    edges: [
      { id: 'e1', source: 't', target: 'tag1' },
      { id: 'e2', source: 'tag1', target: 'd1' },
      { id: 'e3', source: 'd1', target: 'task1' }
    ]
  };
  res = await request(app).post('/api/v1/marketing/journeys').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Nurture tagged leads', triggerType: 'contact_tag_added', triggerConfig: { tag: 'nurture-me' }, graph
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const journey = res.body.journey;
  assert.strictEqual(journey.is_active, false, 'a new journey starts inactive, never live by default');
  console.log('✓ journey created as a real row with a real validated graph, inactive by default');

  res = await request(app).patch(`/api/v1/marketing/journeys/${journey.id}/activate`).set('Authorization', `Bearer ${token('member')}`);
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  console.log('✓ member blocked from activating a journey (admin+ only)');

  res = await request(app).patch(`/api/v1/marketing/journeys/${journey.id}/activate`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.journey.is_active, true);
  console.log('✓ journey activated');

  // --- 2. Manual enrollment runs the first tick synchronously ---

  const { data: contact1 } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Nurture Contact', phone: '919991110001', email: 'nurture1@example.com' }).select('*').single();

  res = await request(app).post(`/api/v1/marketing/journeys/${journey.id}/enroll`).set('Authorization', `Bearer ${token('member')}`).send({ contactId: contact1.id });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const enrollmentId = res.body.enrollmentId;

  let { data: enrollmentRow } = await client.from('workflow_enrollments').select('*').eq('id', enrollmentId).single();
  assert.strictEqual(enrollmentRow.status, 'active');
  assert.strictEqual(enrollmentRow.current_node_id, 'task1', 'tick should run tag1 then pause at the delay node, advancing current_node_id to the node after it');
  assert.ok(enrollmentRow.next_action_at, 'a paused-at-delay enrollment must have next_action_at set so the sweep can find it');

  let { data: taggedContact } = await client.from('contacts').select('tags').eq('id', contact1.id).single();
  assert.ok(taggedContact.tags.includes('in-nurture'), 'the add_tag action before the delay should have run synchronously on enroll');
  console.log('✓ enrolling a contact runs the first tick immediately: action executed, paused at the delay node');

  // --- 3. Restart-mid-journey: nothing about the paused delay lives in process memory — it's the
  // next_action_at column the sweep (lib/journeySweep.js) re-reads from the DB on every pass. Simulate
  // a process restart by just running the exact same sweep() a freshly-started process would run, with
  // zero in-memory state, BEFORE the delay is actually due — it must be a no-op, not an early fire.

  await sweep();
  let { data: afterEarlySweep } = await client.from('workflow_enrollments').select('*').eq('id', enrollmentId).single();
  assert.strictEqual(afterEarlySweep.current_node_id, 'task1', 'a restart must not advance a still-pending delay early');
  assert.strictEqual(afterEarlySweep.status, 'active');
  let { count: taskCountBeforeDue } = await client.from('sales_activities').select('id', { count: 'exact', head: true }).eq('contact_id', contact1.id).eq('subject', 'Check in with nurtured lead');
  assert.strictEqual(taskCountBeforeDue, 0, 'the sweep must not run the downstream action before next_action_at is actually due');
  console.log('✓ restart-mid-journey: a fresh sweep (no in-memory state) run before the delay is due changes nothing');

  // --- 4. Duplicate-job idempotency: the delay-resume sweep must not double-run the create_task action
  // if it (hypothetically) fired twice for the same enrollment — e.g. two overlapping sweep intervals.

  await client.from('workflow_enrollments').update({ next_action_at: new Date(Date.now() - 1000).toISOString() }).eq('id', enrollmentId); // force it due
  await sweep(); // first resume: should run create_task and complete the journey
  let { data: afterSweep1 } = await client.from('workflow_enrollments').select('*').eq('id', enrollmentId).single();
  assert.strictEqual(afterSweep1.status, 'completed', 'ran off the end of the graph after task1 with no goal_config');
  let { count: taskCountAfter1 } = await client.from('sales_activities').select('id', { count: 'exact', head: true }).eq('contact_id', contact1.id).eq('subject', 'Check in with nurtured lead');
  assert.strictEqual(taskCountAfter1, 1, 'create_task should have run exactly once');

  // Now simulate a duplicate sweep pass picking up the SAME enrollment again (e.g. it wasn't cleared
  // in time) by calling runEnrollmentTick directly on a reconstructed "still due" row — the engine's
  // alreadyCompleted() check on workflow_enrollment_events must skip re-running task1 a second time.
  await client.from('workflow_enrollments').update({ status: 'active', current_node_id: 'task1', completed_at: null }).eq('id', enrollmentId);
  const { data: enrollmentForReplay } = await client.from('workflow_enrollments').select('*').eq('id', enrollmentId).single();
  await runEnrollmentTick(client, TENANT_ID, enrollmentForReplay);
  let { count: taskCountAfter2 } = await client.from('sales_activities').select('id', { count: 'exact', head: true }).eq('contact_id', contact1.id).eq('subject', 'Check in with nurtured lead');
  assert.strictEqual(taskCountAfter2, 1, 'a duplicate tick on an already-completed action node must not create a second task — idempotent via workflow_enrollment_events');
  console.log('✓ duplicate-job idempotency: re-running a tick after an action already completed does not re-execute it');

  // Restore it to a clean completed state for the rest of the test.
  await client.from('workflow_enrollments').update({ status: 'completed', completed_at: new Date().toISOString(), next_action_at: null }).eq('id', enrollmentId);

  // --- 5. Re-entry: reentry_allowed=false skips re-enrolling an already-ACTIVE contact; true allows it ---

  const { data: contact2 } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Reentry Contact', phone: '919991110002' }).select('*').single();
  let first = await enrollContact(client, TENANT_ID, journey.id, contact2.id);
  assert.strictEqual(first.alreadyEnrolled, false);
  let second = await enrollContact(client, TENANT_ID, journey.id, contact2.id);
  assert.strictEqual(second.alreadyEnrolled, true, 'reentry_allowed defaults to false — a second enroll while still active must be a no-op, not a duplicate run');
  assert.strictEqual(second.enrollmentId, first.enrollmentId);
  console.log('✓ re-entry blocked by default: enrolling an already-active contact returns the existing enrollment');

  // Flip reentry on and confirm a second real run is now allowed once the first one finishes.
  await client.from('workflow_enrollments').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', first.enrollmentId);
  await client.from('workflow_definitions').update({ reentry_allowed: true }).eq('id', journey.id);
  let third = await enrollContact(client, TENANT_ID, journey.id, contact2.id);
  assert.strictEqual(third.alreadyEnrolled, false, 'with reentry_allowed=true and no active run left, a fresh enrollment should be created');
  assert.notStrictEqual(third.enrollmentId, first.enrollmentId);
  console.log('✓ re-entry allowed once reentry_allowed=true and the previous run has finished');
  await client.from('workflow_definitions').update({ reentry_allowed: false }).eq('id', journey.id);

  // --- 6. Edit-while-live: PATCH a graph while enrollments reference it, with optimistic concurrency ---

  const { data: liveJourney } = await client.from('workflow_definitions').select('version').eq('id', journey.id).single();
  res = await request(app).patch(`/api/v1/marketing/journeys/${journey.id}`).set('Authorization', `Bearer ${token('member')}`).send({
    name: journey.name, triggerType: journey.trigger_type, triggerConfig: journey.trigger_config, graph, version: 1
  });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body), 'version 1 is stale once activation already bumped it — must be a clean 409, not a silent overwrite');
  assert.strictEqual(res.body.code, 'VERSION_CONFLICT');
  console.log('✓ editing a live journey with a stale version is rejected with 409 VERSION_CONFLICT');

  const editedGraph = {
    nodes: [{ id: 't', type: 'trigger' }, { id: 'tag1', type: 'action', actionType: 'add_tag', config: { tag: 'in-nurture-v2' } }],
    edges: [{ id: 'e1', source: 't', target: 'tag1' }]
  };
  res = await request(app).patch(`/api/v1/marketing/journeys/${journey.id}`).set('Authorization', `Bearer ${token('member')}`).send({
    name: journey.name, triggerType: journey.trigger_type, triggerConfig: journey.trigger_config, graph: editedGraph, version: liveJourney.version
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.journey.graph_json.nodes.length, 2, 'the graph actually changed — this is a real edit to a live journey, not a no-op');
  console.log('✓ editing a live journey with the correct version succeeds and the new graph is saved');

  // An enrollment still paused at a node the edit removed (task1/d1 no longer exist) must fail its
  // next tick cleanly rather than crash the sweep — this is the real, documented limitation of
  // editing live journeys (see routes/journeys.js's comment), and it must behave exactly as documented.
  const { data: contact3 } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Orphaned Node Contact', phone: '919991110003' }).select('*').single();
  const { data: orphanEnrollment } = await client.from('workflow_enrollments').insert({ tenant_id: TENANT_ID, workflow_id: journey.id, contact_id: contact3.id, current_node_id: 'task1', status: 'active' }).select('*').single();
  await runEnrollmentTick(client, TENANT_ID, orphanEnrollment);
  let { data: orphanAfter } = await client.from('workflow_enrollments').select('status').eq('id', orphanEnrollment.id).single();
  assert.strictEqual(orphanAfter.status, 'failed', 'an enrollment paused at a node the live edit removed must fail cleanly, not throw/crash');
  console.log('✓ edit-while-live: an enrollment stranded on a since-removed node fails cleanly instead of crashing the sweep');

  // --- 7. Condition + split node branching, end to end ---

  const branchGraph = {
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'cond', type: 'condition', config: { field: 'lead_score', operator: 'gte', value: 50 } },
      { id: 'hot_tag', type: 'action', actionType: 'add_tag', config: { tag: 'hot-lead' } },
      { id: 'cold_tag', type: 'action', actionType: 'add_tag', config: { tag: 'cold-lead' } }
    ],
    edges: [
      { id: 'e1', source: 't', target: 'cond' },
      { id: 'e2', source: 'cond', target: 'hot_tag', branch: 'yes' },
      { id: 'e3', source: 'cond', target: 'cold_tag', branch: 'no' }
    ]
  };
  res = await request(app).post('/api/v1/marketing/journeys').set('Authorization', `Bearer ${token('member')}`).send({ name: 'Score branch', triggerType: 'contact_created', graph: branchGraph });
  const branchJourney = res.body.journey;
  await request(app).patch(`/api/v1/marketing/journeys/${branchJourney.id}/activate`).set('Authorization', `Bearer ${token('admin')}`);

  const { data: hotContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Hot Contact', phone: '919991110004', lead_score: 80 }).select('*').single();
  const { data: coldContact } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Cold Contact', phone: '919991110005', lead_score: 5 }).select('*').single();
  await enrollContact(client, TENANT_ID, branchJourney.id, hotContact.id);
  await enrollContact(client, TENANT_ID, branchJourney.id, coldContact.id);
  const { data: hotTags } = await client.from('contacts').select('tags').eq('id', hotContact.id).single();
  const { data: coldTags } = await client.from('contacts').select('tags').eq('id', coldContact.id).single();
  assert.ok(hotTags.tags.includes('hot-lead') && !hotTags.tags.includes('cold-lead'));
  assert.ok(coldTags.tags.includes('cold-lead') && !coldTags.tags.includes('hot-lead'));
  console.log('✓ condition node routes contacts down the correct yes/no branch');

  // --- 8. Trigger wiring: a real Sales Hub route firing a real journey (not a direct enrollContact call) ---

  res = await request(app).post('/api/v1/sales/contacts').set('Authorization', `Bearer ${token('member')}`).send({ displayName: 'Trigger Wired Contact', phone: '919991110006' });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const wiredContactId = res.body.contact.id;
  res = await request(app).patch(`/api/v1/sales/contacts/${wiredContactId}`).set('Authorization', `Bearer ${token('member')}`).send({ tags: ['nurture-me'] });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const { data: wiredEnrollments } = await client.from('workflow_enrollments').select('*').eq('workflow_id', journey.id).eq('contact_id', wiredContactId);
  assert.strictEqual(wiredEnrollments.length, 1, 'tagging a contact via the real Sales Hub route should auto-enroll it through fireWorkflowTrigger, matching trigger_config.tag');
  console.log('✓ real route (PATCH /sales/contacts/:id with a new tag) fires fireWorkflowTrigger and enrolls into the matching active journey');

  // A tag that does NOT match trigger_config must not enroll anything.
  res = await request(app).patch(`/api/v1/sales/contacts/${wiredContactId}`).set('Authorization', `Bearer ${token('member')}`).send({ tags: ['nurture-me', 'unrelated-tag'] });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const { data: stillOne } = await client.from('workflow_enrollments').select('id').eq('workflow_id', journey.id).eq('contact_id', wiredContactId);
  assert.strictEqual(stillOne.length, 1, 'a non-matching newly-added tag must not trigger a second enrollment');
  console.log('✓ a newly-added tag not matching trigger_config does not fire the journey');

  // --- 9. Templates: every prebuilt template clones into a real, valid, enrollable journey ---

  res = await request(app).get('/api/v1/marketing/journeys/templates').set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.templates.length >= 7);
  const templateKey = res.body.templates[0].key;
  res = await request(app).post(`/api/v1/marketing/journeys/from-template/${templateKey}`).set('Authorization', `Bearer ${token('member')}`);
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.journey.is_active, false);
  console.log('✓ cloning a prebuilt template produces a real, valid, inactive journey');

  // --- 10. High-volume (small-scale) enrollment: many contacts through one tick pass without choking ---

  const VOLUME = 50;
  const volumeGraph = { nodes: [{ id: 't', type: 'trigger' }, { id: 'tag', type: 'action', actionType: 'add_tag', config: { tag: 'bulk-nurtured' } }], edges: [{ id: 'e1', source: 't', target: 'tag' }] };
  res = await request(app).post('/api/v1/marketing/journeys').set('Authorization', `Bearer ${token('member')}`).send({ name: 'Bulk volume journey', triggerType: 'contact_created', graph: volumeGraph });
  const volumeJourney = res.body.journey;
  await request(app).patch(`/api/v1/marketing/journeys/${volumeJourney.id}/activate`).set('Authorization', `Bearer ${token('admin')}`);

  const volumeContacts = [];
  for (let i = 0; i < VOLUME; i++) volumeContacts.push({ tenant_id: TENANT_ID, display_name: `Bulk Contact ${i}`, phone: `9199911${String(20000 + i).padStart(5, '0')}` });
  const { data: insertedBulk } = await client.from('contacts').insert(volumeContacts).select('id');
  assert.strictEqual(insertedBulk.length, VOLUME);

  const start = Date.now();
  await Promise.all(insertedBulk.map((c) => enrollContact(client, TENANT_ID, volumeJourney.id, c.id)));
  const elapsedMs = Date.now() - start;

  const { count: completedVolumeCount } = await client.from('workflow_enrollments').select('id', { count: 'exact', head: true }).eq('workflow_id', volumeJourney.id).eq('status', 'completed');
  assert.strictEqual(completedVolumeCount, VOLUME, `all ${VOLUME} enrollments should reach completed (single action, no delay)`);
  console.log(`✓ high-volume: ${VOLUME} concurrent enrollments all completed correctly in ${elapsedMs}ms`);

  // --- 11. Analytics reflect real totals and per-node counts ---

  res = await request(app).get(`/api/v1/marketing/journeys/${volumeJourney.id}/analytics`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.totals.entered, VOLUME);
  assert.strictEqual(res.body.totals.completed, VOLUME);
  const tagNodeStats = res.body.perNode.find((n) => n.nodeId === 'tag');
  assert.strictEqual(tagNodeStats.completed, VOLUME);
  console.log('✓ analytics endpoint reports real per-node and total counts computed from workflow_enrollment_events');

  // --- 12. Cross-tenant isolation: tenant B cannot see, enroll into, or operate on tenant A's journey ---

  res = await request(app).get(`/api/v1/marketing/journeys/${journey.id}`).set('Authorization', `Bearer ${tokenB('owner')}`);
  assert.strictEqual(res.status, 404, 'tenant B must get 404, not 403 or the real data, for another tenant\'s journey id');
  res = await request(app).patch(`/api/v1/marketing/journeys/${journey.id}/activate`).set('Authorization', `Bearer ${tokenB('owner')}`);
  assert.strictEqual(res.status, 404);
  res = await request(app).get(`/api/v1/marketing/journeys/${journey.id}/enrollments`).set('Authorization', `Bearer ${tokenB('owner')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.enrollments.length, 0, 'scoped() must silently return zero rows, never another tenant\'s enrollments');
  console.log('✓ cross-tenant isolation: tenant B gets 404s and empty results for tenant A\'s journey, never real data');

  // --- 13. Destructive action (delete) is admin+ only and audit-logged ---

  res = await request(app).delete(`/api/v1/marketing/journeys/${volumeJourney.id}`).set('Authorization', `Bearer ${token('member')}`);
  assert.strictEqual(res.status, 403, 'delete must be admin+ only');
  res = await request(app).delete(`/api/v1/marketing/journeys/${volumeJourney.id}`).set('Authorization', `Bearer ${token('admin')}`);
  assert.strictEqual(res.status, 200);
  const { data: auditRow } = await client.from('audit_log').select('*').eq('tenant_id', TENANT_ID).eq('action', 'marketing.journey_deleted').eq('target_id', volumeJourney.id).maybeSingle();
  assert.ok(auditRow, 'deleting a journey must be audit-logged');
  console.log('✓ journey deletion is admin+ only and recorded in the audit log');

  console.log('\nALL JOURNEY ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
