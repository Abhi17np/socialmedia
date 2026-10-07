/**
 * Shared helpers for reading a social_accounts row as something an
 * adapter can actually use: decrypted tokens, refreshed if the stored
 * access token is near/past expiry. Used by both routes/social.js
 * (publish-now / reply actions triggered from the UI) and
 * social/scheduler.js (the background publish poller) so token refresh
 * logic lives in exactly one place.
 */

const tokenCrypto = require('./crypto');
const ADAPTERS = require('./adapters');
const { getSocialClient } = require('./db');

const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry

/** Decrypts a raw social_accounts row into { ...row, accessToken, refreshToken }. */
function decryptAccount(row) {
  return {
    ...row,
    accessToken: tokenCrypto.decrypt(row.access_token),
    refreshToken: row.refresh_token ? tokenCrypto.decrypt(row.refresh_token) : null,
    externalAccountId: row.external_account_id
  };
}

/**
 * Loads a social_accounts row by id, decrypts it, and refreshes the
 * access token first if it's expired or about to be — persisting the new
 * token back (still encrypted) so the next call doesn't have to refresh
 * again. Returns null if the account doesn't exist.
 *
 * tenantId is required and filtered on directly (not just checked after
 * the fact) — without it, any authenticated user could pass another
 * tenant's account id and act on it. This is the one place in the old
 * admin-panel code that genuinely couldn't be ported as-is: that version
 * had no tenants, so there was nothing to scope by.
 */
async function getUsableAccount(tenantId, accountId) {
  const client = getSocialClient();
  if (!client) throw new Error('Database not configured.');

  const { data: row, error } = await client.from('social_accounts').select('*').eq('id', accountId).eq('tenant_id', tenantId).single();
  if (error || !row) return null;

  let account = decryptAccount(row);
  const adapter = ADAPTERS[account.platform];
  if (!adapter) throw new Error(`No adapter registered for platform "${account.platform}".`);

  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;
  const needsRefresh = expiresAt !== null && expiresAt - Date.now() < REFRESH_SKEW_MS;

  if (needsRefresh && account.refreshToken && typeof adapter.refreshAccessToken === 'function') {
    // `account` is passed too — Google's refresh only needs the refresh
    // token, but Meta's needs to know which Page to re-derive a token for
    // (see facebook.js/instagram.js's refreshAccessToken for why).
    const refreshed = await adapter.refreshAccessToken(account.refreshToken, account);
    account.accessToken = refreshed.accessToken;
    const update = { access_token: tokenCrypto.encrypt(refreshed.accessToken), expires_at: refreshed.expiresAt };
    // Google's refresh keeps the same refresh_token (only returns a new
    // access_token). Meta has no refresh_token at all — instead its
    // "refresh" re-exchanges the long-lived user token for a new one, so
    // refreshAccessToken() there returns a new refreshToken too, which
    // must be persisted or the next refresh uses a stale/expired one.
    if (refreshed.refreshToken) {
      account.refreshToken = refreshed.refreshToken;
      update.refresh_token = tokenCrypto.encrypt(refreshed.refreshToken);
    }
    await client.from('social_accounts').update(update).eq('id', accountId);
  }

  return { account, adapter };
}

module.exports = { decryptAccount, getUsableAccount };
