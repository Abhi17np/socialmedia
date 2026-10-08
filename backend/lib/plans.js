/**
 * Plan limits — the enforcement half of the billing story. Billing
 * (routes/billing.js) sets tenants.plan and takes the money; this is
 * what actually stops a free-tier tenant from using more than they pay
 * for. Pure data + a pure decision function, no DB access, so it's
 * unit-testable without a database — the DB-touching half (reading the
 * tenant's current plan and usage) lives in lib/entitlements.js.
 */

const PLAN_LIMITS = {
  free: { socialAccounts: 2, postsPerMonth: 30, whatsappMessagesPerMonth: 200 },
  starter: { socialAccounts: 5, postsPerMonth: 150, whatsappMessagesPerMonth: 2000 },
  pro: { socialAccounts: 15, postsPerMonth: 1000, whatsappMessagesPerMonth: 10000 },
  enterprise: { socialAccounts: Infinity, postsPerMonth: Infinity, whatsappMessagesPerMonth: Infinity }
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
