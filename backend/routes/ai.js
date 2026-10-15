/**
 * AI Assist endpoints — mounted at `${API_PREFIX}/ai` behind requireAuth,
 * same tenant-scoping discipline as routes/social.js. Every draft here
 * is text the human still has to send themselves (Composer's Publish
 * button, Inbox's Send reply button); nothing in this file posts or
 * messages on its own. See backend/lib/ai.js for the actual Anthropic
 * calls and backend/lib/entitlements.js for the per-tenant monthly cap.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { assertWithinLimit, recordUsage } = require('../lib/entitlements');
const { validate } = require('../middleware/validate');
const { requireRole } = require('../middleware/tenant');
const { draftPostSchema, hashtagSuggestSchema, repurposeSchema, competitorGapsSchema } = require('../lib/schemas');
const { draftPost, draftReply, suggestHashtags, classifyMessage, repurposeContent, analyzeCompetitorGaps, summarizeCrisis, getAnthropicClient } = require('../lib/ai');
const { getBrandProfile, buildBrandContext, checkBrandViolations } = require('../lib/brandMemory');
const { findDuplicateWarning, mediaRequirementWarnings } = require('../lib/repurposing');
const { getUsableAccount } = require('../social/accounts');
const { gatherEvidence } = require('../lib/crisisEvidence');

const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

// member+ matches Compose's own nav gating (SocialNav.jsx) — drafting is
// harmless on its own, but keeping the bar consistent avoids a viewer
// having more reach through AI Assist than through the Composer itself.
router.post('/compose/draft', requireRole('member'), validate(draftPostSchema), async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    await assertWithinLimit(client, req.tenantId, 'aiGenerationsPerMonth');
    const { brief, platforms, tone } = req.body;
    const profile = await getBrandProfile(client, req.tenantId);
    const { draft } = await draftPost({ brief, platforms, tone, brandContext: buildBrandContext(profile) });
    await recordUsage(client, req.tenantId, 'aiGenerationsPerMonth');
    res.json({ draft, brandViolations: checkBrandViolations(draft, profile) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// viewer+ matches /social/inbox/:id/reply's own gating — no stricter
// bar for drafting a reply than for actually sending one.
router.post('/inbox/:id/draft-reply', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    await assertWithinLimit(client, req.tenantId, 'aiGenerationsPerMonth');

    const { data: message, error: msgErr } = await scoped(client, req.tenantId, 'inbox_messages').select('*').eq('id', req.params.id).single();
    if (msgErr || !message) return res.status(404).json({ error: 'Message not found.' });

    let contactName = message.sender;
    let history = [];
    if (message.contact_id) {
      const [{ data: contact }, { data: priorMessages }] = await Promise.all([
        scoped(client, req.tenantId, 'contacts').select('display_name').eq('id', message.contact_id).maybeSingle(),
        scoped(client, req.tenantId, 'inbox_messages').select('message, direction, received_at')
          .eq('contact_id', message.contact_id).order('received_at', { ascending: false }).limit(10)
      ]);
      if (contact && contact.display_name) contactName = contact.display_name;
      history = (priorMessages || []).reverse().map(m => ({ text: m.message, direction: m.direction }));
    }

    const { data: savedReplies } = await scoped(client, req.tenantId, 'saved_replies').select('title, body');
    const profile = await getBrandProfile(client, req.tenantId);

    const { draft } = await draftReply({
      contactName,
      platform: message.platform,
      incomingMessage: message.message,
      history,
      savedReplies: savedReplies || [],
      brandContext: buildBrandContext(profile)
    });

    await recordUsage(client, req.tenantId, 'aiGenerationsPerMonth');
    res.json({ draft, brandViolations: checkBrandViolations(draft, profile) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Same bar as /compose/draft — a second, separately-triggered call so a
// tenant can regenerate hashtags without losing a caption they liked.
router.post('/compose/hashtags', requireRole('member'), validate(hashtagSuggestSchema), async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    await assertWithinLimit(client, req.tenantId, 'aiGenerationsPerMonth');
    const { content, platforms } = req.body;
    const profile = await getBrandProfile(client, req.tenantId);
    const { hashtags } = await suggestHashtags({ content, platforms, brandContext: buildBrandContext(profile) });
    await recordUsage(client, req.tenantId, 'aiGenerationsPerMonth');
    res.json({ hashtags, brandViolations: checkBrandViolations(hashtags.join(' '), profile) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * AI Content Repurposing Studio: one piece of approved source content
 * turned into platform-tailored variants in one AI call (1 generation
 * against aiGenerationsPerMonth, same metering unit as /compose/draft
 * regardless of how many target platforms are requested). Every
 * variant is a draft a human still has to load into Composer, review,
 * and schedule/approve through the normal path — nothing here creates
 * a scheduled_posts row itself. member+ matches /compose/draft's bar.
 */
