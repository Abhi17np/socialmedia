/**
 * Crisis Intelligence (migration 041). Alerts are created only by
 * social/crisisSweep.js's real surge-detection sweep — there is no
 * manual "create alert" endpoint, since fabricating one would mean a
 * human typing in a number this app didn't actually measure. This file
 * is read + the human-decides lifecycle (acknowledge/resolve) around
 * whatever the sweep found, plus the real evidence (the actual messages
 * that make up the flagged window) behind each alert.
 */
const express = require('express');
const { getSocialClient } = require('../social/db');
const { scoped } = require('../lib/query');
const { requireRole } = require('../middleware/tenant');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { gatherEvidence } = require('../lib/crisisEvidence');

const router = express.Router();

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Database not configured.' });
    return null;
  }
  return client;
}

router.get('/social/crisis-alerts', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  let query = scoped(client, req.tenantId, 'crisis_alerts').select('*').order('created_at', { ascending: false });
  if (req.query.status) query = query.eq('status', req.query.status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ alerts: data });
}));

router.get('/social/crisis-alerts/:id', asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: alert, error } = await scoped(client, req.tenantId, 'crisis_alerts').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!alert) return res.status(404).json({ error: 'Crisis alert not found.' });

  const messages = await gatherEvidence(client, req.tenantId, alert.window_start, alert.window_end);
  res.json({ alert, messages });
}));

router.patch('/social/crisis-alerts/:id/acknowledge', requireRole('member'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: existing, error: fetchError } = await scoped(client, req.tenantId, 'crisis_alerts').select('*').eq('id', req.params.id).maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Crisis alert not found.' });
  if (existing.status !== 'open') return res.status(409).json({ error: `This alert is already ${existing.status}.` });

  const { data, error } = await scoped(client, req.tenantId, 'crisis_alerts')
    .update({ status: 'acknowledged', acknowledged_by: req.userId, acknowledged_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'social.crisis.acknowledged', targetType: 'crisis_alert', targetId: req.params.id });
  res.json({ alert: data });
}));

router.patch('/social/crisis-alerts/:id/resolve', requireRole('admin'), asyncHandler(async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;
  const { data: existing, error: fetchError } = await scoped(client, req.tenantId, 'crisis_alerts').select('*').eq('id', req.params.id).maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: 'Crisis alert not found.' });
  if (existing.status === 'resolved') return res.status(409).json({ error: 'This alert is already resolved.' });

  const { data, error } = await scoped(client, req.tenantId, 'crisis_alerts')
    .update({ status: 'resolved', resolved_by: req.userId, resolved_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'social.crisis.resolved', targetType: 'crisis_alert', targetId: req.params.id });
  res.json({ alert: data });
}));

module.exports = router;
