/**
 * WhatsApp outbound template & broadcast sending. Genuinely new
 * capability — until now the WhatsApp adapter (social/adapters/whatsapp.js)
 * could only reply inside an open 24h customer-service window
 * (sendReply(), used from the Inbox). This adds the other half: template
 * messages, which are the only way to message a customer OUTSIDE that
 * window, and the campaign machinery to send one to many contacts at
 * once.
 *
 * What is buildable and testable right now, with no external approval:
 *   - Template CRUD, submitting a template to Meta for review, syncing
 *     its approval status back (POST/GET against the real Graph API —
 *     these calls work in Development Mode with no App Review needed).
 *   - Audience segmentation against the real contacts table, campaign
 *     creation, recipient resolution, scheduling.
 *   - The actual send pipeline (social/broadcastQueue.js): enqueue,
 *     retry with backoff, record delivery status from the webhook. This
 *     is real against Meta's sandbox/dev-mode numbers right now — it
 *     is NOT a mock.
 *
 * What stays blocked on Meta, structurally (not just "not implemented"):
 *   - A template can only be SENT once Meta has approved it
 *     (approval_status === 'approved') — POST /campaigns/:id/send below
 *     enforces this with a 409, it is not a soft warning.
 *   - In Development Mode, Meta only allows sending to up to 5
 *     phone numbers the business has explicitly verified as test
 *     recipients in Meta Business Suite — sending to a real customer
 *     base needs the WABA to clear Meta's production messaging limits
 *     (business verification), which is a Meta-side process this code
 *     cannot do for you.
 */

const express = require('express');
const { getSocialClient } = require('../social/db');
const { getUsableAccount } = require('../social/accounts');
const { scoped } = require('../lib/query');
const { validate } = require('../middleware/validate');
const { requireRole } = require('../middleware/tenant');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { getTenantPlan, currentUsage } = require('../lib/entitlements');
const { limitsFor } = require('../lib/plans');
const { resolveSegmentContacts, resolveExplicitContacts, countSegment } = require('../lib/audience');
const { filterConsentedContacts } = require('../lib/consent');
const { validateTree, isV2Filter, SegmentValidationError } = require('../lib/segmentCompiler');
const broadcastQueue = require('../social/broadcastQueue');
const { templateSchema, segmentSchema, segmentMembersSchema, whatsappCampaignSchema } = require('../lib/schemas');

const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

// -------------------------------------------------------------
// Templates
// -------------------------------------------------------------

router.get('/whatsapp/templates', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'whatsapp_templates').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ templates: data });
}));

router.post('/whatsapp/templates', requireRole('member'), validate(templateSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, language, category, bodyText, variableSamples, socialAccountId } = req.body;

  const { data: account } = await scoped(client, req.tenantId, 'social_accounts').select('id, platform').eq('id', socialAccountId).maybeSingle();
  if (!account || account.platform !== 'whatsapp') return res.status(400).json({ error: 'socialAccountId must be a connected WhatsApp account.' });

  const { data, error } = await client.from('whatsapp_templates').insert({
    tenant_id: req.tenantId,
    social_account_id: socialAccountId,
    name, language, category,
    body_text: bodyText,
    variable_samples: variableSamples,
    created_by: req.userId
  }).select('*').single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: `A template named "${name}" already exists for language "${language}".` });
    throw error;
  }
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'whatsapp.template_created', targetType: 'whatsapp_template', targetId: data.id, metadata: { name } });
  res.status(201).json({ template: data });
}));

router.delete('/whatsapp/templates/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'whatsapp_templates').delete().eq('id', req.params.id);
  if (error) {
    if (error.code === '23503') return res.status(409).json({ error: 'This template is used by one or more campaigns and cannot be deleted.' });
    throw error;
  }
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'whatsapp.template_deleted', targetType: 'whatsapp_template', targetId: req.params.id });
  res.json({ success: true });
}));

