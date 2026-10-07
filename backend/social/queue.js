/**
 * Phase 2's real publish queue — BullMQ + Redis, replacing Phase 1's
 * plain setInterval poller (social/scheduler.js) as the thing that
 * actually fires a scheduled post. One job per (post, target account)
 * pair, so a post targeting three accounts is three independent jobs
 * that can retry/fail/succeed independently — a Facebook failure
 * doesn't block or duplicate the YouTube upload for the same post.
 *
 * Job outcomes are written to scheduled_posts by the worker's
 * 'completed'/'failed' event handlers (not inside the job processor
 * itself) so a job that's still retrying never gets recorded as a
 * result — only its final outcome does, after BullMQ has exhausted (or
 * not needed) its retries.
 *
 * Concurrent jobs for the *same* post (different accounts) each merge
 * their own entry into scheduled_posts.platform_results via the
 * merge_platform_result() Postgres function (migrations/002), an atomic
 * UPDATE — not a read-modify-write in this file, which would race.
 *
 * REDIS_URL defaults to a local Redis, same "sane localhost default,
 * .env overrides it" pattern as BACKEND_PUBLIC_URL/FRONTEND_URL.
 */

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const { getSocialClient } = require('./db');
const { getUsableAccount } = require('./accounts');

const QUEUE_NAME = 'social-publish';
const ENQUEUE_TIMEOUT_MS = 5000; // fail fast with a clear error instead of hanging the API if Redis is unreachable
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let connection = null;
let queue = null;
let worker = null;

// One clear line instead of ioredis's per-attempt noise (which, left
// unbounded, is what was flooding the console) — logged once per outage,
// not once per retry.
let warnedUnreachable = false;
function warnUnreachableOnce(source) {
  if (warnedUnreachable) return;
  warnedUnreachable = true;
  console.warn(
    `[social/queue] Redis not reachable at ${REDIS_URL} (via ${source}) — the publish queue is disabled until it is. ` +
    'Install & start Redis (or point REDIS_URL at one), then restart the backend. Posts still save; ' +
    'they just won\'t auto-publish until Redis is up.'
  );
}

function getConnection() {
  if (!connection) {
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null, // required by BullMQ for its blocking connections
      connectTimeout: 5000,
      // Keep retrying indefinitely (capped at a 10s interval) rather than
      // giving up — Redis coming up later (e.g. installed after the
      // backend was already started) should self-heal without a
      // restart. The logging above is what stops this from being noisy,
      // not a retry limit.
      retryStrategy: (times) => Math.min(times * 500, 10000)
    });
    // Required: an EventEmitter's unhandled 'error' event makes Node
    // print/throw the raw error — this is what turned one connection
    // failure into a wall of unlabeled AggregateError dumps.
    connection.on('error', () => warnUnreachableOnce('connection'));
    connection.on('end', () => warnUnreachableOnce('connection'));
    // Redis came back after being down — allow a future outage to warn again.
    connection.on('ready', () => { warnedUnreachable = false; console.log(`[social/queue] Connected to Redis at ${REDIS_URL}.`); });
  }
  return connection;
}

function getQueue() {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, { connection: getConnection() });
    queue.on('error', () => warnUnreachableOnce('queue'));
  }
  return queue;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

/** Enqueues one delayed job per target account. Safe to call again for the same post — jobId is deterministic, so a duplicate add is a no-op. */
async function enqueuePost(post) {
  const q = getQueue();
  const delay = Math.max(0, new Date(post.scheduled_at).getTime() - Date.now());

  for (const accountId of post.target_account_ids || []) {
    await withTimeout(
      q.add(
        'publish',
        { postId: post.id, tenantId: post.tenant_id, accountId, content: post.content, mediaUrls: post.media_urls || [] },
        {
          jobId: `${post.id}__${accountId}`, // BullMQ reserves ':' for its own Redis key namespacing and rejects a custom id containing one
          delay,
          attempts: 4,
          backoff: { type: 'exponential', delay: 10000 }, // 10s, 20s, 40s, 80s
          removeOnComplete: { age: 7 * 24 * 3600 },
          removeOnFail: { age: 30 * 24 * 3600 }
        }
      ),
      ENQUEUE_TIMEOUT_MS,
      `Could not reach Redis (${process.env.REDIS_URL || 'redis://localhost:6379'}) to enqueue the post.`
    );
  }
}

/** Cancels a still-pending post's jobs (used by DELETE /social/posts/:id). No-ops for jobs already running/finished. */
async function cancelPost(post) {
  const q = getQueue();
  for (const accountId of post.target_account_ids || []) {
    const job = await q.getJob(`${post.id}__${accountId}`).catch(() => null);
    if (job) await job.remove().catch(() => {});
  }
}

