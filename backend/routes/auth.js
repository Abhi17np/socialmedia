const express = require('express');
const { getSocialClient } = require('../social/db');
const { hashPassword, verifyPassword, signToken } = require('../lib/auth');
const { validate } = require('../middleware/validate');
const { signupSchema, loginSchema } = require('../lib/schemas');

const router = express.Router();

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'workspace';
}

// Signup creates a brand-new tenant and its first user (role: owner) in
// one atomic call — see create_tenant_with_owner() in
// migrations/001_tenants_users.sql for why this can't be two separate
// .insert() calls from here.
router.post('/auth/signup', validate(signupSchema), async (req, res) => {
  const { tenantName, email, password } = req.body;
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  try {
    const passwordHash = await hashPassword(password);
    const slug = `${slugify(tenantName)}-${Date.now().toString(36)}`; // cheap uniqueness without a retry loop

    const { data, error } = await client.rpc('create_tenant_with_owner', {
      p_tenant_name: tenantName,
      p_tenant_slug: slug,
      p_email: email.toLowerCase().trim(),
      p_password_hash: passwordHash
    });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
      throw error;
    }

    const { tenant_id: tenantId, user_id: userId } = data[0];
    const token = signToken({ userId, tenantId, role: 'owner' });
    res.status(201).json({ token, tenant: { id: tenantId, name: tenantName, plan: 'free' } });
  } catch (err) {
    req.log.error({ err }, 'Signup failed');
    res.status(500).json({ error: 'Could not create account.' });
  }
});

router.post('/auth/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  try {
    const { data: user, error } = await client
      .from('users')
      .select('id, tenant_id, email, password_hash, role')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();
    if (error) throw error;

    // Same error for "no such user" and "wrong password" — don't leak
    // which one it was.
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken({ userId: user.id, tenantId: user.tenant_id, role: user.role });
    res.json({ token });
  } catch (err) {
    req.log.error({ err }, 'Login failed');
    res.status(500).json({ error: 'Could not log in.' });
  }
});

const protectedRouter = express.Router();

// What the sidebar's user-profile footer reads — the JWT carries
// userId/tenantId/role but not email or the tenant's display name, so
// the frontend needs a real lookup rather than decoding the token.
protectedRouter.get('/auth/me', async (req, res) => {
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  try {
    const [{ data: user, error: userError }, { data: tenant, error: tenantError }] = await Promise.all([
      client.from('users').select('id, email, role').eq('id', req.userId).single(),
      client.from('tenants').select('id, name, plan').eq('id', req.tenantId).single()
    ]);
    if (userError || tenantError) throw userError || tenantError;
    res.json({ user, tenant });
  } catch (err) {
    req.log.error({ err }, 'Could not load current user');
    res.status(500).json({ error: 'Could not load account.' });
  }
});

module.exports = { router, protectedRouter };
