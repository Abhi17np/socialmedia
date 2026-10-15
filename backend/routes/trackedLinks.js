/**
 * Tracked Links (migration 039) — the honest, minimal version of a
 * link-shortener this app can deliver: a tenant creates one for a
 * destination URL, pastes the returned short redirect URL into a
 * social post's content, and every click is tagged with real UTM
 * params (utm_source=<platform>, utm_medium=social, utm_content=<this
 * link's own id>) before landing on the destination. If that
 * destination is the tenant's own website with the Marketing Hub
 * tracking snippet installed (routes/tracking.js), the resulting
 * pageview carries those same UTM params straight into site_visits —
 * which is exactly what lib/attribution.js's new 'social' channel
 * reads. If it isn't (an external page, or no snippet), click_count
 * below is still a real, if cruder, "did this get used at all" signal.
 *
 * Same public/protected split as routes/social.js and routes/tracking.js:
 * the redirect is unauthenticated by necessity (anyone clicking a link
 * from a social post has no Bearer token), everything else is tenant-
 * scoped and authenticated.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { createTrackedLinkSchema, updateTrackedLinkSchema } = require('../lib/schemas');
const { appendUtmParams, shortUrlFor } = require('../lib/trackedLinks');
const { API_PREFIX } = require('../lib/apiPrefix');

const publicRouter = express.Router();
const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured.' });
    return null;
  }
  return client;
}

function apiBaseFor(req) {
  return (process.env.BACKEND_PUBLIC_URL || `${req.protocol}://${req.get('host')}`) + API_PREFIX;
}

/**
 * The actual redirect. The click-count increment is awaited before
 * redirecting — a few extra ms is an acceptable trade for a reliably
 * accurate count on what isn't a hot, high-QPS path; a failed count
 * update is logged but never blocks the redirect itself, since a real
 * person is waiting on the other end of this click.
 */
publicRouter.get('/t/:id', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { data: link } = await client.from('tracked_links').select('*').eq('id', req.params.id).maybeSingle();
  if (!link) return res.status(404).send('This link no longer exists.');

  let target;
  try {
    target = appendUtmParams(link.destination_url, {
      utm_source: link.platform || 'social',
      utm_medium: 'social',
      utm_campaign: link.label || undefined,
      utm_content: link.id
    });
  } catch {
    target = link.destination_url; // a destination that somehow stopped being a valid URL still redirects, just untagged, rather than 500ing on a real visitor
  }

  const { error: countError } = await client.from('tracked_links').update({ click_count: link.click_count + 1 }).eq('id', link.id);
  if (countError) console.error(`[trackedLinks] could not increment click_count for ${link.id}:`, countError.message);

  res.redirect(302, target);
}));

// member+ matches POST /social/posts' own bar — creating a tracked link is no more consequential than writing a post.
router.post('/social/tracked-links', requireRole('member'), validate(createTrackedLinkSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { destinationUrl, platform, label } = req.body;

  const { data, error } = await client.from('tracked_links').insert({
    tenant_id: req.tenantId, destination_url: destinationUrl, platform: platform || null, label: label || null, created_by: req.userId
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({ link: data, shortUrl: shortUrlFor(data.id, apiBaseFor(req)) });
}));

router.get('/social/tracked-links', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'tracked_links').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const apiBase = apiBaseFor(req);
  res.json({ links: (data || []).map((link) => ({ ...link, shortUrl: shortUrlFor(link.id, apiBase) })) });
}));

// Attaching a real scheduled_post_id after the fact (the post doesn't
// exist yet when the link is created — see this file's header) is
// optional enrichment, not required for attribution to work at all
// (utm_content already carries this link's own id either way); it just
// lets the UI show which specific post drove a given result.
router.patch('/social/tracked-links/:id', requireRole('member'), validate(updateTrackedLinkSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { scheduledPostId, label } = req.body;

  // Fetch-then-404-then-update, not an update().select().single() —
  // .single() errors (not just a null `data`) on zero matched rows, so
  // chaining it straight onto an update for a wrong-tenant or
  // nonexistent id would surface as a confusing 500 instead of a clean
  // 404. Same reasoning as every other PATCH in this codebase that
  // needs to distinguish "not found" from "something broke."
  const { data: existing, error: fetchError } = await scoped(client, req.tenantId, 'tracked_links').select('id').eq('id', req.params.id).maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Tracked link not found.' });

  if (scheduledPostId) {
    const { data: post } = await scoped(client, req.tenantId, 'scheduled_posts').select('id').eq('id', scheduledPostId).maybeSingle();
    if (!post) return res.status(404).json({ error: 'That post was not found.' });
  }

  const patch = {};
  if (scheduledPostId !== undefined) patch.scheduled_post_id = scheduledPostId;
  if (label !== undefined) patch.label = label;

  const { data, error } = await scoped(client, req.tenantId, 'tracked_links').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ link: { ...data, shortUrl: shortUrlFor(data.id, apiBaseFor(req)) } });
}));

module.exports = { router, publicRouter };
