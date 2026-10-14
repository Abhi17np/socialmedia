/**
 * Resumes a journey enrollment once its delay node's due time has
 * passed — same restart-safe sweep shape as lib/sequenceScheduler.js
 * and lib/email/scheduledSendSweep.js: a slow interval re-reading every
 * due row from the DB, not a per-enrollment setTimeout a restart would
 * silently lose.
 */
const { getSocialClient } = require('../social/db');
const { runEnrollmentTick } = require('./journeyEngine');

const SWEEP_INTERVAL_MS = 60 * 1000;

let intervalHandle = null;

async function sweep() {
  const client = getSocialClient();
  if (!client) return;

  const { data: due, error } = await client
    .from('workflow_enrollments')
    .select('*')
    .eq('status', 'active')
    .not('next_action_at', 'is', null)
    .lte('next_action_at', new Date().toISOString())
    .limit(200);
  if (error) { console.error('[journeySweep] could not query due enrollments:', error.message); return; }

  for (const enrollment of due || []) {
    await client.from('workflow_enrollments').update({ next_action_at: null }).eq('id', enrollment.id); // clear first so a slow tick isn't picked up twice by the next interval tick
    await runEnrollmentTick(client, enrollment.tenant_id, { ...enrollment, next_action_at: null });
  }
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => { sweep().catch((err) => console.error('[journeySweep] sweep failed:', err.message)); }, SWEEP_INTERVAL_MS);
  sweep().catch((err) => console.error('[journeySweep] initial sweep failed:', err.message));
  console.log('[journeySweep] Journey delay-resume sweep started (60s interval).');
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, sweep };
