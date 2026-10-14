/**
 * Marketing Hub Phase 4: journeys. CRUD + activation for
 * workflow_definitions (migrations/015 + 028), manual enrollment,
 * enrollment listing, and journey-level analytics computed from
 * workflow_enrollment_events — the per-node step log
 * lib/journeyEngine.js writes on every transition.
 *
 * The engine itself (lib/journeyEngine.js, lib/journeyGraph.js,
 * lib/journeyActions.js) is the part that actually runs a journey; this
 * file is purely the authoring/management surface over it, same
 * separation as routes/marketing.js vs lib/automation.js.
 */

const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped, updateScopedWithVersion } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { requireHub } = require('../middleware/hubs');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { validateGraph, JourneyGraphError } = require('../lib/journeyGraph');
const { enrollContact } = require('../lib/journeyEngine');
const { JOURNEY_TEMPLATES } = require('../lib/journeyTemplates');
const { journeySchema, journeyEnrollSchema } = require('../lib/schemas');

const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

function validateGraphOr400(res, graph) {
  try {
    validateGraph(graph);
    return true;
  } catch (err) {
    if (err instanceof JourneyGraphError) { res.status(400).json({ error: err.message }); return false; }
    throw err;
  }
}

router.get('/marketing/journeys/templates', requireHub('marketing'), asyncHandler(async (req, res) => {
  const templates = Object.entries(JOURNEY_TEMPLATES).map(([key, t]) => ({ key, name: t.name, description: t.description, triggerType: t.triggerType }));
  res.json({ templates });
}));

router.get('/marketing/journeys', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'workflow_definitions').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ journeys: data });
}));

router.post('/marketing/journeys', requireHub('marketing'), requireRole('member'), validate(journeySchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, description, triggerType, triggerConfig, graph, reentryAllowed, goalConfig } = req.body;
  if (!validateGraphOr400(res, graph)) return;

  const { data, error } = await client.from('workflow_definitions').insert({
    tenant_id: req.tenantId, name, description: description || null, trigger_type: triggerType, trigger_config: triggerConfig,
    graph_json: graph, reentry_allowed: reentryAllowed, goal_config: goalConfig || null, is_active: false, created_by: req.userId
  }).select('*').single();
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.journey_created', targetType: 'workflow_definition', targetId: data.id, metadata: { name } });
  res.status(201).json({ journey: data });
}));

router.post('/marketing/journeys/from-template/:templateKey', requireHub('marketing'), requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const template = JOURNEY_TEMPLATES[req.params.templateKey];
  if (!template) return res.status(404).json({ error: 'Unknown journey template.' });

  const { data, error } = await client.from('workflow_definitions').insert({
    tenant_id: req.tenantId, name: template.name, description: template.description, trigger_type: template.triggerType,
    trigger_config: template.triggerConfig, graph_json: template.graph, is_active: false, created_by: req.userId
  }).select('*').single();
  if (error) throw error;
  res.status(201).json({ journey: data });
}));

router.get('/marketing/journeys/:id', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'workflow_definitions').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Journey not found.' });
  res.json({ journey: data });
}));

router.patch('/marketing/journeys/:id', requireHub('marketing'), requireRole('member'), validate(journeySchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { name, description, triggerType, triggerConfig, graph, reentryAllowed, goalConfig, version } = req.body;
  if (!validateGraphOr400(res, graph)) return;

  // Editing a live (is_active) journey is allowed (task brief: "safe
  // edits to live journeys") but a real limitation, not a false
  // guarantee: an enrollment currently paused at a node id that this
  // edit removes or renames will fail its next tick (lib/journeyEngine.js
  // can't find the node) rather than silently continuing on stale logic.
  // Full graph-versioning per in-flight enrollment is real future work,
  // not attempted here — see docs/MARKETING_HUB_IMPLEMENTATION.md.
  const result = await updateScopedWithVersion(client, req.tenantId, 'workflow_definitions', req.params.id, {
    name, description: description || null, trigger_type: triggerType, trigger_config: triggerConfig,
    graph_json: graph, reentry_allowed: reentryAllowed, goal_config: goalConfig || null, updated_at: new Date().toISOString()
  }, version);
  if (result.notFound) return res.status(404).json({ error: 'Journey not found.' });
  if (result.conflict) return res.status(409).json({ error: 'This journey was changed by someone else since you loaded it. Reload to see the latest version.', code: 'VERSION_CONFLICT', currentVersion: result.currentVersion });
  if (result.error) throw result.error;
  res.json({ journey: result.data });
}));

