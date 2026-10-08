/**
 * Infopace's own internal ops console — "view every client, their plan,
 * their usage" (the strategy doc's Admin/platform-owner capabilities).
 * Nothing here is reachable with a tenant JWT; see middleware/platform.js.
 */

const express = require('express');
const { getSocialClient } = require('../social/db');
const { hashPassword, verifyPassword, signPlatformToken } = require('../lib/auth');
const { validate } = require('../middleware/validate');
const { loginSchema } = require('../lib/schemas');
const { limitsFor } = require('../lib/plans');
const { currentPeriod } = require('../lib/entitlements');

const publicRouter = express.Router();
const protectedRouter = express.Router();

publicRouter.post('/platform/login', validate(loginSchema), async (req, res) => {
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
    const { data: tenants, error } = await client.from('tenants').select('id, name, plan, subscription_status, created_at').order('created_at', { ascending: false });
    if (error) throw error;

    const period = currentPeriod();
    const summary = await Promise.all((tenants || []).map(async (t) => {
      const [{ count: userCount }, { count: accountCount }, { data: usage }] = await Promise.all([
        client.from('users').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
        client.from('social_accounts').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id).eq('status', 'active'),
        client.from('usage_counters').select('posts_published, whatsapp_messages').eq('tenant_id', t.id).eq('period', period).maybeSingle()
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
        whatsappLimit: limits.whatsappMessagesPerMonth
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

module.exports = { publicRouter, protectedRouter };
