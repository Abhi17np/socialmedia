/**
 * Marketing Hub Phase 9: AI Assist endpoints. Same posture as
 * routes/ai.js — every response is a draft for a human to review, metered
 * against the same `aiGenerationsPerMonth` cost center, fails closed
 * (503) when ANTHROPIC_API_KEY isn't configured. See lib/marketingAi.js
 * for the actual prompts/validation.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { assertWithinLimit, recordUsage } = require('../lib/entitlements');
const { validate } = require('../middleware/validate');
const { requireRole } = require('../middleware/tenant');
const { requireHub } = require('../middleware/hubs');
const { asyncHandler } = require('../lib/asyncHandler');
const {
  aiEmailCopySchema, aiSmsCopySchema, aiSegmentFilterSchema, aiInsightsSchema
} = require('../lib/schemas');
const {
  generateEmailCopy, generateSmsCopy, generateSegmentFilter, generateInsights
} = require('../lib/marketingAi');

const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

async function withBrandVoice(client, tenantId) {
  const { data } = await client.from('tenants').select('marketing_brand_voice').eq('id', tenantId).maybeSingle();
  return data?.marketing_brand_voice || null;
}

async function metered(req, res, run) {
  const client = requireSocialClient(res);
  if (!client) return;
  try {
    await assertWithinLimit(client, req.tenantId, 'aiGenerationsPerMonth');
    const result = await run(client);
    await recordUsage(client, req.tenantId, 'aiGenerationsPerMonth');
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}

router.post('/marketing/ai/email-copy', requireHub('marketing'), requireRole('member'), validate(aiEmailCopySchema), asyncHandler(async (req, res) => {
  await metered(req, res, async (client) => {
    const brandVoice = await withBrandVoice(client, req.tenantId);
    return generateEmailCopy({ ...req.body, brandVoice });
  });
}));

router.post('/marketing/ai/sms-copy', requireHub('marketing'), requireRole('member'), validate(aiSmsCopySchema), asyncHandler(async (req, res) => {
  await metered(req, res, async (client) => {
    const brandVoice = await withBrandVoice(client, req.tenantId);
    return generateSmsCopy({ ...req.body, brandVoice });
  });
}));

router.post('/marketing/ai/segment-filter', requireHub('marketing'), requireRole('member'), validate(aiSegmentFilterSchema), asyncHandler(async (req, res) => {
  await metered(req, res, async () => generateSegmentFilter(req.body));
}));

router.post('/marketing/ai/insights', requireHub('marketing'), requireRole('member'), validate(aiInsightsSchema), asyncHandler(async (req, res) => {
  await metered(req, res, async (client) => {
    const brandVoice = await withBrandVoice(client, req.tenantId);
    return generateInsights({ overview: req.body.overview, brandVoice });
  });
}));

module.exports = router;
