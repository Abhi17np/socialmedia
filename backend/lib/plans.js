/**
 * Plan limits — the enforcement half of the billing story. Billing
 * (routes/billing.js) sets tenants.plan and takes the money; this is
 * what actually stops a free-tier tenant from using more than they pay
 * for. Pure data + a pure decision function, no DB access, so it's
 * unit-testable without a database — the DB-touching half (reading the
 * tenant's current plan and usage) lives in lib/entitlements.js.
 */

// aiGenerationsPerMonth counts AI Assist drafts (lib/ai.js) — a post
// draft and an inbox reply draft each cost one, regardless of length.
// whatsappBroadcastSendsPerMonth is metered separately from
// whatsappMessagesPerMonth (inbound/reply conversation traffic) — a
// template broadcast send is a distinct, marketing-style cost center
// from customer-service replies, see migrations/012_whatsapp_broadcast.sql.
const PLAN_LIMITS = {
  free: { socialAccounts: 2, postsPerMonth: 30, whatsappMessagesPerMonth: 200, aiGenerationsPerMonth: 20, whatsappBroadcastSendsPerMonth: 100, emailSendsPerMonth: 500 },
  starter: { socialAccounts: 5, postsPerMonth: 150, whatsappMessagesPerMonth: 2000, aiGenerationsPerMonth: 200, whatsappBroadcastSendsPerMonth: 1000, emailSendsPerMonth: 5000 },
  pro: { socialAccounts: 15, postsPerMonth: 1000, whatsappMessagesPerMonth: 10000, aiGenerationsPerMonth: 1000, whatsappBroadcastSendsPerMonth: 10000, emailSendsPerMonth: 50000 },
  enterprise: { socialAccounts: Infinity, postsPerMonth: Infinity, whatsappMessagesPerMonth: Infinity, aiGenerationsPerMonth: Infinity, whatsappBroadcastSendsPerMonth: Infinity, emailSendsPerMonth: Infinity }
};

// Unknown/unset plan fails closed to the lowest tier, never to unlimited.
function limitsFor(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

function checkLimit(plan, resource, used) {
  const limit = limitsFor(plan)[resource];
  if (limit === undefined) throw new Error(`Unknown resource "${resource}".`);
  return { allowed: used < limit, limit, used };
}

module.exports = { PLAN_LIMITS, limitsFor, checkLimit };
