/**
 * Shared OAuth2 helper for the two Google-family adapters (youtube.js,
 * google-business.js) — both platforms live under the same Google Cloud
 * project, so they share one OAuth client (GOOGLE_OAUTH_CLIENT_ID/SECRET)
 * the same way this repo already prefers one config object per concern
 * over duplicating it per adapter. Not itself one of the "same interface"
 * platform adapters (see backend/adapters/_retention.js for the existing
 * precedent of a leading-underscore shared helper that isn't an adapter).
 */

const { OAuth2Client } = require('google-auth-library');

function redirectUriFor(platform) {
  const base = process.env.BACKEND_PUBLIC_URL || 'http://localhost:5000';
  return `${base}/api/social/callback/${platform}`;
}

function isConfigured() {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function getOAuthClient(platform) {
  if (!isConfigured()) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set in backend/.env.');
  }
  return new OAuth2Client(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUriFor(platform)
  );
}

function buildAuthUrl(platform, scopes, state) {
  const client = getOAuthClient(platform);
  return client.generateAuthUrl({
    access_type: 'offline',       // request a refresh_token
    prompt: 'consent',            // force a refresh_token even on repeat connects
    scope: scopes,
    state
  });
}

async function exchangeCode(platform, code) {
  const client = getOAuthClient(platform);
  const { tokens } = await client.getToken(code);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null
  };
}

/** Refreshes an access token using the stored (decrypted) refresh token. */
async function refreshAccessToken(platform, refreshToken) {
  const client = getOAuthClient(platform);
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  return {
    accessToken: credentials.access_token,
    expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null
  };
}

module.exports = { isConfigured, buildAuthUrl, exchangeCode, refreshAccessToken, redirectUriFor };
