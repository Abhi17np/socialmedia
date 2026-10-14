/**
 * Composes lib/emailRenderer.js (blocks → HTML/text) with
 * lib/email/compliance.js (unsubscribe, physical address, tracking) into
 * the exact message handed to a provider. One function, used by both the
 * real send path (lib/email/emailQueue.js's enqueue, via routes) and the
 * send-test endpoint, so a test send is never allowed to drift from what
 * a real send actually produces.
 */
const { mergeContextFromContact, applyMergeTags, renderBlocksToHtml, renderBlocksToText, withTrackedLinks } = require('../emailRenderer');
const { clickTrackingUrl, openPixelHtml, complianceFooterHtml, complianceFooterText, listUnsubscribeHeaders } = require('./compliance');

/**
 * `template` = { subject, blocks, brand }, `campaign` = { subject?, preheader? } (a campaign-level subject override, if set),
 * `contact` = the recipient's contact row (needs display_name/email/phone + preference_token),
 * `recipientId` = the email_campaign_recipients.id this render is for (tracking is keyed to it),
 * `tenant` = { marketing_postal_address }.
 */
function renderEmailForRecipient({ template, campaign, contact, recipientId, tenant }) {
  const context = mergeContextFromContact(contact);
  const subjectSource = campaign?.subject || template.subject || '';
  const subject = applyMergeTags(subjectSource, context);

  const trackedBlocks = withTrackedLinks(template.blocks || [], (url) => clickTrackingUrl(recipientId, url));
  let html = renderBlocksToHtml(trackedBlocks, { context, brand: template.brand || {} });
  const text = renderBlocksToText(template.blocks || [], { context });

  const footerArgs = { preferenceToken: contact.preference_token, postalAddress: tenant?.marketing_postal_address };
  html = html + complianceFooterHtml(footerArgs) + openPixelHtml(recipientId);
  const fullText = text + complianceFooterText(footerArgs);

  return { subject, html, text: fullText, headers: listUnsubscribeHeaders(recipientId, contact.preference_token) };
}

module.exports = { renderEmailForRecipient };
