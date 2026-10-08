/**
 * Tenant team management — adding teammates is the one thing a tenant
 * could not do at all before this: signup creates exactly one user (the
 * owner), and nothing let them add a second. Mutations are admin+ only
 * (see middleware/tenant.js's requireRole); any authenticated member can
 * list the team, since the Inbox's assignee dropdown needs it too.
 */

const express = require('express');
const { getSocialClient } = require('../social/db');
const { hashPassword } = require('../lib/auth');
const { requireRole } = require('../middleware/tenant');
const { scoped } = require('../lib/query');
const { validate } = require('../middleware/validate');
const { addMemberSchema, updateMemberSchema } = require('../lib/schemas');

const router = express.Router();

router.get('/team/members', async (req, res) => {
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });
  const { data, error } = await scoped(client, req.tenantId, 'users').select('id, email, role, created_at').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ members: data });
});

router.post('/team/members', requireRole('admin'), validate(addMemberSchema), async (req, res) => {
  const { email, password, role } = req.body;
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  // Only an owner can create another owner — an admin granting
  // owner-level access to someone (including themselves, by inviting an
  // account they control) would be a privilege escalation.
  if (role === 'owner' && req.role !== 'owner') {
    return res.status(403).json({ error: 'Only an owner can add another owner.' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const { data, error } = await client.from('users').insert({
      tenant_id: req.tenantId,
      email: email.toLowerCase().trim(),
      password_hash: passwordHash,
      role
    }).select('id, email, role, created_at').single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A teammate with that email already exists in this workspace.' });
      throw error;
    }
    res.status(201).json({ member: data });
  } catch (err) {
    req.log.error({ err }, 'Could not add team member');
    res.status(500).json({ error: 'Could not add teammate.' });
  }
});

router.patch('/team/members/:id', requireRole('admin'), validate(updateMemberSchema), async (req, res) => {
  const { role } = req.body;
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  if (role === 'owner' && req.role !== 'owner') {
    return res.status(403).json({ error: 'Only an owner can promote someone to owner.' });
  }

  const { data: existing } = await scoped(client, req.tenantId, 'users').select('id, role').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Teammate not found.' });

  // The last owner can't be demoted — every tenant needs at least one
  // account that can manage billing and add other owners.
  if (existing.role === 'owner' && role !== 'owner') {
    const { count } = await scoped(client, req.tenantId, 'users').select('id', { count: 'exact', head: true }).eq('role', 'owner');
    if ((count || 0) <= 1) return res.status(400).json({ error: 'Cannot demote the only owner — promote someone else to owner first.' });
  }

  const { data, error } = await scoped(client, req.tenantId, 'users').update({ role }).eq('id', req.params.id).select('id, email, role, created_at').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ member: data });
});

router.delete('/team/members/:id', requireRole('admin'), async (req, res) => {
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  const { data: existing } = await scoped(client, req.tenantId, 'users').select('id, role').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Teammate not found.' });

  if (existing.role === 'owner') {
    const { count } = await scoped(client, req.tenantId, 'users').select('id', { count: 'exact', head: true }).eq('role', 'owner');
    if ((count || 0) <= 1) return res.status(400).json({ error: 'Cannot remove the only owner.' });
  }

  const { error } = await scoped(client, req.tenantId, 'users').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
