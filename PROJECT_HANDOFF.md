# Infopace Social/Sales/Marketing Hub — Project Handoff

**Purpose of this file**: a single, self-contained briefing for a new Claude
session (or a new engineer) picking up this codebase cold. It covers what
the whole project is, what's built and working today, what's deliberately
not done yet (and why), how to run and test it, and where to look for more
detail. Read this first; it points to the other docs for depth.

Last updated: 2026-10-14.

---

## 1. What this is

A multi-tenant SaaS with three "Hubs" sold together under one login:

- **Social Hub** — WhatsApp + social media scheduling, unified inbox, and
  analytics. Built and sold first, alone, before the other two Hubs existed.
- **Sales Hub** — a practical CRM: companies, leads, deal pipelines,
  activities, sequences, dashboards.
- **Marketing Hub** — campaign orchestration + automation rules on top of
  the channels Social Hub already sends through.

All three share one tenant, one login, one Postgres database, and one
Express backend. Sales Hub and Marketing Hub are feature-complete but
commercially gated — invisible and 403'd for a tenant until an Infopace
platform admin flips a switch for that tenant (see §4). WhatsApp broadcast
sending is Social Hub's own feature and is **not** behind that gate.

The one feature that makes this different from a generic scheduler or a
generic CRM: **one contact across every channel**. A `contacts` table +
`contact_identities` resolve a WhatsApp message, an Instagram DM, and a
Facebook comment from the same person into one record
(`backend/lib/contacts.js`, `resolve_contact()` in
`migrations/003_contacts.sql`).

---

## 2. Architecture

- **Backend**: Node/Express (`backend/`), one process, versioned API under
  `/api/v1`.
- **Database**: one shared Postgres project, accessed via
  **PostgREST + `@supabase/supabase-js`** (the Supabase stack, self-hosted
  or via Supabase proper) — not a raw `pg` driver. Every route goes through
  `getSocialClient()` (`backend/social/db.js`).
- **Multi-tenancy**: enforced at the **app layer**, not Postgres RLS.
  Every tenant-owned table carries `tenant_id`; every read/update/delete
  goes through `scoped(client, tenantId, table)` (`backend/lib/query.js`),
  which adds the `tenant_id` filter automatically. Every insert sets
  `tenant_id: req.tenantId` explicitly from the verified JWT claim —
  **never** from request body. This was grepped and confirmed clean
  end-to-end as of this handoff (see §8).
- **Auth**: JWT (`backend/lib/auth.js`), `JWT_SECRET` required at boot (no
  silent default — the process refuses to start without it).
  `middleware/tenant.js`'s `requireAuth`/`requireRole` resolve
  tenant/user/role from the token on every protected route.
  `middleware/hubs.js`'s `requireHub('sales'|'marketing')` gates Sales/
  Marketing Hub routes. A **separate** platform-admin login/token
  (`middleware/platform.js`) powers Infopace's own internal `/platform`
  console — fully independent of tenant auth.
- **Background work**: Redis + BullMQ. Two queues: `social/queue.js`
  (scheduled post publishing) and `social/broadcastQueue.js` (WhatsApp
  template sends). Plus a few setInterval-based sweepers:
  `social/scheduler.js` (reconciliation), `social/pollers.js` (inbound
  sync/analytics), `lib/sequenceScheduler.js` (Sales Hub sequence
  enrollment sweep — restart-safe, re-reads due enrollments from the DB
  rather than keeping state in memory).
- **Frontend**: Next.js (App Router), real per-page URLs. `app/(app)/`
  is one shared authenticated shell (top bar + hub-aware sidebar +
  mobile bottom nav) wrapping every tenant page; `app/platform/` is the
  separate Infopace-internal console.
- **Secrets at rest**: OAuth tokens (social accounts, and now Sales Hub
  email connections) are AES-256-GCM encrypted via
  `SOCIAL_TOKEN_ENCRYPTION_KEY`, never stored plaintext
  (`backend/social/crypto.js`).
- **Logging**: `pino` + `pino-http`, with `Authorization`/`Cookie`
  headers redacted (fixed this round — see §9).

### Repo layout (abbreviated — see `README.md` for the full annotated tree)

