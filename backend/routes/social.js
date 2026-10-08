/**
 * Social Hub routes, ported from admin-panel's routes/social.js with one
 * structural change throughout: every query is tenant-scoped via
 * lib/query.js's scoped() helper, and the old `brand` query param (a
 * free-text label anyone could pass) is gone — replaced by req.tenantId,
 * which only ever comes from a verified JWT (see middleware/tenant.js).
 *
 * Same public/protected split as the original: publicRouter is the OAuth
 * callback + WhatsApp webhook (unauthenticated by necessity — see below),
 * protectedRouter is everything else. server.js mounts requireAuth
 * between them, same position admin-panel's authenticateToken had.
 */

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const ADAPTERS = require('../social/adapters');
const tokenCrypto = require('../social/crypto');
const { getSocialClient } = require('../social/db');
const { getUsableAccount } = require('../social/accounts');
const { resolveContact } = require('../lib/contacts');
const { scoped } = require('../lib/query');
const { assertWithinLimit, recordUsage } = require('../lib/entitlements');
const { validate } = require('../middleware/validate');
const { createPostSchema } = require('../lib/schemas');
const socialQueue = require('../social/queue');

const STATE_MAX_AGE_MS = 15 * 60 * 1000; // OAuth round trip has 15 min to complete

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

