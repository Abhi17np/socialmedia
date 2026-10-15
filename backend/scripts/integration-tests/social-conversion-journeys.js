/**
 * Social-to-WhatsApp Conversion Journeys: the focused, ungated
 * authoring surface (routes/conversionJourneys.js) over the SAME
 * journey engine Marketing Hub's full journey builder already runs on.
 * Covers the full real pipeline — create a journey, activate it, fire
 * the real 'social_message_received' trigger (the same call
 * social/pollers.js makes for a genuinely new resolved inbound
 * message), confirm it actually enrolls and advances to the
 * send_whatsapp action, confirm a consented contact gets a real
 * whatsapp_campaigns/whatsapp_campaign_recipients row while an opted-
 * out one is correctly skipped (lib/journeyActions.js's existing
 * consent gate, not re-implemented here), and confirms this surface
 * needs no Marketing Hub — the "WhatsApp broadcast is Social Hub's own
 * feature" posture applied to journeys.
 *
 * Run: node scripts/integration-tests/social-conversion-journeys.js
 * (needs PostgREST + the rest-proxy running; does NOT need Redis — this
 * test verifies ENQUEUEING, i.e. the campaign/recipient rows and the
 * consent gate, the same boundary broadcast-queue.js's own test draws
 * around the actual send, not a live Meta delivery.)
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
const { fireWorkflowTrigger, runEnrollmentTick } = require(path.join(BACKEND, 'lib/journeyEngine'));

const TENANT_A = randomUUID(); // Marketing Hub NOT enabled — proves this surface doesn't need it
const TENANT_B = randomUUID();
const MEMBER_A = randomUUID();
const ADMIN_A = randomUUID();
const memberTokenA = signToken({ userId: MEMBER_A, tenantId: TENANT_A, role: 'member' });
const adminTokenA = signToken({ userId: ADMIN_A, tenantId: TENANT_A, role: 'admin' });
const viewerTokenB = signToken({ userId: randomUUID(), tenantId: TENANT_B, role: 'viewer' });

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert([
    { id: TENANT_A, name: 'Conversion Journey Tenant A', slug: 'conv-journey-a-' + Date.now() },
    { id: TENANT_B, name: 'Conversion Journey Tenant B', slug: 'conv-journey-b-' + Date.now() }
  ]);
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert([
    { id: MEMBER_A, tenant_id: TENANT_A, email: `member-${Date.now()}@cj-test.com`, password_hash: 'x', role: 'member' },
    { id: ADMIN_A, tenant_id: TENANT_A, email: `admin-${Date.now()}@cj-test.com`, password_hash: 'x', role: 'admin' }
  ]);
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  const waAccountId = randomUUID();
  r = await client.from('social_accounts').insert({ id: waAccountId, tenant_id: TENANT_A, platform: 'whatsapp', account_label: 'Test WABA', external_account_id: 'ext-waba', access_token: 'enc-not-real' });
  if (r.error) throw new Error('social_accounts insert failed: ' + JSON.stringify(r.error));

  const templateId = randomUUID();
  r = await client.from('whatsapp_templates').insert({
    id: templateId, tenant_id: TENANT_A, social_account_id: waAccountId, name: 'follow_up', language: 'en_US',
    body_text: 'Thanks for reaching out! {{1}}', variable_samples: ['details'], approval_status: 'approved'
  });
  if (r.error) throw new Error('whatsapp_templates insert failed: ' + JSON.stringify(r.error));

  // --- A viewer cannot create one; a member can ---
  let res = await request(app).post('/api/v1/social/conversion-journeys').set('Authorization', `Bearer ${signToken({ userId: randomUUID(), tenantId: TENANT_A, role: 'viewer' })}`).send({
    name: 'should be forbidden', templateId, socialAccountId: waAccountId
  });
  assert.strictEqual(res.status, 403);

  res = await request(app).post('/api/v1/social/conversion-journeys').set('Authorization', `Bearer ${memberTokenA}`).send({
    name: 'DM follow-up', delayAmount: 5, delayUnit: 'minutes', templateId, socialAccountId: waAccountId
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const journeyId = res.body.journey.id;
  assert.strictEqual(res.body.journey.is_active, false, 'a new conversion journey starts inactive, same convention as the full journey builder');
  assert.strictEqual(res.body.journey.trigger_type, 'social_message_received');
  console.log('✓ POST /social/conversion-journeys is member+ gated and creates an inactive journey with the right trigger type');

  // --- socialAccountId must actually be a WhatsApp account ---
  const fbAccountId = randomUUID();
  await client.from('social_accounts').insert({ id: fbAccountId, tenant_id: TENANT_A, platform: 'facebook', account_label: 'Not WhatsApp', external_account_id: 'ext-fb', access_token: 'enc-not-real' });
  res = await request(app).post('/api/v1/social/conversion-journeys').set('Authorization', `Bearer ${memberTokenA}`).send({
    name: 'wrong platform', templateId, socialAccountId: fbAccountId
  });
  assert.strictEqual(res.status, 400);
  console.log('✓ socialAccountId must be a connected WhatsApp account');

  // --- Firing the trigger before activation does NOT enroll anyone ---
  const contactConsented = randomUUID();
  await client.from('contacts').insert({ id: contactConsented, tenant_id: TENANT_A, display_name: 'Consented Contact', phone: '15550001111' });
  await fireWorkflowTrigger(client, TENANT_A, 'social_message_received', { contactId: contactConsented, platform: 'whatsapp' });
  let { data: enrollments } = await client.from('workflow_enrollments').select('*').eq('workflow_id', journeyId);
  assert.strictEqual((enrollments || []).length, 0, 'an inactive journey must not enroll anyone, even when its trigger fires');
  console.log('✓ firing the trigger on an inactive journey enrolls no one');

  // --- Activate (admin+ only), then firing the trigger really enrolls and advances to the send_whatsapp action ---
  res = await request(app).patch(`/api/v1/social/conversion-journeys/${journeyId}/activate`).set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 403, 'a member cannot activate');
  res = await request(app).patch(`/api/v1/social/conversion-journeys/${journeyId}/activate`).set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.journey.is_active, true);

  await fireWorkflowTrigger(client, TENANT_A, 'social_message_received', { contactId: contactConsented, platform: 'whatsapp' });
  ({ data: enrollments } = await client.from('workflow_enrollments').select('*').eq('workflow_id', journeyId).eq('contact_id', contactConsented));
  assert.strictEqual(enrollments.length, 1, 'activating, then firing the same trigger, now enrolls the contact');
  const enrollment = enrollments[0];
  assert.ok(enrollment.next_action_at, 'the enrollment must be paused at the delay node, with a real resume time set');
  console.log('✓ activating the journey, then firing the real trigger, enrolls the contact and pauses it at the delay');

  // --- Force the delay to resolve now (same effect as lib/journeySweep.js noticing next_action_at has passed) and confirm a real WhatsApp campaign is created ---
  await runEnrollmentTick(client, TENANT_A, enrollment);
  const { data: campaignRows } = await client.from('whatsapp_campaigns').select('*, whatsapp_campaign_recipients(*)').eq('tenant_id', TENANT_A).eq('template_id', templateId);
  const consentedCampaign = (campaignRows || []).find((c) => (c.whatsapp_campaign_recipients || []).some((r2) => r2.contact_id === contactConsented));
  assert.ok(consentedCampaign, 'a real whatsapp_campaigns row must exist for the consented contact');
  console.log('✓ resuming the enrollment past the delay really creates a whatsapp_campaigns/whatsapp_campaign_recipients row — reusing lib/journeyActions.js\'s sendWhatsapp() exactly');

  // --- An opted-out contact is correctly SKIPPED, not sent to — the existing consent gate, not re-implemented here ---
  const contactOptedOut = randomUUID();
  await client.from('contacts').insert({ id: contactOptedOut, tenant_id: TENANT_A, display_name: 'Opted-Out Contact', phone: '15550002222', global_opt_out_at: new Date().toISOString() });
  await fireWorkflowTrigger(client, TENANT_A, 'social_message_received', { contactId: contactOptedOut, platform: 'whatsapp' });
  const { data: optedOutEnrollments } = await client.from('workflow_enrollments').select('*').eq('workflow_id', journeyId).eq('contact_id', contactOptedOut);
  await runEnrollmentTick(client, TENANT_A, optedOutEnrollments[0]);

  const { data: optedOutEvents } = await client.from('workflow_enrollment_events').select('*').eq('enrollment_id', optedOutEnrollments[0].id).eq('node_id', 'send');
  assert.strictEqual(optedOutEvents[0].result.skipped, 'suppressed_or_opted_out');
  const { data: optedOutCampaignRows } = await client.from('whatsapp_campaigns').select('*, whatsapp_campaign_recipients(*)').eq('tenant_id', TENANT_A).eq('template_id', templateId);
  assert.ok(!(optedOutCampaignRows || []).some((c) => (c.whatsapp_campaign_recipients || []).some((r2) => r2.contact_id === contactOptedOut)), 'an opted-out contact must never get a real campaign/recipient row');
  console.log('✓ an opted-out contact is correctly skipped — no WhatsApp send, consent gate honored end to end');

  // --- Tenant isolation ---
  res = await request(app).get(`/api/v1/social/conversion-journeys/${journeyId}`).set('Authorization', `Bearer ${viewerTokenB}`);
  assert.strictEqual(res.status, 404);
  console.log('✓ conversion journeys are tenant-isolated');

  // --- This surface genuinely needs no Marketing Hub — list/pause/delete all work on an ungated tenant ---
  res = await request(app).get('/api/v1/social/conversion-journeys').set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.journeys.some((j) => j.id === journeyId));
  res = await request(app).patch(`/api/v1/social/conversion-journeys/${journeyId}/pause`).set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.journey.is_active, false);
  res = await request(app).delete(`/api/v1/social/conversion-journeys/${journeyId}`).set('Authorization', `Bearer ${adminTokenA}`);
  assert.strictEqual(res.status, 200);
  console.log('✓ list/pause/delete all work, ungated, on a tenant with no Marketing Hub enabled');

  console.log('\nALL SOCIAL CONVERSION JOURNEY ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('SOCIAL CONVERSION JOURNEY TEST FAILED:', err.message);
  process.exit(1);
});