```
backend/
  migrations/*.sql     Run in order against one shared Postgres project (24 files)
  lib/                 auth.js, query.js (scoped()), contacts.js, csv.js, audit.js,
                       automation.js, sequences.js, sequenceScheduler.js, leadScoring.js, ...
  middleware/          tenant.js (requireAuth/requireRole), hubs.js (requireHub), platform.js
  routes/              auth.js, social.js, whatsapp.js, sales.js, salesEmail.js,
                       marketing.js, billing.js, team.js, platform.js, ai.js
  social/              platform adapters (facebook/instagram/linkedin/youtube/
                       google-business/whatsapp), crypto.js, db.js, queue.js,
                       broadcastQueue.js, scheduler.js, pollers.js, accounts.js
  email/providers/     gmail.js, microsoft365.js — Sales Hub email/calendar OAuth (new)
  scripts/integration-tests/   Real-backend integration scripts, one per feature area
  test/                node:test unit suite (37 tests)
  server.js

frontend/
  app/(app)/layout.jsx Shared shell: top bar, hub-aware sidebar, hub-aware mobile nav
  app/platform/         Infopace-internal console (separate auth)
  src/social/           Dashboard, Composer, Posts, Inbox, Analytics, ConnectAccounts, Team, Billing
  src/whatsapp/         WhatsAppHub — templates, audience segments, campaigns
  src/sales/            SalesHub + every Sales Hub tab/drawer (see §5)
  src/marketing/        MarketingHub — campaigns, automation rules
  src/shell/            TopBar, HubSwitcher, GlobalSearch, NotificationsMenu, HelpMenu
  src/platform/         PlatformLogin, PlatformDashboard
```

---

## 3. Running it locally

1. One Postgres project (Supabase-hosted or self-hosted + PostgREST in front
   of it). Run `backend/migrations/*.sql` **in order**.
   - **Gotcha**: a brand-new table or function needs an **explicit**
     `grant all privileges/execute on <object> to service_role;` — the
     original role setup only covers objects that existed at that time.
     Every migration after the first needs this run manually, then a
     PostgREST schema-cache reload (`kill -SIGUSR1 <postgrest_pid>`).
   - **Gotcha**: `@supabase/supabase-js` always targets
     `${SUPABASE_URL_SOCIAL}/rest/v1/...` — it does not support a bare-root
     PostgREST. If you're running PostgREST directly rather than through
     Supabase's own gateway, put a tiny strip-`/rest/v1`-prefix reverse
     proxy in front of it (see
     `backend/scripts/integration-tests/rest-proxy.js` for exactly this,
     with `backend/scripts/integration-tests/postgrest.conf.example` for a
     matching PostgREST config).
2. `cp backend/.env.example backend/.env` and fill in at minimum:
   `SUPABASE_URL_SOCIAL`/`SUPABASE_KEY_SOCIAL`, `JWT_SECRET`,
   `SOCIAL_TOKEN_ENCRYPTION_KEY`, `REDIS_URL`. Everything else (OAuth
   credentials per channel, Razorpay, email/calendar) is optional — its
   absence just disables that one feature's Connect button, nothing fails
   to start. See `.env.example`'s comments for exactly what each one is
   for and where to get it.
3. `npm run install:all` (root `package.json` — installs both
   `backend/` and `frontend/`).
4. `npm run dev` (root) — backend on `:5001`, frontend on Next.js's default
   (`:3000`, unless overridden). Set `NEXT_PUBLIC_API_BASE` in
   `frontend/.env.local` if the backend isn't on localhost.
5. Seed a `platform_admins` row (bcrypt password hash) to reach
   `/platform` — that console's Hubs column is where you flip
   `tenants.hubs_enabled` to unlock Sales/Marketing Hub for a tenant.

Docker / real deployment: see `DEPLOYMENT.md`.

---

## 4. Commercial gating

