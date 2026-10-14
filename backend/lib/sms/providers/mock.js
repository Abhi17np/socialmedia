/**
 * Local/dev/test SMS provider — same role as lib/email/providers/mock.js:
 * always configured, never touches the network, honors the same
 * "+bounce@"-style test convention (a phone containing "0000" simulates
 * a permanent failure, "1111" a transient one) so the full pipeline is
 * exercisable with no real Twilio/MSG91 account.
 */
const crypto = require('crypto');

function isConfigured() {
  return true;
}

async function send({ message }) {
  const { to } = message;
  if (to.includes('0000')) {
    const err = new Error(`Mock SMS provider: simulated permanent failure for ${to}`);
    err.permanent = true;
    throw err;
  }
  if (to.includes('1111')) {
    throw new Error(`Mock SMS provider: simulated transient send failure for ${to}`);
  }
  const externalId = 'mock-sms-' + crypto.randomBytes(8).toString('hex');
  console.log(`[sms/providers/mock] "sent" to ${to}: ${message.body} (${externalId})`);
  return { externalId };
}

module.exports = { name: 'mock', isConfigured, send };
