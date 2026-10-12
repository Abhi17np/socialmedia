/**
 * Marketing Hub: campaigns that orchestrate the channels that already
 * exist and genuinely send — scheduled social posts (routes/social.js)
 * and WhatsApp broadcasts (routes/whatsapp.js) — against an audience
 * segment, plus a small automation-rule management surface over
 * lib/automation.js's engine (which itself is wired into
 * routes/sales.js's contact/deal triggers).
 *
 * Deliberately NOT a parallel send pipeline: there is no email/SMS
 * provider configured in this app, so "marketing campaign" here means
 * "group one or more real sends under one name and roll up their real
 * results", not a new channel. Audience segments are the same shared
 * audience_segments table routes/whatsapp.js's segment CRUD manages —
 * no second copy here; Marketing Hub's UI calls those same endpoints.
 *
 * Gated behind tenants.hubs_enabled->>'marketing' (requireHub).
 */

const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { requireHub } = require('../middleware/hubs');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { marketingCampaignSchema, automationRuleSchema } = require('../lib/schemas');

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
// Campaigns
// -------------------------------------------------------------

router.get('/marketing/campaigns', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'marketing_campaigns').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ campaigns: data });
}));

router.post('/marketing/campaigns', requireHub('marketing'), requireRole('member'), validate(marketingCampaignSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, description, segmentId, startDate, endDate } = req.body;

  if (segmentId) {
    const { data: segment } = await scoped(client, req.tenantId, 'audience_segments').select('id').eq('id', segmentId).maybeSingle();
    if (!segment) return res.status(400).json({ error: 'Segment not found.' });
  }

  const { data, error } = await client.from('marketing_campaigns').insert({
    tenant_id: req.tenantId, name, description: description || null, segment_id: segmentId || null,
    start_date: startDate || null, end_date: endDate || null, created_by: req.userId
  }).select('*').single();
  if (error) throw error;

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.campaign_created', targetType: 'marketing_campaign', targetId: data.id, metadata: { name } });
  res.status(201).json({ campaign: data });
}));

router.get('/marketing/campaigns/:id', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: campaign, error } = await scoped(client, req.tenantId, 'marketing_campaigns').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

  const [{ data: postLinks }, { data: waLinks }] = await Promise.all([
    client.from('marketing_campaign_posts').select('scheduled_post_id').eq('campaign_id', campaign.id),
    client.from('marketing_campaign_whatsapp').select('whatsapp_campaign_id').eq('campaign_id', campaign.id)
  ]);

  const postIds = (postLinks || []).map((l) => l.scheduled_post_id);
  const waIds = (waLinks || []).map((l) => l.whatsapp_campaign_id);

  const [{ data: posts }, { data: waCampaigns }] = await Promise.all([
    postIds.length > 0 ? scoped(client, req.tenantId, 'scheduled_posts').select('id, content, status, target_platforms, scheduled_at, platform_results').in('id', postIds) : Promise.resolve({ data: [] }),
    waIds.length > 0 ? scoped(client, req.tenantId, 'whatsapp_campaigns').select('id, name, status, total_recipients, sent_count, delivered_count, read_count, failed_count').in('id', waIds) : Promise.resolve({ data: [] })
  ]);

  res.json({ campaign, posts: posts || [], whatsappCampaigns: waCampaigns || [] });
}));

router.patch('/marketing/campaigns/:id', requireHub('marketing'), requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const patch = {};
  for (const [bodyKey, column] of [['name', 'name'], ['description', 'description'], ['segmentId', 'segment_id'], ['startDate', 'start_date'], ['endDate', 'end_date']]) {
    if (req.body[bodyKey] !== undefined) patch[column] = req.body[bodyKey];
  }
  if (req.body.status !== undefined) {
    if (!['draft', 'active', 'completed', 'archived'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status.' });
    patch.status = req.body.status;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  patch.updated_at = new Date().toISOString();

  const { data, error } = await scoped(client, req.tenantId, 'marketing_campaigns').update(patch).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Campaign not found.' });
  res.json({ campaign: data });
}));

router.delete('/marketing/campaigns/:id', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'marketing_campaigns').delete().eq('id', req.params.id);
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.campaign_deleted', targetType: 'marketing_campaign', targetId: req.params.id });
  res.json({ success: true });
}));

router.post('/marketing/campaigns/:id/link-post', requireHub('marketing'), requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { scheduledPostId } = req.body || {};
  if (!scheduledPostId) return res.status(400).json({ error: 'scheduledPostId is required.' });

  const { data: campaign } = await scoped(client, req.tenantId, 'marketing_campaigns').select('id').eq('id', req.params.id).maybeSingle();
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  const { data: post } = await scoped(client, req.tenantId, 'scheduled_posts').select('id').eq('id', scheduledPostId).maybeSingle();
  if (!post) return res.status(400).json({ error: 'Post not found.' });

  const { error } = await client.from('marketing_campaign_posts').insert({ campaign_id: campaign.id, scheduled_post_id: scheduledPostId });
  if (error && error.code !== '23505') throw error; // 23505 = already linked, a safe no-op
  res.json({ success: true });
}));

