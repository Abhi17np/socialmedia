/**
 * Phase 2: reconciliation sweep, not the publisher anymore — that's
 * social/queue.js's BullMQ worker now. This file's job is narrower:
 * every `pending` scheduled_posts row should have a queued job per
 * target account (routes/social.js enqueues immediately on creation),
 * but a row could exist without one — created while Redis was down, or
 * left behind by a crash between insert and enqueue. This sweep re-runs
 * enqueuePost() for every still-pending row on a slow interval; BullMQ's
 * deterministic jobId (`${postId}:${accountId}`) makes re-adding an
 * already-queued job a safe no-op, so this never double-publishes.
 *
 * (Phase 1's version of this file polled and published directly — see
 * git history. This is the "replace tick() with a BullMQ worker" swap
 * promised in that commit, without changing server.js's start()/stop()
 * calling convention.)
 */

const { getSocialClient } = require('./db');
const queue = require('./queue');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // BullMQ already fires jobs on time; this just catches orphans
let intervalHandle = null;

async function sweep() {
  const client = getSocialClient();
  if (!client) return; // social project not configured — nothing to reconcile yet

  const { data: pending, error } = await client.from('scheduled_posts').select('*').eq('status', 'pending');
  if (error) {
    console.error('[social/scheduler] Could not query pending scheduled_posts:', error.message);
    return;
  }

  for (const post of pending || []) {
    await queue.enqueuePost(post).catch(err => console.error(`[social/scheduler] Could not reconcile post ${post.id}:`, err.message));
  }
}

function start() {
  if (intervalHandle) return;
  queue.start();
  intervalHandle = setInterval(() => { sweep().catch(err => console.error('[social/scheduler] sweep failed:', err.message)); }, SWEEP_INTERVAL_MS);
  sweep().catch(err => console.error('[social/scheduler] initial sweep failed:', err.message));
  console.log('[social/scheduler] Reconciliation sweep started (5 min interval) alongside the BullMQ worker.');
}

async function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  await queue.stop();
}

module.exports = { start, stop, sweep };