function signState(payload) {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

// This runs against whatever `state` an unauthenticated request throws at
// the public callback route below, so nothing here may throw — a
// malformed/adversarial state (wrong-length signature, garbage base64,
// non-JSON payload) must fail closed (return null → 400), not crash the
// request handler.
function verifyState(state) {
  try {
    const [b64, sig] = String(state || '').split('.');
    if (!b64 || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(b64).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!payload || typeof payload.ts !== 'number' || Date.now() - payload.ts > STATE_MAX_AGE_MS) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

// -------------------------------------------------------------
// Public router — OAuth callback + WhatsApp webhook only
// -------------------------------------------------------------
const publicRouter = express.Router();

publicRouter.get('/social/callback/:platform', async (req, res) => {
  const { platform } = req.params;
  const { code, error: oauthError, state } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5174';

  const adapter = ADAPTERS[platform];
  if (!adapter) return res.status(404).send(`No adapter registered for platform "${platform}".`);

  if (oauthError) {
    return res.redirect(`${frontendUrl}/?social_error=${encodeURIComponent(oauthError)}`);
  }

  // tenantId travels through the signed state, minted by the
  // authenticated GET /social/connect/:platform below — this callback
  // itself can't carry a Bearer header (the browser is redirected here
  // directly by the OAuth provider), so the signed state is what proves
  // which tenant initiated this connection.
  const statePayload = verifyState(state);
  if (!statePayload || statePayload.platform !== platform) {
    return res.status(400).send('Invalid or expired OAuth state — restart the connect flow from Connect Accounts.');
  }

  try {
    const client = getSocialClient();
    if (!client) return res.status(503).send('Database not configured.');

    // Re-checked here, not just at /social/connect below, in case two
    // connect flows for the same tenant were started back to back — the
    // account doesn't exist yet at /social/connect time, so that earlier
    // check can't see it.
    await assertWithinLimit(client, statePayload.tenantId, 'socialAccounts');

    const result = await adapter.connect.exchangeCode(code);

    const { error: insertError } = await client.from('social_accounts').insert({
      tenant_id: statePayload.tenantId,
      platform,
      account_label: result.accountLabel,
      external_account_id: result.externalAccountId,
      access_token: tokenCrypto.encrypt(result.accessToken),
      refresh_token: result.refreshToken ? tokenCrypto.encrypt(result.refreshToken) : null,
      expires_at: result.expiresAt,
      status: 'active'
    });
    if (insertError) throw insertError;

    return res.redirect(`${frontendUrl}/?social_connected=${encodeURIComponent(platform)}`);
  } catch (err) {
    console.error(`[social] OAuth callback failed for ${platform}:`, err.message);
    return res.redirect(`${frontendUrl}/?social_error=${encodeURIComponent(err.message)}`);
  }
});

// -------------------------------------------------------------
// WhatsApp inbound webhook — Meta pushes messages here in real time.
// Public like the OAuth callback above: Meta calls this directly, no
// Bearer token, so the GET verification handshake + POST payload
// signature check are what stand in for auth here.
// -------------------------------------------------------------

publicRouter.get('/social/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && token === expected) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

function verifyMetaWebhookSignature(req) {
  const signature = req.get('x-hub-signature-256');
  if (!signature || !process.env.META_APP_SECRET || !req.rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(req.rawBody).digest('hex')}`;
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
}

publicRouter.post('/social/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200); // ack first, process after — Meta retries aggressively on non-2xx

  if (!verifyMetaWebhookSignature(req)) {
    console.error('[social] WhatsApp webhook payload failed signature verification — dropped.');
    return;
  }

  const client = getSocialClient();
  if (!client) return;

  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const phoneNumberId = value.metadata && value.metadata.phone_number_id;
        const messages = value.messages || [];
        if (!phoneNumberId || messages.length === 0) continue; // also covers status-update payloads

        // Unscoped by tenant_id here deliberately — this is the one
        // lookup in the whole app that has to find the tenant, not
        // start from one: Meta's payload carries no tenant context, only
        // the phone_number_id, which is globally unique across every
        // tenant's connected WhatsApp numbers.
        const { data: account } = await client.from('social_accounts')
          .select('id, tenant_id')
          .eq('platform', 'whatsapp')
          .eq('external_account_id', phoneNumberId)
          .eq('status', 'active')
          .maybeSingle();
        if (!account) {
          console.error(`[social] WhatsApp webhook payload for phone_number_id ${phoneNumberId} matched no active connected account — dropped.`);
          continue;
        }

        const nameByWaId = {};
        for (const c of value.contacts || []) nameByWaId[c.wa_id] = c.profile && c.profile.name;

        const rows = [];
        for (const msg of messages) {
          // The selling feature, live: this is the exact moment a
          // WhatsApp message resolves to a tenant-scoped contact record
          // instead of a bare phone number — see lib/contacts.js.
          const contactId = await resolveContact(client, account.tenant_id, 'whatsapp', msg.from, nameByWaId[msg.from]).catch(err => {
            console.error('[social] resolveContact failed for WhatsApp webhook message:', err.message);
            return null;
          });
          rows.push({
            tenant_id: account.tenant_id,
            social_account_id: account.id,
            contact_id: contactId,
            platform: 'whatsapp',
            external_thread_id: msg.from,
            external_message_id: msg.id,
            sender: nameByWaId[msg.from] || msg.from,
            message: (msg.text && msg.text.body) || `[${msg.type}]`,
            direction: 'inbound',
            received_at: new Date(Number(msg.timestamp) * 1000).toISOString()
          });
        }

        const { error } = await client.from('inbox_messages').upsert(rows, { onConflict: 'platform,external_message_id', ignoreDuplicates: true });
        if (error) console.error('[social] Could not store inbound WhatsApp message(s):', error.message);

        // Usage metering (migrations/004_billing.sql) — counts inbound
        // WhatsApp messages per tenant per month.
        const period = new Date().toISOString().slice(0, 8) + '01';
        await client.rpc('increment_usage', { p_tenant_id: account.tenant_id, p_period: period, p_column: 'whatsapp_messages', p_amount: rows.length })
          .catch(err => console.error('[social] increment_usage failed for WhatsApp webhook:', err.message));
      }
    }
  } catch (err) {
    console.error('[social] WhatsApp webhook processing failed:', err.message);
  }
});

// -------------------------------------------------------------
// Protected router — everything else, mounted after requireAuth
// -------------------------------------------------------------
const protectedRouter = express.Router();

protectedRouter.get('/social/accounts', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'social_accounts')
    .select('id, platform, account_label, connected_at, expires_at, status')
    .order('connected_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ accounts: data });
});

protectedRouter.get('/social/accounts/:id/posts', async (req, res) => {
  try {
    const usable = await getUsableAccount(req.tenantId, req.params.id);
    if (!usable) return res.status(404).json({ error: 'Connected account not found.' });
    const { account, adapter } = usable;
    if (typeof adapter.fetchPosts !== 'function') {
      return res.status(400).json({ error: `${account.platform} does not support per-post insights yet.` });
    }
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    const posts = await adapter.fetchPosts(account, limit);
    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

protectedRouter.get('/social/connect/:platform', async (req, res) => {
  const { platform } = req.params;
  const adapter = ADAPTERS[platform];
  if (!adapter) return res.status(404).json({ error: `No adapter registered for platform "${platform}" yet.` });
  if (!adapter.isConfigured()) {
    return res.status(400).json({ error: `${platform} OAuth is not configured — set its client id/secret in backend/.env.` });
  }

  const client = requireSocialClient(res);
  if (!client) return;
  try {
    await assertWithinLimit(client, req.tenantId, 'socialAccounts');
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }

  const state = signState({ platform, tenantId: req.tenantId, ts: Date.now() });
  res.json({ url: adapter.connect.getAuthUrl(state) });
});

protectedRouter.get('/social/whatsapp/embedded-signup-config', (req, res) => {
  if (!process.env.META_APP_ID || !process.env.WHATSAPP_SIGNUP_CONFIG_ID) {
    return res.status(400).json({ error: 'META_APP_ID / WHATSAPP_SIGNUP_CONFIG_ID are not set in backend/.env.' });
  }
  res.json({ appId: process.env.META_APP_ID, configId: process.env.WHATSAPP_SIGNUP_CONFIG_ID });
});

protectedRouter.post('/social/whatsapp/embedded-signup', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { code, wabaId, phoneNumberId } = req.body || {};
  if (!code || !wabaId) return res.status(400).json({ error: 'code and wabaId are required.' });

  try {
    await assertWithinLimit(client, req.tenantId, 'socialAccounts');
    const result = await ADAPTERS.whatsapp.completeEmbeddedSignup({ code, wabaId, phoneNumberId });
    const { error: insertError } = await client.from('social_accounts').insert({
      tenant_id: req.tenantId,
      platform: 'whatsapp',
      account_label: result.accountLabel,
      external_account_id: result.externalAccountId,
      access_token: tokenCrypto.encrypt(result.accessToken),
      refresh_token: result.refreshToken ? tokenCrypto.encrypt(result.refreshToken) : null,
      expires_at: result.expiresAt,
      status: 'active'
    });
    if (insertError) throw insertError;
    res.json({ success: true, accountLabel: result.accountLabel });
  } catch (err) {
    console.error('[social] WhatsApp Embedded Signup failed:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
});

protectedRouter.post('/social/accounts/:id/disconnect', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'social_accounts').update({ status: 'revoked' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/|^video\//.test(file.mimetype)) return cb(new Error('Only image or video files are accepted.'));
    cb(null, true);
  }
});

const MEDIA_BUCKET = process.env.SUPABASE_SOCIAL_MEDIA_BUCKET || 'social-media';
let mediaBucketReady = false;

async function ensureMediaBucket(client) {
  if (mediaBucketReady) return;
  const { data: buckets, error } = await client.storage.listBuckets();
  if (!error && buckets && buckets.some(b => b.name === MEDIA_BUCKET)) {
    mediaBucketReady = true;
    return;
  }
  await client.storage.createBucket(MEDIA_BUCKET, { public: true }).catch(() => {});
  mediaBucketReady = true;
}

protectedRouter.post('/social/media/upload', (req, res) => {
  mediaUpload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    const client = requireSocialClient(res);
    if (!client) return;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded — attach it under the "file" field.' });

    try {
      await ensureMediaBucket(client);
      // Tenant id in the storage path, not a caller-supplied brand string
      // — this is also what stops one tenant's uploads from colliding
      // with or overwriting another's.
      const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
      const path = `${req.tenantId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;

      const { error: storageError } = await client.storage.from(MEDIA_BUCKET).upload(path, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });
      if (storageError) throw storageError;

      const { data: publicUrlData } = client.storage.from(MEDIA_BUCKET).getPublicUrl(path);
      res.status(201).json({
        url: publicUrlData.publicUrl,
        mediaType: req.file.mimetype.startsWith('video/') ? 'video' : 'image',
        mimeType: req.file.mimetype
      });
    } catch (err) {
      console.error('[social] Media upload failed:', err.message);
      res.status(500).json({ error: `Could not upload media: ${err.message}` });
    }
  });
});

