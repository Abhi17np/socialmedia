/**
 * Password-reset / email-verification tokens (migrations/010). The raw
 * token goes out in the email link; only its SHA-256 hash is stored, so
 * a leaked auth_tokens row (DB dump, backup, log) can't be replayed —
 * same reasoning as never storing a password in plaintext, just applied
 * to a token instead of a password. Tokens are single-use (used_at) and
 * short-lived (callers pass the TTL).
 */
const crypto = require('crypto');

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createToken(client, { userId, purpose, ttlMs }) {
  const rawToken = generateRawToken();
  const { error } = await client.from('auth_tokens').insert({
    user_id: userId,
    purpose,
    token_hash: hashToken(rawToken),
    expires_at: new Date(Date.now() + ttlMs).toISOString()
  });
  if (error) throw error;
  return rawToken;
}

// Consumes the token atomically-enough for this use case: fetched, then
// marked used in the same call site right after — a race between two
// simultaneous uses of the same token is an accepted, low-value edge
// case (whoever's request reads it first before the other's UPDATE still
// changes the password/verifies the email; replaying it a third time is
// what used_at actually prevents).
async function consumeToken(client, { rawToken, purpose }) {
  const tokenHash = hashToken(rawToken);
  const { data: row } = await client.from('auth_tokens').select('id, user_id, expires_at, used_at')
    .eq('token_hash', tokenHash).eq('purpose', purpose).maybeSingle();
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) return null;
  await client.from('auth_tokens').update({ used_at: new Date().toISOString() }).eq('id', row.id);
  return { userId: row.user_id };
}

module.exports = { createToken, consumeToken };