router.post('/compose/repurpose', requireRole('member'), validate(repurposeSchema), async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    await assertWithinLimit(client, req.tenantId, 'aiGenerationsPerMonth');
    const { sourceContent, targetPlatforms, hasMedia } = req.body;

    const profile = await getBrandProfile(client, req.tenantId);
    const { variants } = await repurposeContent({ sourceContent, targetPlatforms, brandContext: buildBrandContext(profile) });

    // Recent posts to check each variant against for a near-duplicate
    // repost — 90 days is generous enough to catch "I repurposed this
    // same source two months ago" without comparing against a tenant's
    // entire history on every call.
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentPosts } = await scoped(client, req.tenantId, 'scheduled_posts')
      .select('id, content, created_at').gte('created_at', since).order('created_at', { ascending: false });

    const results = {};
    for (const platform of targetPlatforms) {
      const text = typeof variants[platform] === 'string' ? variants[platform] : null;
      results[platform] = {
        content: text,
        brandViolations: text ? checkBrandViolations(text, profile) : [],
        duplicateWarning: text ? findDuplicateWarning(text, recentPosts || []) : null
      };
    }

    await recordUsage(client, req.tenantId, 'aiGenerationsPerMonth');
    res.json({ results, mediaWarnings: mediaRequirementWarnings(targetPlatforms, !!hasMedia) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// On-demand inbox triage — viewer+ matches the inbox's own read access;
// this never sends or routes anything, just labels the message for a
// human to prioritize off of.
router.post('/inbox/:id/analyze', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    await assertWithinLimit(client, req.tenantId, 'aiGenerationsPerMonth');
    const { data: message, error: msgErr } = await scoped(client, req.tenantId, 'inbox_messages').select('*').eq('id', req.params.id).single();
    if (msgErr || !message) return res.status(404).json({ error: 'Message not found.' });

    const { sentiment, urgent } = await classifyMessage({ text: message.message, platform: message.platform });
    const { data: updated, error } = await scoped(client, req.tenantId, 'inbox_messages')
      .update({ ai_sentiment: sentiment, ai_urgent: urgent }).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });

    await recordUsage(client, req.tenantId, 'aiGenerationsPerMonth');
    res.json({ sentiment: updated.ai_sentiment, urgent: updated.ai_urgent });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Competitor Opportunity Radar's content-gap analysis (lib/ai.js's
 * analyzeCompetitorGaps). member+ matches /compose/draft's own bar —
 * this is a drafting aid, not an action on its own. Fetches the
 * competitor's recent posts LIVE via the adapter's fetchCompetitor()
 * (not from competitor_snapshots, which only stores rolled-up metrics,
 * not caption text) and the tenant's own recent captions from
 * scheduled_posts, then returns each gap's evidence resolved back to
 * the actual competitor post it cites — see lib/ai.js's own header for
 * why the model's citation indices are re-validated before this point.
 * Checks AI Assist is actually configured BEFORE spending a live
 * fetchCompetitor() call against the viewer account's own API quota —
 * failing closed early here, not after that call, is the whole point
 * of "fail closed," not just its end state.
 */
