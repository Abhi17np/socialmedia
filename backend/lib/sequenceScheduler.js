/**
 * Persistent sweep for Sales Hub sequences (lib/sequences.js) — same
 * shape as social/scheduler.js's reconciliation sweep: a slow interval
 * that finds every due row and processes it, rather than a per-row
 * setTimeout (which a restart would silently lose).
 */

const { getSocialClient } = require('../social/db');
const { processDueEnrollments } = require('./sequences');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // day-granularity delays don't need finer than this

let intervalHandle = null;

async function sweep() {
  const client = getSocialClient();
  if (!client) return; // social project not configured — nothing to sweep yet
  await processDueEnrollments(client);
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => { sweep().catch((err) => console.error('[sequenceScheduler] sweep failed:', err.message)); }, SWEEP_INTERVAL_MS);
  sweep().catch((err) => console.error('[sequenceScheduler] initial sweep failed:', err.message));
  console.log('[sequenceScheduler] Sequence sweep started (5 min interval).');
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, sweep };
