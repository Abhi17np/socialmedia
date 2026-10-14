/**
 * Gmail + Google Calendar OAuth, for the Sales Hub's email/calendar
 * connection (not to be confused with social/adapters/_google-oauth.js,
 * which is Google Business Profile/YouTube under a *different* GCP OAuth
 * client — see SALES_HUB_IMPLEMENTATION.md's "Blocked: Email & Calendar":
 * Gmail/Calendar scopes need their own consent screen, so this uses its
 * own env vars (GMAIL_OAUTH_CLIENT_ID/SECRET) rather than reusing
 * GOOGLE_OAUTH_CLIENT_ID/SECRET.
 *
 * Uses google-auth-library (already a dependency for the social adapter
 * above) purely as a thin OAuth2 client — no Gmail/Calendar API calls
 * happen here yet; see index.js's header for what is and isn't wired up.
 */

const { OAuth2Client } = require('google-auth-library');
const { API_PREFIX } = require('../../lib/apiPrefix');

const PROVIDER = 'gmail';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email'
];

function isConfigured() {
  return !!(process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_CLIENT_SECRET);
}

function redirectUri() {
  const base = process.env.BACKEND_PUBLIC_URL || 'http://localhost:5001';
  return `${base}${API_PREFIX}/sales/email/callback/${PROVIDER}`;
}

function getClient() {
  if (!isConfigured()) {
    throw new Error('GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET are not set in backend/.env.');
  }
  return new OAuth2Client(process.env.GMAIL_OAUTH_CLIENT_ID, process.env.GMAIL_OAUTH_CLIENT_SECRET, redirectUri());
}

function buildAuthUrl(state) {
  return getClient().generateAuthUrl({
    access_type: 'offline', // request a refresh_token
    prompt: 'consent',      // force a refresh_token even on repeat connects
    scope: SCOPES,
    state
  });
}

/**
 * Exchanges an OAuth code for tokens and resolves the connected mailbox's
 * address via Google's userinfo endpoint. This is the one call in this
 * file that genuinely requires a real GMAIL_OAUTH_CLIENT_ID/SECRET and a
 * real `code` from Google's consent screen to succeed — untestable in
 * this environment (no credentials exist here), but written against
 * Google's real, documented OAuth2 + userinfo APIs, not simulated.
 */
async function exchangeCode(code) {
  const client = getClient();
  const { tokens } = await client.getToken(code);

  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });
  if (!userInfoRes.ok) {
    throw new Error(`Google userinfo lookup failed (${userInfoRes.status}) after an otherwise successful token exchange.`);
  }
  const userInfo = await userInfoRes.json();

  return {
    emailAddress: userInfo.email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    scopes: SCOPES
  };
}

module.exports = { PROVIDER, SCOPES, isConfigured, buildAuthUrl, exchangeCode };
