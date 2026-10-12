/**
 * WhatsApp broadcast send queue — same BullMQ/Redis shape as
 * social/queue.js's publish queue (one job per unit of work, deterministic
 * jobId, bounded retries with exponential backoff, outcome recorded only
 * in the worker's 'completed'/'failed' listeners, never inside the job
 * processor itself), applied here per campaign RECIPIENT instead of per
 * post TARGET ACCOUNT. Kept as a separate queue/worker (not reused from
 * queue.js) because the two have different concurrency needs — a
 * broadcast can be thousands of recipients, a scheduled post is a
 * handful of target accounts — and different job payloads.
 */

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const { getSocialClient } = require('./db');
const { getUsableAccount } = require('./accounts');
const { recordUsage } = require('../lib/entitlements');

const QUEUE_NAME = 'whatsapp-broadcast';
const ENQUEUE_TIMEOUT_MS = 5000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let connection = null;
let queue = null;
let worker = null;

let warnedUnreachable = false;
function warnUnreachableOnce(source) {
  if (warnedUnreachable) return;
  warnedUnreachable = true;
  console.warn(
    `[social/broadcastQueue] Redis not reachable at ${REDIS_URL} (via ${source}) — broadcast sending is disabled until it is. ` +
    'Install & start Redis (or point REDIS_URL at one), then restart the backend. Campaigns still save; they just won\'t send until Redis is up.'
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
    connection.on('ready', () => { warnedUnreachable = false; console.log(`[social/broadcastQueue] Connected to Redis at ${REDIS_URL}.`); });
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

/**
 * Enqueues one job per recipient row. jobId is deterministic
 * (`${campaignId}__${recipientId}`, no colons — same BullMQ reservation
 * queue.js's header explains) so re-calling this for a campaign that's
 * already partway queued (e.g. the reconciliation path in
 * routes/whatsapp.js retrying a 'queued but not yet processed' recipient)
 * is a safe no-op, not a duplicate send.
 */
async function enqueueCampaign(campaign, recipients, template, delayMs = 0) {
  const q = getQueue();
  for (const recipient of recipients) {
    await withTimeout(
      q.add(
        'send-template',
        {
          campaignId: campaign.id,
          tenantId: campaign.tenant_id,
          recipientId: recipient.id,
          phone: recipient.phone,
          accountId: campaign.social_account_id,
          templateName: template.name,
          templateLanguage: template.language,
          variableValues: campaign.variable_values || []
        },
        {
          jobId: `${campaign.id}__${recipient.id}`,
          delay: delayMs,
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

/** Cancels a still-pending campaign's not-yet-processed jobs (DELETE/cancel route). No-ops for jobs already running/finished. */
async function cancelCampaign(campaign, recipients) {
  const q = getQueue();
  for (const recipient of recipients) {
    const job = await q.getJob(`${campaign.id}__${recipient.id}`).catch(() => null);
    if (job) await job.remove().catch(() => {});
  }
}

async function processJob(job) {
  const { tenantId, accountId, phone, templateName, templateLanguage, variableValues } = job.data;
  const usable = await getUsableAccount(tenantId, accountId);
  if (!usable) throw new Error(`social_accounts row ${accountId} not found (disconnected?).`);
  const { account, adapter } = usable;
  if (typeof adapter.sendTemplate !== 'function') throw new Error(`${account.platform} adapter does not support sendTemplate().`);

  const result = await adapter.sendTemplate(account, phone, { name: templateName, language: templateLanguage }, variableValues || []);
  return result;
}

async function recordRecipientOutcome(client, recipientId, campaignId, patch) {
  const { error } = await client.from('whatsapp_campaign_recipients').update(patch).eq('id', recipientId);
  if (error) {
    console.error(`[social/broadcastQueue] Could not update recipient ${recipientId}:`, error.message);
    return;
  }
  await client.rpc('recompute_whatsapp_campaign_counts', { p_campaign_id: campaignId })
    .then(({ error: rpcError }) => { if (rpcError) console.error(`[social/broadcastQueue] recompute_whatsapp_campaign_counts failed for ${campaignId}:`, rpcError.message); });
}

function start() {
  if (worker) return;

  getQueue();

  worker = new Worker(QUEUE_NAME, processJob, { connection: getConnection(), concurrency: 10 });
  worker.on('error', () => warnUnreachableOnce('worker'));

  worker.on('active', (job) => {
    const client = getSocialClient();
    if (client) client.from('whatsapp_campaign_recipients').update({ status: 'queued', queued_at: new Date().toISOString() }).eq('id', job.data.recipientId).eq('status', 'pending').then(() => {}, () => {});
  });

  worker.on('completed', (job, returnValue) => {
    const client = getSocialClient();
    if (!client) return;
    recordRecipientOutcome(client, job.data.recipientId, job.data.campaignId, {
      status: 'sent',
      external_message_id: (returnValue && returnValue.externalId) || null,
      sent_at: new Date().toISOString()
    })
      .then(() => recordUsage(client, job.data.tenantId, 'whatsappBroadcastSendsPerMonth', 1))
      .catch(err => console.error('[social/broadcastQueue] recordRecipientOutcome (completed) failed:', err.message));
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts || 1;
    const exhausted = job.attemptsMade >= maxAttempts;
    console.error(`[social/broadcastQueue] Job ${job.id} attempt ${job.attemptsMade}/${maxAttempts} failed${exhausted ? ' (no attempts left)' : ' — will retry'}:`, err.message);
    if (!exhausted) return;
    const client = getSocialClient();
    if (!client) return;
    recordRecipientOutcome(client, job.data.recipientId, job.data.campaignId, {
      status: 'failed',
      error: err.message,
      failed_at: new Date().toISOString()
    }).catch(e => console.error('[social/broadcastQueue] recordRecipientOutcome (failed) failed:', e.message));
  });

  console.log('[social/broadcastQueue] BullMQ worker started (concurrency 10, exponential backoff, 4 attempts).');
}

async function stop() {
  const CLOSE_TIMEOUT_MS = 3000;
  await Promise.all([
    worker ? withTimeout(worker.close(), CLOSE_TIMEOUT_MS, 'worker.close() timed out')
      .catch(err => console.warn(`[social/broadcastQueue] ${err.message} — Redis was likely never reachable.`)) : null,
    queue ? withTimeout(queue.close(), CLOSE_TIMEOUT_MS, 'queue.close() timed out')
      .catch(err => console.warn(`[social/broadcastQueue] ${err.message} — Redis was likely never reachable.`)) : null
  ]);
  worker = null;
  queue = null;
  if (connection) { connection.disconnect(); connection = null; }
}

module.exports = { start, stop, enqueueCampaign, cancelCampaign };
