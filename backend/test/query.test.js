const test = require('node:test');
const assert = require('node:assert/strict');
const { scoped } = require('../lib/query');

// Models the real @supabase/postgrest-js two-stage shape: client.from()
// returns a PostgrestQueryBuilder with ONLY select/insert/update/delete/
// upsert; .eq() lives on the PostgrestFilterBuilder those verbs return.
// The previous version of this mock flattened both stages into one
// object with .eq() directly on from()'s return value — which let
// scoped()'s original `client.from(table).eq(...)` bug (a TypeError
// against every real Supabase client) pass every test in this file
// while failing on literally every real tenant-scoped query.
function fakeClient() {
  const calls = [];
  function filterBuilder(verb) {
    return {
      eq(column, value) {
        calls.push({ verb, column, value });
        return this;
      }
    };
  }
  return {
    calls,
    from(table) {
      calls.push({ table });
      return {
        select: (...args) => { calls.push({ verb: 'select', args }); return filterBuilder('select'); },
        update: (...args) => { calls.push({ verb: 'update', args }); return filterBuilder('update'); },
        delete: (...args) => { calls.push({ verb: 'delete', args }); return filterBuilder('delete'); },
        insert: (...args) => { calls.push({ verb: 'insert', args }); return filterBuilder('insert'); },
        upsert: (...args) => { calls.push({ verb: 'upsert', args }); return filterBuilder('upsert'); }
        // Deliberately no .eq() here — matching the real
        // PostgrestQueryBuilder, so a regression back to the old
        // `client.from(table).eq(...)` shape fails this test immediately.
      };
    }
  };
}

test('scoped() does not expose .eq() before a verb is called (matches the real SDK shape)', () => {
  const client = fakeClient();
  const query = scoped(client, 'tenant-123', 'scheduled_posts');
  assert.equal(typeof query.eq, 'undefined');
});

test('scoped().select() applies the tenant filter', () => {
  const client = fakeClient();
  scoped(client, 'tenant-123', 'scheduled_posts').select('*');
  assert.deepEqual(client.calls, [
    { table: 'scheduled_posts' },
    { verb: 'select', args: ['*'] },
    { verb: 'select', column: 'tenant_id', value: 'tenant-123' }
  ]);
});

test('scoped().update() and scoped().delete() both apply the tenant filter', () => {
  for (const verb of ['update', 'delete']) {
    const client = fakeClient();
    scoped(client, 'tenant-123', 'scheduled_posts')[verb]();
    assert.deepEqual(client.calls[2], { verb, column: 'tenant_id', value: 'tenant-123' });
  }
});

test('scoped().insert() / .upsert() refuse rather than silently writing unscoped', () => {
  const client = fakeClient();
  const query = scoped(client, 'tenant-123', 'scheduled_posts');
  assert.throws(() => query.insert({ content: 'hi' }), /cannot insert/);
  assert.throws(() => query.upsert({ content: 'hi' }), /cannot upsert/);
});

test('scoped() refuses to run without a tenantId rather than silently querying unscoped', () => {
  const client = fakeClient();
  assert.throws(() => scoped(client, null, 'scheduled_posts'), /tenantId/);
  assert.throws(() => scoped(client, undefined, 'scheduled_posts'), /tenantId/);
  assert.throws(() => scoped(client, '', 'scheduled_posts'), /tenantId/);
});
