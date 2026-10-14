/**
 * Promotes a `scheduled` email campaign to actually sending once its
 * `scheduled_at` time has passed — same restart-safe sweep shape as
 * lib/sequenceScheduler.js (a slow interval re-reading due rows from the
 * DB, not a per-campaign setTimeout a restart would silently lose).
 *
 * Without this, POST /campaigns (sendMode: 'scheduled') correctly stores
 * status='scheduled' and scheduled_at, but nothing ever reads it back —
 * a real gap this file closes, not speculative infrastructure.
 */
const { getSocialClient } = require('../../social/db');
const { sendCampaign } = require('./campaignSender');

const SWEEP_INTERVAL_MS = 60 * 1000; // a scheduled send can reasonably be a minute late, not 5+

let intervalHandle = null;

async function sweep() {
  const client = getSocialClient();
  if (!client) return;

  const { data: due, error } = await client
    .from('email_campaigns')
    .select('id, tenant_id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .limit(100);
  if (error) { console.error('[email/scheduledSendSweep] could not query due campaigns:', error.message); return; }

  for (const row of due || []) {
    try {
      await sendCampaign(client, row.tenant_id, row.id, { actorUserId: null });
      console.log(`[email/scheduledSendSweep] sent scheduled campaign ${row.id}`);
    } catch (err) {
      // A campaign that's gone stale (template deleted, segment empty,
      // plan limit hit since scheduling) fails loudly in the log, not
      // silently forever — but doesn't crash the sweep for every other
      // due campaign.
      console.error(`[email/scheduledSendSweep] campaign ${row.id} failed to send:`, err.message);
      await client.from('email_campaigns').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', row.id)
        .then(() => {}, (e) => console.error('[email/scheduledSendSweep] could not mark campaign failed:', e.message));
    }
  }
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => { sweep().catch((err) => console.error('[email/scheduledSendSweep] sweep failed:', err.message)); }, SWEEP_INTERVAL_MS);
  sweep().catch((err) => console.error('[email/scheduledSendSweep] initial sweep failed:', err.message));
  console.log('[email/scheduledSendSweep] Scheduled-send sweep started (60s interval).');
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, sweep };
