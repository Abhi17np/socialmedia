/**
 * The non-negotiable parts of a marketing email: an unsubscribe link,
 * List-Unsubscribe/List-Unsubscribe-Post headers (RFC 8058 one-click —
 * Gmail/Yahoo require this for bulk senders as of their 2024 sender
 * requirements), a physical mailing address in the footer (CAN-SPAM,
 * and parallel requirements under GDPR/India's DPDP Act), open-pixel and
 * click-redirect tracking URLs. Every campaign send runs through this —
 * there is no code path that renders an email without it.
 */
const { escapeHtml } = require('../emailRenderer');

function backendPublicUrl() {
  return process.env.BACKEND_PUBLIC_URL || 'http://localhost:5001';
}
function frontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:3000';
}

function preferenceCenterUrl(preferenceToken) {
  return `${frontendUrl()}/preferences/${preferenceToken}`;
}

// recipientId in the path lets the endpoint log a real per-campaign
// 'unsubscribe' event (so a campaign report's unsubscribed count is
// real, not inferred); preferenceToken as a query param is the actual
// access control (an email client can't be tricked into unsubscribing a
// different recipient by guessing a UUID — the token must match that
// recipient's own contact).
function oneClickUnsubscribeUrl(recipientId, preferenceToken) {
  return `${backendPublicUrl()}/api/v1/marketing/email/one-click-unsubscribe/${recipientId}?token=${preferenceToken}`;
}

function openPixelUrl(recipientId) {
  return `${backendPublicUrl()}/api/v1/marketing/email/track/open/${recipientId}`;
}

function clickTrackingUrl(recipientId, destinationUrl) {
  return `${backendPublicUrl()}/api/v1/marketing/email/track/click/${recipientId}?u=${encodeURIComponent(Buffer.from(destinationUrl, 'utf8').toString('base64url'))}`;
}

function decodeClickDestination(encoded) {
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** The List-Unsubscribe / List-Unsubscribe-Post header pair, RFC 8058. */
function listUnsubscribeHeaders(recipientId, preferenceToken) {
  return {
    'List-Unsubscribe': `<${oneClickUnsubscribeUrl(recipientId, preferenceToken)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  };
}

/** Appended to every rendered body — unsubscribe link, preference-center link, and the tenant's required physical address. */
function complianceFooterHtml({ preferenceToken, postalAddress }) {
  const unsubUrl = preferenceCenterUrl(preferenceToken);
  const address = postalAddress ? escapeHtml(postalAddress) : '';
  return `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:11px;color:#999;text-align:center;">` +
    `<p style="margin:0 0 4px;"><a href="${unsubUrl}" style="color:#999;">Unsubscribe</a> or <a href="${unsubUrl}" style="color:#999;">manage your preferences</a></p>` +
    (address ? `<p style="margin:0;">${address}</p>` : '') +
    `</div>`;
}

function complianceFooterText({ preferenceToken, postalAddress }) {
  const lines = [`Unsubscribe or manage your preferences: ${preferenceCenterUrl(preferenceToken)}`];
  if (postalAddress) lines.push(postalAddress);
  return '\n\n--\n' + lines.join('\n');
}

/** Appended to the rendered HTML body — invisible 1x1 image whose request is the open signal. */
function openPixelHtml(recipientId) {
  return `<img src="${openPixelUrl(recipientId)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;">`;
}

// A valid, minimal 1x1 transparent GIF, served by the tracking endpoint.
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64');

module.exports = {
  preferenceCenterUrl, oneClickUnsubscribeUrl, openPixelUrl, clickTrackingUrl, decodeClickDestination,
  listUnsubscribeHeaders, complianceFooterHtml, complianceFooterText, openPixelHtml, TRANSPARENT_GIF
};