// Registers the template with Meta for review. Works today against a
// Development-Mode app — this is NOT the blocked step; approval turnaround
// (Meta's own review queue) is what's outside this app's control.
router.post('/whatsapp/templates/:id/submit', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { data: template, error: fetchError } = await scoped(client, req.tenantId, 'whatsapp_templates').select('*').eq('id', req.params.id).single();
  if (fetchError || !template) return res.status(404).json({ error: 'Template not found.' });
  if (template.approval_status !== 'draft') return res.status(409).json({ error: `Template is already "${template.approval_status}" — only a draft can be (re)submitted.` });

  const usable = await getUsableAccount(req.tenantId, template.social_account_id);
  if (!usable) return res.status(404).json({ error: 'The WhatsApp account this template was created under is no longer connected.' });
  const { account, adapter } = usable;
  if (typeof adapter.submitTemplate !== 'function') return res.status(400).json({ error: `${account.platform} adapter does not support template submission.` });

  try {
    const result = await adapter.submitTemplate(account, template);
    const { data: updated, error } = await client.from('whatsapp_templates')
      .update({ approval_status: result.status === 'approved' ? 'approved' : 'pending', meta_template_id: result.metaTemplateId, updated_at: new Date().toISOString() })
      .eq('id', template.id).select('*').single();
    if (error) throw error;
    await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'whatsapp.template_submitted', targetType: 'whatsapp_template', targetId: template.id, metadata: { metaTemplateId: result.metaTemplateId } });
    res.json({ template: updated });
  } catch (err) {
    return res.status(502).json({ error: `Meta rejected the submission: ${err.message}` });
  }
}));

// Syncs approval status for every template under one WhatsApp account —
// called on demand since Meta's review turnaround is hours/days.
router.post('/whatsapp/templates/sync', requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { socialAccountId } = req.body || {};
  if (!socialAccountId) return res.status(400).json({ error: 'socialAccountId is required.' });

  const usable = await getUsableAccount(req.tenantId, socialAccountId);
  if (!usable) return res.status(404).json({ error: 'Account not found.' });
  const { account, adapter } = usable;
  if (typeof adapter.fetchTemplateStatuses !== 'function') return res.status(400).json({ error: `${account.platform} adapter does not support template status sync.` });

  const metaTemplates = await adapter.fetchTemplateStatuses(account);
  const byKey = new Map(metaTemplates.map(t => [`${t.name}::${t.language}`, t]));

  const { data: ours, error: fetchError } = await scoped(client, req.tenantId, 'whatsapp_templates').select('*').eq('social_account_id', socialAccountId);
  if (fetchError) throw fetchError;

  let updatedCount = 0;
  for (const tpl of ours || []) {
    const match = byKey.get(`${tpl.name}::${tpl.language}`);
    if (!match) continue;
    if (match.status !== tpl.approval_status || match.rejectedReason !== tpl.rejected_reason) {
      await client.from('whatsapp_templates').update({
        approval_status: match.status, meta_template_id: match.metaTemplateId, rejected_reason: match.rejectedReason, updated_at: new Date().toISOString()
      }).eq('id', tpl.id);
      updatedCount += 1;
    }
  }
  res.json({ synced: metaTemplates.length, updated: updatedCount });
}));

// -------------------------------------------------------------
// Audience segments (shared table with Marketing Hub — routes/marketing.js)
// -------------------------------------------------------------

router.get('/whatsapp/segments', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'audience_segments').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ segments: data });
}));

// A v2 filter tree's exact (field, operator, value) validity can't be
// expressed in zod alone (lib/segmentCompiler.js owns the full field/
// operator registry) — this runs after validate(segmentSchema) confirms
// the general shape, and turns a bad tree into the same 400 style every
// other validation failure in this app uses, not an unhandled throw.
function validateSegmentFilter(req, res) {
  if (!isV2Filter(req.body.filter)) return true;
  try {
    validateTree(req.body.filter.root);
    return true;
  } catch (err) {
    if (err instanceof SegmentValidationError) {
      res.status(400).json({ error: err.message });
      return false;
    }
    throw err;
  }
}

router.post('/whatsapp/segments', requireRole('member'), validate(segmentSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  if (!validateSegmentFilter(req, res)) return;
  const { data, error } = await client.from('audience_segments').insert({
    tenant_id: req.tenantId, name: req.body.name, description: req.body.description || null,
    segment_type: req.body.segmentType, filter_json: req.body.filter, created_by: req.userId
  }).select('*').single();
  if (error) throw error;
  res.status(201).json({ segment: data });
}));

router.patch('/whatsapp/segments/:id', requireRole('member'), validate(segmentSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  if (!validateSegmentFilter(req, res)) return;
  const { data, error } = await scoped(client, req.tenantId, 'audience_segments').update({
    name: req.body.name, description: req.body.description || null, segment_type: req.body.segmentType,
    filter_json: req.body.filter, updated_at: new Date().toISOString()
  }).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Segment not found.' });
  res.json({ segment: data });
}));

router.delete('/whatsapp/segments/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'audience_segments').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ success: true });
}));

