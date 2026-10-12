/**
 * Real SMTP delivery (nodemailer), not a fabricated "email sent"
 * response — works with any SMTP provider (Gmail, SES, SendGrid,
 * Mailgun, Resend's SMTP endpoint, etc.), no vendor lock-in. Same
 * fail-closed pattern as Supabase/Redis/Razorpay/Anthropic elsewhere in
 * this app: unconfigured means a clear 503, never a silent no-op dressed
 * up as success.
 */
const nodemailer = require('nodemailer');

let transporter = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return transporter;
}

function unavailableError() {
  const err = new Error('Email delivery is not configured (SMTP_HOST/PORT/USER/PASS in backend/.env).');
  err.statusCode = 503;
  return err;
}

async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) throw unavailableError();
  await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
}

async function sendPasswordResetEmail(to, resetUrl) {
  await sendMail({
    to,
    subject: 'Reset your Social Hub password',
    text: `Reset your password here (expires in 1 hour): ${resetUrl}\n\nIf you didn't request this, ignore this email.`
  });
}

async function sendVerificationEmail(to, verifyUrl) {
  await sendMail({
    to,
    subject: 'Verify your Social Hub email',
    text: `Verify your email here (expires in 24 hours): ${verifyUrl}`
  });
}

module.exports = { isConfigured, sendPasswordResetEmail, sendVerificationEmail };
