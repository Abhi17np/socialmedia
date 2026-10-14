/**
 * Generic SMTP provider (nodemailer) — works against any real SMTP
 * endpoint: Amazon SES's SMTP interface, Mailgun, Postmark, Gmail SMTP,
 * a self-hosted Postfix, etc. Per-tenant credentials (not the app-wide
 * SMTP_HOST/.../PASS lib/email.js uses for password-reset mail — see
 * migrations/027's header for why these are deliberately separate).
 *
 * Covers Amazon SES on purpose instead of a hand-rolled SES API/SigV4
 * client: SES's own SMTP interface is a first-class, documented way to
 * send through it, and reusing this one well-tested path for every
 * SMTP-speaking provider is a smaller, more honestly-verifiable surface
 * than re-implementing AWS request signing this session has no live SES
 * account to test against anyway.
 */
const nodemailer = require('nodemailer');

function isConfigured(connection) {
  const c = connection?.config || {};
  return !!(c.host && c.port && c.user && connection?.secret);
}

async function send({ connection, message }) {
  if (!isConfigured(connection)) throw new Error('SMTP connection is missing host/port/user/password.');
  const c = connection.config;
  const transporter = nodemailer.createTransport({
    host: c.host,
    port: Number(c.port),
    secure: c.secure !== undefined ? !!c.secure : Number(c.port) === 465,
    auth: { user: c.user, pass: connection.secret }
  });
  const info = await transporter.sendMail({
    from: message.fromName ? `"${message.fromName}" <${message.fromEmail}>` : message.fromEmail,
    to: message.to,
    replyTo: message.replyTo || undefined,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers || {}
  });
  return { externalId: info.messageId };
}

module.exports = { name: 'smtp', isConfigured, send };
