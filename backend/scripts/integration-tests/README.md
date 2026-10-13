# Integration test scripts

These are NOT part of `npm test` — they need real infrastructure CI
doesn't have (a Postgres database behind PostgREST, acting as a stand-in
for Supabase's REST API, and a real Redis), so they live outside
`test/` specifically so `node --test`'s default glob never picks them
up. `npm test` stays a fast, no-infra unit/role-gating suite; these are
what to run locally after a change to WhatsApp broadcast, Sales Hub, or
Marketing Hub, before opening a PR.

They were written during the implementation of those three features and
each one caught and verified the fix for a real bug — see the git log
for the exact commits. They're kept here, not deleted, because they're
the only thing that actually exercises: the BullMQ broadcast queue
against real Redis, the `move_deal_stage`/`mark_whatsapp_recipient_status`/
`recompute_whatsapp_campaign_counts` Postgres functions, the automation
engine firing from a real route call, and the hub-gating middleware
chain end to end — none of which a forged-JWT supertest call (the
`test/routes.security.test.js` pattern) can reach, since those routes
all require a working database before `requireRole`'s check even
matters.

## One-time setup

1. A local Postgres with the schema applied:
   ```
   createdb socialhub_test
   for f in migrations/*.sql; do psql -d socialhub_test -v ON_ERROR_STOP=1 -f "$f"; done
   ```
2. A local PostgREST instance (not Supabase itself — these scripts talk
   PostgREST's REST API directly, which is exactly what Supabase runs
   under the hood) pointed at that database, with a `service_role`-like
   Postgres role and a signed JWT for it. See
   `postgrest.conf.example` in this directory for the exact roles/config
   and `../../lib/schemas.js`'s comments for why — or just:
   ```
   # one-time role setup
   psql -d socialhub_test <<'SQL'
     create role web_anon nologin;
     create role service_role nologin bypassrls;
     create role authenticator noinherit login password 'test';
     grant usage on schema public to web_anon, service_role;
     grant all privileges on all tables in schema public to service_role;
     grant all privileges on all sequences in schema public to service_role;
     grant execute on all functions in schema public to service_role;
     grant web_anon, service_role to authenticator;
   SQL

   # run PostgREST (download from https://postgrest.org, any recent version)
   postgrest postgrest.conf.example

   # PostgREST has no path-prefix option, but supabase-js always calls
   # ${SUPABASE_URL_SOCIAL}/rest/v1/... — this strips that prefix:
   node scripts/integration-tests/rest-proxy.js
   ```
   Point `SUPABASE_URL_SOCIAL=http://localhost:3001` (the proxy, not
   PostgREST's own port) and `SUPABASE_KEY_SOCIAL=<a JWT signed with
   the jwt-secret above, claiming {"role":"service_role"}>`.
3. A local Redis (`redis-server`), no special config.
4. A real backend server running against that stack — see
   `postgrest.conf.example`'s comment for the exact env vars, then
   `node server.js` from `backend/`.

## Running

Each script is self-contained and idempotent (uses fresh random tenant
IDs per run):

```
node scripts/integration-tests/broadcast-queue.js
node scripts/integration-tests/whatsapp-routes.js
node scripts/integration-tests/sales-routes.js
node scripts/integration-tests/sales-stage1.js
node scripts/integration-tests/sales-dashboard.js
node scripts/integration-tests/sales-lead-scoring.js
node scripts/integration-tests/marketing-routes.js
```

Run `broadcast-queue.js` on its own (no server needed, no PostgREST
even — it mocks the DB client directly); the other three need the
server running first, as set up above. Don't run the server and
`whatsapp-routes.js` at the same time against the SAME Redis — both
would start their own BullMQ worker on the same queue and race for
jobs (harmless, but makes failures confusing to read). Flush Redis
(`redis-cli flushall`) between runs of the same script if you see a
job silently not re-process — BullMQ's deterministic job IDs make a
duplicate `enqueue` call for the same tenant a safe no-op, which is
correct in production but means a second test run reusing the exact
same IDs won't see a fresh job fire.
