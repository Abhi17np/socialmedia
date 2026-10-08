/**
 * DB-touching half of plan enforcement — reads the tenant's current
 * plan and this month's usage, then defers to plans.js's pure
 * checkLimit() for the actual decision. Routes call assertWithinLimit()
 * before creating something that counts against a quota, and
 * recordUsage() after it succeeds.
 */

const { checkLimit } = require('./plans');
const { scoped } = require('./query');

const USAGE_COLUMN = {
  postsPerMonth: 'posts_published',
  whatsappMessagesPerMonth: 'whatsapp_messages'
};

function currentPeriod() {
  return new Date().toISOString().slice(0, 8) + '01'; // first of the current month, matches usage_counters.period
}

async function getTenantPlan(client, tenantId) {
  const { data } = await client.from('tenants').select('plan').eq('id', tenantId).maybeSingle();
  return (data && data.plan) || 'free';
}

async function currentUsage(client, tenantId, resource) {
  if (resource === 'socialAccounts') {
    const { count } = await scoped(client, tenantId, 'social_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');
    return count || 0;
  }

  const column = USAGE_COLUMN[resource];
  const { data } = await client.from('usage_counters').select(column)
    .eq('tenant_id', tenantId).eq('period', currentPeriod()).maybeSingle();
  return (data && data[column]) || 0;
}

// Throws a 402 (not 403 — this isn't an auth failure, it's "pay for more")
// with a message the frontend can show as-is. Call before creating the
// resource; the insert never happens if this throws.
async function assertWithinLimit(client, tenantId, resource) {
  const plan = await getTenantPlan(client, tenantId);
  const used = await currentUsage(client, tenantId, resource);
  const result = checkLimit(plan, resource, used);

  if (!result.allowed) {
    const err = new Error(
      `Your ${plan} plan allows ${result.limit} ${resource === 'socialAccounts' ? 'connected accounts' : 'per month'}` +
      `${result.limit === Infinity ? '' : ` (currently using ${result.used})`}. Upgrade to continue.`
    );
    err.statusCode = 402;
    err.code = 'PLAN_LIMIT_REACHED';
    throw err;
  }

  return { plan, ...result };
}

async function recordUsage(client, tenantId, resource, amount = 1) {
  const column = USAGE_COLUMN[resource];
  if (!column) throw new Error(`recordUsage() can't meter "${resource}" — no usage_counters column mapped.`);
  await client.rpc('increment_usage', { p_tenant_id: tenantId, p_period: currentPeriod(), p_column: column, p_amount: amount });
}

module.exports = { assertWithinLimit, recordUsage, getTenantPlan, currentUsage, currentPeriod };
