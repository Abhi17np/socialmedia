/**
 * One place that knows every email provider and how to load a tenant's
 * active connection for one — mirrors social/adapters/'s
 * `{ isConfigured, send }` shape so this is a familiar pattern, not a new
 * one. See migrations/027_email_marketing.sql's header for why this is a
 * separate, per-tenant, multi-provider system from lib/email.js (the
 * app's own single-config transactional SMTP sender).
 */
const { scoped } = require('../query');
const crypto = require('../../social/crypto');

const PROVIDERS = {
  mock: require('./providers/mock'),
  smtp: require('./providers/smtp'),
  sendgrid: require('./providers/sendgrid'),
  resend: require('./providers/resend')
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

/** The tenant's active email provider connection, decrypted and ready to pass to that provider's send(). Falls back to the mock provider if the tenant hasn't configured one — honest campaigns still work in dev/trial, exactly like Social Hub's AI features fail loudly instead of silently when unconfigured, except here "unconfigured" has a safe, real fallback rather than a 503 (a marketing campaign isn't a paid API call with real cost to gate). */
async function getActiveConnection(client, tenantId) {
  const { data, error } = await scoped(client, tenantId, 'email_provider_connections').select('*').eq('status', 'active').maybeSingle();
  if (error) throw error;
  if (!data) {
    return { provider: 'mock', connection: { config: {}, secret: null, fromName: 'Marketing', fromEmail: 'marketing@example.com' } };
  }
  return {
    provider: data.provider,
    connection: {
      config: data.config || {},
      secret: data.secret_encrypted ? crypto.decrypt(data.secret_encrypted) : null,
      fromName: data.from_name,
      fromEmail: data.from_email,
      replyTo: data.reply_to
    }
  };
}

function getProviderImpl(name) {
  const impl = PROVIDERS[name];
  if (!impl) throw new Error(`Unknown email provider "${name}".`);
  return impl;
}

/** Sends one message through the tenant's active provider (or mock, if none configured). Throws on failure — callers (the send worker) handle retry/suppression, this never swallows an error into a fake success. */
async function sendViaTenantProvider(client, tenantId, message) {
  const { provider, connection } = await getActiveConnection(client, tenantId);
  const impl = getProviderImpl(provider);
  const fullMessage = { ...message, fromName: message.fromName || connection.fromName, fromEmail: message.fromEmail || connection.fromEmail, replyTo: message.replyTo || connection.replyTo };
  const result = await impl.send({ connection, message: fullMessage });
  return { provider, ...result };
}

module.exports = { PROVIDER_NAMES, getActiveConnection, getProviderImpl, sendViaTenantProvider };
