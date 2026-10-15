/**
 * Automatic A/B subject-line winner selection — the one piece
 * migration 027's `ab_test` jsonb comment reserved a `winnerKey` slot
 * for but nothing ever populated (see docs/MARKETING_HUB_AUDIT.md's
 * gap matrix). Same restart-safe interval-sweep shape as
 * lib/email/scheduledSendSweep.js: re-reads due rows from the DB on
 * every tick rather than a per-campaign setTimeout a restart would lose.
 *
 * A campaign only gets picked up here once it's genuinely finished
 * sending (status='completed', completed_at set by
 * recompute_email_campaign_counts) AND its ab_test.decisionHours has
 * passed AND it hasn't been decided yet (winnerKey still null) — never
 * decided early off partial data, and never re-decided.
 */
const { getSocialClient } = require('../../social/db');
const { scoped } = require('../query');
const { recordAudit } = require('../audit');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // a winner call an hour late doesn't matter; every 5 min is plenty

let intervalHandle = null;

/** Exported for the one-campaign-at-a-time check the sweep itself does, and for a direct call from a test. */
function pickWinner(byVariant, variants, winnerMetric) {
  let best = null;
  for (const v of variants) {
    const stats = byVariant[v.key] || { sent: 0, opened: 0, clicked: 0 };
    const numerator = winnerMetric === 'clicks' ? stats.clicked : stats.opened;
    const rate = stats.sent > 0 ? numerator / stats.sent : 0;
    if (!best || rate > best.rate) best = { key: v.key, rate };
  }
  return best ? best.key : null;
}

async function sweep() {
  const client = getSocialClient();
  if (!client) return;

  const { data: candidates, error } = await client
    .from('email_campaigns')
    .select('id, tenant_id, ab_test, completed_at')
    .eq('status', 'completed')
    .not('ab_test', 'is', null)
    .not('completed_at', 'is', null)
    .limit(100);
  if (error) { console.error('[email/abWinnerSweep] could not query candidates:', error.message); return; }

  const now = Date.now();
  for (const campaign of candidates || []) {
    const abTest = campaign.ab_test;
    if (!abTest || abTest.winnerKey || !abTest.decisionHours) continue;
    const dueAt = new Date(campaign.completed_at).getTime() + abTest.decisionHours * 3600 * 1000;
    if (now < dueAt) continue;

    try {
      const { data: rows } = await scoped(client, campaign.tenant_id, 'email_campaign_recipients').select('variant, status').eq('campaign_id', campaign.id);
      const byVariant = {};
      for (const row of rows || []) {
        const key = row.variant || 'unassigned';
        byVariant[key] = byVariant[key] || { sent: 0, opened: 0, clicked: 0 };
        if (['sent', 'delivered', 'opened', 'clicked'].includes(row.status)) byVariant[key].sent += 1;
        if (['opened', 'clicked'].includes(row.status)) byVariant[key].opened += 1;
        if (row.status === 'clicked') byVariant[key].clicked += 1;
      }
      const winnerKey = pickWinner(byVariant, abTest.variants, abTest.winnerMetric);
      if (!winnerKey) continue; // no sends recorded yet — try again next tick rather than deciding on zero data

      await client.from('email_campaigns').update({ ab_test: { ...abTest, winnerKey, decidedAt: new Date().toISOString() } }).eq('id', campaign.id);
      await recordAudit(client, {
        tenantId: campaign.tenant_id, actorUserId: null, action: 'marketing.email_campaign.ab_winner_decided',
        targetType: 'email_campaign', targetId: campaign.id, metadata: { winnerKey, winnerMetric: abTest.winnerMetric }
      });
      console.log(`[email/abWinnerSweep] campaign ${campaign.id}: variant "${winnerKey}" wins by ${abTest.winnerMetric}.`);
    } catch (err) {
      console.error(`[email/abWinnerSweep] campaign ${campaign.id} failed to decide a winner:`, err.message);
    }
  }
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => { sweep().catch((err) => console.error('[email/abWinnerSweep] sweep failed:', err.message)); }, SWEEP_INTERVAL_MS);
  sweep().catch((err) => console.error('[email/abWinnerSweep] initial sweep failed:', err.message));
  console.log('[email/abWinnerSweep] A/B winner-decision sweep started (5 min interval).');
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, sweep, pickWinner };
