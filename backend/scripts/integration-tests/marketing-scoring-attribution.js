/**
 * End-to-end exercise of the Phase 6 scoring/lifecycle/attribution
 * upgrade (migrations/030_lifecycle_attribution.sql, lib/leadScoring.js's
 * behavioral condition types + MQL auto-promotion, lib/attribution.js,
 * routes/attribution.js) against a real Postgres/PostgREST/Redis stack.
 *
 * Covers: behavioral lead-scoring rules reacting to REAL email opens/
 * clicks (the actual public tracking endpoints), a real form submission,
 * and a real journey completion; MQL auto-promotion crossing a tenant-
 * configurable threshold (and never promoting a contact already past
 * mql or marked 'other'); the 'became_mql' journey trigger firing for
 * real; and attribution (first/last/linear) computed from real
 * touchpoints for a real won deal, respecting the closed_at cutoff and
 * never summing revenue across currencies.
 *
 * Run: node scripts/integration-tests/marketing-scoring-attribution.js
 * (needs PostgREST + the rest-proxy + Redis running; does NOT need a
 * separately running `node server.js` — see this directory's README.
 * Assumes a platform_admins row already exists.)
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

function clickUrl(recipientId, dest) {
  return `/api/v1/marketing/email/track/click/${recipientId}?u=${encodeURIComponent(Buffer.from(dest, 'utf8').toString('base64url'))}`;
}

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert({ id: TENANT_ID, name: 'Scoring Test Tenant', slug: 'scoring-test-' + Date.now() });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('tenants').insert({ id: TENANT_B_ID, name: 'Scoring Test Tenant B', slug: 'scoring-test-b-' + Date.now() });
  if (r.error) throw new Error('tenant B insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: USER_ID, tenant_id: TENANT_ID, email: `owner-${Date.now()}@scoring-test.com`, password_hash: 'x', role: 'owner' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  const { data: admin } = await client.from('platform_admins').select('id').limit(1).single();
  const jwt = require(path.join(BACKEND, 'node_modules/jsonwebtoken'));
  const platformToken = jwt.sign({ adminId: admin.id, scope: 'platform' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  for (const t of [TENANT_ID, TENANT_B_ID]) {
    const res = await request(app).patch(`/api/v1/platform/tenants/${t}/hubs`).set('Authorization', `Bearer ${platformToken}`).send({ marketing: true, sales: true });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  }
  console.log('✓ Marketing + Sales Hub enabled for both test tenants');

  // --- 0. Scoring settings: defaults, role gating, validation ---

  let res = await request(app).get('/api/v1/marketing/scoring-settings').set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.mqlThreshold, 50, 'a fresh tenant defaults to the documented 50-point threshold');
  console.log('✓ scoring-settings defaults to mqlThreshold=50');

  res = await request(app).patch('/api/v1/marketing/scoring-settings').set('Authorization', `Bearer ${token('member')}`).send({ mqlThreshold: 50 });
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  res = await request(app).patch('/api/v1/marketing/scoring-settings').set('Authorization', `Bearer ${token('admin')}`).send({ mqlThreshold: -5 });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  res = await request(app).patch('/api/v1/marketing/scoring-settings').set('Authorization', `Bearer ${token('admin')}`).send({ mqlThreshold: 50 });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  console.log('✓ scoring-settings PATCH is admin+ only and validates the threshold');

  // --- 1. Behavioral lead-scoring rules, each worth real points ---

  const rules = [
    { name: 'Has email', conditionType: 'has_email', points: 10 },
    { name: 'Opened an email', conditionType: 'email_opened_any', points: 20 },
    { name: 'Clicked an email', conditionType: 'email_clicked_any', points: 15 },
    { name: 'Submitted a form', conditionType: 'form_submitted_any', points: 25 },
    { name: 'Completed a journey', conditionType: 'journey_completed_any', points: 30 }
  ];
  for (const rule of rules) {
    res = await request(app).post('/api/v1/sales/lead-scoring-rules').set('Authorization', `Bearer ${token('admin')}`).send(rule);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  }
  console.log('✓ 5 lead-scoring rules created (1 static + 4 new Phase 6 behavioral)');

  // --- 2. A contact starts at 10 (has_email only — no behavior yet) ---

  res = await request(app).post('/api/v1/sales/contacts').set('Authorization', `Bearer ${token('member')}`).send({ displayName: 'Ada Scoring', email: 'ada-scoring@example.com', phone: '919992220001' });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const ada = res.body.contact;
  assert.strictEqual(ada.lead_score, 10);
  assert.strictEqual(ada.lifecycle_stage, 'subscriber');
  console.log('✓ a fresh contact scores 10 (has_email only)');

  // --- 3. A REAL email open (the actual public tracking pixel endpoint) scores +20 live ---

  const { data: campaign } = await client.from('email_campaigns').insert({ tenant_id: TENANT_ID, name: 'Scoring Test Campaign' }).select('id').single();
  const { data: recipient } = await client.from('email_campaign_recipients').insert({ tenant_id: TENANT_ID, campaign_id: campaign.id, contact_id: ada.id, email: ada.email }).select('id').single();

  res = await request(app).get(`/api/v1/marketing/email/track/open/${recipient.id}`);
  assert.strictEqual(res.status, 200);
  await new Promise((r2) => setTimeout(r2, 200)); // the recompute is fire-and-forget off the tracking response
  let { data: afterOpen } = await client.from('contacts').select('lead_score').eq('id', ada.id).single();
  assert.strictEqual(afterOpen.lead_score, 30, 'has_email(10) + email_opened_any(20)');
  console.log('✓ a real email-open tracking pixel hit recomputes lead score live: 10 -> 30');

  // --- 4. A REAL click (the actual public redirect endpoint) scores +15 live ---

  res = await request(app).get(clickUrl(recipient.id, 'https://example.com/offer'));
  assert.strictEqual(res.status, 302);
  await new Promise((r2) => setTimeout(r2, 200));
  let { data: afterClick } = await client.from('contacts').select('lead_score').eq('id', ada.id).single();
  assert.strictEqual(afterClick.lead_score, 45, 'previous 30 + email_clicked_any(15)');
  console.log('✓ a real click-tracking redirect recomputes lead score live: 30 -> 45');

  // --- 5. A form submission + a completed journey push the score to MQL ---

  const { data: form } = await client.from('lead_forms').insert({ tenant_id: TENANT_ID, name: 'Scoring Form', fields: [{ key: 'email', label: 'Email', type: 'email', required: true }] }).select('id').single();
  await client.from('lead_form_submissions').insert({ tenant_id: TENANT_ID, form_id: form.id, contact_id: ada.id, data: { email: ada.email } });

  res = await request(app).post('/api/v1/marketing/journeys').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Instant journey', triggerType: 'contact_created', graph: { nodes: [{ id: 't', type: 'trigger' }, { id: 'n0', type: 'action', actionType: 'add_tag', config: { tag: 'scored' } }], edges: [{ id: 'e0', source: 't', target: 'n0' }] }
  });
  const instantJourney = res.body.journey;
  await request(app).patch(`/api/v1/marketing/journeys/${instantJourney.id}/activate`).set('Authorization', `Bearer ${token('admin')}`);

  // Also activate a 'became_mql' journey BEFORE the promotion happens, so we can prove it fires for real.
  res = await request(app).post('/api/v1/marketing/journeys').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'MQL welcome', triggerType: 'became_mql', graph: { nodes: [{ id: 't', type: 'trigger' }, { id: 'n0', type: 'action', actionType: 'add_tag', config: { tag: 'mql-welcomed' } }], edges: [{ id: 'e0', source: 't', target: 'n0' }] }
  });
  const mqlJourney = res.body.journey;
  await request(app).patch(`/api/v1/marketing/journeys/${mqlJourney.id}/activate`).set('Authorization', `Bearer ${token('admin')}`);

  res = await request(app).post(`/api/v1/marketing/journeys/${instantJourney.id}/enroll`).set('Authorization', `Bearer ${token('member')}`).send({ contactId: ada.id });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));

  const { data: afterAll } = await client.from('contacts').select('lead_score, lifecycle_stage').eq('id', ada.id).single();
  assert.strictEqual(afterAll.lead_score, 100, 'has_email(10) + opened(20) + clicked(15) + form(25) + journey_completed(30)');
  assert.strictEqual(afterAll.lifecycle_stage, 'mql', 'crossing the 50-point threshold must auto-promote subscriber -> mql');
  console.log('✓ a form submission + a completed journey push the score to 100 and auto-promote the contact to mql');

  const { data: mqlAudit } = await client.from('audit_log').select('*').eq('tenant_id', TENANT_ID).eq('action', 'marketing.contact_became_mql').eq('target_id', ada.id).maybeSingle();
  assert.ok(mqlAudit, 'MQL promotion must be audit-logged');

  const { data: mqlEnrollment } = await client.from('workflow_enrollments').select('id').eq('workflow_id', mqlJourney.id).eq('contact_id', ada.id).maybeSingle();
  assert.ok(mqlEnrollment, 'the became_mql journey trigger must fire for real the moment the contact is promoted');
  console.log('✓ MQL promotion is audit-logged and fires the real became_mql journey trigger');

  // Pause the contact_created-triggered journey now — every contact
  // created from here on (sections 6-9) would otherwise auto-enroll and
  // immediately complete it, contaminating the "zero touchpoints" and
  // currency-isolation fixtures below with an unintended extra touchpoint.
  await request(app).patch(`/api/v1/marketing/journeys/${instantJourney.id}/pause`).set('Authorization', `Bearer ${token('admin')}`);

  // --- 6. Promotion never happens for a contact already past mql, or marked "other" ---

  res = await request(app).post('/api/v1/sales/contacts').set('Authorization', `Bearer ${token('member')}`).send({ displayName: 'Already Customer', email: 'already-customer@example.com' });
  const customerContact = res.body.contact;
  await client.from('contacts').update({ lifecycle_stage: 'customer' }).eq('id', customerContact.id);
  await client.from('lead_form_submissions').insert({ tenant_id: TENANT_ID, form_id: form.id, contact_id: customerContact.id, data: { email: customerContact.email } });
  res = await request(app).patch(`/api/v1/sales/contacts/${customerContact.id}`).set('Authorization', `Bearer ${token('member')}`).send({ tags: ['touch-to-recompute'] });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const { data: stillCustomer } = await client.from('contacts').select('lifecycle_stage').eq('id', customerContact.id).single();
  assert.strictEqual(stillCustomer.lifecycle_stage, 'customer', 'a contact already past mql must never be reset by a later recompute');
  console.log('✓ a contact already at "customer" is never touched by MQL auto-promotion, however high the score goes');

  res = await request(app).post('/api/v1/sales/contacts').set('Authorization', `Bearer ${token('member')}`).send({ displayName: 'Marked Other', email: 'marked-other@example.com' });
  const otherContact = res.body.contact;
  await client.from('contacts').update({ lifecycle_stage: 'other' }).eq('id', otherContact.id);
  await client.from('lead_form_submissions').insert({ tenant_id: TENANT_ID, form_id: form.id, contact_id: otherContact.id, data: { email: otherContact.email } });
  res = await request(app).patch(`/api/v1/sales/contacts/${otherContact.id}`).set('Authorization', `Bearer ${token('member')}`).send({ tags: ['touch-to-recompute'] });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const { data: stillOther } = await client.from('contacts').select('lifecycle_stage').eq('id', otherContact.id).single();
  assert.strictEqual(stillOther.lifecycle_stage, 'other', '"other" is a deliberate manual marker, never auto-promoted even though its numeric rank is low');
  console.log('✓ a contact manually marked "other" is never auto-promoted to mql');

  // --- 7. Attribution: first/last/linear on a real contact with 3 real, distinctly-timed touchpoints ---

  res = await request(app).post('/api/v1/sales/contacts').set('Authorization', `Bearer ${token('member')}`).send({ displayName: 'Attributed Buyer', email: 'buyer@example.com' });
  const buyer = res.body.contact;

  const t1 = new Date(Date.now() - 10 * 86400000).toISOString(); // 10 days ago: form (first touch)
  const t2 = new Date(Date.now() - 5 * 86400000).toISOString();  // 5 days ago: email open
  const t3 = new Date(Date.now() - 1 * 86400000).toISOString();  // 1 day ago: journey completion (last touch)
  const tAfter = new Date().toISOString(); // after the deal closes — must NOT count

  const { data: campaignAfterClose } = await client.from('email_campaigns').insert({ tenant_id: TENANT_ID, name: 'Post-close Campaign' }).select('id').single();

  await client.from('lead_form_submissions').insert({ tenant_id: TENANT_ID, form_id: form.id, contact_id: buyer.id, data: { email: buyer.email }, created_at: t1 });
  await client.from('email_campaign_recipients').insert({ tenant_id: TENANT_ID, campaign_id: campaign.id, contact_id: buyer.id, email: buyer.email, opened_at: t2 });
  await client.from('workflow_enrollments').insert({ tenant_id: TENANT_ID, workflow_id: instantJourney.id, contact_id: buyer.id, status: 'completed', completed_at: t3 });
  // A touch AFTER the deal closes, on a DIFFERENT campaign (the unique
  // (campaign_id, contact_id) constraint means the same buyer can't have
  // two recipient rows on the same campaign) — proves the cutoff
  // actually excludes it, not just happens not to be picked.
  await client.from('email_campaign_recipients').insert({ tenant_id: TENANT_ID, campaign_id: campaignAfterClose.id, contact_id: buyer.id, email: buyer.email, clicked_at: tAfter });

  const { data: pipeline } = await client.from('deal_pipelines').insert({ tenant_id: TENANT_ID, name: 'Default' }).select('id').single();
  const { data: stage } = await client.from('deal_stages').insert({ tenant_id: TENANT_ID, pipeline_id: pipeline.id, name: 'Won', position: 0, is_won: true }).select('id').single();
  const closedAt = new Date(Date.now() - 12 * 3600000).toISOString(); // 12 hours ago — after t3, before tAfter
  const { data: wonDeal } = await client.from('deals').insert({ tenant_id: TENANT_ID, pipeline_id: pipeline.id, stage_id: stage.id, name: 'Buyer Deal', amount: 900, currency: 'INR', contact_id: buyer.id, status: 'won', closed_at: closedAt }).select('id').single();

  res = await request(app).get(`/api/v1/marketing/attribution/deals/${wonDeal.id}?model=first_touch`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.touchpoints.length, 1);
  assert.strictEqual(res.body.touchpoints[0].channel, 'form');
  assert.strictEqual(res.body.touchpoints[0].creditedAmount, 900);
  console.log('✓ first_touch credits the earliest real touchpoint (the form submission) with the full deal amount');

  res = await request(app).get(`/api/v1/marketing/attribution/deals/${wonDeal.id}?model=last_touch`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.body.touchpoints.length, 1);
  assert.strictEqual(res.body.touchpoints[0].channel, 'journey');
  assert.strictEqual(res.body.touchpoints[0].creditedAmount, 900);
  console.log('✓ last_touch credits the latest real touchpoint before close (the journey completion), excluding the one after close');

  res = await request(app).get(`/api/v1/marketing/attribution/deals/${wonDeal.id}?model=linear`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.body.touchpoints.length, 3, 'exactly the 3 touchpoints before close — the post-close click must be excluded');
  const total = res.body.touchpoints.reduce((sum, tp) => sum + tp.creditedAmount, 0);
  assert.strictEqual(Math.round(total * 100) / 100, 900, 'linear credits must sum exactly to the deal amount');
  console.log('✓ linear splits the real deal amount across exactly the 3 pre-close touchpoints, summing exactly to 900');

  res = await request(app).get('/api/v1/marketing/attribution?model=bogus_model').set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 400);
  console.log('✓ an unknown attribution model is rejected with a clean 400');

  // --- 8. Tenant-wide report: unattributed revenue + currency grouping (never summed across currencies) ---

  res = await request(app).post('/api/v1/sales/contacts').set('Authorization', `Bearer ${token('member')}`).send({ displayName: 'No Touch Buyer', email: 'no-touch@example.com' });
  const noTouchBuyer = res.body.contact;
  await client.from('deals').insert({ tenant_id: TENANT_ID, pipeline_id: pipeline.id, stage_id: stage.id, name: 'No-touch Deal', amount: 500, currency: 'INR', contact_id: noTouchBuyer.id, status: 'won', closed_at: new Date().toISOString() });

  res = await request(app).post('/api/v1/sales/contacts').set('Authorization', `Bearer ${token('member')}`).send({ displayName: 'USD Buyer', email: 'usd-buyer@example.com' });
  const usdBuyer = res.body.contact;
  await client.from('lead_form_submissions').insert({ tenant_id: TENANT_ID, form_id: form.id, contact_id: usdBuyer.id, data: { email: usdBuyer.email } });
  await client.from('deals').insert({ tenant_id: TENANT_ID, pipeline_id: pipeline.id, stage_id: stage.id, name: 'USD Deal', amount: 200, currency: 'USD', contact_id: usdBuyer.id, status: 'won', closed_at: new Date().toISOString() });

  res = await request(app).get('/api/v1/marketing/attribution?model=linear').set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.unattributedDealCount, 1, 'exactly the no-touch deal');
  assert.ok(res.body.unattributedRevenue.some((u) => u.currency === 'INR' && u.total === 500));

  const formRows = res.body.byChannel.filter((c) => c.sourceName === 'Scoring Form');
  const inrFormRow = formRows.find((c) => c.currency === 'INR');
  const usdFormRow = formRows.find((c) => c.currency === 'USD');
  assert.ok(inrFormRow && usdFormRow, 'the same form must appear as two SEPARATE rows, one per currency');
  assert.strictEqual(inrFormRow.totalCredited, 300, 'the INR row is only the buyer\'s 1/3 linear share of the 900 INR deal');
  assert.strictEqual(usdFormRow.totalCredited, 200, 'the USD row is the usdBuyer\'s full 200 USD deal (their only touchpoint) — critically, NOT 300+200=500 summed across currencies');
  console.log('✓ the tenant-wide report tracks unattributed revenue and keeps every currency in its own row, never summed together');

  // --- 9. Cross-tenant isolation ---

  res = await request(app).get('/api/v1/marketing/attribution?model=linear').set('Authorization', `Bearer ${tokenB('owner')}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.dealCount, 0, 'tenant B must see none of tenant A\'s won deals or revenue');
  res = await request(app).get(`/api/v1/marketing/attribution/deals/${wonDeal.id}`).set('Authorization', `Bearer ${tokenB('owner')}`);
  assert.strictEqual(res.status, 404, 'tenant B must get 404 for tenant A\'s deal id, never real data');
  console.log('✓ cross-tenant isolation: tenant B sees zero deals/revenue and 404s on tenant A\'s deal id');

  console.log('\nALL SCORING/ATTRIBUTION ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
