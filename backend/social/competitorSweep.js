/**
 * Competitor Opportunity Radar — ingestion sweep. Same restart-safe
 * interval-sweep shape as social/pollers.js, but its own file: this
 * iterates tracked_competitors (migration 040), a different entity
 * than social_accounts, on a deliberately slower, once-a-day cadence —
 * every lookup here spends quota against one of the TENANT's own
 * connected accounts to read a competitor's PUBLIC data (Instagram
 * Business Discovery, YouTube's public channel/video lookups — see
 * social/adapters/instagram.js's and youtube.js's own fetchCompetitor()
 * headers for exactly which official API and why no new OAuth scope
 * was needed), so this is deliberately conservative about how often it
 * spends that quota, not tied to how often account-level analytics move.
 */
const { getSocialClient } = require('./db');
const { getUsableAccount } = require('./accounts');
const ADAPTERS = require('./adapters');
const { averageEngagementRate, postsInWindow } = require('../lib/competitorRadar');

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day — see header
const ENGAGEMENT_WINDOW_DAYS = 30;

let intervalHandle = null;

async function pollOneCompetitor(client, competitor) {
  const usable = await getUsableAccount(competitor.tenant_id, competitor.viewer_account_id);
  if (!usable) return; // the viewer account was disconnected since this competitor was added
  const { account, adapter } = usable;
  if (typeof adapter.fetchCompetitor !== 'function') return; // this platform has no public-lookup capability — see that adapter's own header

  try {
    const result = await adapter.fetchCompetitor(account, competitor.handle);
    const capturedDate = new Date().toISOString().slice(0, 10);
    const rows = [
      { metric: 'followers', value: result.followersCount },
      { metric: 'media_count', value: result.mediaCount },
      { metric: 'posts_in_window', value: postsInWindow(result.posts, ENGAGEMENT_WINDOW_DAYS) },
      { metric: 'avg_engagement_rate', value: averageEngagementRate(result.posts, result.followersCount) }
    ].map((r) => ({
      tenant_id: competitor.tenant_id, tracked_competitor_id: competitor.id, metric: r.metric, value: r.value, captured_date: capturedDate
    }));
    const { error } = await client.from('competitor_snapshots').upsert(rows, { onConflict: 'tracked_competitor_id,metric,captured_date' });
    if (error) throw error;
  } catch (err) {
    console.error(`[social/competitorSweep] fetchCompetitor failed for @${competitor.handle} (${competitor.platform}, tenant ${competitor.tenant_id}):`, err.message);
  }
}

async function sweep() {
  const client = getSocialClient();
  if (!client) return;

  const { data: competitors, error } = await client.from('tracked_competitors').select('*');
  if (error) {
    console.error('[social/competitorSweep] could not list tracked_competitors:', error.message);
    return;
  }

  for (const competitor of competitors || []) {
    if (!ADAPTERS[competitor.platform]) continue;
    await pollOneCompetitor(client, competitor).catch((err) => console.error(`[social/competitorSweep] unexpected failure for competitor ${competitor.id}:`, err.message));
  }
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => { sweep().catch((err) => console.error('[social/competitorSweep] sweep failed:', err.message)); }, SWEEP_INTERVAL_MS);
  sweep().catch((err) => console.error('[social/competitorSweep] initial sweep failed:', err.message));
  console.log('[social/competitorSweep] Competitor radar sync started (24 hour interval).');
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, sweep };