protectedRouter.post('/social/posts', validate(createPostSchema), async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { content, mediaUrls, targetPlatforms, targetAccountIds, scheduledAt, idempotencyKey } = req.body;

  try {
    await assertWithinLimit(client, req.tenantId, 'postsPerMonth');
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }

  const { data, error } = await client.from('scheduled_posts').insert({
    tenant_id: req.tenantId,
    content,
    media_urls: mediaUrls,
    target_platforms: targetPlatforms,
    target_account_ids: targetAccountIds,
    scheduled_at: scheduledAt,
    idempotency_key: idempotencyKey || null,
    status: 'pending'
  }).select().single();

  // A retried request with the same idempotencyKey hits
  // idx_scheduled_posts_tenant_idempotency (migrations/005) and is
  // refused here as a conflict, not silently scheduled twice — the
  // caller's retry logic treats 409 as "already done, move on."
  if (error && error.code === '23505') {
    const { data: existing } = await scoped(client, req.tenantId, 'scheduled_posts').select('*').eq('idempotency_key', idempotencyKey).maybeSingle();
    return res.status(409).json({ error: 'A post with this idempotency key was already created.', post: existing || null });
  }

  if (error) return res.status(500).json({ error: error.message });

  // Metered on creation, not on actual publish — a scheduled post counts
  // against the quota the moment it's created, same as every competitor's
  // "scheduled posts" limit. Not refunded on cancel (see DELETE below):
  // the quota is "posts you scheduled this month," not "posts currently live."
  await recordUsage(client, req.tenantId, 'postsPerMonth').catch(err =>
    console.error(`[social] Could not record usage for post ${data.id}:`, err.message));

  try {
    await socialQueue.enqueuePost(data);
  } catch (err) {
    console.error(`[social] Could not enqueue post ${data.id} immediately (will be picked up by the reconciliation sweep):`, err.message);
  }

  res.status(201).json({ post: data });
});

