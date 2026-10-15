/**
 * AI Content Experiment Engine (migration 038). Every experiment
 * groups exactly two ALREADY-EXISTING scheduled_posts rows as its
 * variants — this file never creates, approves, or schedules a post
 * itself, so an experiment variant is gated by the exact same approval
 * workflow, plan limits, and consent checks as any other post, through
 * the one real creation path (POST /social/posts). Decisions are made
 * by lib/experimentSweep.js, on a timer, using lib/experimentStats.js's
 * real two-proportion z-test — this file only creates/reads/cancels.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { createExperimentSchema } = require('../lib/schemas');
const { gatherVariantStats } = require('../lib/experimentSweep');
const { evaluateExperiment } = require('../lib/experimentStats');

const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

/**
 * Both referenced posts must: belong to this tenant, not already be a
 * variant of another experiment (the DB's own unique(scheduled_post_id)
 * is the final guard, but checking first gives a clear 400 instead of a
 * raw constraint-violation error), target exactly one account each (a
 * multi-account post variant would make "same audience" ambiguous), and
 * target the SAME account as each other — the "same audience" / apples-
 * to-apples comparison this app can honestly make without a deeper
 * cross-account normalization model.
 */
async function resolveAndValidateVariants(client, tenantId, variantInputs) {
  const posts = await Promise.all(
    variantInputs.map((v) => scoped(client, tenantId, 'scheduled_posts').select('id, target_account_ids, status').eq('id', v.scheduledPostId).maybeSingle())
  );

  const resolved = [];
  for (let i = 0; i < variantInputs.length; i++) {
    const { data: post, error } = posts[i];
    if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
    if (!post) throw Object.assign(new Error(`Post ${variantInputs[i].scheduledPostId} not found.`), { statusCode: 404 });
    if ((post.target_account_ids || []).length !== 1) {
      throw Object.assign(new Error(`Variant ${variantInputs[i].key}'s post must target exactly one account — an experiment compares variants on the same audience.`), { statusCode: 400 });
    }
    resolved.push({ key: variantInputs[i].key, scheduledPostId: post.id, socialAccountId: post.target_account_ids[0] });
  }

  const [first, second] = resolved;
  if (first.socialAccountId !== second.socialAccountId) {
    throw Object.assign(new Error('Both variants must target the same connected account — this app compares variants on one audience, not across different ones.'), { statusCode: 400 });
  }

  return resolved;
}

// member+ matches POST /social/posts' own bar — creating an experiment
// is no more consequential than scheduling a post, since both posts
// already exist and go through their own approval workflow regardless.
router.post('/experiments', requireRole('member'), validate(createExperimentSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { name, variable, minSampleSize, confidenceLevel, minObservationHours, variants } = req.body;
  let resolvedVariants;
  try {
    resolvedVariants = await resolveAndValidateVariants(client, req.tenantId, variants);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }

  const { data: experiment, error } = await client.from('content_experiments').insert({
    tenant_id: req.tenantId,
    name,
    variable,
    min_sample_size: minSampleSize,
    confidence_level: confidenceLevel,
    min_observation_hours: minObservationHours,
    created_by: req.userId
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  const { error: variantsError } = await client.from('content_experiment_variants').insert(
    resolvedVariants.map((v) => ({
      tenant_id: req.tenantId,
      experiment_id: experiment.id,
      variant_key: v.key,
      scheduled_post_id: v.scheduledPostId,
      social_account_id: v.socialAccountId
    }))
  );
  if (variantsError) {
    await client.from('content_experiments').delete().eq('id', experiment.id); // roll back the experiment row rather than leave an orphan with no variants
    const conflict = /duplicate key|unique/i.test(variantsError.message);
    return res.status(conflict ? 409 : 500).json({ error: conflict ? 'One of these posts is already a variant of another experiment.' : variantsError.message });
  }

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'social.experiment.created', targetType: 'content_experiment', targetId: experiment.id, metadata: { variable, variants: resolvedVariants.map((v) => v.key) } });
  res.status(201).json({ experiment });
}));

router.get('/experiments', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'content_experiments').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ experiments: data });
}));

/**
 * Detail view: the stored decision (if any) plus, for a still-`running`
 * experiment, a LIVE preview computed the exact same way the sweep
 * itself will (lib/experimentSweep.js's gatherVariantStats +
 * lib/experimentStats.js's evaluateExperiment) — so a tenant watching a
 * running experiment sees real current numbers, not silence until it
 * resolves. This never writes a decision; only the sweep does that.
 */
router.get('/experiments/:id', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { data: experiment, error } = await scoped(client, req.tenantId, 'content_experiments').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!experiment) return res.status(404).json({ error: 'Experiment not found.' });

  const { data: variants, error: variantsError } = await scoped(client, req.tenantId, 'content_experiment_variants')
    .select('id, variant_key, scheduled_post_id, social_account_id, scheduled_posts(id, status, scheduled_at, content), social_accounts(platform, account_label)')
    .eq('experiment_id', experiment.id);
  if (variantsError) return res.status(500).json({ error: variantsError.message });

  let preview = null;
  if (experiment.status === 'running' && variants && variants.length === 2) {
    try {
      const stats = [];
      for (const v of variants) {
        const gathered = await gatherVariantStats(client, { social_account_id: v.social_account_id, platform: v.social_accounts.platform }, v.scheduled_posts);
        stats.push(gathered ? { key: v.variant_key, engagements: gathered.engagements, audience: gathered.audience } : { key: v.variant_key, engagements: null, audience: null });
      }
      if (stats.every((s) => s.audience !== null)) {
        preview = evaluateExperiment(stats, { minSampleSize: experiment.min_sample_size, confidenceLevel: experiment.confidence_level });
        preview.isPreview = true; // a live snapshot, not yet the sweep's own recorded decision
      } else {
        preview = { decision: 'pending', note: 'Waiting on analytics data for one or both variants (data is ingested roughly every 6 hours after each post publishes).' };
      }
    } catch (err) {
      preview = { decision: 'pending', note: `Could not compute a live preview yet: ${err.message}` };
    }
  }

  res.json({ experiment, variants, preview });
}));

// admin+ — cancelling an in-flight experiment is a governance action,
// same bar as /social/approval-settings.
router.patch('/experiments/:id/cancel', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { data: existing, error: fetchError } = await scoped(client, req.tenantId, 'content_experiments').select('id, status').eq('id', req.params.id).maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Experiment not found.' });
  if (existing.status !== 'running') return res.status(400).json({ error: `Cannot cancel an experiment with status "${existing.status}".` });

  const { data, error } = await scoped(client, req.tenantId, 'content_experiments').update({ status: 'cancelled' }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'social.experiment.cancelled', targetType: 'content_experiment', targetId: req.params.id });
  res.json({ experiment: data });
}));

module.exports = router;
