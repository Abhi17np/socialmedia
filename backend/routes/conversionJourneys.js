/**
 * Social-to-WhatsApp Conversion Journeys — the focused, ungated
 * authoring surface for ONE trigger type (`social_message_received`,
 * fired from social/pollers.js) over the SAME journey engine Marketing
 * Hub's full journey builder (routes/journeys.js) already runs on.
 * Deliberately not the full graph editor: every journey created here
 * is a fixed trigger -> delay -> send_whatsapp shape (built with
 * lib/journeyTemplates.js's existing chain() helper, no conditions or
 * splits) — a named scope cut in favor of a zero-friction, always-on
 * surface, the same "WhatsApp broadcast is Social Hub's own feature,
 * not behind the commercial gate" posture README.md already
 * establishes. A tenant who wants branching and already has Marketing
 * Hub enabled can still build one with the full journeySchema using
 * this exact same trigger type — nothing here is exclusive to this
 * surface at the data layer, only at the authoring layer.
 *
 * Every query below filters on trigger_type = 'social_message_received'
 * in addition to tenant scoping, so this ungated surface can only ever
 * see/touch journeys of its own kind — never an unrelated Marketing
 * Hub journey, even though both live in the same workflow_definitions
 * table.
 *
 * Consent (filterConsentedContacts) and template-approval enforcement
 * are NOT duplicated here — lib/journeyActions.js's sendWhatsapp()
 * already does both, unconditionally, for every journey regardless of
 * which surface created it.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { validateGraph, JourneyGraphError } = require('../lib/journeyGraph');
const { chain } = require('../lib/journeyTemplates');
const { conversionJourneySchema } = require('../lib/schemas');

const TRIGGER_TYPE = 'social_message_received';
const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured.' });
    return null;
  }
  return client;
}

function buildGraph({ delayAmount, delayUnit, templateId, socialAccountId, variableValues }) {
  return chain(TRIGGER_TYPE, {}, [
    { id: 'wait', type: 'delay', config: { amount: delayAmount, unit: delayUnit } },
    { id: 'send', type: 'action', actionType: 'send_whatsapp', config: { templateId, socialAccountId, variableValues } }
  ]).graph;
}

router.post('/social/conversion-journeys', requireRole('member'), validate(conversionJourneySchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, platform, delayAmount, delayUnit, templateId, socialAccountId, variableValues } = req.body;

  const { data: template } = await scoped(client, req.tenantId, 'whatsapp_templates').select('id').eq('id', templateId).maybeSingle();
  if (!template) return res.status(404).json({ error: 'WhatsApp template not found.' });
  const { data: account } = await scoped(client, req.tenantId, 'social_accounts').select('id, platform').eq('id', socialAccountId).maybeSingle();
  if (!account) return res.status(404).json({ error: 'Connected account not found.' });
  if (account.platform !== 'whatsapp') return res.status(400).json({ error: 'socialAccountId must be a connected WhatsApp account.' });

  const graph = buildGraph({ delayAmount, delayUnit, templateId, socialAccountId, variableValues });
  try {
    validateGraph(graph);
  } catch (err) {
    if (!(err instanceof JourneyGraphError)) throw err;
    return res.status(400).json({ error: err.message });
  }

  // trigger_config only filters by platform when the tenant actually
  // asked for that — omitting it (undefined) means "any platform",
  // matching fireWorkflowTrigger()'s own
  // `Object.entries(trigger_config).every(...)` semantics (an empty
  // object always matches).
  const { data, error } = await client.from('workflow_definitions').insert({
    tenant_id: req.tenantId, name, trigger_type: TRIGGER_TYPE, trigger_config: platform ? { platform } : {},
    graph_json: graph, is_active: false, created_by: req.userId
  }).select('*').single();
  if (error) return res.status(500).json({ error: error.message });

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'social.conversion_journey.created', targetType: 'workflow_definition', targetId: data.id, metadata: { name, platform: platform || 'any' } });
  res.status(201).json({ journey: data });
}));

router.get('/social/conversion-journeys', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'workflow_definitions').select('*').eq('trigger_type', TRIGGER_TYPE).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ journeys: data });
}));

router.get('/social/conversion-journeys/:id', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'workflow_definitions').select('*').eq('id', req.params.id).eq('trigger_type', TRIGGER_TYPE).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Conversion journey not found.' });
  res.json({ journey: data });
}));

router.patch('/social/conversion-journeys/:id/activate', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: existing, error: fetchError } = await scoped(client, req.tenantId, 'workflow_definitions').select('id, graph_json').eq('id', req.params.id).eq('trigger_type', TRIGGER_TYPE).maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Conversion journey not found.' });
  try {
    validateGraph(existing.graph_json);
  } catch (err) {
    if (!(err instanceof JourneyGraphError)) throw err;
    return res.status(400).json({ error: err.message });
  }

  const { data, error } = await client.from('workflow_definitions').update({ is_active: true, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'social.conversion_journey.activated', targetType: 'workflow_definition', targetId: req.params.id });
  res.json({ journey: data });
}));

router.patch('/social/conversion-journeys/:id/pause', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: existing, error: fetchError } = await scoped(client, req.tenantId, 'workflow_definitions').select('id').eq('id', req.params.id).eq('trigger_type', TRIGGER_TYPE).maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Conversion journey not found.' });

  const { data, error } = await client.from('workflow_definitions').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'social.conversion_journey.paused', targetType: 'workflow_definition', targetId: req.params.id });
  res.json({ journey: data });
}));

router.delete('/social/conversion-journeys/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: existing, error: fetchError } = await scoped(client, req.tenantId, 'workflow_definitions').select('id').eq('id', req.params.id).eq('trigger_type', TRIGGER_TYPE).maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Conversion journey not found.' });

  const { error } = await scoped(client, req.tenantId, 'workflow_definitions').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'social.conversion_journey.deleted', targetType: 'workflow_definition', targetId: req.params.id });
  res.json({ success: true });
}));

router.get('/social/conversion-journeys/:id/enrollments', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: journey, error: fetchError } = await scoped(client, req.tenantId, 'workflow_definitions').select('id').eq('id', req.params.id).eq('trigger_type', TRIGGER_TYPE).maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!journey) return res.status(404).json({ error: 'Conversion journey not found.' });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  const { data, error, count } = await scoped(client, req.tenantId, 'workflow_enrollments').select('*, contacts(display_name, email, phone)', { count: 'exact' })
    .eq('workflow_id', journey.id).order('enrolled_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ enrollments: data, page, pageSize, total: count });
}));

module.exports = router;
