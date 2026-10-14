/**
 * SendGrid v3 Mail Send API (api.sendgrid.com) via plain `fetch` — no
 * @sendgrid/mail SDK dependency for one JSON POST. Untested against a
 * real SendGrid account in this environment (no API key available);
 * implemented against SendGrid's documented request shape. See
 * docs/MARKETING_HUB_IMPLEMENTATION.md for exactly what "untested" means
 * here and what to verify once a real key exists.
 */
const ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

function isConfigured(connection) {
  return !!connection?.secret;
}

async function send({ connection, message }) {
  if (!isConfigured(connection)) throw new Error('SendGrid connection is missing an API key.');
  const body = {
    personalizations: [{ to: [{ email: message.to }] }],
    from: { email: message.fromEmail, name: message.fromName || undefined },
    reply_to: message.replyTo ? { email: message.replyTo } : undefined,
    subject: message.subject,
    content: [
      { type: 'text/plain', value: message.text },
      { type: 'text/html', value: message.html }
    ],
    headers: message.headers || {}
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`SendGrid send failed (${res.status}): ${detail.slice(0, 500)}`);
  }
  // SendGrid returns the message id in the X-Message-Id response header,
  // not the (empty, 202) body.
  const externalId = res.headers.get('x-message-id') || null;
  return { externalId };
}

module.exports = { name: 'sendgrid', isConfigured, send };
