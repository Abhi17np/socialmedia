/**
 * Razorpay subscriptions. Plans themselves (Free/Starter/Pro/Enterprise)
 * are created once in the Razorpay dashboard, not here — RAZORPAY_PLAN_*
 * env vars just map our plan names to Razorpay's plan ids.
 *
 * Two halves, same public/protected split as routes/social.js:
 *   - publicRouter: the webhook only, Razorpay calls it directly with no
 *     Bearer header — its own HMAC signature is what authenticates it.
 *   - protectedRouter: checkout, mounted after requireAuth.
 */

const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { getSocialClient } = require('../social/db');
const { limitsFor } = require('../lib/plans');
const { getTenantPlan, currentUsage } = require('../lib/entitlements');
const { validate } = require('../middleware/validate');
const { checkoutSchema } = require('../lib/schemas');

const PLAN_IDS = {
  starter: process.env.RAZORPAY_PLAN_STARTER,
  pro: process.env.RAZORPAY_PLAN_PRO
  // enterprise is sold manually, not self-serve checkout
};

function getRazorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

const publicRouter = express.Router();
const protectedRouter = express.Router();

// What the frontend needs to render "12 / 30 posts used this month" and
// to gray out "Connect account" before the backend rejects it — the
// actual enforcement is lib/entitlements.js's assertWithinLimit(),
// called from the routes that create something; this is read-only.
protectedRouter.get('/billing/usage', async (req, res) => {
  const client = getSocialClient();
  if (!client) return res.status(503).json({ error: 'Database not configured.' });

  try {
    const plan = await getTenantPlan(client, req.tenantId);
    const limits = limitsFor(plan);
    const [socialAccounts, postsPerMonth, whatsappMessagesPerMonth] = await Promise.all([
      currentUsage(client, req.tenantId, 'socialAccounts'),
      currentUsage(client, req.tenantId, 'postsPerMonth'),
      currentUsage(client, req.tenantId, 'whatsappMessagesPerMonth')
    ]);

    res.json({
      plan,
      usage: {
        socialAccounts: { used: socialAccounts, limit: limits.socialAccounts },
        postsPerMonth: { used: postsPerMonth, limit: limits.postsPerMonth },
        whatsappMessagesPerMonth: { used: whatsappMessagesPerMonth, limit: limits.whatsappMessagesPerMonth }
      }
    });
  } catch (err) {
    req.log.error({ err }, 'Could not load usage');
    res.status(500).json({ error: 'Could not load usage.' });
  }
});

protectedRouter.post('/billing/checkout', validate(checkoutSchema), async (req, res) => {
  const { plan } = req.body;
  const planId = PLAN_IDS[plan];
  // zod already confirmed `plan` is 'starter' or 'pro' — this check is a
  // separate failure mode: a valid plan name whose Razorpay plan id was
  // never configured in env (ops issue, not a bad request).
  if (!planId) return res.status(503).json({ error: `Plan "${plan}" has no Razorpay plan id configured (RAZORPAY_PLAN_${plan.toUpperCase()}).` });

  const razorpay = getRazorpay();
  if (!razorpay) return res.status(503).json({ error: 'Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).' });

  try {
    // total_count: 120 months (10 years) — Razorpay subscriptions require
    // a bound count; this is the usual "effectively indefinite until
    // cancelled" convention rather than a real 10-year commitment.
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count: 120,
      notes: { tenantId: req.tenantId }
    });

    const client = getSocialClient();
    if (client) {
      await client.from('tenants').update({ razorpay_subscription_id: subscription.id }).eq('id', req.tenantId);
    }

    res.json({ subscriptionId: subscription.id, shortUrl: subscription.short_url });
  } catch (err) {
    req.log.error({ err }, 'Could not create Razorpay subscription');
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

function verifyRazorpaySignature(req) {
  const signature = req.get('x-razorpay-signature');
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!signature || !secret || !req.rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
}

// Same "ack fast, then process" shape as the WhatsApp webhook in
// routes/social.js — Razorpay retries aggressively on non-2xx too.
publicRouter.post('/billing/webhook', async (req, res) => {
  res.sendStatus(200);

  if (!verifyRazorpaySignature(req)) {
    req.log.warn('Webhook payload failed signature verification — dropped');
    return;
  }

  const client = getSocialClient();
  if (!client) return;

  const event = req.body.event;
  const subscriptionId = req.body.payload && req.body.payload.subscription && req.body.payload.subscription.entity && req.body.payload.subscription.entity.id;
  if (!subscriptionId) return;

  try {
    const { data: tenant } = await client.from('tenants').select('id').eq('razorpay_subscription_id', subscriptionId).maybeSingle();
    if (!tenant) {
      req.log.warn({ event, subscriptionId }, "Webhook event for unknown subscription — dropped");
      return;
    }

    // A small, explicit set — anything else (there are ~15 subscription.*
    // events) is intentionally ignored rather than guessed at.
    const STATUS_BY_EVENT = {
      'subscription.activated': 'active',
      'subscription.charged': 'active',
      'subscription.pending': 'past_due',
      'subscription.halted': 'past_due',    // Razorpay's dunning gave up retrying the charge
      'subscription.cancelled': 'canceled'
    };
    const status = STATUS_BY_EVENT[event];
    if (status) {
      await client.from('tenants').update({ subscription_status: status }).eq('id', tenant.id);
    }
  } catch (err) {
    req.log.error({ err }, 'Webhook processing failed');
  }
});

module.exports = { publicRouter, protectedRouter };
