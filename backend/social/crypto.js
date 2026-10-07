/**
 * Encrypt/decrypt helpers for OAuth tokens at rest (social_accounts.access_token
 * / refresh_token). These are equivalent in sensitivity to the Supabase
 * service keys this repo already handles carefully via .env + dbConfig —
 * so unlike a Supabase URL/key (which this app is fine echoing back to its
 * own Settings panel), a token never gets written to social_accounts as
 * plaintext, no exceptions, no "mock mode" fallback.
 *
 * AES-256-GCM, key from SOCIAL_TOKEN_ENCRYPTION_KEY (.env) — 64 hex chars
 * (32 bytes). Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Stored/returned format: "<ivHex>:<authTagHex>:<ciphertextHex>"
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV length for GCM

function getKey() {
  const raw = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.length !== 64) {
    throw new Error(
      'SOCIAL_TOKEN_ENCRYPTION_KEY is missing or not 64 hex chars (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
      'and set it in backend/.env before connecting any social account.'
    );
  }
  return Buffer.from(raw, 'hex');
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decrypt(payload) {
  if (!payload) return null;
  const key = getKey();
  const [ivHex, authTagHex, ciphertextHex] = payload.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Malformed encrypted token payload — expected "iv:authTag:ciphertext".');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
