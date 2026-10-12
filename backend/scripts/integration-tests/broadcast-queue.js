/**
 * Exercises social/broadcastQueue.js end to end against a REAL Redis
 * (BullMQ needs one — there's no meaningful way to fake it) while
 * mocking the DB client and the WhatsApp adapter's sendTemplate(),
 * since this script needs no Postgres/PostgREST at all. Run on its own:
 *
 *   redis-server &   # if not already running
 *   node scripts/integration-tests/broadcast-queue.js
 *
 * Verifies: a successful send is marked 'sent' with the adapter's real
 * external_message_id, a failing send is retried exactly 4 times
 * (attempts:4) with real exponential backoff before being marked
 * 'failed', recompute_whatsapp_campaign_counts is called for both
 * outcomes, and usage is metered exactly once — only for the success.
 * Takes about 70s (the failure path's real backoff) — this is
 * deliberate, not a hang.
 */
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const path = require('path');
const assert = require('assert');
const BACKEND = path.join(__dirname, '..', '..');

const updates = [];
const rpcCalls = [];
const recordedUsage = [];

function fakeClient() {
  return {
    from(table) {
      return {
        update(patch) {
          return {
            eq(col, val) {
              updates.push({ table, patch, col, val });
              return Promise.resolve({ error: null });
            }
          };
        }
      };
    },
    rpc(name, args) {
      rpcCalls.push({ name, args });
      return Promise.resolve({ error: null });
    }
  };
}

// Inject fake modules into the require cache BEFORE broadcastQueue.js
// requires them, so the real Supabase/adapter code never runs.
const dbPath = require.resolve(path.join(BACKEND, 'social/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSocialClient: () => fakeClient(), isConfigured: () => true } };

const sendTemplateCalls = [];
const accountsPath = require.resolve(path.join(BACKEND, 'social/accounts.js'));
require.cache[accountsPath] = {
  id: accountsPath, filename: accountsPath, loaded: true,
  exports: {
    getUsableAccount: async () => ({
      account: { platform: 'whatsapp', externalAccountId: 'phone123', accessToken: 'tok' },
      adapter: {
        sendTemplate: async (account, phone, template, vars) => {
          sendTemplateCalls.push({ phone, template, vars });
          if (phone === '919999999998') throw new Error('simulated send failure');
          return { externalId: 'wamid.' + phone };
        }
      }
    })
  }
};

const entPath = require.resolve(path.join(BACKEND, 'lib/entitlements.js'));
const realEnt = require(entPath);
require.cache[entPath] = {
  id: entPath, filename: entPath, loaded: true,
  exports: { ...realEnt, recordUsage: async (client, tenantId, resource, amount) => { recordedUsage.push({ tenantId, resource, amount }); } }
};

const broadcastQueue = require(path.join(BACKEND, 'social/broadcastQueue.js'));

async function main() {
  broadcastQueue.start();

  const campaign = { id: 'camp-' + Date.now(), tenant_id: 'tenant-1', social_account_id: 'acct-1', variable_values: ['Jane'] };
  const recipients = [
    { id: 'rec-ok-' + Date.now(), phone: '919999999999' },
    { id: 'rec-fail-' + Date.now(), phone: '919999999998' }
  ];
  const template = { name: 'order_update', language: 'en_US' };

  await broadcastQueue.enqueueCampaign(campaign, recipients, template);

  // Poll until both jobs reach a terminal outcome (the failure path
  // retries 4x with real exponential backoff — 10s/20s/40s — so this
  // takes ~70s by design, not a hang).
  const deadline = Date.now() + 110000;
  while (Date.now() < deadline) {
    const okDone = updates.some((u) => u.val === recipients[0].id && u.patch.status === 'sent');
    const failDone = updates.some((u) => u.val === recipients[1].id && u.patch.status === 'failed');
    if (okDone && failDone) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const okUpdate = updates.find((u) => u.val === recipients[0].id && u.patch.status === 'sent');
  assert.ok(okUpdate, 'expected the first recipient to be marked sent');
  assert.strictEqual(okUpdate.patch.external_message_id, 'wamid.919999999999');
  console.log('✓ successful send marked "sent" with the real external_message_id');

  const failUpdate = updates.find((u) => u.val === recipients[1].id && u.patch.status === 'failed');
  assert.ok(failUpdate, 'expected the second recipient to be marked failed after exhausting retries');
  assert.ok(failUpdate.patch.error.includes('simulated send failure'));
  console.log('✓ failing send marked "failed" only after exhausting retries');

  const recomputeCalls = rpcCalls.filter((c) => c.name === 'recompute_whatsapp_campaign_counts');
  assert.ok(recomputeCalls.length >= 2, 'expected recompute to be called for both outcomes');
  console.log('✓ recompute_whatsapp_campaign_counts called for both outcomes');

  assert.strictEqual(recordedUsage.length, 1, 'expected usage metered once, only for the successful send');
  assert.strictEqual(recordedUsage[0].resource, 'whatsappBroadcastSendsPerMonth');
  console.log('✓ usage metered exactly once, only for the successful send');

  const okSendCalls = sendTemplateCalls.filter((c) => c.phone === '919999999999');
  assert.strictEqual(okSendCalls.length, 1, 'expected exactly one send attempt for the successful recipient');
  const failSendCalls = sendTemplateCalls.filter((c) => c.phone === '919999999998');
  assert.strictEqual(failSendCalls.length, 4, `expected exactly 4 attempts (attempts:4) before giving up, got ${failSendCalls.length}`);
  console.log('✓ exactly 4 attempts made for the failing recipient, matching attempts:4');

  console.log('\nALL BROADCAST QUEUE ASSERTIONS PASSED');
  await broadcastQueue.stop();
  process.exit(0);
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