protectedRouter.get('/social/posts', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  let query = scoped(client, req.tenantId, 'scheduled_posts').select('*').order('scheduled_at', { ascending: false });
  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ posts: data });
});

protectedRouter.delete('/social/posts/:id', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { data: existing, error: fetchError } = await scoped(client, req.tenantId, 'scheduled_posts').select('*').eq('id', req.params.id).single();
  if (fetchError || !existing) return res.status(404).json({ error: 'Post not found.' });
  if (existing.status !== 'pending') return res.status(400).json({ error: `Cannot cancel a post with status "${existing.status}".` });

  await socialQueue.cancelPost(existing).catch(err => console.error(`[social] Could not cancel queued jobs for post ${existing.id}:`, err.message));

  const { error } = await scoped(client, req.tenantId, 'scheduled_posts').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// page/pageSize instead of a hardcoded limit(200) — that cap silently
// hid anything past the 200th row once a tenant had real volume, with no
// way for the frontend to even know more existed.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function pageParams(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE));
  return { page, pageSize, from: (page - 1) * pageSize, to: (page - 1) * pageSize + pageSize - 1 };
}

protectedRouter.get('/social/mentions', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  try {
    const { page, pageSize, from, to } = pageParams(req);
    let query = scoped(client, req.tenantId, 'mentions').select('*', { count: 'exact' }).order('captured_at', { ascending: false }).range(from, to);
    if (req.query.platform) query = query.eq('platform', req.query.platform);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ mentions: data, page, pageSize, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

protectedRouter.get('/social/inbox', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  try {
    const { page, pageSize, from, to } = pageParams(req);
    let query = scoped(client, req.tenantId, 'inbox_messages').select('*', { count: 'exact' }).order('received_at', { ascending: false }).range(from, to);
    if (req.query.platform) query = query.eq('platform', req.query.platform);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ messages: data, page, pageSize, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The payoff of the unified contact spine: every message/mention from
// the same contact_id, across every platform, in one request — this is
// what the Inbox UI's "customer timeline" view reads from.
protectedRouter.get('/social/contacts/:id/timeline', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  try {
    const { data: contact, error: contactError } = await scoped(client, req.tenantId, 'contacts').select('*').eq('id', req.params.id).single();
    if (contactError || !contact) return res.status(404).json({ error: 'Contact not found.' });

    const [{ data: messages, error: msgErr }, { data: mentions, error: mentErr }] = await Promise.all([
      scoped(client, req.tenantId, 'inbox_messages').select('*').eq('contact_id', req.params.id).order('received_at', { ascending: true }),
      scoped(client, req.tenantId, 'mentions').select('*').eq('contact_id', req.params.id).order('captured_at', { ascending: true })
    ]);
    if (msgErr) throw msgErr;
    if (mentErr) throw mentErr;

    const timeline = [
      ...(messages || []).map(m => ({ kind: 'message', platform: m.platform, at: m.received_at, text: m.message, direction: m.direction })),
      ...(mentions || []).map(m => ({ kind: 'mention', platform: m.platform, at: m.captured_at, text: m.text, url: m.url }))
    ].sort((a, b) => new Date(a.at) - new Date(b.at));

    res.json({ contact, timeline });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

protectedRouter.post('/social/inbox/:id/reply', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required.' });

  const { data: thread, error: fetchError } = await scoped(client, req.tenantId, 'inbox_messages').select('*').eq('id', req.params.id).single();
  if (fetchError || !thread) return res.status(404).json({ error: 'Message not found.' });

  try {
    const usable = await getUsableAccount(req.tenantId, thread.social_account_id);
    if (!usable) return res.status(404).json({ error: 'Connected account for this message no longer exists.' });
    const { account, adapter } = usable;
    if (typeof adapter.sendReply !== 'function') {
      return res.status(400).json({ error: `${account.platform} adapter does not support sending replies.` });
    }

    await adapter.sendReply(account, thread.external_thread_id, message);
    await client.from('inbox_messages').update({ status: 'replied' }).eq('id', req.params.id);
    await client.from('inbox_messages').insert({
      tenant_id: req.tenantId,
      social_account_id: thread.social_account_id,
      contact_id: thread.contact_id,
      platform: thread.platform,
      external_thread_id: thread.external_thread_id,
      external_message_id: `outbound-${Date.now()}`,
      sender: 'team',
      message,
      direction: 'outbound',
      status: 'read'
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

protectedRouter.get('/social/analytics', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  try {
    const { platform, metric, startDate, endDate, accountId } = req.query;
    let query = scoped(client, req.tenantId, 'analytics_snapshots').select('*').order('captured_date', { ascending: true });
    if (platform) query = query.eq('platform', platform);
    if (metric) query = query.eq('metric', metric);
    if (accountId) query = query.eq('social_account_id', accountId);
    if (startDate) query = query.gte('captured_date', startDate);
    if (endDate) query = query.lte('captured_date', endDate);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ snapshots: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const FOLLOWER_METRIC = { youtube: 'followers', facebook: 'fans', instagram: 'follower_count' };
const REACH_METRIC = { facebook: 'impressions', instagram: 'reach' };
const ENGAGEMENT_METRIC = { facebook: 'engaged_users' };
const SUMMARY_WINDOW_DAYS = 30;

async function latestMetricValue(client, accountId, metric) {
  if (!metric) return null;
  const { data } = await client.from('analytics_snapshots').select('value').eq('social_account_id', accountId).eq('metric', metric)
    .order('captured_date', { ascending: false }).limit(1).maybeSingle();
  return data ? Number(data.value) : null;
}

async function metricValueOnOrBefore(client, accountId, metric, date) {
  if (!metric) return null;
  const { data } = await client.from('analytics_snapshots').select('value').eq('social_account_id', accountId).eq('metric', metric)
    .lte('captured_date', date).order('captured_date', { ascending: false }).limit(1).maybeSingle();
  return data ? Number(data.value) : null;
}

async function postCountForAccount(client, tenantId, account, windowStart) {
  const adapter = ADAPTERS[account.platform];
  if (adapter && typeof adapter.fetchPostCount === 'function') {
    try {
      const usable = await getUsableAccount(tenantId, account.id);
      if (usable) return await adapter.fetchPostCount(usable.account, windowStart.toISOString());
    } catch (err) {
      console.error(`[social] Live fetchPostCount failed for ${account.platform} account ${account.id}, falling back to scheduled_posts count:`, err.message);
    }
  }

  const { count } = await scoped(client, tenantId, 'scheduled_posts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'published')
    .gte('scheduled_at', windowStart.toISOString())
    .contains('target_account_ids', [account.id]);
  return count || 0;
}

protectedRouter.get('/social/analytics/summary', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    const { data: accounts, error: accountsError } = await scoped(client, req.tenantId, 'social_accounts').select('id, platform, account_label').eq('status', 'active');
    if (accountsError) throw accountsError;

    const windowStart = new Date(Date.now() - SUMMARY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const windowStartDate = windowStart.toISOString().slice(0, 10);

    const summary = await Promise.all((accounts || []).map(async (a) => {
      const followerMetric = FOLLOWER_METRIC[a.platform];
      const reachMetric = REACH_METRIC[a.platform];
      const engagementMetric = ENGAGEMENT_METRIC[a.platform];

      const [followers, followersBefore, reach, engagement, posts] = await Promise.all([
        latestMetricValue(client, a.id, followerMetric),
        metricValueOnOrBefore(client, a.id, followerMetric, windowStartDate),
        latestMetricValue(client, a.id, reachMetric),
        latestMetricValue(client, a.id, engagementMetric),
        postCountForAccount(client, req.tenantId, a, windowStart)
      ]);

      return {
        accountId: a.id,
        platform: a.platform,
        accountLabel: a.account_label,
        followers,
        newFollowers: (followers !== null && followersBefore !== null) ? followers - followersBefore : null,
        posts,
        reach,
        engagement
      };
    }));

    res.json({ summary, windowDays: SUMMARY_WINDOW_DAYS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const INTERACTION_TABLES = { mention: 'mentions', message: 'inbox_messages' };

function normalizeInteraction(source, row) {
  return {
    id: row.id,
    source,
    platform: row.platform,
    contactId: row.contact_id || null,
    accountLabel: row.social_accounts ? row.social_accounts.account_label : null,
    author: source === 'mention' ? row.author : row.sender,
    text: source === 'mention' ? row.text : row.message,
    url: row.url || null,
    date: source === 'mention' ? row.captured_at : row.received_at,
    interactionStatus: row.interaction_status,
    priority: row.priority,
    assignedTo: row.assigned_to
  };
}

protectedRouter.get('/social/interactions', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    const { platform, priority, status, assignedTo, type } = req.query;

    async function queryTable(table, source) {
      if (type && type !== source) return [];
      let query = scoped(client, req.tenantId, table).select('*, social_accounts(account_label)');
      if (platform) query = query.eq('platform', platform);
      if (priority) query = query.eq('priority', priority);
      if (status) query = query.eq('interaction_status', status);
      if (assignedTo) query = query.eq('assigned_to', assignedTo);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(row => normalizeInteraction(source, row));
    }

    const [mentions, messages] = await Promise.all([
      queryTable('mentions', 'mention'),
      queryTable('inbox_messages', 'message')
    ]);

    const interactions = [...mentions, ...messages].sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ interactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

protectedRouter.patch('/social/interactions/:source/:id', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const table = INTERACTION_TABLES[req.params.source];
  if (!table) return res.status(404).json({ error: `Unknown interaction source "${req.params.source}".` });

  const { interactionStatus, priority, assignedTo } = req.body;
  const update = {};
  if (interactionStatus !== undefined) update.interaction_status = interactionStatus;
  if (priority !== undefined) update.priority = priority;
  if (assignedTo !== undefined) update.assigned_to = assignedTo || null;
  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update — pass interactionStatus, priority and/or assignedTo.' });

  const { data, error } = await scoped(client, req.tenantId, table).update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Interaction not found.' });
  res.json({ interaction: normalizeInteraction(req.params.source, data) });
});

// Assignable teammates for the Inbox's assignee dropdown — this tenant's
// own users table now, not a separate roster or a flat JSON file.
protectedRouter.get('/social/team', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'users').select('id, email, role');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: data });
});

module.exports = { publicRouter, protectedRouter };