router.post('/compose/competitor-gaps', requireRole('member'), validate(competitorGapsSchema), async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  if (!getAnthropicClient()) return res.status(503).json({ error: 'AI Assist is not configured (ANTHROPIC_API_KEY in backend/.env).' });

  try {
    await assertWithinLimit(client, req.tenantId, 'aiGenerationsPerMonth');
    const { trackedCompetitorId } = req.body;

    const { data: competitor, error: compErr } = await scoped(client, req.tenantId, 'tracked_competitors').select('*').eq('id', trackedCompetitorId).maybeSingle();
    if (compErr) return res.status(500).json({ error: compErr.message });
    if (!competitor) return res.status(404).json({ error: 'Tracked competitor not found.' });

    const usable = await getUsableAccount(req.tenantId, competitor.viewer_account_id);
    if (!usable || typeof usable.adapter.fetchCompetitor !== 'function') {
      return res.status(503).json({ error: 'The connected account used to view this competitor is no longer available.' });
    }
    const live = await usable.adapter.fetchCompetitor(usable.account, competitor.handle);
    const competitorPosts = live.posts.filter((p) => p.caption);
    if (competitorPosts.length === 0) {
      return res.status(422).json({ error: `@${competitor.handle} has no recent captioned posts to compare against.` });
    }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: ownPosts } = await scoped(client, req.tenantId, 'scheduled_posts').select('content')
      .eq('status', 'published').gte('scheduled_at', since).contains('target_account_ids', [competitor.viewer_account_id]).limit(20);

    const profile = await getBrandProfile(client, req.tenantId);
    const { gaps } = await analyzeCompetitorGaps({
      ownCaptions: (ownPosts || []).map((p) => p.content).filter(Boolean),
      competitorCaptions: competitorPosts.map((p) => p.caption),
      competitorLabel: competitor.label || `@${competitor.handle}`,
      brandContext: buildBrandContext(profile)
    });

    // Resolve each gap's 1-based evidence indices back to the real post
    // objects (caption + permalink) so the UI shows an actual, clickable
    // source instead of a bare number — the whole point of citing at all.
    const resolvedGaps = gaps.map((g) => ({
      ...g,
      evidence: g.evidence.map((i) => ({ caption: competitorPosts[i - 1].caption, permalinkUrl: competitorPosts[i - 1].permalinkUrl }))
    }));

    await recordUsage(client, req.tenantId, 'aiGenerationsPerMonth');
    res.json({ gaps: resolvedGaps });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Crisis Intelligence's optional summary (lib/ai.js's summarizeCrisis).
 * viewer+ matches /inbox/:id/analyze's own bar — reading a summary of
 * already-visible messages is no more privileged than reading the
 * messages themselves. Reads the exact same real evidence the alert's
 * own detail view shows (lib/crisisEvidence.js), never a second,
 * possibly-different query. Checks AI Assist is configured before doing
 * any work, same "fail closed early" discipline as the competitor-gaps
 * endpoint above.
 */
router.post('/crisis-alerts/:id/summarize', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  if (!getAnthropicClient()) return res.status(503).json({ error: 'AI Assist is not configured (ANTHROPIC_API_KEY in backend/.env).' });

  try {
    await assertWithinLimit(client, req.tenantId, 'aiGenerationsPerMonth');

    const { data: alert, error: alertErr } = await scoped(client, req.tenantId, 'crisis_alerts').select('*').eq('id', req.params.id).maybeSingle();
    if (alertErr) return res.status(500).json({ error: alertErr.message });
    if (!alert) return res.status(404).json({ error: 'Crisis alert not found.' });

    const messages = await gatherEvidence(client, req.tenantId, alert.window_start, alert.window_end);
    if (messages.length === 0) {
      return res.status(422).json({ error: 'No messages were found for this alert\'s window — nothing to summarize.' });
    }

    const profile = await getBrandProfile(client, req.tenantId);
    const { themes, priorityMessages, note } = await summarizeCrisis({ messages, brandContext: buildBrandContext(profile) });

    // Resolve 1-based indices back to the real message objects — same
    // "never hand back a bare number" discipline as the competitor-gaps
    // endpoint's evidence resolution above.
    const resolvedThemes = themes.map((t) => ({ theme: t.theme, evidence: t.evidence.map((i) => messages[i - 1]) }));
    const resolvedPriority = priorityMessages.map((i) => messages[i - 1]);

    await recordUsage(client, req.tenantId, 'aiGenerationsPerMonth');
    res.json({ themes: resolvedThemes, priorityMessages: resolvedPriority, note });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
