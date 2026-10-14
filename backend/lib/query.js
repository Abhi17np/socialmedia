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
 *
 * The filter cannot be attached eagerly. client.from(table) hands back a
 * PostgrestQueryBuilder, which only exposes select/insert/update/upsert/
 * delete; .eq() lives on the PostgrestFilterBuilder those return. The
 * first version of this file did `client.from(table).eq(...)` directly,
 * which threw "client.from(...).eq is not a function" on every single
 * tenant-scoped route — and because nothing above it caught the throw,
 * it took the whole process down rather than failing one request.
 *
 * So scoped() returns a thin proxy that defers the tenant filter to the
 * exact moment one can be applied: the builder a verb returns.
 */

// Verbs whose return value is a filter builder — the tenant predicate
// goes on immediately, before any caller-supplied .eq()/.order()/.range().
const FILTERABLE = new Set(['select', 'update', 'delete']);

// Writes can't be filtered, only stamped, and getting that wrong writes
// a row into the wrong tenant. Rather than guess, refuse: callers insert
// through client.from(table) with an explicit tenant_id in the payload,
// which keeps the decision visible at the call site.
const WRITES = new Set(['insert', 'upsert']);

function scoped(client, tenantId, table) {
  if (!tenantId) throw new Error(`scoped() called without a tenantId for table "${table}" — check tenant middleware ran first.`);

  const builder = client.from(table);

  return new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      if (FILTERABLE.has(prop)) {
        return (...args) => Reflect.apply(value, target, args).eq('tenant_id', tenantId);
      }

      if (WRITES.has(prop)) {
        throw new Error(
          `scoped() cannot ${String(prop)} into "${table}" — a tenant filter can't be applied to a write. ` +
          `Use client.from('${table}').${String(prop)}({ tenant_id, ... }) so the tenant is explicit in the payload.`
        );
      }

      return value.bind(target);
    }
  });
}

/**
 * Optimistic concurrency: a PATCH that includes `clientVersion` only
 * applies if the row hasn't moved on since the client loaded it
 * (bump_version() trigger, migrations/023_optimistic_concurrency.sql and
 * migrations/025_consent_preferences.sql for contact_consents).
 * Distinguishes "no such row" (404) from "row exists but someone else
 * changed it first" (409) — the two look identical to a plain
 * `.update().eq('id', id)` once zero rows match, so a second read is
 * needed to tell them apart. Originally local to routes/sales.js; moved
 * here once routes/marketing.js needed the exact same shape for
 * contact_consents rather than duplicating it.
 */
async function updateScopedWithVersion(client, tenantId, table, id, patch, clientVersion) {
  let query = scoped(client, tenantId, table).update(patch).eq('id', id);
  if (clientVersion !== undefined) query = query.eq('version', clientVersion);
  const { data, error } = await query.select('*').single();
  if (!error && data) return { data };

  const { data: existing } = await scoped(client, tenantId, table).select('id, version').eq('id', id).maybeSingle();
  if (!existing) return { notFound: true };
  if (clientVersion !== undefined && existing.version !== clientVersion) return { conflict: true, currentVersion: existing.version };
  return { error: error || new Error(`Update to ${table} affected no rows for an unknown reason`) };
}

module.exports = { scoped, updateScopedWithVersion };
