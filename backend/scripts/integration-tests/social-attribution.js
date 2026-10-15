/**
 * Social Hub: Revenue Attribution (migration 039). Covers the full real
 * pipeline — create a Tracked Link, click its real redirect (confirming
 * the UTM params actually land on the destination and click_count
 * really increments), feed the resulting pageview back through the
 * real POST /track/pageview endpoint (as the destination site's own
 * tracking snippet would), and confirm the real GET /social/attribution
 * report — reusing lib/attribution.js's already-existing, channel-
 * agnostic model math — correctly attributes revenue to the social
 * channel once that visit resolves to a contact who closes a deal.
 * Also proves the "ungated, Social Hub's own feature" design claim: a
 * tenant WITHOUT Marketing Hub enabled can call /social/attribution but
 * still correctly gets 403'd from the existing /marketing/attribution.
 *
 * Run: node scripts/integration-tests/social-attribution.js
 * (needs PostgREST + the rest-proxy running; does NOT need Redis or a
 * separately running `node server.js`.)
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

const TENANT_A = randomUUID(); // no Marketing Hub enabled — proves /social/attribution doesn't need it
const TENANT_B = randomUUID();
const MEMBER_A = randomUUID();
const memberTokenA = signToken({ userId: MEMBER_A, tenantId: TENANT_A, role: 'member' });
const viewerTokenA = signToken({ userId: randomUUID(), tenantId: TENANT_A, role: 'viewer' });
const viewerTokenB = signToken({ userId: randomUUID(), tenantId: TENANT_B, role: 'viewer' });

async function main() {
  const client = getSocialClient();

  let r = await client.from('tenants').insert([
    { id: TENANT_A, name: 'Attribution Tenant A', slug: 'attribution-a-' + Date.now() }, // hubs_enabled defaults to {} — Marketing Hub NOT enabled
    { id: TENANT_B, name: 'Attribution Tenant B', slug: 'attribution-b-' + Date.now() }
  ]);
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: MEMBER_A, tenant_id: TENANT_A, email: `member-${Date.now()}@attr-test.com`, password_hash: 'x', role: 'member' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  // --- Create a tracked link ---
  let res = await request(app).post('/api/v1/social/tracked-links').set('Authorization', `Bearer ${memberTokenA}`).send({
    destinationUrl: 'https://example.com/landing', platform: 'facebook', label: 'October launch'
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const linkId = res.body.link.id;
  assert.match(res.body.shortUrl, new RegExp(`/t/${linkId}$`));
  console.log('✓ POST /social/tracked-links creates a link and returns a real short URL');

  // --- Clicking the real redirect appends real UTM params and increments click_count ---
  res = await request(app).get(`/api/v1/t/${linkId}`);
  assert.strictEqual(res.status, 302);
  const redirectUrl = new URL(res.headers.location);
  assert.strictEqual(redirectUrl.searchParams.get('utm_source'), 'facebook');
  assert.strictEqual(redirectUrl.searchParams.get('utm_medium'), 'social');
  assert.strictEqual(redirectUrl.searchParams.get('utm_content'), linkId);
  assert.strictEqual(redirectUrl.searchParams.get('utm_campaign'), 'October launch');

  res = await request(app).get('/api/v1/social/tracked-links').set('Authorization', `Bearer ${memberTokenA}`);
  assert.strictEqual(res.body.links.find((l) => l.id === linkId).click_count, 1, 'click_count must really increment, not just appear to in the redirect');
  console.log('✓ GET /t/:id redirects with real UTM params and reliably increments click_count');

  // --- Feed the resulting pageview back through the real tracking pixel endpoint ---
  const visitorId = randomUUID();
  res = await request(app).post('/api/v1/track/pageview').send({
    tenantId: TENANT_A, visitorId, url: redirectUrl.toString(), referrer: 'https://facebook.com'
  });
  assert.strictEqual(res.status, 204);

  const { data: storedVisit } = await client.from('site_visits').select('*').eq('visitor_id', visitorId).single();
  assert.strictEqual(storedVisit.utm_medium, 'social');
  assert.strictEqual(storedVisit.utm_content, linkId);
  console.log('✓ the real pageview pixel endpoint parses and stores UTM params on site_visits');

  // --- Resolve that visitor to a real contact (simulating what routes/leadForms.js does on form submit) and close a deal ---
  const contactId = randomUUID();
  await client.from('contacts').insert({ id: contactId, tenant_id: TENANT_A, display_name: 'Attribution Test Contact' });
  // The pageview pixel call above already created this site_visitors row (upsert) — resolve it to the contact, same update-in-place routes/leadForms.js's real resolution does, not a second insert (which would conflict on the primary key).
  const { error: resolveError } = await client.from('site_visitors').update({ contact_id: contactId }).eq('id', visitorId);
  if (resolveError) throw new Error('site_visitors resolve failed: ' + JSON.stringify(resolveError));

  const { data: pipeline } = await client.from('deal_pipelines').insert({ tenant_id: TENANT_A, name: 'Default' }).select('id').single();
  const { data: stage } = await client.from('deal_stages').insert({ tenant_id: TENANT_A, pipeline_id: pipeline.id, name: 'Won', position: 0, is_won: true }).select('id').single();
  const dealId = randomUUID();
  const { error: dealError } = await client.from('deals').insert({
    id: dealId, tenant_id: TENANT_A, pipeline_id: pipeline.id, stage_id: stage.id, contact_id: contactId,
    name: 'Attribution Test Deal', amount: 50000, currency: 'INR', status: 'won', closed_at: new Date().toISOString()
  });
  if (dealError) throw new Error('deal insert failed: ' + JSON.stringify(dealError));

  // --- The real, ungated report attributes real revenue to the social channel ---
  res = await request(app).get('/api/v1/social/attribution?model=last_touch').set('Authorization', `Bearer ${viewerTokenA}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const socialRow = res.body.byChannel.find((row) => row.channel === 'social');
  assert.ok(socialRow, `expected a 'social' row in the report, got channels: ${res.body.byChannel.map((r) => r.channel).join(', ')}`);
  assert.strictEqual(socialRow.totalCredited, 50000);
  assert.match(socialRow.sourceName, /facebook/i);
  assert.match(socialRow.sourceName, /October launch/);
  console.log('✓ GET /social/attribution correctly credits real revenue to the social channel, resolved to the real tracked link\'s platform + label');

  // --- This endpoint needs NO Marketing Hub — proving it's genuinely Social Hub's own, ungated feature ---
  res = await request(app).get('/api/v1/marketing/attribution').set('Authorization', `Bearer ${viewerTokenA}`);
  assert.strictEqual(res.status, 403, 'the EXISTING marketing-hub-gated endpoint must still be gated on this same tenant — this proves /social/attribution is a separate, deliberately ungated mount, not an accidental bypass of the gate');
  console.log('✓ the existing /marketing/attribution stays correctly hub-gated, while /social/attribution on the same ungated tenant works — confirming this is a deliberate second mount, not a gate bypass');

  // --- Tenant isolation ---
  res = await request(app).get('/api/v1/social/attribution').set('Authorization', `Bearer ${viewerTokenB}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((res.body.byChannel || []).length, 0, 'a different tenant must see zero channels, never tenant A\'s revenue');
  console.log('✓ /social/attribution is tenant-isolated');

  console.log('\nALL SOCIAL ATTRIBUTION ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('SOCIAL ATTRIBUTION TEST FAILED:', err.message);
  process.exit(1);
});