router.post('/marketing/campaigns/:id/link-whatsapp', requireHub('marketing'), requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { whatsappCampaignId } = req.body || {};
  if (!whatsappCampaignId) return res.status(400).json({ error: 'whatsappCampaignId is required.' });

  const { data: campaign } = await scoped(client, req.tenantId, 'marketing_campaigns').select('id').eq('id', req.params.id).maybeSingle();
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  const { data: waCampaign } = await scoped(client, req.tenantId, 'whatsapp_campaigns').select('id').eq('id', whatsappCampaignId).maybeSingle();
  if (!waCampaign) return res.status(400).json({ error: 'WhatsApp campaign not found.' });

  const { error } = await client.from('marketing_campaign_whatsapp').insert({ campaign_id: campaign.id, whatsapp_campaign_id: whatsappCampaignId });
  if (error && error.code !== '23505') throw error;
  res.json({ success: true });
}));

// Real rollup over whatever the campaign actually links to — no
// fabricated "opens"/"clicks" metrics for channels that don't report
// them (WhatsApp Cloud API doesn't give link-click analytics; this
// reports what's real: delivery/read counts and post publish status).
router.get('/marketing/campaigns/:id/analytics', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: campaign, error } = await scoped(client, req.tenantId, 'marketing_campaigns').select('id').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

  const { data: waLinks } = await client.from('marketing_campaign_whatsapp').select('whatsapp_campaign_id').eq('campaign_id', campaign.id);
  const waIds = (waLinks || []).map((l) => l.whatsapp_campaign_id);
  const { data: waCampaigns } = waIds.length > 0
    ? await scoped(client, req.tenantId, 'whatsapp_campaigns').select('total_recipients, sent_count, delivered_count, read_count, failed_count').in('id', waIds)
    : { data: [] };

  const { data: postLinks } = await client.from('marketing_campaign_posts').select('scheduled_post_id').eq('campaign_id', campaign.id);
  const postIds = (postLinks || []).map((l) => l.scheduled_post_id);
  const { data: posts } = postIds.length > 0
    ? await scoped(client, req.tenantId, 'scheduled_posts').select('status').in('id', postIds)
    : { data: [] };

  const whatsapp = (waCampaigns || []).reduce((acc, c) => ({
    totalRecipients: acc.totalRecipients + c.total_recipients, sent: acc.sent + c.sent_count,
    delivered: acc.delivered + c.delivered_count, read: acc.read + c.read_count, failed: acc.failed + c.failed_count
  }), { totalRecipients: 0, sent: 0, delivered: 0, read: 0, failed: 0 });

  const socialPosts = {
    total: (posts || []).length,
    published: (posts || []).filter((p) => p.status === 'published').length,
    failed: (posts || []).filter((p) => p.status === 'failed').length
  };

  res.json({ whatsapp, socialPosts });
}));

// -------------------------------------------------------------
// Automation rules (lib/automation.js is the engine; this is CRUD +
// a read-only view of recent firings)
// -------------------------------------------------------------

router.get('/marketing/automation-rules', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'automation_rules').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ rules: data });
}));

router.post('/marketing/automation-rules', requireHub('marketing'), requireRole('admin'), validate(automationRuleSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, triggerType, triggerConfig, actionType, actionConfig, isActive } = req.body;
  const { data, error } = await client.from('automation_rules').insert({
    tenant_id: req.tenantId, name, trigger_type: triggerType, trigger_config: triggerConfig,
    action_type: actionType, action_config: actionConfig, is_active: isActive, created_by: req.userId
  }).select('*').single();
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.automation_rule_created', targetType: 'automation_rule', targetId: data.id, metadata: { name, triggerType, actionType } });
  res.status(201).json({ rule: data });
}));

router.patch('/marketing/automation-rules/:id', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const patch = {};
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.isActive !== undefined) patch.is_active = req.body.isActive;
  if (req.body.triggerConfig !== undefined) patch.trigger_config = req.body.triggerConfig;
  if (req.body.actionConfig !== undefined) patch.action_config = req.body.actionConfig;
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  patch.updated_at = new Date().toISOString();

  const { data, error } = await scoped(client, req.tenantId, 'automation_rules').update(patch).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Rule not found.' });
  res.json({ rule: data });
}));

router.delete('/marketing/automation-rules/:id', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'automation_rules').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ success: true });
}));

router.get('/marketing/automation-rules/:id/runs', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'automation_runs').select('*').eq('rule_id', req.params.id).order('ran_at', { ascending: false }).limit(50);
  if (error) throw error;
  res.json({ runs: data });
}));

module.exports = router;
