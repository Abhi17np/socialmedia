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

// Shared by routes/social.js (a brand-new post) and spawnNextOccurrence()
// below (a recurring post's next instance) — re-evaluated fresh every
// time rather than inherited from the series' first post, since a
// tenant could turn approval on/off, or the creator's role could change,
// partway through a long-running series.
async function determineInitialStatus(client, tenantId, creatorRole) {
  const { data: tenant } = await client.from('tenants').select('social_require_approval').eq('id', tenantId).maybeSingle();
  const needsReview = !!tenant?.social_require_approval && !['admin', 'owner'].includes(creatorRole);
  return needsReview ? 'pending_review' : 'pending';
}

function nextOccurrenceDate(scheduledAt, freq) {
  const d = new Date(scheduledAt);
  if (freq === 'daily') d.setDate(d.getDate() + 1);
  else if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
  return d;
}

/** Migration 035: a published recurring post spawns its own next occurrence through the exact same creation path (approval gate, plan-limit metering, queue) a one-off post goes through — never a parallel "recurring post" code path that could drift from it. */
async function spawnNextOccurrence(client, post) {
  if (!post.recurrence?.freq || !post.recurrence?.until) return;
  const next = nextOccurrenceDate(post.scheduled_at, post.recurrence.freq);
  if (next > new Date(post.recurrence.until)) return; // series has run its course

  const { data: creator } = post.created_by ? await client.from('users').select('role').eq('id', post.created_by).maybeSingle() : { data: null };
  const status = await determineInitialStatus(client, post.tenant_id, creator?.role || 'member');

  const { data: spawned, error } = await client.from('scheduled_posts').insert({
    tenant_id: post.tenant_id,
    content: post.content,
    media_urls: post.media_urls,
    target_platforms: post.target_platforms,
    target_account_ids: post.target_account_ids,
    scheduled_at: next.toISOString(),
    status,
    created_by: post.created_by,
    recurrence: post.recurrence,
    recurrence_series_id: post.recurrence_series_id || post.id
  }).select().single();
  if (error) { console.error(`[social/queue] could not spawn next occurrence of series ${post.recurrence_series_id || post.id}:`, error.message); return; }

  if (status === 'pending') await enqueuePost(spawned).catch(err => console.error(`[social/queue] could not enqueue spawned occurrence ${spawned.id}:`, err.message));
}

async function maybeFinalize(client, postId) {
  const { data: post } = await client.from('scheduled_posts').select('*').eq('id', postId).single();
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
    // Pre-existing bug fixed here: supabase-js's query builder is
    // PromiseLike (has .then, no .catch), so the previous
    // `.catch(...)` chained directly onto client.rpc(...) silently
    // never attached — a rejected/errored call here would throw
    // uncaught instead of just logging, exactly what this whole
    // function exists to avoid. A real await + try/catch, the same
    // pattern every other .rpc() call site in this codebase uses.
    try {
      await client.rpc('increment_usage', { p_tenant_id: post.tenant_id, p_period: period, p_column: 'posts_published', p_amount: 1 });
    } catch (err) {
      console.error(`[social/queue] increment_usage failed for post ${postId}:`, err.message);
    }
    // A failed occurrence does NOT advance the series — a tenant should
    // see and fix a broken recurring post, not have it silently skip
    // ahead to the next date while quietly failing forever.
    await spawnNextOccurrence(client, post).catch(err => console.error(`[social/queue] spawnNextOccurrence failed for post ${postId}:`, err.message));
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

// worker.close()/queue.close() wait on BullMQ's internal Redis commands,
// which never resolve if the connection never came up in the first
// place (ioredis's retryStrategy above keeps it retrying indefinitely,
// by design, for a Redis that comes up later). Without a timeout here,
// every `node --watch` restart during local dev without Redis running
// — an explicitly supported setup, see README — hung for the full 10s
// of server.js's shutdown force-exit instead of a normal fast restart.
// Timing out and disconnecting directly is safe either way: there's
// nothing queued server-side to lose by tearing down a connection that
// was never serving requests.
async function stop() {
  const CLOSE_TIMEOUT_MS = 3000;
  await Promise.all([
    worker ? withTimeout(worker.close(), CLOSE_TIMEOUT_MS, 'worker.close() timed out')
      .catch(err => console.warn(`[social/queue] ${err.message} — Redis was likely never reachable.`)) : null,
    queue ? withTimeout(queue.close(), CLOSE_TIMEOUT_MS, 'queue.close() timed out')
      .catch(err => console.warn(`[social/queue] ${err.message} — Redis was likely never reachable.`)) : null
  ]);
  worker = null;
  queue = null;
  if (connection) { connection.disconnect(); connection = null; }
}

module.exports = { start, stop, enqueuePost, cancelPost, determineInitialStatus, nextOccurrenceDate, recordOutcome };