Sales Hub and Marketing Hub are **fully built** but gated: every route in
`routes/sales.js`/`routes/marketing.js` individually calls
`requireHub('sales'|'marketing')`, which 403s with
`{code: 'HUB_NOT_ENABLED'}` until a platform admin enables that hub for
the tenant from `/platform`. This is deliberate — "first paying customer"
is Infopace's own commercial call, not a self-service plan-tier perk.
WhatsApp broadcast sending is **not** behind this gate; it's Social Hub's
own always-on feature. (Its own separate gate is Meta's own approval
process — a template can only send once Meta approves it, enforced
server-side with a 409; production-volume sending needs WABA business
verification. Not a code gap.)

---

## 5. Sales Hub — full feature detail

This is where the bulk of recent work happened. Everything below is real,
tested CRUD/logic against the real backend — nothing is a mockup.

### CRM records
- **Companies**: create/edit/delete, industry/domain/phone/notes/owner,
  linked contacts/deals/activity timeline on the detail drawer.
- **Contacts/Leads**: shares the same table as inbound WhatsApp/Instagram/
  Facebook contacts (no separate "lead" table) — job title, lead status,
  owner, tags, lead score (auto-recomputed on every create/update via
  tenant-configurable scoring rules).
- **Deals**: name, amount, **currency**, expected close date, forecast
  category (Pipeline/Best Case/Commit), owner, stage. **New deals default
  to the creating rep as owner** if none is explicitly set (fixed this
  round — previously silently unassigned; see §9).
- **Multi-contact deals**: several contacts per deal, one marked primary.
- **Bulk actions**: add/remove tag, set owner, set lead status, delete.
  Bulk delete now requires confirmation (fixed this round; was the one
  destructive action in the app with no confirm step).
- **CSV import/export**: real server-side pagination-aware limits (2MB /
  5000 rows per import); export is formula-injection-safe (fixed this
  round — see §9).
- **Duplicate detection + safe merge**: flags contacts/companies sharing
  key fields; merging goes through atomic Postgres functions
  (`merge_contacts`/`merge_companies`, migration 022) that reassign every
  linked deal/activity/relationship to the survivor and record the merge
  in the audit log, with a conflict-resolution UI for picking which
  field value wins per conflicting field.
- **Custom fields**: per-tenant extra fields on contacts/companies/deals.

### Pipeline
- Kanban + table views, multi-pipeline support, drag-and-drop or dropdown
  stage moves (server-validated; moving to "lost" requires a reason).
- Deal cards show company/contact/owner/next-activity-due, not just
  name+amount. Stage headers show count, total, **and** probability-
  weighted total — **grouped by currency**, never summed across
  currencies (fixed this round; see §9).
