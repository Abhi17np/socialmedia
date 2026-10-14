/**
 * Marketing email send queue — same BullMQ/Redis shape as
 * social/broadcastQueue.js (one job per recipient, deterministic jobId,
 * bounded retries with exponential backoff, outcome recorded only in the
 * worker's 'completed'/'failed' listeners, never inside the job processor
 * itself, so a crash between a successful send and recording it is
 * caught by BullMQ's own retry machinery the same way broadcastQueue.js
 * accepts it). See that file for the fuller reasoning; differences below
 * are called out, not silently copied.
 *
 * Differences from broadcastQueue.js, both deliberate:
 *   1. A rendered email body (subject/html/text) is safe to put in the
 *      Redis job payload — it's not a secret. The tenant's PROVIDER
 *      CREDENTIAL is re-fetched fresh from the DB (decrypted) inside
 *      processJob, never persisted into the job payload, so a secret
 *      never sits in Redis and a credential rotated after enqueue takes
 *      effect immediately, not after a stale copy expires.
 *   2. Per-tenant pacing: broadcastQueue.js has no rate limiter at all
 *      (a documented gap from the Phase 0 audit). enqueueCampaign here
 *      staggers each successive recipient's job with an increasing
 *      `delay` based on a per-tenant sends-per-minute budget, so a
 *      10,000-recipient campaign doesn't fire all at once against a
 *      provider's own rate limits — real pacing, not just a worker
 *      concurrency cap (BullMQ's open-source `limiter` is global to the
 *      whole worker, not per-tenant, so this is the mechanism that
 *      actually achieves per-tenant pacing without BullMQ Pro's group
 *      rate limiting).
 *   3. A hard bounce (lib/email/providers/mock.js's simulated bounce,
 *      and any real provider that can distinguish one) is NOT retried —
 *      thrown as BullMQ's UnrecoverableError, since retrying a permanent
 *      failure four times with backoff just delays the inevitable and
 *      wastes the per-tenant send quota.
 */

const { Queue, Worker, UnrecoverableError } = require('bullmq');
const IORedis = require('ioredis');
const { getSocialClient } = require('../../social/db');
const { sendViaTenantProvider } = require('./providerRegistry');
const { recordUsage } = require('../entitlements');
const { addSuppression } = require('../consent');

const QUEUE_NAME = 'marketing-email';
const ENQUEUE_TIMEOUT_MS = 5000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const SENDS_PER_MINUTE_PER_TENANT = Number(process.env.EMAIL_SENDS_PER_MINUTE_PER_TENANT) || 60;
const STAGGER_MS = Math.max(1, Math.round(60000 / SENDS_PER_MINUTE_PER_TENANT));

let connection = null;
let queue = null;
let worker = null;

let warnedUnreachable = false;
function warnUnreachableOnce(source) {
  if (warnedUnreachable) return;
  warnedUnreachable = true;
  console.warn(
    `[lib/email/emailQueue] Redis not reachable at ${REDIS_URL} (via ${source}) — email sending is disabled until it is. ` +
    'Campaigns still save; they just won\'t send until Redis is up.'
  );
}

function getConnection() {
  if (!connection) {
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      connectTimeout: 5000,
      retryStrategy: (times) => Math.min(times * 500, 10000)
    });
    connection.on('error', () => warnUnreachableOnce('connection'));
    connection.on('end', () => warnUnreachableOnce('connection'));
    connection.on('ready', () => { warnedUnreachable = false; console.log(`[lib/email/emailQueue] Connected to Redis at ${REDIS_URL}.`); });
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
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

/**
 * One job per recipient, staggered by STAGGER_MS per recipient within
 * this one enqueue call — see this file's header for why. `baseDelayMs`
 * lets a caller offset an entire campaign (e.g. a scheduled send waiting
 * for its scheduled_at time) without changing the per-recipient pacing.
 *
 * `rendered` is a Map<recipientId, {subject, html, text, headers}> — each
 * recipient's email is personalized (merge tags, a per-recipient
 * click-tracking link, their own unsubscribe token), so there is no
 * single shared rendering for the whole campaign the way a WhatsApp
 * template's variables are substituted server-side by Meta; the caller
 * (routes/marketingEmail.js) renders every recipient via
 * lib/email/sendPipeline.js before calling this.
 */
async function enqueueCampaign(campaign, recipients, rendered, baseDelayMs = 0) {
  const q = getQueue();
  let i = 0;
  for (const recipient of recipients) {
    const r = rendered.get(recipient.id);
    if (!r) { console.error(`[lib/email/emailQueue] No rendered content for recipient ${recipient.id} — skipped.`); continue; }
    const delay = baseDelayMs + i * STAGGER_MS;
    i += 1;
    await withTimeout(
      q.add(
        'send-email',
        {
          campaignId: campaign.id,
          tenantId: campaign.tenant_id,
          recipientId: recipient.id,
          email: recipient.email,
          subject: r.subject,
          html: r.html,
          text: r.text,
          headers: r.headers || {},
          fromName: campaign.from_name || undefined,
          fromEmail: campaign.from_email || undefined
        },
        {
          jobId: `${campaign.id}__${recipient.id}`,
          delay,
          attempts: 4,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: { age: 7 * 24 * 3600 },
          removeOnFail: { age: 30 * 24 * 3600 }
        }
      ),
      ENQUEUE_TIMEOUT_MS,
      `Could not reach Redis (${REDIS_URL}) to enqueue the campaign.`
    );
  }
}

