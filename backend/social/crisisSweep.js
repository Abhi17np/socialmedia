/**
 * Crisis Intelligence — surge-detection sweep (migration 041). Same
 * restart-safe interval-sweep shape as lib/experimentSweep.js, but reads
 * real inbound volume across a tenant's connected accounts, not a
 * specific entity table: every 15 minutes, for every tenant with at
 * least one active connected account, counts inbound inbox_messages +
 * mentions in a trailing WINDOW_HOURS window and compares it against a
 * trailing BASELINE_BUCKETS-window baseline via
 * lib/crisisDetection.js's real z-score (never sentiment, never an AI
 * judgment call — see that file's own header for why).
 *
 * 15-minute cadence (not experimentSweep's "a decision an hour late
 * doesn't matter" reasoning) because the entire point of this feature is
 * catching a surge WHILE it's developing, not after; still far cheaper
 * than social/pollers.js's 10-minute inbound poll since this only reads
 * two already-populated tables per tenant, no outbound API calls at all.
 */
const { getSocialClient } = require('./db');
const { computeBaseline, detectSpike } = require('../lib/crisisDetection');

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const WINDOW_HOURS = 3;
const BASELINE_BUCKETS = 14; // 14 trailing 3h windows = 42h of history, excluding the live window itself
const MIN_COUNT = 5;         // see crisisDetection.js's detectSpike() — a non-negotiable floor, not just a statistical threshold
const Z_THRESHOLD = 3;

let intervalHandle = null;

/**
 * Splits `timestamps` (Date-coercible) into `numBuckets` consecutive,
 * equal-length windows ending at `now` — the last entry is the live
 * "current" window, everything before it is baseline history. A
 * timestamp older than the full lookback range is silently outside
 * every bucket (not an error — the caller only asked for this much
 * history to begin with).
 */
function bucketCounts(timestamps, now, windowHours, numBuckets) {
  const bucketMs = windowHours * 60 * 60 * 1000;
  const counts = new Array(numBuckets).fill(0);
  for (const ts of timestamps) {
    const ageMs = now - new Date(ts).getTime();
    const bucketsAgo = Math.floor(ageMs / bucketMs); // 0 = current (most recent) bucket
    if (bucketsAgo >= 0 && bucketsAgo < numBuckets) counts[numBuckets - 1 - bucketsAgo]++;
  }
  return counts; // oldest first; last element is the current window
}

async function evaluateTenant(client, tenantId, now) {
  const lookbackStart = new Date(now - (BASELINE_BUCKETS + 1) * WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const [{ data: inboxRows }, { data: mentionRows }] = await Promise.all([
    client.from('inbox_messages').select('received_at').eq('tenant_id', tenantId).eq('direction', 'inbound').gte('received_at', lookbackStart),
    client.from('mentions').select('captured_at').eq('tenant_id', tenantId).gte('captured_at', lookbackStart)
  ]);
  const timestamps = [
    ...(inboxRows || []).map((r) => r.received_at),
    ...(mentionRows || []).map((r) => r.captured_at)
  ].filter(Boolean);

  const counts = bucketCounts(timestamps, now, WINDOW_HOURS, BASELINE_BUCKETS + 1);
  const currentCount = counts[counts.length - 1];
  const baselineCounts = counts.slice(0, -1);
  const { mean, stddev } = computeBaseline(baselineCounts);
  const { isSpike, zScore } = detectSpike({ currentCount, baselineMean: mean, baselineStddev: stddev, minCount: MIN_COUNT, zThreshold: Z_THRESHOLD });

  if (!isSpike) return;

  // Never open a second alert on top of one already open — a sustained
  // surge should read as one ongoing incident, not a new row every tick.
  const { data: existingOpen } = await client.from('crisis_alerts').select('id').eq('tenant_id', tenantId).eq('status', 'open').limit(1).maybeSingle();
  if (existingOpen) return;

  const windowStart = new Date(now - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const { error } = await client.from('crisis_alerts').insert({
    tenant_id: tenantId, window_start: windowStart, window_end: new Date(now).toISOString(),
    message_count: currentCount, baseline_mean: mean, baseline_stddev: stddev, z_score: zScore
  });
  if (error) console.error(`[social/crisisSweep] could not record alert for tenant ${tenantId}:`, error.message);
  else console.log(`[social/crisisSweep] tenant ${tenantId}: surge detected — ${currentCount} inbound in ${WINDOW_HOURS}h vs. a baseline of ~${mean.toFixed(1)}.`);
}

async function sweep() {
  const client = getSocialClient();
  if (!client) return;

  const { data: accounts, error } = await client.from('social_accounts').select('tenant_id').eq('status', 'active');
  if (error) {
    console.error('[social/crisisSweep] could not list active accounts:', error.message);
    return;
  }
  const tenantIds = [...new Set((accounts || []).map((a) => a.tenant_id))];
  const now = Date.now();

  for (const tenantId of tenantIds) {
    await evaluateTenant(client, tenantId, now).catch((err) => console.error(`[social/crisisSweep] tenant ${tenantId} failed to evaluate:`, err.message));
  }
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => { sweep().catch((err) => console.error('[social/crisisSweep] sweep failed:', err.message)); }, SWEEP_INTERVAL_MS);
  sweep().catch((err) => console.error('[social/crisisSweep] initial sweep failed:', err.message));
  console.log('[social/crisisSweep] Crisis surge-detection sweep started (15 min interval).');
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, sweep, bucketCounts };
