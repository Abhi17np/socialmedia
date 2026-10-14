/**
 * Microsoft 365 (Outlook Mail + Calendar via Microsoft Graph) OAuth, for
 * the Sales Hub's email/calendar connection — see
 * SALES_HUB_IMPLEMENTATION.md's "Blocked: Email & Calendar": needs an
 * Entra ID (Azure AD) app registration with Mail.Send/Mail.Read/
 * Calendars.ReadWrite Graph permissions, which doesn't exist in this
 * environment (MS365_CLIENT_ID/SECRET/TENANT_ID are unset).
 *
 * No Microsoft SDK is a dependency of this repo, and the v2.0 endpoint
 * is plain OAuth2 over REST (same "fetch directly, no extra SDK" call
 * this repo already made for google-business.js) — so this talks to
 * login.microsoftonline.com and graph.microsoft.com directly.
 */

const { API_PREFIX } = require('../../lib/apiPrefix');

const PROVIDER = 'microsoft365';
const SCOPES = ['Mail.Send', 'Mail.Read', 'Calendars.ReadWrite', 'offline_access', 'User.Read'];

function isConfigured() {
  return !!(process.env.MS365_CLIENT_ID && process.env.MS365_CLIENT_SECRET && process.env.MS365_TENANT_ID);
}

function redirectUri() {
  const base = process.env.BACKEND_PUBLIC_URL || 'http://localhost:5001';
  return `${base}${API_PREFIX}/sales/email/callback/${PROVIDER}`;
}

function authorizeBase() {
  return `https://login.microsoftonline.com/${process.env.MS365_TENANT_ID}/oauth2/v2.0`;
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new Error('MS365_CLIENT_ID / MS365_CLIENT_SECRET / MS365_TENANT_ID are not set in backend/.env.');
  }
}

function buildAuthUrl(state) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: process.env.MS365_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state
  });
  return `${authorizeBase()}/authorize?${params.toString()}`;
}

/**
 * Exchanges an OAuth code for tokens and resolves the connected
 * mailbox's address via Microsoft Graph's /me. Like gmail.js's
 * exchangeCode, this is written against Microsoft's real, documented
 * v2.0 token + Graph APIs but is untestable end-to-end in this
 * environment — no MS365_CLIENT_ID/SECRET/TENANT_ID exist here, so
 * nothing calls this function unless a real code from Microsoft's
 * consent screen reaches it.
 */
async function exchangeCode(code) {
  assertConfigured();
  const tokenRes = await fetch(`${authorizeBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS365_CLIENT_ID,
      client_secret: process.env.MS365_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      scope: SCOPES.join(' ')
    })
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    throw new Error(`Microsoft token exchange failed (${tokenRes.status}): ${tokenBody.error_description || tokenBody.error || 'unknown error'}`);
  }

  const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` }
  });
  if (!meRes.ok) {
    throw new Error(`Microsoft Graph /me lookup failed (${meRes.status}) after an otherwise successful token exchange.`);
  }
  const me = await meRes.json();

  return {
    emailAddress: me.mail || me.userPrincipalName,
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token || null,
    expiresAt: tokenBody.expires_in ? new Date(Date.now() + tokenBody.expires_in * 1000).toISOString() : null,
    scopes: SCOPES
  };
}

module.exports = { PROVIDER, SCOPES, isConfigured, buildAuthUrl, exchangeCode };