// Static-list membership — dynamic segments have nothing to manage here
// (filter_json is the only source of truth for those); a static segment's
// membership is these rows, added/removed explicitly or via import.
router.post('/whatsapp/segments/:id/members', requireRole('member'), validate(segmentMembersSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: segment } = await scoped(client, req.tenantId, 'audience_segments').select('id, segment_type').eq('id', req.params.id).maybeSingle();
  if (!segment) return res.status(404).json({ error: 'Segment not found.' });
  if (segment.segment_type !== 'static') return res.status(400).json({ error: 'Only a static list has members to add — a dynamic segment is defined entirely by its filter.' });

  const { data: validContacts, error: cErr } = await scoped(client, req.tenantId, 'contacts').select('id').in('id', req.body.contactIds);
  if (cErr) throw cErr;
  const validIds = (validContacts || []).map((c) => c.id);
  if (validIds.length === 0) return res.status(400).json({ error: 'None of the given contact ids belong to this tenant.' });

  const { error } = await client.from('segment_members').upsert(
    validIds.map((contactId) => ({ tenant_id: req.tenantId, segment_id: segment.id, contact_id: contactId, added_by: req.userId })),
    { onConflict: 'segment_id,contact_id', ignoreDuplicates: true }
  );
  if (error) throw error;
  res.status(201).json({ added: validIds.length, skipped: req.body.contactIds.length - validIds.length });
}));

router.delete('/whatsapp/segments/:id/members/:contactId', requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'segment_members').delete().eq('segment_id', req.params.id).eq('contact_id', req.params.contactId);
  if (error) throw error;
  res.json({ success: true });
}));

router.get('/whatsapp/segments/:id/preview', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  // No ?channel param: the original, WhatsApp-specific preview (phone
  // required, whatsapp consent applied) — kept as the default so
  // WhatsAppHub.jsx's existing call sites are unaffected. The segment
  // builder UI (any channel, or none yet picked) passes ?channel= to get
  // a plain or channel-specific count instead.
  const channel = ['email', 'whatsapp', 'sms'].includes(req.query.channel) ? req.query.channel : undefined;
  const requirePhone = req.query.channel === undefined ? true : channel === 'whatsapp' || channel === 'sms';
  const { segment, count, suppressedCount } = await countSegment(client, req.tenantId, req.params.id, { requirePhone, consentChannel: channel || (req.query.channel === undefined ? 'whatsapp' : null) });
  if (!segment) return res.status(404).json({ error: 'Segment not found.' });
  res.json({ segment, whatsappEligibleCount: count, eligibleCount: count, suppressedCount: suppressedCount || 0 });
}));

// -------------------------------------------------------------
// Campaigns
// -------------------------------------------------------------

router.get('/whatsapp/campaigns', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'whatsapp_campaigns').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ campaigns: data });
}));

router.get('/whatsapp/campaigns/:id', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: campaign, error } = await scoped(client, req.tenantId, 'whatsapp_campaigns').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

  const { data: recipients, error: recError } = await scoped(client, req.tenantId, 'whatsapp_campaign_recipients').select('*').eq('campaign_id', req.params.id).order('queued_at', { ascending: false }).limit(500);
  if (recError) throw recError;

  res.json({ campaign, recipients });
}));

router.post('/whatsapp/campaigns', requireRole('member'), validate(whatsappCampaignSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, socialAccountId, templateId, segmentId, contactIds, variableValues, scheduledAt } = req.body;

  const { data: account } = await scoped(client, req.tenantId, 'social_accounts').select('id, platform').eq('id', socialAccountId).maybeSingle();
  if (!account || account.platform !== 'whatsapp') return res.status(400).json({ error: 'socialAccountId must be a connected WhatsApp account.' });

  const { data: template } = await scoped(client, req.tenantId, 'whatsapp_templates').select('id').eq('id', templateId).maybeSingle();
  if (!template) return res.status(400).json({ error: 'Template not found.' });

  if (segmentId) {
    const { data: segment } = await scoped(client, req.tenantId, 'audience_segments').select('id').eq('id', segmentId).maybeSingle();
    if (!segment) return res.status(400).json({ error: 'Segment not found.' });
  }

  const { data, error } = await client.from('whatsapp_campaigns').insert({
    tenant_id: req.tenantId, name, social_account_id: socialAccountId, template_id: templateId,
    segment_id: segmentId || null, variable_values: variableValues, scheduled_at: scheduledAt || null,
    status: scheduledAt ? 'scheduled' : 'draft', created_by: req.userId
  }).select('*').single();
  if (error) throw error;

  // contactIds (an explicit, ad hoc list rather than a saved segment)
  // snapshot onto the campaign row itself via metadata isn't modeled —
  // kept in-memory and resolved again at send time alongside segment_id
  // would silently drop them, so persist them now as pending recipients.
  if (!segmentId && contactIds && contactIds.length > 0) {
    const contacts = await resolveExplicitContacts(client, req.tenantId, contactIds, { requirePhone: true, consentChannel: 'whatsapp' });
    if (contacts.length > 0) {
      await client.from('whatsapp_campaign_recipients').insert(contacts.map(c => ({
        tenant_id: req.tenantId, campaign_id: data.id, contact_id: c.id, phone: c.phone
      })));
      await client.from('whatsapp_campaigns').update({ total_recipients: contacts.length }).eq('id', data.id);
      data.total_recipients = contacts.length;
    }
  }

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'whatsapp.campaign_created', targetType: 'whatsapp_campaign', targetId: data.id, metadata: { name } });
  res.status(201).json({ campaign: data });
}));

