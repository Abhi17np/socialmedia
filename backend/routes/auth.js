const express = require('express');
const { getSocialClient } = require('../social/db');
const { hashPassword, verifyPassword, signToken } = require('../lib/auth');
const { validate } = require('../middleware/validate');
const { signupSchema, loginSchema, changePasswordSchema, forgotPasswordSchema, resetPasswordSchema } = require('../lib/schemas');
const { createToken, consumeToken } = require('../lib/authTokens');
const email = require('../lib/email');
const { scoped } = require('../lib/query');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    // One person can legitimately hold a user row in several tenants: the
    // schema's constraint is unique(tenant_id, email) — per tenant, not
    // global (migrations/001_tenants_users.sql). So this can't use
    // .maybeSingle(), which throws PGRST116 ("multiple (or no) rows
    // returned") the moment someone signs up for a second workspace, and
    // that 500 then locks them out of every workspace, not just the new
    // one. Newest workspace first, then take the row whose password
    // actually verifies.
    const { data: candidates, error } = await client
      .from('users')
      .select('id, tenant_id, email, password_hash, role')
      .eq('email', email.toLowerCase().trim())
      .order('created_at', { ascending: false });
    if (error) throw error;

    let user = null;
    for (const candidate of candidates || []) {
      if (await verifyPassword(password, candidate.password_hash)) {
        user = candidate;
        break;
      }
    }

    // Same error for "no such user" and "wrong password" — don't leak
    // which one it was.
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

    const token = signToken({ userId: user.id, tenantId: user.tenant_id, role: user.role });
    res.json({ token });
  } catch (err) {
    req.log.error({ err }, 'Login failed');
    res.status(500).json({ error: 'Could not log in.' });
  }
});

// Generic response either way — confirming or denying that an email has
// an account is a user-enumeration leak. An unconfigured SMTP setup is
// an ops signal, not tied to any particular email, so it's safe to
// surface as a real 503 without weakening that.
router.post('/auth/forgot-password', validate(forgotPasswordSchema), async (req, res) => {
  const { email: rawEmail } = req.body;
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });
  if (!email.isConfigured()) return res.status(503).json({ error: 'Email delivery is not configured (SMTP_HOST/PORT/USER/PASS in backend/.env).' });

  try {
    const { data: user } = await client.from('users').select('id, email').eq('email', rawEmail.toLowerCase().trim()).maybeSingle();
    if (user) {
      const rawToken = await createToken(client, { userId: user.id, purpose: 'password_reset', ttlMs: RESET_TOKEN_TTL_MS });
      const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${rawToken}`;
      await email.sendPasswordResetEmail(user.email, resetUrl).catch(err => req.log.error({ err }, 'Could not send password reset email'));
    }
    // Same response whether or not that email has an account.
    res.json({ message: 'If that email has an account, a password reset link has been sent.' });
  } catch (err) {
    req.log.error({ err }, 'forgot-password failed');
    res.status(500).json({ error: 'Could not process that request.' });
  }
});

router.post('/auth/reset-password', validate(resetPasswordSchema), async (req, res) => {
  const { token, newPassword } = req.body;
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  try {
    const consumed = await consumeToken(client, { rawToken: token, purpose: 'password_reset' });
    if (!consumed) return res.status(400).json({ error: 'This reset link is invalid or has expired — request a new one.' });

    const passwordHash = await hashPassword(newPassword);
    const { error } = await client.from('users').update({ password_hash: passwordHash }).eq('id', consumed.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'reset-password failed');
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// Signup never sends this on its own (no SMTP step wired into the
// signup flow yet) — this is the verify-side mechanics, ready for
// whenever a "verify your email" send is added to signup.
router.get('/auth/verify-email', async (req, res) => {
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'token is required.' });

  try {
    const consumed = await consumeToken(client, { rawToken: token, purpose: 'email_verification' });
    if (!consumed) return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    const { error } = await client.from('users').update({ email_verified_at: new Date().toISOString() }).eq('id', consumed.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'verify-email failed');
    res.status(500).json({ error: 'Could not verify email.' });
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
      client.from('users').select('id, email, role, email_verified_at').eq('id', req.userId).single(),
      client.from('tenants').select('id, name, plan').eq('id', req.tenantId).single()
    ]);
    if (userError || tenantError) throw userError || tenantError;
    res.json({ user, tenant });
  } catch (err) {
    req.log.error({ err }, 'Could not load current user');
    res.status(500).json({ error: 'Could not load account.' });
  }
});

protectedRouter.post('/auth/change-password', validate(changePasswordSchema), asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  const { data: user, error: fetchError } = await client.from('users').select('id, password_hash').eq('id', req.userId).single();
  if (fetchError || !user) return res.status(404).json({ error: 'Account not found.' });

  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const passwordHash = await hashPassword(newPassword);
  const { error } = await client.from('users').update({ password_hash: passwordHash }).eq('id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
}));

protectedRouter.post('/auth/send-verification-email', asyncHandler(async (req, res) => {
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });
  if (!email.isConfigured()) return res.status(503).json({ error: 'Email delivery is not configured (SMTP_HOST/PORT/USER/PASS in backend/.env).' });

  const { data: user, error: fetchError } = await client.from('users').select('id, email, email_verified_at').eq('id', req.userId).single();
  if (fetchError || !user) return res.status(404).json({ error: 'Account not found.' });
  if (user.email_verified_at) return res.status(400).json({ error: 'This email is already verified.' });

  const rawToken = await createToken(client, { userId: user.id, purpose: 'email_verification', ttlMs: VERIFY_TOKEN_TTL_MS });
  const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-email?token=${rawToken}`;
  await email.sendVerificationEmail(user.email, verifyUrl);
  res.json({ success: true });
}));

// Self-service account deletion — the calling user's own row only, not
// the whole workspace (deleting every tenant record, cancelling the
// Razorpay subscription, etc. is a bigger, separate, more destructive
// action that deserves its own dedicated flow rather than being folded
// in here). Blocked for the last owner for the same reason team.js
// blocks removing/demoting one: every tenant needs at least one owner.
// Known limitation: this deletes the user row, but an already-issued
// JWT has no server-side revocation list, so it stays technically valid
// (per lib/auth.js's 7-day expiry) until it naturally expires — a
// larger change (short-lived tokens + refresh, or a revocation table)
// than this endpoint's scope.
protectedRouter.delete('/auth/me', asyncHandler(async (req, res) => {
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  const { data: existing, error: fetchError } = await scoped(client, req.tenantId, 'users').select('id, role, email').eq('id', req.userId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Account not found.' });

  if (existing.role === 'owner') {
    const { count } = await scoped(client, req.tenantId, 'users').select('id', { count: 'exact', head: true }).eq('role', 'owner');
    if ((count || 0) <= 1) {
      return res.status(400).json({ error: 'You are the only owner of this workspace — promote a teammate to owner before deleting your account, or delete the whole workspace instead (contact support).' });
    }
  }

  const { error } = await scoped(client, req.tenantId, 'users').delete().eq('id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  await recordAudit(client, { tenantId: req.tenantId, actorUserId: req.userId, action: 'account.deleted', targetType: 'user', targetId: req.userId, metadata: { email: existing.email } });
  res.json({ success: true });
}));

module.exports = { router, protectedRouter };
