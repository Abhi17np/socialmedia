/**
 * SMS send queue — same BullMQ/Redis shape as lib/email/emailQueue.js
 * (one job per recipient, deterministic jobId, per-tenant pacing via
 * staggered delay, exponential backoff, outcome recorded only in the
 * worker's 'completed'/'failed' listeners, a permanent failure thrown as
 * UnrecoverableError so it isn't retried 4 times pointlessly). See that
 * file's header for the fuller reasoning — not re-explained here.
 */
const { Queue, Worker, UnrecoverableError } = require('bullmq');
const IORedis = require('ioredis');
const { getSocialClient } = require('../../social/db');
const { sendViaTenantProvider } = require('./providerRegistry');
const { recordUsage } = require('../entitlements');
const { addSuppression } = require('../consent');

const QUEUE_NAME = 'marketing-sms';
const ENQUEUE_TIMEOUT_MS = 5000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const SENDS_PER_MINUTE_PER_TENANT = Number(process.env.SMS_SENDS_PER_MINUTE_PER_TENANT) || 60;
const STAGGER_MS = Math.max(1, Math.round(60000 / SENDS_PER_MINUTE_PER_TENANT));

let connection = null;
let queue = null;
let worker = null;
let warnedUnreachable = false;

function warnUnreachableOnce(source) {
  if (warnedUnreachable) return;
  warnedUnreachable = true;
  console.warn(`[lib/sms/smsQueue] Redis not reachable at ${REDIS_URL} (via ${source}) — SMS sending is disabled until it is. Campaigns still save; they just won't send until Redis is up.`);
}

function getConnection() {
  if (!connection) {
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, connectTimeout: 5000, retryStrategy: (times) => Math.min(times * 500, 10000) });
    connection.on('error', () => warnUnreachableOnce('connection'));
    connection.on('end', () => warnUnreachableOnce('connection'));
    connection.on('ready', () => { warnedUnreachable = false; console.log(`[lib/sms/smsQueue] Connected to Redis at ${REDIS_URL}.`); });
  }
  return connection;
}

function getQueue() {
  if (!queue) { queue = new Queue(QUEUE_NAME, { connection: getConnection() }); queue.on('error', () => warnUnreachableOnce('queue')); }
  return queue;
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

async function enqueueCampaign(campaign, recipients, bodyByRecipient, baseDelayMs = 0) {
  const q = getQueue();
  let i = 0;
  for (const recipient of recipients) {
    const body = bodyByRecipient.get(recipient.id);
    if (!body) { console.error(`[lib/sms/smsQueue] No rendered body for recipient ${recipient.id} — skipped.`); continue; }
    const delay = baseDelayMs + i * STAGGER_MS;
    i += 1;
    await withTimeout(
      q.add('send-sms', { campaignId: campaign.id, tenantId: campaign.tenant_id, recipientId: recipient.id, phone: recipient.phone, body },
        { jobId: `${campaign.id}__${recipient.id}`, delay, attempts: 4, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: { age: 7 * 24 * 3600 }, removeOnFail: { age: 30 * 24 * 3600 } }),
      ENQUEUE_TIMEOUT_MS, `Could not reach Redis (${REDIS_URL}) to enqueue the campaign.`
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
  const { tenantId, phone, body } = job.data;
  const client = getSocialClient();
  if (!client) throw new Error('Database not configured.');
  try {
    return await sendViaTenantProvider(client, tenantId, { to: phone, body });
  } catch (err) {
    if (err.permanent) throw new UnrecoverableError(err.message);
    throw err;
  }
}

async function recordRecipientOutcome(client, recipientId, campaignId, patch) {
  const { error } = await client.from('sms_campaign_recipients').update(patch).eq('id', recipientId);
  if (error) { console.error(`[lib/sms/smsQueue] Could not update recipient ${recipientId}:`, error.message); return; }
  await client.rpc('recompute_sms_campaign_counts', { p_campaign_id: campaignId }).then(({ error: rpcError }) => { if (rpcError) console.error(`[lib/sms/smsQueue] recompute_sms_campaign_counts failed for ${campaignId}:`, rpcError.message); });
}

function start() {
  if (worker) return;
  getQueue();
  worker = new Worker(QUEUE_NAME, processJob, { connection: getConnection(), concurrency: 5 });
  worker.on('error', () => warnUnreachableOnce('worker'));

  worker.on('completed', (job, returnValue) => {
    const client = getSocialClient();
    if (!client) return;
    recordRecipientOutcome(client, job.data.recipientId, job.data.campaignId, { status: 'sent', external_message_id: (returnValue && returnValue.externalId) || null, sent_at: new Date().toISOString() })
      .then(() => recordUsage(client, job.data.tenantId, 'smsSendsPerMonth', 1))
      .catch((err) => console.error('[lib/sms/smsQueue] recordRecipientOutcome (completed) failed:', err.message));
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    const isUnrecoverable = err instanceof UnrecoverableError || err.name === 'UnrecoverableError';
    const maxAttempts = job.opts.attempts || 1;
    const exhausted = isUnrecoverable || job.attemptsMade >= maxAttempts;
    console.error(`[lib/sms/smsQueue] Job ${job.id} attempt ${job.attemptsMade}/${maxAttempts} failed${exhausted ? ' (no attempts left)' : ' — will retry'}:`, err.message);
    if (!exhausted) return;
    const client = getSocialClient();
    if (!client) return;
    recordRecipientOutcome(client, job.data.recipientId, job.data.campaignId, { status: 'failed', error: err.message }).catch((e) => console.error('[lib/sms/smsQueue] recordRecipientOutcome (failed) failed:', e.message));
    if (isUnrecoverable) {
      addSuppression(client, job.data.tenantId, 'sms', job.data.phone, 'hard_bounce', { source: 'provider' }).catch((e) => console.error('[lib/sms/smsQueue] addSuppression failed:', e.message));
    }
  });

  console.log(`[lib/sms/smsQueue] BullMQ worker started (concurrency 5, ${SENDS_PER_MINUTE_PER_TENANT}/min/tenant pacing, exponential backoff, 4 attempts).`);
}

async function stop() {
  const CLOSE_TIMEOUT_MS = 3000;
  await Promise.all([
    worker ? withTimeout(worker.close(), CLOSE_TIMEOUT_MS, 'worker.close() timed out').catch((err) => console.warn(`[lib/sms/smsQueue] ${err.message}`)) : null,
    queue ? withTimeout(queue.close(), CLOSE_TIMEOUT_MS, 'queue.close() timed out').catch((err) => console.warn(`[lib/sms/smsQueue] ${err.message}`)) : null
  ]);
  worker = null;
  queue = null;
  if (connection) { connection.disconnect(); connection = null; }
}

module.exports = { start, stop, enqueueCampaign, cancelCampaign, STAGGER_MS };
