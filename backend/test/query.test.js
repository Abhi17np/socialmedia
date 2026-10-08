const test = require('node:test');
const assert = require('node:assert/strict');
const { scoped } = require('../lib/query');

// This is the single most important guarantee in a multi-tenant app: it's
// structurally impossible to call scoped() and get back an unfiltered
// query. A fake client here stands in for supabase-js — we're testing
// scoped()'s own logic, not Supabase's.
function fakeClient() {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push({ table });
      return {
        eq(column, value) {
          calls.push({ column, value });
          return this;
        }
      };
    }
  };
}

test('scoped() always applies a tenant_id filter', () => {
  const client = fakeClient();
  scoped(client, 'tenant-123', 'scheduled_posts');
  assert.deepEqual(client.calls, [
    { table: 'scheduled_posts' },
    { column: 'tenant_id', value: 'tenant-123' }
  ]);
});

test('scoped() refuses to run without a tenantId rather than silently querying unscoped', () => {
  const client = fakeClient();
  assert.throws(() => scoped(client, null, 'scheduled_posts'), /tenantId/);
  assert.throws(() => scoped(client, undefined, 'scheduled_posts'), /tenantId/);
  assert.throws(() => scoped(client, '', 'scheduled_posts'), /tenantId/);
});
