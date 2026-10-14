/**
 * Sales Hub email/calendar connections (Gmail, Microsoft 365) — scaffolding
 * only, per SALES_HUB_IMPLEMENTATION.md's "Blocked: Email & Calendar": no
 * real OAuth credentials exist in this environment, so GMAIL_OAUTH_CLIENT_ID/
 * SECRET and MS365_CLIENT_ID/SECRET/TENANT_ID are unset and
 * providers/*.isConfigured() returns false for both — /connect then
 * refuses with a clear "not configured" error instead of ever redirecting
 * to a fake consent screen, and nothing is simulated: no connection row is
 * written, no "connected" state shown, no email sent or calendar read,
 * until a real provider token exchange actually succeeds. Same
 * public/protected router split and signed-state CSRF protection as
 * routes/social.js's OAuth callback, for the same reason: the provider
 * redirects the browser straight to the callback with no Bearer header
 * available, so the signed state is what proves which tenant+user
 * started this connection.
 *
 * What's deliberately NOT here yet, because it needs a working
 * connection to test against: actually sending a sequence email through
 * a connected account, inbox/reply sync, or calendar event creation.
 * Task-based sequence steps are unaffected — see lib/automation.js.
 */

const express = require('express');
const crypto = require('crypto');
const PROVIDERS = require('../email/providers');
const tokenCrypto = require('../social/crypto');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { requireHub } = require('../middleware/hubs');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');

const STATE_MAX_AGE_MS = 15 * 60 * 1000;

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

// Mirrors routes/social.js's verifyState — see that file's comment on
// why this must fail closed on anything malformed rather than throw,
// since it runs against whatever `state` an unauthenticated request
// throws at the public callback below.
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
// Public router — OAuth callback only (the browser lands here directly
// from Google/Microsoft's consent screen, with no Bearer token).
// -------------------------------------------------------------
const publicRouter = express.Router();

publicRouter.get('/sales/email/callback/:provider', async (req, res) => {
  const { provider } = req.params;
  const { code, error: oauthError, state } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5174';

  const impl = PROVIDERS[provider];
  if (!impl) return res.status(404).send(`No email provider registered for "${provider}".`);

  if (oauthError) {
    return res.redirect(`${frontendUrl}/sales?tab=settings&email_error=${encodeURIComponent(oauthError)}`);
  }

  const statePayload = verifyState(state);
  if (!statePayload || statePayload.provider !== provider) {
    return res.status(400).send('Invalid or expired OAuth state — restart the connect flow from Sales Hub Settings.');
  }

  try {
    const client = getSocialClient();
    if (!client) return res.status(503).send('Database not configured.');

    const result = await impl.exchangeCode(code);

    const { error: upsertError } = await client.from('email_connections').upsert({
      tenant_id: statePayload.tenantId,
      user_id: statePayload.userId,
      provider,
      email_address: result.emailAddress,
      access_token: tokenCrypto.encrypt(result.accessToken),
      refresh_token: result.refreshToken ? tokenCrypto.encrypt(result.refreshToken) : null,
      token_expires_at: result.expiresAt,
      scopes: result.scopes,
      status: 'active',
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'tenant_id,user_id,provider' });
    if (upsertError) throw upsertError;

    await recordAudit(client, {
      tenantId: statePayload.tenantId, actorUserId: statePayload.userId,
      action: 'sales.email_connected', targetType: 'email_connection', targetId: null,
      metadata: { provider, emailAddress: result.emailAddress }
    });

    return res.redirect(`${frontendUrl}/sales?tab=settings&email_connected=${encodeURIComponent(provider)}`);
  } catch (err) {
    console.error(`[sales/email] OAuth callback failed for ${provider}:`, err.message);
    return res.redirect(`${frontendUrl}/sales?tab=settings&email_error=${encodeURIComponent(err.message)}`);
  }
});

// -------------------------------------------------------------
// Protected router — status/connect/disconnect, scoped to the signed-in
// user (this is "my inbox", not a shared tenant resource).
// -------------------------------------------------------------
const router = express.Router();

router.get('/sales/email/status', requireHub('sales'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { data: connections, error } = await scoped(client, req.tenantId, 'email_connections')
    .select('provider, email_address, status, connected_at').eq('user_id', req.userId);
  if (error) throw error;
  const connectionByProvider = new Map((connections || []).map((c) => [c.provider, c]));

  res.json({
    providers: Object.keys(PROVIDERS).map((key) => {
      const impl = PROVIDERS[key];
      const connection = connectionByProvider.get(key);
      return {
        provider: key,
        configured: impl.isConfigured(),
        connected: !!connection && connection.status === 'active',
        emailAddress: connection?.email_address || null,
        connectedAt: connection?.connected_at || null
      };
    })
  });
}));

router.get('/sales/email/connect/:provider', requireHub('sales'), requireRole('member'), asyncHandler(async (req, res) => {
  const { provider } = req.params;
  const impl = PROVIDERS[provider];
  if (!impl) return res.status(404).json({ error: `No email provider registered for "${provider}".` });
  if (!impl.isConfigured()) {
    return res.status(400).json({
      error: `${provider} is not configured yet — see SALES_HUB_IMPLEMENTATION.md's "Blocked: Email & Calendar" for the environment variables an administrator needs to set.`,
      code: 'PROVIDER_NOT_CONFIGURED'
    });
  }

  const state = signState({ provider, tenantId: req.tenantId, userId: req.userId, ts: Date.now() });
  res.json({ url: impl.buildAuthUrl(state) });
}));

router.post('/sales/email/:provider/disconnect', requireHub('sales'), requireRole('member'), asyncHandler(async (req, res) => {
  const { provider } = req.params;
  const client = requireSocialClient(res);
  if (!client) return;

  const { error } = await scoped(client, req.tenantId, 'email_connections')
    .delete().eq('user_id', req.userId).eq('provider', provider);
  if (error) throw error;

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'sales.email_disconnected', targetType: 'email_connection', targetId: null, metadata: { provider } });
  res.json({ success: true });
}));

module.exports = { publicRouter, protectedRouter: router };
