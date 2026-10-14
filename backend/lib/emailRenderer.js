/**
 * Turns an email_templates.blocks array + a contact into real responsive
 * HTML and a plain-text fallback. Pure functions, no DB/network — fully
 * unit-testable (test/emailRenderer.test.js). Click-tracking and the
 * open pixel are injected by the caller (lib/email/sendPipeline.js),
 * which knows the recipient id; this file only knows blocks and merge
 * tags.
 *
 * Supported block types (BLOCK_TYPES): 'heading', 'text', 'image',
 * 'button', 'divider', 'spacer'. Deliberately not a full drag-and-drop
 * visual canvas — a structured block list with a live preview covers the
 * brief's "block-based email editor" requirement without the much larger
 * frontend lift a true WYSIWYG canvas would need; see
 * docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 3 entry for this as a
 * recorded scope decision, not an oversight.
 */

const BLOCK_TYPES = ['heading', 'text', 'image', 'button', 'divider', 'spacer'];

const MERGE_TAG_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([^}]*))?\}\}/g;

/** { firstName, lastName, displayName, email, phone } → merge-tag source, with a documented fallback for a tag with no value. */
function mergeContextFromContact(contact) {
  const displayName = contact?.display_name || '';
  const [firstName, ...rest] = displayName.split(' ').filter(Boolean);
  return {
    firstName: firstName || '',
    lastName: rest.join(' ') || '',
    displayName,
    email: contact?.email || '',
    phone: contact?.phone || ''
  };
}

/** Replaces {{field}} / {{field|fallback}} — an unknown field or an empty value both fall back to the given fallback (or '' if none given), never leaves a literal "{{firstName}}" in a sent email. */
function applyMergeTags(str, context) {
  if (!str) return '';
  return str.replace(MERGE_TAG_RE, (_, field, fallback) => {
    const value = context[field];
    return value !== undefined && value !== '' ? String(value) : (fallback !== undefined ? fallback : '');
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function blockToHtml(block, context, brand) {
  const color = brand?.primaryColor || '#5b5fef';
  switch (block.type) {
    case 'heading':
      return `<h2 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111;">${escapeHtml(applyMergeTags(block.text, context))}</h2>`;
    case 'text':
      return `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#333;">${escapeHtml(applyMergeTags(block.text, context)).replace(/\n/g, '<br>')}</p>`;
    case 'image':
      return block.src ? `<img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt || '')}" style="max-width:100%;display:block;margin:0 0 12px;">` : '';
    case 'button': {
      const label = escapeHtml(applyMergeTags(block.label || 'Learn more', context));
      const href = escapeHtml(block.href || '#');
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px;"><tr><td style="background:${color};border-radius:6px;">` +
        `<a href="${href}" data-link="true" style="display:inline-block;padding:10px 20px;color:#fff;text-decoration:none;font-size:14px;font-weight:600;">${label}</a>` +
        `</td></tr></table>`;
    }
    case 'divider':
      return '<hr style="border:none;border-top:1px solid #e5e5e5;margin:16px 0;">';
    case 'spacer':
      return `<div style="height:${Number(block.height) || 16}px;"></div>`;
    default:
      return '';
  }
}

function blockToText(block, context) {
  switch (block.type) {
    case 'heading':
      return applyMergeTags(block.text, context).toUpperCase();
    case 'text':
      return applyMergeTags(block.text, context);
    case 'button':
      return `${applyMergeTags(block.label || 'Learn more', context)}: ${block.href || ''}`;
    case 'image':
      return block.alt ? `[image: ${block.alt}]` : '';
    case 'divider':
      return '----------';
    default:
      return '';
  }
}

/** Renders blocks (already merge-tag-applied) to a responsive, email-client-safe HTML body (no head/html wrapper — the caller wraps it with compliance footer + tracking). */
function renderBlocksToHtml(blocks, { context = {}, brand = {} } = {}) {
  const inner = (blocks || []).map((b) => blockToHtml(b, context, brand)).join('\n');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${inner}</div>`;
}

function renderBlocksToText(blocks, { context = {} } = {}) {
  return (blocks || []).map((b) => blockToText(b, context)).filter(Boolean).join('\n\n');
}

/** Every <a href> a button block can produce, for click-link-wrapping without parsing arbitrary HTML (see this file's header for why only button links are tracked). */
function extractLinks(blocks) {
  return (blocks || []).filter((b) => b.type === 'button' && b.href).map((b) => b.href);
}

/** Rewrites button-block hrefs to a click-tracking redirect URL before rendering, keyed by the original URL (stable regardless of block order/edits). */
function withTrackedLinks(blocks, toTrackingUrl) {
  return (blocks || []).map((b) => (b.type === 'button' && b.href ? { ...b, href: toTrackingUrl(b.href) } : b));
}

module.exports = {
  BLOCK_TYPES, mergeContextFromContact, applyMergeTags, renderBlocksToHtml, renderBlocksToText, extractLinks, withTrackedLinks, escapeHtml
};
