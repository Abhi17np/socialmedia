/**
 * End-to-end exercise of the Phase 2 segmentation upgrade
 * (migrations/026_segmentation.sql, backend/lib/segmentCompiler.js): a
 * real AND/OR rule tree evaluated against real contacts/deals/contact
 * identities/consent rows via ONE compiled query, a static list's
 * membership CRUD, and backward compatibility with every segment created
 * before this phase (the legacy flat filter shape).
 *
 * Run: node scripts/integration-tests/marketing-segmentation.js
 * (needs PostgREST + the rest-proxy + Redis running; does NOT need a
 * separately running `node server.js` — see this directory's README)
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
  let r = await client.from('tenants').insert({ id: TENANT_ID, name: 'Segmentation Test Tenant', slug: 'seg-test-' + Date.now() });
  if (r.error) throw new Error('tenant insert failed: ' + JSON.stringify(r.error));
  r = await client.from('users').insert({ id: USER_ID, tenant_id: TENANT_ID, email: `owner-${Date.now()}@seg-test.com`, password_hash: 'x', role: 'owner' });
  if (r.error) throw new Error('user insert failed: ' + JSON.stringify(r.error));

  // --- Seed a realistic, varied contact base ---

  const { data: vipHighScore } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'VIP High Score', phone: '919990000001', tags: ['vip'], lead_score: 80, lifecycle_stage: 'customer' }).select('*').single();
  const { data: vipLowScore } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'VIP Low Score', phone: '919990000002', tags: ['vip'], lead_score: 10, lifecycle_stage: 'lead' }).select('*').single();
  const { data: plainLead } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'Plain Lead', phone: '919990000003', tags: [], lead_score: 5, lifecycle_stage: 'lead' }).select('*').single();
  const { data: whatsappOnly } = await client.from('contacts').insert({ tenant_id: TENANT_ID, display_name: 'WhatsApp Identity Contact', phone: '919990000004', tags: [] }).select('*').single();
  await client.from('contact_identities').insert({ tenant_id: TENANT_ID, contact_id: whatsappOnly.id, platform: 'whatsapp', external_id: 'wa-' + Date.now() });

  // --- A real deal, to test deal-based conditions ---

  const { data: pipeline } = await client.from('deal_pipelines').insert({ tenant_id: TENANT_ID, name: 'Default' }).select('*').single();
  const { data: stage } = await client.from('deal_stages').insert({ tenant_id: TENANT_ID, pipeline_id: pipeline.id, name: 'Proposal', position: 0, probability: 50 }).select('*').single();
  const { data: deal } = await client.from('deals').insert({ tenant_id: TENANT_ID, pipeline_id: pipeline.id, stage_id: stage.id, name: 'Big Deal', amount: 5000, contact_id: vipHighScore.id, status: 'open' }).select('*').single();
  await client.from('deal_contacts').insert({ tenant_id: TENANT_ID, deal_id: deal.id, contact_id: vipHighScore.id, is_primary: true });

  // --- 1. v2 AND/OR tree: (tags contains_any vip) AND (lead_score >= 50 OR lifecycle_stage = customer) ---

  let res = await request(app).post('/api/v1/whatsapp/segments').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'High-value VIPs',
    filter: {
      version: 2,
      root: {
        logic: 'AND',
        children: [
          { field: 'tags', operator: 'contains_any', value: ['vip'] },
          { logic: 'OR', children: [{ field: 'lead_score', operator: 'gte', value: 50 }, { field: 'lifecycle_stage', operator: 'eq', value: 'customer' }] }
        ]
      }
    }
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const andOrSegment = res.body.segment;
  assert.strictEqual(andOrSegment.segment_type, 'dynamic');
  console.log('✓ created a v2 AND/OR dynamic segment');

  res = await request(app).get(`/api/v1/whatsapp/segments/${andOrSegment.id}/preview`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.whatsappEligibleCount, 1, 'only vipHighScore should match (vip AND (score>=50 OR customer))');
  console.log('✓ AND/OR tree resolved to exactly the right contact (1 of 4), via one compiled query');

  // --- 2. Cross-table conditions: channel_identity + deal_status ---

  res = await request(app).post('/api/v1/whatsapp/segments').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Has WhatsApp identity',
    filter: { version: 2, root: { field: 'channel_identity', operator: 'has', value: 'whatsapp' } }
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  res = await request(app).get(`/api/v1/whatsapp/segments/${res.body.segment.id}/preview`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.body.whatsappEligibleCount, 1, 'only the contact with a real contact_identities row should match');
  console.log('✓ cross-table channel_identity condition resolved correctly (pre-resolved id set folded into the query)');

  res = await request(app).post('/api/v1/whatsapp/segments').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Has an open deal',
    filter: { version: 2, root: { field: 'has_open_deal', operator: 'eq', value: true } }
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  res = await request(app).get(`/api/v1/whatsapp/segments/${res.body.segment.id}/preview`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.body.whatsappEligibleCount, 1, 'only the contact linked to the open deal should match');
  console.log('✓ cross-table deal-based condition (has_open_deal) resolved correctly via deal_contacts join');

  // --- 3. Invalid tree is rejected with a clean 400, not a 500 ---

  res = await request(app).post('/api/v1/whatsapp/segments').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Bad segment',
    filter: { version: 2, root: { field: 'favorite_color', operator: 'eq', value: 'blue' } }
  });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  assert.ok(res.body.error.includes('favorite_color'));
  console.log('✓ an invalid filter field is rejected with a clear 400, not a crash');

  // --- 4. Legacy v1 segments still work unchanged (backward compatibility) ---

  res = await request(app).post('/api/v1/whatsapp/segments').set('Authorization', `Bearer ${token('member')}`).send({
    name: 'Legacy-style segment', filter: { tags: ['vip'], hasPhone: true }
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  res = await request(app).get(`/api/v1/whatsapp/segments/${res.body.segment.id}/preview`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.body.whatsappEligibleCount, 2, 'both vip contacts should match the untouched legacy filter shape');
  console.log('✓ a pre-Phase-2 (legacy flat filter) segment still resolves exactly as before');

  // --- 5. Static list: explicit membership, not a filter ---

  res = await request(app).post('/api/v1/whatsapp/segments').set('Authorization', `Bearer ${token('member')}`).send({ name: 'Hand-picked list', segmentType: 'static' });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const staticSegment = res.body.segment;
  assert.strictEqual(staticSegment.segment_type, 'static');

  res = await request(app).post(`/api/v1/whatsapp/segments/${staticSegment.id}/members`).set('Authorization', `Bearer ${token('member')}`).send({ contactIds: [plainLead.id, vipLowScore.id, randomUUID()] });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.added, 2, 'two real contacts added, the random non-existent id silently skipped, not a hard failure');
  console.log('✓ static list membership: valid contacts added, a bogus id safely ignored rather than erroring the whole call');

  res = await request(app).get(`/api/v1/whatsapp/segments/${staticSegment.id}/preview`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.body.whatsappEligibleCount, 2);
  console.log('✓ static list preview count reflects real membership, not a filter evaluation');

  res = await request(app).delete(`/api/v1/whatsapp/segments/${staticSegment.id}/members/${plainLead.id}`).set('Authorization', `Bearer ${token('member')}`);
  assert.strictEqual(res.status, 200);
  res = await request(app).get(`/api/v1/whatsapp/segments/${staticSegment.id}/preview`).set('Authorization', `Bearer ${token('viewer')}`);
  assert.strictEqual(res.body.whatsappEligibleCount, 1);
  console.log('✓ removing a static list member updates the count immediately');

  // Adding a member to a dynamic segment is rejected — there's nothing to add to.
  res = await request(app).post(`/api/v1/whatsapp/segments/${andOrSegment.id}/members`).set('Authorization', `Bearer ${token('member')}`).send({ contactIds: [plainLead.id] });
  assert.strictEqual(res.status, 400);
  console.log('✓ cannot add members to a dynamic segment (filter is its only source of truth)');

  console.log('\nALL SEGMENTATION ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
