/**
 * Tenant-scoped query entry point. Every route handler must start a
 * query with scoped(client, req.tenantId, 'table'), never client.from()
 * directly, on any table that has a tenant_id column. This doesn't
 * enforce isolation by itself (see social/db.js for why RLS isn't in
 * play here) — it just makes "forgot the tenant filter" a visible,
 * greppable deviation from house style instead of a silent bug: every
 * tenant-scoped query reads the same way, and client.from('mentions')
 * with no scoped() wrapper anywhere in a route is the review smell to
 * catch.
 */

function scoped(client, tenantId, table) {
  if (!tenantId) throw new Error(`scoped() called without a tenantId for table "${table}" — check tenant middleware ran first.`);
  return client.from(table).eq('tenant_id', tenantId);
}

module.exports = { scoped };