router.post('/whatsapp/campaigns/:id/send', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { data: campaign, error: fetchError } = await scoped(client, req.tenantId, 'whatsapp_campaigns').select('*').eq('id', req.params.id).maybeSingle();
  if (fetchError) throw fetchError;
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  if (!['draft', 'scheduled'].includes(campaign.status)) return res.status(409).json({ error: `Campaign status is "${campaign.status}" — only a draft or scheduled campaign can be sent.` });

  const { data: template, error: tplError } = await scoped(client, req.tenantId, 'whatsapp_templates').select('*').eq('id', campaign.template_id).single();
  if (tplError || !template) return res.status(404).json({ error: 'The campaign\'s template no longer exists.' });

  // The structural Meta-side gate, enforced here rather than left as a
  // soft warning: the Cloud API itself rejects a template send unless
  // Meta has approved that exact template, so there is nothing to retry
  // into — surfacing this clearly, with the real approval_status, is
  // strictly better than letting every recipient job fail individually.
  if (template.approval_status !== 'approved') {
    return res.status(409).json({
      error: `Template "${template.name}" is not approved yet (status: ${template.approval_status}). Submit it for review and wait for Meta's approval before sending.`,
      code: 'TEMPLATE_NOT_APPROVED'
    });
  }

  let recipients;
  let suppressedContactIds = [];
  if (campaign.segment_id) {
    // Fresh read against live contact/consent data — authoritative by
    // construction, nothing further to re-check.
    const result = await resolveSegmentContacts(client, req.tenantId, campaign.segment_id, { requirePhone: true, consentChannel: 'whatsapp' });
    recipients = result.contacts;
    suppressedContactIds = result.suppressed.map((c) => c.id);
  } else {
    // These rows were snapshotted at campaign-creation time (already
    // consent-filtered then) and could be stale by send time — re-check
    // against live consent/suppression data now, since this is the one
    // place every send ultimately passes through. See lib/consent.js's
    // header for why this gate can never be skipped.
    const { data: existing, error: existingError } = await scoped(client, req.tenantId, 'whatsapp_campaign_recipients').select('id, contact_id, phone').eq('campaign_id', campaign.id);
    if (existingError) throw existingError;
    const contactIds = (existing || []).map((r) => r.contact_id).filter(Boolean);
    const liveContacts = contactIds.length > 0
      ? (await scoped(client, req.tenantId, 'contacts').select('id, email, phone, global_opt_out_at').in('id', contactIds)).data || []
      : [];
    const { allowed, blocked } = await filterConsentedContacts(client, req.tenantId, liveContacts, 'whatsapp');
    const allowedIds = new Set(allowed.map((c) => c.id));
    recipients = (existing || []).filter((r) => allowedIds.has(r.contact_id));
    suppressedContactIds = blocked.map((c) => c.id);
  }

  // Mark any now-suppressed contact's recipient row distinctly so a
  // stale 'pending' row never gets picked up by the status='pending'
  // query below (this send attempt or a future resend) and the
  // per-recipient status table in the UI shows the real reason instead
  // of "pending" forever.
  if (suppressedContactIds.length > 0) {
    await client.from('whatsapp_campaign_recipients')
      .update({ status: 'suppressed', error: 'Opted out, globally unsubscribed, or on the suppression list as of send time.' })
      .eq('campaign_id', campaign.id).eq('status', 'pending').in('contact_id', suppressedContactIds);
  }

  if (recipients.length === 0) {
    return res.status(400).json(
      suppressedContactIds.length > 0
        ? { error: `All ${suppressedContactIds.length} matched contact(s) have opted out of WhatsApp, globally unsubscribed, or are on the suppression list — nothing to send.`, code: 'ALL_RECIPIENTS_SUPPRESSED' }
        : { error: 'This campaign has no eligible recipients (no contact with a phone number matched).' }
    );
  }

  // Pre-checked against the whole batch, not just "is at least one send
  // allowed" (assertWithinLimit's usual per-request check) — a campaign
  // is one request that's about to consume N sends at once, so the gate
  // has to compare N against what's actually left this period, not just
  // whether the counter has already been exhausted.
  const plan = await getTenantPlan(client, req.tenantId);
  const used = await currentUsage(client, req.tenantId, 'whatsappBroadcastSendsPerMonth');
  const limit = limitsFor(plan).whatsappBroadcastSendsPerMonth;
  const remaining = limit === Infinity ? Infinity : Math.max(0, limit - used);
  if (recipients.length > remaining) {
    return res.status(402).json({ error: `This campaign's ${recipients.length} recipients exceed your plan's remaining WhatsApp broadcast allowance (${remaining} left this month, ${limit}/month total). Upgrade or shrink the audience.` });
  }

  // Snapshot into recipient rows (segment-backed campaigns have none yet;
  // an explicit-contactIds campaign already has them from creation —
  // upsert is the no-op path for that case).
  if (campaign.segment_id) {
    const { error: insertError } = await client.from('whatsapp_campaign_recipients').upsert(
      recipients.map(c => ({ tenant_id: req.tenantId, campaign_id: campaign.id, contact_id: c.id, phone: c.phone })),
      { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true }
    );
    if (insertError) throw insertError;
  }

  // Scoped to this send's own consented contact_ids, not just
  // status='pending' for the whole campaign — a defense-in-depth measure
  // against any other stale pending row (e.g. from an interrupted
  // earlier attempt) for a contact that isn't in this send's allowed set.
  const allowedContactIds = recipients.map((r) => r.contact_id || r.id).filter(Boolean);
  const { data: recipientRows, error: rowsError } = await scoped(client, req.tenantId, 'whatsapp_campaign_recipients').select('id, phone').eq('campaign_id', campaign.id).eq('status', 'pending').in('contact_id', allowedContactIds);
  if (rowsError) throw rowsError;

  await client.from('whatsapp_campaigns').update({ status: 'sending', total_recipients: recipientRows.length, updated_at: new Date().toISOString() }).eq('id', campaign.id);

  await broadcastQueue.enqueueCampaign(campaign, recipientRows, template);

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'whatsapp.campaign_sent', targetType: 'whatsapp_campaign', targetId: campaign.id, metadata: { recipientCount: recipientRows.length, suppressedCount: suppressedContactIds.length } });
  res.json({ success: true, queued: recipientRows.length, suppressed: suppressedContactIds.length });
}));

