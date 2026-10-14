/**
 * Resend API (api.resend.com) via plain `fetch`. Untested against a real
 * Resend account in this environment (no API key available); implemented
 * against Resend's documented request shape. See
 * docs/MARKETING_HUB_IMPLEMENTATION.md for what "untested" means here.
 */
const ENDPOINT = 'https://api.resend.com/emails';

function isConfigured(connection) {
  return !!connection?.secret;
}

async function send({ connection, message }) {
  if (!isConfigured(connection)) throw new Error('Resend connection is missing an API key.');
  const body = {
    from: message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail,
    to: [message.to],
    reply_to: message.replyTo || undefined,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers || {}
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend send failed (${res.status}): ${JSON.stringify(data).slice(0, 500)}`);
  return { externalId: data.id || null };
}

module.exports = { name: 'resend', isConfigured, send };
