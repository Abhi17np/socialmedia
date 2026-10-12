/**
 * Infopace's own internal ops console — "view every client, their plan,
 * their usage" (the strategy doc's Admin/platform-owner capabilities).
 * Nothing here is reachable with a tenant JWT; see middleware/platform.js.
 */

const express = require('express');
const { getSocialClient } = require('../social/db');
const { verifyPassword, signPlatformToken } = require('../lib/auth');
const { validate } = require('../middleware/validate');
const { loginSchema, updateHubsSchema } = require('../lib/schemas');
const { asyncHandler } = require('../lib/asyncHandler');
const { recordAudit } = require('../lib/audit');
const { limitsFor } = require('../lib/plans');
const { currentPeriod } = require('../lib/entitlements');
const { authLimiter } = require('../lib/rateLimiters');

const publicRouter = express.Router();
const protectedRouter = express.Router();

publicRouter.post('/platform/login', authLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  try {
    const { data: admin, error } = await client.from('platform_admins').select('id, password_hash').eq('email', email.toLowerCase().trim()).maybeSingle();
    if (error) throw error;
    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    res.json({ token: signPlatformToken({ adminId: admin.id }) });
  } catch (err) {
    req.log.error({ err }, 'Platform login failed');
    res.status(500).json({ error: 'Could not log in.' });
  }
});

// One row per tenant: plan, status, seat count, accounts connected, and
// this month's usage against its plan limit — the "is this customer
// healthy, are they about to hit a wall" list a support/success person
// opens first, same job as HubSpot's or Zoho's own internal account list.
protectedRouter.get('/tenants', async (req, res) => {
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  try {
    const { data: tenants, error } = await client.from('tenants').select('id, name, plan, subscription_status, hubs_enabled, created_at').order('created_at', { ascending: false });
    if (error) throw error;

    const period = currentPeriod();
    const summary = await Promise.all((tenants || []).map(async (t) => {
      const [{ count: userCount }, { count: accountCount }, { data: usage }] = await Promise.all([
        client.from('users').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
        client.from('social_accounts').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id).eq('status', 'active'),
        client.from('usage_counters').select('posts_published, whatsapp_messages, ai_generations, whatsapp_broadcast_sends').eq('tenant_id', t.id).eq('period', period).maybeSingle()
      ]);
      const limits = limitsFor(t.plan);
      return {
        ...t,
        userCount: userCount || 0,
        accountCount: accountCount || 0,
        accountLimit: limits.socialAccounts,
        postsThisMonth: (usage && usage.posts_published) || 0,
        postsLimit: limits.postsPerMonth,
        whatsappMessagesThisMonth: (usage && usage.whatsapp_messages) || 0,
        whatsappLimit: limits.whatsappMessagesPerMonth,
        aiGenerationsThisMonth: (usage && usage.ai_generations) || 0,
        aiGenerationsLimit: limits.aiGenerationsPerMonth,
        whatsappBroadcastSendsThisMonth: (usage && usage.whatsapp_broadcast_sends) || 0,
        whatsappBroadcastSendsLimit: limits.whatsappBroadcastSendsPerMonth,
        hubsEnabled: t.hubs_enabled || { sales: false, marketing: false }
      };
    }));

    res.json({ tenants: summary });
  } catch (err) {
    req.log.error({ err }, 'Could not list tenants');
    res.status(500).json({ error: 'Could not load tenants.' });
  }
});

protectedRouter.get('/tenants/:id', async (req, res) => {
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  try {
    const [{ data: tenant, error: tenantError }, { data: users, error: usersError }, { data: accounts, error: accountsError }] = await Promise.all([
      client.from('tenants').select('*').eq('id', req.params.id).single(),
      client.from('users').select('id, email, role, created_at').eq('tenant_id', req.params.id).order('created_at'),
      client.from('social_accounts').select('id, platform, account_label, status, connected_at').eq('tenant_id', req.params.id).order('connected_at', { ascending: false })
    ]);
    if (tenantError || !tenant) return res.status(404).json({ error: 'Tenant not found.' });
    if (usersError) throw usersError;
    if (accountsError) throw accountsError;

    res.json({ tenant, users, accounts });
  } catch (err) {
    req.log.error({ err }, 'Could not load tenant detail');
    res.status(500).json({ error: 'Could not load tenant.' });
  }
});

// The commercial gate itself: Sales Hub / Marketing Hub are fully built
// and running in every tenant's app, but middleware/hubs.js's
// requireHub() 403s every route under them (and the frontend nav hides
// the section entirely) until this flips a tenant's hubs_enabled flag —
// this is the ONLY route that can. Deliberately platform-admin-only:
// "first paying customer" is Infopace's own business call, not a
// tenant self-service toggle or plan-tier perk.
protectedRouter.patch('/tenants/:id/hubs', validate(updateHubsSchema), asyncHandler(async (req, res) => {
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  const { data: tenant, error: fetchError } = await client.from('tenants').select('id, hubs_enabled').eq('id', req.params.id).maybeSingle();
  if (fetchError) throw fetchError;
  if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });

  const nextHubs = { ...(tenant.hubs_enabled || { sales: false, marketing: false }), ...req.body };
  const { data: updated, error } = await client.from('tenants').update({ hubs_enabled: nextHubs }).eq('id', req.params.id).select('id, hubs_enabled').single();
  if (error) throw error;

  await recordAudit(client, {
    tenantId: req.params.id,
    actorUserId: null,
    action: 'platform.hubs_updated',
    targetType: 'tenant',
    targetId: req.params.id,
    metadata: { hubsEnabled: nextHubs, platformAdminId: req.platformAdminId }
  });

  res.json({ tenant: updated });
}));

module.exports = { publicRouter, protectedRouter };