router.post('/whatsapp/campaigns/:id/cancel', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { data: campaign, error: fetchError } = await scoped(client, req.tenantId, 'whatsapp_campaigns').select('*').eq('id', req.params.id).maybeSingle();
  if (fetchError) throw fetchError;
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  if (campaign.status !== 'sending') return res.status(409).json({ error: `Campaign status is "${campaign.status}" — only a sending campaign can be canceled.` });

  const { data: pending, error: pendingError } = await scoped(client, req.tenantId, 'whatsapp_campaign_recipients').select('id, phone').eq('campaign_id', campaign.id).in('status', ['pending', 'queued']);
  if (pendingError) throw pendingError;

  await broadcastQueue.cancelCampaign(campaign, pending).catch(err => console.error(`[whatsapp] Could not cancel queued jobs for campaign ${campaign.id}:`, err.message));

  if (pending.length > 0) {
    await client.from('whatsapp_campaign_recipients').update({ status: 'failed', error: 'Campaign canceled.', failed_at: new Date().toISOString() }).in('id', pending.map(p => p.id));
  }
  await client.from('whatsapp_campaigns').update({ status: 'canceled', updated_at: new Date().toISOString() }).eq('id', campaign.id);
  await client.rpc('recompute_whatsapp_campaign_counts', { p_campaign_id: campaign.id });

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'whatsapp.campaign_canceled', targetType: 'whatsapp_campaign', targetId: campaign.id });
  res.json({ success: true, canceled: pending.length });
}));

router.delete('/whatsapp/campaigns/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: campaign } = await scoped(client, req.tenantId, 'whatsapp_campaigns').select('status').eq('id', req.params.id).maybeSingle();
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  if (!['draft', 'canceled', 'completed', 'failed'].includes(campaign.status)) return res.status(409).json({ error: 'Cannot delete a campaign that is currently sending.' });

  const { error } = await scoped(client, req.tenantId, 'whatsapp_campaigns').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ success: true });
}));

module.exports = router;