- Stale-deal flag (configurable per-stage threshold), stage editor
  (rename/reorder/probability/stale-threshold; a pipeline/stage with
  deals can't be deleted).

### Dashboard & Workspace
- Dashboard KPIs (revenue won, pipeline value, weighted forecast,
  conversion rate, won/lost, overdue activities), forecast-by-category
  breakdown, sales targets with real attainment tracking, team
  performance table — **all currency-grouped**, all computed from real
  deals over a selectable date range, not hardcoded.
- Workspace: per-rep overdue/due-today/upcoming activity queue + stale
  deals, one-click complete. Empty states are compact (one line per
  section, a single "all caught up" state when everything's clear — fixed
  this round, was four stacked full-size empty panels).

### Pagination, saved views, concurrency (this round's "Known Gaps" closures)
- **Server-side pagination** with real total counts and stable sort on
  Companies/Contacts/Deals (previously a silent, frontend-invisible
  50-row cap).
- **Per-user saved views**: filters/sort/visible columns, scoped to
  tenant + owner (another user in the same tenant can't see/rename/delete
  someone else's view).
- **Optimistic concurrency**: every editable record carries a `version`
  column (auto-incrementing trigger); a PATCH that doesn't match the
  current version gets a 409 `VERSION_CONFLICT` with a reload-to-reconcile
  prompt in the UI, instead of a silent overwrite.

### Sequences (multi-step follow-ups)
Task/tag-based (create a follow-up task, tag a contact) — deliberately
**not** email-based yet, since that needs a connected mailbox (see
"Email & Calendar" below). Full lifecycle: create → add step → enroll →
pause → resume, restart-safe (the sweep re-reads due enrollments from the
DB rather than relying on in-memory timers).

### Automation
Trigger/action rules (contact created, tag added, deal stage changed,
deal won/lost → add tag / remove tag / create task / assign owner), with
a time-windowed duplicate-fire guard and manual retry for a failed run.

### Global Search
Covers companies, leads, **and deals**; every result deep-links straight
into that record's own detail view (`?open=<id>`), not just the tab.

### Settings (admin-only)
Custom fields, lead scoring rules, sales targets, automation rules, audit
log, and (new this round) **Email & calendar** connections.

### Email & Calendar (scaffolded, not live)
Real OAuth connect/status/disconnect routes and a real `email_connections`
table exist for Gmail and Microsoft 365 (`backend/email/providers/`,
`backend/routes/salesEmail.js`). `isConfigured()` gates everything —
**no real OAuth credentials exist in this environment**
(`GMAIL_OAUTH_CLIENT_ID`/`SECRET`, `MS365_CLIENT_ID`/`SECRET`/`TENANT_ID`
are all unset), so both providers honestly report `configured: false` and
the UI disables Connect with an explanation rather than faking a flow.
`buildAuthUrl()` is verified to produce a correctly-shaped real authorize
URL once credentials exist; `exchangeCode()` is written against each
provider's real, documented API but is the one piece genuinely untestable
without a real consent-screen code. **Nothing past the connect handshake
is built** (actual send, inbox sync, calendar events) — there's no
connected account to build it against yet. See
`SALES_HUB_IMPLEMENTATION.md`'s "Blocked: Email & Calendar" section for
the exact remaining steps (create the OAuth apps, set the env vars,
complete one real connect flow, then build the `sales_emails` table +
send/sync on top of it).

### Deliberately deferred (not a gap — no evidence of need)
Products/line-items/quotes/CPQ.

---

## 6. Social Hub & Marketing Hub (brief — see `README.md` for depth)

**Social Hub**: connect accounts (Facebook, Instagram, LinkedIn, YouTube,
Google Business, WhatsApp), schedule posts, unified inbox across every
channel (resolved to one contact), brand-health analytics, Razorpay
subscriptions + usage metering, AI Assist (Claude-backed Compose/Inbox
drafting, `backend/lib/ai.js`). WhatsApp template management + audience
segments + broadcast campaigns live in `routes/whatsapp.js` /
`src/whatsapp/WhatsAppHub.jsx`.

**Marketing Hub**: campaign orchestration + the same automation-rule
engine Sales Hub uses, on top of the channels Social Hub already sends
through.

**Phase 3** (cross-Hub AI layer beyond AI Assist, visual workflow builder,
integrations marketplace, SMS): schema exists
(`migrations/015_phase3_foundation.sql`, `docs/phase3-foundation.md`) but
nothing reads or writes it yet. Doesn't start until the commercial gate
clears for both Hubs, per the strategy doc's sequencing.

---

## 7. Testing

```bash
# Backend unit suite (node:test) — 37/37 passing
cd backend && npm test

# Backend integration suite — real Postgres/PostgREST/Redis, one script per area.
# (package.json's own test:integration script is stale and only lists 4 of these —
# run them individually, in any order, each spins up its own in-process app via supertest.)
cd backend
for f in sales-routes sales-stage1 sales-dashboard sales-deal-relationships \
         sales-custom-fields sales-bulk-import sales-lead-scoring sales-sequences \
         sales-pagination-views sales-merge sales-concurrency sales-email-integration \
         marketing-routes whatsapp-routes broadcast-queue; do
  node scripts/integration-tests/$f.js
done

# Frontend lint
cd frontend && npx eslint .
```

**Current status** (last full run, 2026-10-14): unit 37/37, all 13
Sales/Marketing-area integration scripts green. Two **pre-existing,
unrelated** scripts — `whatsapp-routes.js` and `broadcast-queue.js`, both
exercising the BullMQ broadcast worker — are genuinely flaky under this
environment's timing (confirmed by repeated isolated runs: pass/fail
alternates with no code change). Root cause looks like retry/backoff
timing, not a logic bug; out of scope for Sales Hub work, flagged rather
than silently ignored.

See `backend/scripts/integration-tests/README.md` for setup notes per
script.

---

## 8. Security / production-readiness posture

Audited and confirmed sound:
- **Tenant isolation**: every read/update/delete via `scoped()`; every
  insert's `tenant_id` from the verified JWT, never from request body
  (grepped the whole backend to confirm no exception).
- **Destructive-action RBAC**: every `DELETE` route requires `admin`+ and
  is audit-logged (`backend/lib/audit.js` → `audit_log` table).
- **CSV import limits**: 2MB file size, 5000 row cap.
- **Error handling**: global handler returns a generic message, never a
  stack trace; full detail logged server-side only.
- **CORS**: explicit allowlist (`FRONTEND_URL`, comma-separated), not a
  bare `cors()`.
- **JWT_SECRET**: fails fast at boot if unset — no shared default.
- **Accessibility**: every icon-only `IconButton` call site passes a
  real `aria-label`.
- **Merge rollback**: `merge_contacts`/`merge_companies` are single
  plpgsql functions — a `raise exception` on invalid input rolls back the
  whole operation atomically.

Fixed this round (previously real, verified gaps):
- **Live JWT bearer tokens logged in plaintext** — `pino-http` logged
  `req.headers` wholesale with no redaction. Now redacts
  `Authorization`/`Cookie` (`backend/lib/logger.js`).
- **CSV formula injection** — an exported field starting with
  `=`/`+`/`-`/`@` would execute as a formula when opened in Excel/Sheets.
  Fixed with the standard OWASP leading-quote mitigation
  (`backend/lib/csv.js`).
- **No confirmation before bulk-deleting companies** — now requires
  confirmation like every other delete path in the app.
- **New deals silently unowned** (data-integrity, not strictly security)
  — `POST /sales/deals` now defaults `owner_id` to the creating rep.

---

## 9. Recent defect log (this round, 2026-10-14 — for calibration on code quality bar)

Each of these was reproduced, fixed, and covered by a test or screenshot
before being called done — not assumed, not speculative:

1. Mixed-currency dashboard/stage-header/target/team-performance totals
   summed incompatible currencies — now grouped by currency.
2. Silent 50-row pagination cap on Companies/Contacts/Deals lists.
3. No saved views.
4. No safe duplicate-merge path for contacts/companies.
5. No concurrent-edit protection (silent last-write-wins).
6. Stale `version` in every contact PATCH/POST response (a hidden
   second write from lead-score recompute silently re-bumped it).
7. Mobile bottom nav was Social-Hub-only on every page, and its "More"
   button logged the user out instead of opening a menu.
8. New deals silently unowned (see §8).
9. Live JWTs logged in plaintext (see §8).
10. CSV formula injection (see §8).
11. No confirmation before bulk-deleting companies (see §8).

All fixed, all tested, all on branch `claude/lucid-hypatia-n6s4mz`.

---

## 10. Where to look for more

- **`README.md`** — architecture, repo layout, getting-started, the
  commercial-gating story, what's deliberately not built.
- **`SALES_HUB_IMPLEMENTATION.md`** — the detailed, dated engineering
  changelog for every Sales Hub round: gap matrix, exact files touched,
  exact test results, the full "Blocked: Email & Calendar" writeup with
  exact remaining steps and env vars.
- **`SALES_HUB_FEATURES.md`** — a plain feature checklist (Sales Hub
  only, slightly behind this document — this one supersedes it on
  pagination/saved-views/merge/concurrency/email-scaffolding/security
  fixes, all added after it was written).
- **`DEPLOYMENT.md`** — Docker / real-environment deployment notes.
- **`docs/phase3-foundation.md`** — the deferred cross-Hub AI/workflow-
  builder/integrations-marketplace schema and what it still needs.
- **`backend/scripts/integration-tests/README.md`** — per-script setup
  notes for the integration suite.

If you're a fresh Claude session starting from this file: the codebase is
in good shape, well-tested, and the gaps that remain are either genuinely
credential-blocked (Email/Calendar send/sync) or deliberately deferred
with a documented reason (Phase 3, Products/CPQ) — not oversights. Don't
assume something is broken without reproducing it, and don't assume
something is safe just because the UI renders; that's the standard this
codebase has been held to throughout.