async function cancelCampaign(campaign, recipients) {
  const q = getQueue();
  for (const recipient of recipients) {
    const job = await q.getJob(`${campaign.id}__${recipient.id}`).catch(() => null);
    if (job) await job.remove().catch(() => {});
  }
}

async function processJob(job) {
  const client = getSocialClient();
  if (!client) throw new Error('Database not configured.');
  const { tenantId, email, subject, html, text, headers, fromName, fromEmail } = job.data;
  try {
    return await sendViaTenantProvider(client, tenantId, { to: email, subject, html, text, headers, fromName, fromEmail });
  } catch (err) {
    if (err.bounce) throw new UnrecoverableError(err.message);
    throw err;
  }
}

async function recordRecipientOutcome(client, recipientId, campaignId, patch, eventType) {
  const { error } = await client.from('email_campaign_recipients').update(patch).eq('id', recipientId);
  if (error) { console.error(`[lib/email/emailQueue] Could not update recipient ${recipientId}:`, error.message); return; }
  if (eventType) {
    await client.from('email_events').insert({ tenant_id: patch.tenant_id, campaign_id: campaignId, recipient_id: recipientId, event_type: eventType, metadata: {} })
      .then(({ error: evErr }) => { if (evErr) console.error('[lib/email/emailQueue] event log insert failed:', evErr.message); });
  }
  await client.rpc('recompute_email_campaign_counts', { p_campaign_id: campaignId })
    .then(({ error: rpcError }) => { if (rpcError) console.error(`[lib/email/emailQueue] recompute_email_campaign_counts failed for ${campaignId}:`, rpcError.message); });
}

function start() {
  if (worker) return;
  getQueue();

  worker = new Worker(QUEUE_NAME, processJob, { connection: getConnection(), concurrency: 5 });
  worker.on('error', () => warnUnreachableOnce('worker'));

  worker.on('active', (job) => {
    const client = getSocialClient();
    if (client) client.from('email_campaign_recipients').update({ status: 'sent', queued_at: new Date().toISOString() }).eq('id', job.data.recipientId).eq('status', 'pending').then(() => {}, () => {});
  });

  worker.on('completed', (job, returnValue) => {
    const client = getSocialClient();
    if (!client) return;
    recordRecipientOutcome(client, job.data.recipientId, job.data.campaignId, {
      tenant_id: job.data.tenantId, status: 'sent', external_message_id: (returnValue && returnValue.externalId) || null, sent_at: new Date().toISOString()
    }, 'sent')
      .then(() => recordUsage(client, job.data.tenantId, 'emailSendsPerMonth', 1))
      .catch((err) => console.error('[lib/email/emailQueue] recordRecipientOutcome (completed) failed:', err.message));
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    const isUnrecoverable = err instanceof UnrecoverableError || err.name === 'UnrecoverableError';
    const maxAttempts = job.opts.attempts || 1;
    const exhausted = isUnrecoverable || job.attemptsMade >= maxAttempts;
    console.error(`[lib/email/emailQueue] Job ${job.id} attempt ${job.attemptsMade}/${maxAttempts} failed${exhausted ? ' (no attempts left)' : ' — will retry'}:`, err.message);
    if (!exhausted) return;
    const client = getSocialClient();
    if (!client) return;
    const isBounce = /bounce/i.test(err.message);
    recordRecipientOutcome(client, job.data.recipientId, job.data.campaignId, {
      tenant_id: job.data.tenantId, status: isBounce ? 'bounced' : 'failed', error: err.message,
      ...(isBounce ? { bounced_at: new Date().toISOString() } : {})
    }, isBounce ? 'bounce' : 'failed').catch((e) => console.error('[lib/email/emailQueue] recordRecipientOutcome (failed) failed:', e.message));
    // A hard bounce suppresses the address outright, tenant-wide, for
    // every future campaign — not just this one recipient row — same
    // "survives a contact being deleted/merged" reasoning as every other
    // suppression_list entry (lib/consent.js's header).
    if (isBounce) {
      addSuppression(client, job.data.tenantId, 'email', job.data.email, 'hard_bounce', { source: 'provider' })
        .catch((e) => console.error('[lib/email/emailQueue] addSuppression (hard bounce) failed:', e.message));
    }
  });

  console.log(`[lib/email/emailQueue] BullMQ worker started (concurrency 5, ${SENDS_PER_MINUTE_PER_TENANT}/min/tenant pacing, exponential backoff, 4 attempts).`);
}

async function stop() {
  const CLOSE_TIMEOUT_MS = 3000;
  await Promise.all([
    worker ? withTimeout(worker.close(), CLOSE_TIMEOUT_MS, 'worker.close() timed out').catch((err) => console.warn(`[lib/email/emailQueue] ${err.message}`)) : null,
    queue ? withTimeout(queue.close(), CLOSE_TIMEOUT_MS, 'queue.close() timed out').catch((err) => console.warn(`[lib/email/emailQueue] ${err.message}`)) : null
  ]);
  worker = null;
  queue = null;
  if (connection) { connection.disconnect(); connection = null; }
}

module.exports = { start, stop, enqueueCampaign, cancelCampaign, STAGGER_MS };
