/**
 * Twilio Messages API via plain `fetch` (Basic Auth, account_sid:auth_token)
 * — no twilio SDK dependency for one form-encoded POST. Untested against a
 * real Twilio account in this environment (no credentials available);
 * implemented against Twilio's documented request shape. See
 * docs/MARKETING_HUB_IMPLEMENTATION.md for what "untested" means here.
 */
function isConfigured(connection) {
  return !!(connection?.secret && connection?.config?.accountSid);
}

async function send({ connection, message }) {
  if (!isConfigured(connection)) throw new Error('Twilio connection is missing an account SID or auth token.');
  const { accountSid } = connection.config;
  const auth = Buffer.from(`${accountSid}:${connection.secret}`).toString('base64');
  const body = new URLSearchParams({ To: message.to, From: connection.fromNumber, Body: message.body });

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio send failed (${res.status}): ${json.message || 'unknown error'}`);
  return { externalId: json.sid || null };
}

module.exports = { name: 'twilio', isConfigured, send };
