/**
 * Local/dev/test email provider — always "configured," never touches the
 * network. Lets the entire campaign pipeline (segment → compose →
 * send → track opens/clicks → suppression) be exercised end to end with
 * no real provider account, the same role social/broadcastQueue.js's
 * tests give the mocked Meta Graph API.
 *
 * Deliberately not a silent no-op: it logs every "send," and honors a
 * test convention (an address containing "+bounce@" or "+fail@") to
 * simulate the two realistic outcomes real providers fail by — a hard
 * bounce (permanent, never retry) and a transient failure (retryable) —
 * so integration tests can exercise both without a real provider.
 */
const crypto = require('crypto');

function isConfigured() {
  return true;
}

async function send({ message }) {
  const { to } = message;
  if (to.includes('+bounce@')) {
    const err = new Error(`Mock provider: simulated hard bounce for ${to}`);
    err.bounce = true;
    throw err;
  }
  if (to.includes('+fail@')) {
    throw new Error(`Mock provider: simulated transient send failure for ${to}`);
  }
  const externalId = 'mock-' + crypto.randomBytes(8).toString('hex');
  console.log(`[email/providers/mock] "sent" to ${to}: ${message.subject} (${externalId})`);
  return { externalId };
}

module.exports = { name: 'mock', isConfigured, send };