router.patch('/marketing/journeys/:id/activate', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: journey } = await scoped(client, req.tenantId, 'workflow_definitions').select('*').eq('id', req.params.id).maybeSingle();
  if (!journey) return res.status(404).json({ error: 'Journey not found.' });
  if (!validateGraphOr400(res, journey.graph_json)) return;

  const { data, error } = await client.from('workflow_definitions').update({ is_active: true, updated_at: new Date().toISOString() }).eq('id', journey.id).select('*').single();
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.journey_activated', targetType: 'workflow_definition', targetId: journey.id });
  res.json({ journey: data });
}));

router.patch('/marketing/journeys/:id/pause', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data, error } = await scoped(client, req.tenantId, 'workflow_definitions').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Journey not found.' });
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.journey_paused', targetType: 'workflow_definition', targetId: req.params.id });
  res.json({ journey: data });
}));

router.post('/marketing/journeys/:id/clone', requireHub('marketing'), requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: original } = await scoped(client, req.tenantId, 'workflow_definitions').select('*').eq('id', req.params.id).maybeSingle();
  if (!original) return res.status(404).json({ error: 'Journey not found.' });

  const { data, error } = await client.from('workflow_definitions').insert({
    tenant_id: req.tenantId, name: `${original.name} (copy)`, description: original.description, trigger_type: original.trigger_type,
    trigger_config: original.trigger_config, graph_json: original.graph_json, reentry_allowed: original.reentry_allowed,
    goal_config: original.goal_config, is_active: false, created_by: req.userId
  }).select('*').single();
  if (error) throw error;
  res.status(201).json({ journey: data });
}));

router.delete('/marketing/journeys/:id', requireHub('marketing'), requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { error } = await scoped(client, req.tenantId, 'workflow_definitions').delete().eq('id', req.params.id);
  if (error) throw error;
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.journey_deleted', targetType: 'workflow_definition', targetId: req.params.id });
  res.json({ success: true });
}));

router.post('/marketing/journeys/:id/enroll', requireHub('marketing'), requireRole('member'), validate(journeyEnrollSchema), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: contact } = await scoped(client, req.tenantId, 'contacts').select('id').eq('id', req.body.contactId).maybeSingle();
  if (!contact) return res.status(400).json({ error: 'Contact not found.' });
  try {
    const result = await enrollContact(client, req.tenantId, req.params.id, req.body.contactId);
    await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'marketing.journey_manual_enroll', targetType: 'workflow_definition', targetId: req.params.id, metadata: { contactId: req.body.contactId } });
    res.status(result.alreadyEnrolled ? 200 : 201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.get('/marketing/journeys/:id/enrollments', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  const { data, error, count } = await scoped(client, req.tenantId, 'workflow_enrollments').select('*, contacts(display_name, email, phone)', { count: 'exact' })
    .eq('workflow_id', req.params.id).order('enrolled_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw error;
  res.json({ enrollments: data, page, pageSize, total: count });
}));

router.get('/marketing/journeys/:id/analytics', requireHub('marketing'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: journey } = await scoped(client, req.tenantId, 'workflow_definitions').select('id, graph_json').eq('id', req.params.id).maybeSingle();
  if (!journey) return res.status(404).json({ error: 'Journey not found.' });

  const { data: enrollments, error } = await scoped(client, req.tenantId, 'workflow_enrollments').select('status').eq('workflow_id', journey.id);
  if (error) throw error;
  const totals = { entered: (enrollments || []).length, active: 0, completed: 0, exited: 0, goal_met: 0, failed: 0 };
  for (const e of enrollments || []) totals[e.status] = (totals[e.status] || 0) + 1;

  const { data: enrollmentIds } = await scoped(client, req.tenantId, 'workflow_enrollments').select('id').eq('workflow_id', journey.id);
  const ids = (enrollmentIds || []).map((e) => e.id);
  let perNode = [];
  if (ids.length > 0) {
    const { data: events, error: evErr } = await client.from('workflow_enrollment_events').select('node_id, event_type').in('enrollment_id', ids);
    if (evErr) throw evErr;
    const byNode = {};
    for (const ev of events || []) {
      byNode[ev.node_id] = byNode[ev.node_id] || { entered: 0, completed: 0, failed: 0 };
      if (ev.event_type === 'entered' || ev.event_type === 'completed') byNode[ev.node_id].entered += 1;
      if (ev.event_type === 'completed') byNode[ev.node_id].completed += 1;
      if (ev.event_type === 'failed') byNode[ev.node_id].failed += 1;
    }
    perNode = Object.entries(byNode).map(([nodeId, counts]) => ({ nodeId, ...counts }));
  }

  const conversionRate = totals.entered > 0 ? Math.round((totals.goal_met / totals.entered) * 1000) / 10 : 0;
  res.json({ totals, conversionRate, perNode });
}));

module.exports = router;
