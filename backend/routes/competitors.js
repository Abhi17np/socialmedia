/**
 * Competitor Opportunity Radar (migration 040). CRUD for
 * tracked_competitors + a comparison view against the tenant's OWN
 * account — reusing the real per-post analytics pipeline (migration
 * 036) and account-level follower snapshots (migration 002) already
 * collected for the tenant's own accounts, not a fresh API call, since
 * that data already exists. The content-gap AI endpoint lives in
 * routes/ai.js (lib/ai.js's analyzeCompetitorGaps), same file every
 * other AI Assist feature lives in.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { createTrackedCompetitorSchema } = require('../lib/schemas');
const { averageEngagementRate } = require('../lib/competitorRadar');
const { FOLLOWER_METRIC } = require('../lib/socialMetrics');
const ADAPTERS = require('../social/adapters');

const router = express.Router();
const OWN_COMPARISON_WINDOW_DAYS = 30;

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured.' });
    return null;
  }
  return client;
}

// member+ matches POST /social/posts' own bar.
router.post('/social/competitors', requireRole('member'), validate(createTrackedCompetitorSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { platform, handle, label, viewerAccountId } = req.body;

  const adapter = ADAPTERS[platform];
  if (!adapter || typeof adapter.fetchCompetitor !== 'function') {
    return res.status(400).json({ error: `Competitor tracking isn't available for ${platform} yet — see that platform adapter's own header for the specific reason (usually a Meta/platform permission this app doesn't have).` });
  }
  const { data: viewerAccount } = await scoped(client, req.tenantId, 'social_accounts').select('id, platform').eq('id', viewerAccountId).maybeSingle();
  if (!viewerAccount) return res.status(404).json({ error: 'Connected account not found.' });
  if (viewerAccount.platform !== platform) return res.status(400).json({ error: `viewerAccountId must be a connected ${platform} account.` });

  const { data, error } = await client.from('tracked_competitors').insert({
    tenant_id: req.tenantId, platform, handle, label: label || null, viewer_account_id: viewerAccountId, created_by: req.userId
  }).select().single();
  if (error) {
    const conflict = /duplicate key|unique/i.test(error.message);
    return res.status(conflict ? 409 : 500).json({ error: conflict ? `@${handle} on ${platform} is already tracked.` : error.message });
  }

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'social.competitor.tracked', targetType: 'tracked_competitor', targetId: data.id, metadata: { platform, handle } });
  res.status(201).json({ competitor: data });
}));

router.get('/social/competitors', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'tracked_competitors').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ competitors: data });
}));

/** Sums (likes+comments) from the tenant's own recent post_analytics against viewerAccountId, averaged per post and divided by the account's latest follower count — the exact same formula lib/competitorRadar.js's averageEngagementRate uses for the competitor, so the two numbers are directly comparable. */
async function ownEngagementRate(client, tenantId, viewerAccountId, platform) {
  const since = new Date(Date.now() - OWN_COMPARISON_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: ownPosts } = await scoped(client, tenantId, 'scheduled_posts').select('id').eq('status', 'published').gte('scheduled_at', since).contains('target_account_ids', [viewerAccountId]);
  const postIds = (ownPosts || []).map((p) => p.id);

  const { data: followerRow } = await client.from('analytics_snapshots').select('value').eq('social_account_id', viewerAccountId)
    .eq('metric', FOLLOWER_METRIC[platform] || 'followers').order('captured_date', { ascending: false }).limit(1).maybeSingle();
  const followers = followerRow ? Number(followerRow.value) : 0;
  if (postIds.length === 0 || !followers) return { rate: 0, postsCompared: 0, followers };

  const { data: analyticsRows } = await client.from('post_analytics').select('scheduled_post_id, metric, value').in('scheduled_post_id', postIds).eq('social_account_id', viewerAccountId);
  const byPost = new Map();
  for (const row of analyticsRows || []) {
    if (!['likes', 'comments'].includes(row.metric)) continue;
    const current = byPost.get(row.scheduled_post_id) || { likes: 0, comments: 0 };
    current[row.metric] = Number(row.value) || 0; // post_analytics is itself a time series; this is a reasonable simplification (last-seen per metric, not re-sorted by date here) for a "rough own-side comparator," not the headline number
    byPost.set(row.scheduled_post_id, current);
  }
  const pseudoPosts = [...byPost.values()];
  return { rate: averageEngagementRate(pseudoPosts, followers), postsCompared: pseudoPosts.length, followers };
}

router.get('/social/competitors/:id', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: competitor, error } = await scoped(client, req.tenantId, 'tracked_competitors').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!competitor) return res.status(404).json({ error: 'Tracked competitor not found.' });

  const { data: snapshotRows } = await client.from('competitor_snapshots').select('metric, value, captured_date').eq('tracked_competitor_id', competitor.id).order('captured_date', { ascending: true });
  const latest = {};
  for (const row of snapshotRows || []) latest[row.metric] = Number(row.value); // ordered ascending, so the last write per metric is the latest

  const own = await ownEngagementRate(client, req.tenantId, competitor.viewer_account_id, competitor.platform);

  res.json({
    competitor,
    history: snapshotRows || [],
    competitorLatest: { followers: latest.followers ?? null, mediaCount: latest.media_count ?? null, postsInWindow: latest.posts_in_window ?? null, avgEngagementRate: latest.avg_engagement_rate ?? null },
    own: { followers: own.followers, avgEngagementRate: own.rate, postsCompared: own.postsCompared }
  });
}));

router.delete('/social/competitors/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: existing, error: fetchError } = await scoped(client, req.tenantId, 'tracked_competitors').select('id').eq('id', req.params.id).maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Tracked competitor not found.' });

  const { error } = await scoped(client, req.tenantId, 'tracked_competitors').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'social.competitor.untracked', targetType: 'tracked_competitor', targetId: req.params.id });
  res.json({ success: true });
}));

module.exports = router;