async function processJob(job) {
  const { tenantId, accountId, content, mediaUrls } = job.data;
  const usable = await getUsableAccount(tenantId, accountId);
  if (!usable) throw new Error(`social_accounts row ${accountId} not found (disconnected?).`);
  const { account, adapter } = usable;
  if (typeof adapter.publish !== 'function') throw new Error(`${account.platform} adapter does not support publish().`);

  const result = await adapter.publish(account, { content, mediaUrls: mediaUrls || [] });
  return { platform: account.platform, ...result };
}

async function maybeFinalize(client, postId) {
  const { data: post } = await client.from('scheduled_posts').select('tenant_id, target_account_ids, platform_results').eq('id', postId).single();
  if (!post) return;
  const results = post.platform_results || {};
  const allIn = (post.target_account_ids || []).every(id => results[id] !== undefined);
  if (!allIn) return;
  const anyFailed = Object.values(results).some(r => r.status === 'failed');
  await client.from('scheduled_posts').update({ status: anyFailed ? 'failed' : 'published' }).eq('id', postId);

  // Usage metering (see migrations/004_billing.sql) — counted once per
  // post that reaches a terminal 'published' state, not per target
  // account, so a post to 3 platforms counts as 1 published post.
  if (!anyFailed) {
    const period = new Date().toISOString().slice(0, 8) + '01'; // first of the current month
    await client.rpc('increment_usage', { p_tenant_id: post.tenant_id, p_period: period, p_column: 'posts_published', p_amount: 1 })
      .catch(err => console.error(`[social/queue] increment_usage failed for post ${postId}:`, err.message));
  }
}

async function recordOutcome(postId, accountId, resultEntry) {
  const client = getSocialClient();
  if (!client) return;
  const { error } = await client.rpc('merge_platform_result', { p_post_id: postId, p_key: accountId, p_result: resultEntry });
  if (error) {
    console.error(`[social/queue] merge_platform_result failed for post ${postId}/${accountId}:`, error.message);
    return;
  }
  await maybeFinalize(client, postId);
}

function start() {
  if (worker) return;

  getQueue(); // ensure the producer connection exists too

  worker = new Worker(QUEUE_NAME, processJob, { connection: getConnection(), concurrency: 5 });

  // BullMQ duplicates the shared connection internally for its blocking
  // commands — that duplicate is a separate EventEmitter this file never
  // otherwise touches, so without this listener ITS connection failures
  // are what actually produced the raw unlabeled AggregateError dumps
  // (an EventEmitter's unhandled 'error' event makes Node print/throw).
  worker.on('error', () => warnUnreachableOnce('worker'));

  worker.on('active', (job) => {
    // First job to reach here for a post flips it out of 'pending' so the
    // UI shows "Publishing" instead of looking untouched. Optimistic:
    // .eq('status', 'pending') means only the first racer's write matches.
    const client = getSocialClient();
    if (client) client.from('scheduled_posts').update({ status: 'publishing' }).eq('id', job.data.postId).eq('status', 'pending').then(() => {}, () => {});
  });

  worker.on('completed', (job, returnValue) => {
    recordOutcome(job.data.postId, job.data.accountId, { status: 'published', ...returnValue })
      .catch(err => console.error('[social/queue] recordOutcome (completed) failed:', err.message));
  });

  worker.on('failed', (job, err) => {
    if (!job) return; // job itself failed to even be read from Redis — nothing to record
    const maxAttempts = job.opts.attempts || 1;
    const exhausted = job.attemptsMade >= maxAttempts;
    console.error(`[social/queue] Job ${job.id} attempt ${job.attemptsMade}/${maxAttempts} failed${exhausted ? ' (no attempts left)' : ' — will retry'}:`, err.message);
    // BullMQ fires 'failed' on every attempt, not just the last one — a
    // job that still has retries left is NOT a final outcome, so it must
    // not get recorded (an early attempt failing would otherwise mark
    // the post 'failed' even if a later retry goes on to succeed).
    if (!exhausted) return;
    recordOutcome(job.data.postId, job.data.accountId, { status: 'failed', error: err.message })
      .catch(e => console.error('[social/queue] recordOutcome (failed) failed:', e.message));
  });

  console.log('[social/queue] BullMQ worker started (concurrency 5, exponential backoff, 4 attempts).');
}

async function stop() {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
  if (connection) { connection.disconnect(); connection = null; }
}

module.exports = { start, stop, enqueuePost, cancelPost };
