/**
 * Same shape as lib/email/providerRegistry.js: loads a tenant's active
 * SMS connection (decrypted fresh per call, never persisted into a
 * BullMQ job payload) and falls back to the mock provider when
 * unconfigured — campaigns work in dev/trial with zero setup.
 */
const { scoped } = require('../query');
const crypto = require('../../social/crypto');

const PROVIDERS = {
  mock: require('./providers/mock'),
  twilio: require('./providers/twilio'),
  msg91: require('./providers/msg91')
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

async function getActiveConnection(client, tenantId) {
  const { data, error } = await scoped(client, tenantId, 'sms_provider_connections').select('*').eq('status', 'active').maybeSingle();
  if (error) throw error;
  if (!data) return { provider: 'mock', connection: { config: {}, secret: null, fromNumber: '+10000000000' } };
  return {
    provider: data.provider,
    connection: { config: data.config || {}, secret: data.secret_encrypted ? crypto.decrypt(data.secret_encrypted) : null, fromNumber: data.from_number }
  };
}

function getProviderImpl(name) {
  const impl = PROVIDERS[name];
  if (!impl) throw new Error(`Unknown SMS provider "${name}".`);
  return impl;
}

async function sendViaTenantProvider(client, tenantId, message) {
  const { provider, connection } = await getActiveConnection(client, tenantId);
  const impl = getProviderImpl(provider);
  const result = await impl.send({ connection, message });
  return { provider, ...result };
}

module.exports = { PROVIDER_NAMES, getActiveConnection, getProviderImpl, sendViaTenantProvider };
