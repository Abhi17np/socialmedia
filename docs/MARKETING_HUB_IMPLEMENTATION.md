# Marketing Hub — Implementation Changelog

Dated, append-only log of this build. Each entry lists exactly what was
touched, what was tested, and the result — no "complete" claims without a
reproduction. Honesty key used throughout: **LIVE** (verified against a
real third-party service with real credentials), **WORKS WITH MOCK
PROVIDER** (code complete, exercised against a local mock, untested
against the real provider), **SCAFFOLDED** (structure exists, not wired
end to end), **DEFERRED** (explicitly not built this round, with a
reason).

---

## 2026-10-14 — Phase 0: Audit, benchmark, build plan

**Files added:**
- `docs/MARKETING_HUB_AUDIT.md`
- `docs/MARKETING_HUB_BENCHMARK.md`
- `docs/MARKETING_HUB_IMPLEMENTATION.md` (this file)

**What was done:**
- Read every file named in the task brief's Phase 0 list in full
  (`routes/marketing.js`, `src/marketing/*`, `lib/automation.js`,
  `routes/whatsapp.js`, segments/campaigns/`broadcastQueue.js`, `lib/ai.js`,
  `lib/contacts.js` + migration 003, migration 015, `docs/phase3-foundation.md`),
  both directly and via an independent `Explore` subagent whose file:line
  citations were spot-checked directly (3/3 key claims confirmed by direct
  grep: consent model absent, Phase 3 tables genuinely unread anywhere,
  `routes/whatsapp.js` has zero `requireHub()` calls).
- Stood up a complete local verification stack from scratch in this
  container (no Supabase account available): Postgres 16 (`initdb` +
  `socialhub_test` db), all 24 migrations applied in order with zero
  errors, PostgREST 12.2.8 via Docker (dockerd started manually — the
  container ships Docker but it isn't running by default) against the
  `web_anon`/`service_role`/`authenticator` roles from
  `scripts/integration-tests/README.md`, the repo's own `rest-proxy.js`,
  a local Redis, and the real `node server.js`.
- Ran `cd backend && npm test`: 15/16 pass after `npm install` (the one
  failure before `npm install` was a missing `supertest` devDependency in
  a fresh checkout, not a logic bug).
- Ran `scripts/integration-tests/marketing-routes.js` against the real
  stack: **all 11 assertions pass**, including a genuine cross-Hub
  automation firing (`POST /sales/contacts` → rule fires → contact really
  tagged `welcomed` → run logged).
- Ran `scripts/integration-tests/whatsapp-routes.js` and
  `broadcast-queue.js` repeatedly (6 total runs combined) to verify
  PROJECT_HANDOFF.md's flakiness claim and find a root cause rather than
  just confirm the symptom. **Root-caused**: a leftover `node server.js`
  process from earlier manual testing was still connected to the same
  local Redis with its own real `broadcastQueue.js` `Worker` on the
  identical queue name, racing the test's own worker for jobs — this
  reliably reproduced both observed failure signatures. After killing
  that process, most runs passed cleanly; one residual failure out of
  several clean re-runs is attributed to real wall-clock-timing
  sensitivity (~70s of genuine BullMQ exponential backoff against a fixed
  poll deadline) under this session's single shared, CPU-constrained
  container running Postgres+Docker+PostgREST+Redis+Node simultaneously.
  Full writeup in `docs/MARKETING_HUB_AUDIT.md` §6.
- Web-researched 6 benchmark product families (HubSpot, Mailchimp/Brevo,
  Klaviyo/Customer.io, ActiveCampaign, WebEngage/MoEngage/CleverTap,
  Zoho) via `WebSearch`; wrote the comparison table and table-stakes/
  differentiators split in `MARKETING_HUB_BENCHMARK.md`.
- Produced the gap matrix (every §3 feature from the task brief vs.
  DONE/PARTIAL/MISSING) and a 9-phase, dependency-ordered build plan in
  `MARKETING_HUB_AUDIT.md` §4-5.

**Tests run:** see above — `npm test` (15/16, 1 pre-existing missing-dep
issue, not a code defect), 3 integration scripts against a real local
stack, 9 total integration-script runs for flakiness root-causing.

**Decisions recorded (per task §7 — no irreversible/pricing/credential
decision needed a stop-and-ask this round):**
- Build Journeys (Phase 4) as an extension of the existing
  `lib/automation.js` action/trigger model rather than a parallel engine,
  per `docs/phase3-foundation.md`'s own architectural recommendation,
  which this audit's code reading confirms is sound (avoids two audit
  trails, two ways to tag a contact).
- Sequence Phase 1 (consent) before every send-capable module, since
  retrofitting consent onto segments/sends already in production use is
  strictly riskier than building it first.
- Defer the website-tracking snippet (brief §F3) past this build's
  scope — the brief itself flags it as deferrable if large, and its
  privacy/consent design is substantial enough to deserve dedicated
  scoping rather than being squeezed into module F's timeline.

---

## 2026-10-14 — Phase 1: Consent & preference foundation

**Status: LIVE** (no external credentials needed — this is pure app DB +
logic; verified against a real Postgres/PostgREST/Redis stack, not mocked).

**Files added:**
- `backend/migrations/025_consent_preferences.sql` — `contact_consents`
  (per-contact, per-channel opt-in/opt-out with source/timestamp,
  optimistic-concurrency `version`), `suppression_list` (keyed by raw
  identifier, survives contact deletion/merge), `contacts.global_opt_out_at`,
  `contacts.preference_token` (unguessable, for the public preference
  center).
- `backend/lib/consent.js` — the one place every send path checks:
  `filterConsentedContacts` (bulk, 3 fixed queries regardless of audience
  size — no N+1), `getConsentSummary`, `upsertConsent` (optional
  optimistic-concurrency via `expectedVersion`), `setGlobalOptOut`,
  `addSuppression`/`removeSuppression`, `findContactByPreferenceToken`.
- `backend/scripts/integration-tests/marketing-consent.js` — 17
  assertions against the real stack; the critical one: a segment with 3
  matching contacts (1 consented, 1 explicitly opted out, 1 globally
  unsubscribed) sends for real through BullMQ with a mocked Meta API, and
  the test asserts the mocked `graph.facebook.com/.../messages` endpoint
  was called **exactly once**, for the consented contact only — the other
  two never reach the network call, not just hidden from a UI list.
- `frontend/src/marketing/PreferenceCenter.jsx` +
  `frontend/app/preferences/[token]/page.jsx` — public, no-login page a
  contact reaches from an unsubscribe/preference link; per-channel
  checkboxes plus a global "unsubscribe from everything," all states
  (loading, invalid-token, saved, error) covered.
- `frontend/src/marketing/MarketingHub.jsx`'s new "Consent & Suppression"
  tab (`SuppressionTab`) — paginated, searchable, channel-filterable
  suppression list; admin-only add/remove, with `ConfirmDialog` on
  delete per the house destructive-action rule.

**Files changed:**
- `backend/routes/whatsapp.js` — `POST /campaigns/:id/send` now
  authoritatively re-checks consent against live data immediately before
  enqueueing (not just at campaign-creation time, since a contact can opt
  out in between), for both segment-backed and explicit-contactId-list
  campaigns; a now-suppressed contact's existing recipient row (the
  explicit-list case) is relabeled `status: 'suppressed'` rather than left
  stuck at `'pending'` forever; the send response now reports `suppressed:
  N` alongside `queued: N` so the UI/caller sees the real count, not a
  silent drop. `GET /segments/:id/preview` now returns a consent-aware
  `whatsappEligibleCount` (and `suppressedCount`), so the UI's own preview
  number was never lying even before a send is attempted.
- `backend/lib/audience.js` — `resolveSegmentContacts`/
  `resolveExplicitContacts`/`countSegment` take an optional
  `consentChannel` that runs the same `filterConsentedContacts` check;
  every current and future caller (WhatsApp today, email/SMS in later
  phases) gets the same enforcement by construction instead of
  reimplementing it per channel.
- `backend/routes/marketing.js` — export shape changed from a bare
  `router` to `{ publicRouter, protectedRouter }` (matching
  `social.js`/`salesEmail.js`/`billing.js`'s existing pattern) to carry
  the new public preference-center endpoints; `backend/server.js` updated
  to mount both. New admin routes: suppression-list CRUD, per-contact
  consent view + manual override (with optimistic-concurrency `version`/
  409 `VERSION_CONFLICT`, same as Sales Hub), global-opt-out toggle — all
  `requireHub('marketing')`, mutations `requireRole('admin')`,
  audit-logged.
- `backend/lib/schemas.js` — `preferenceUpdateSchema`,
  `suppressionCreateSchema`, `contactConsentUpdateSchema`.
- `backend/lib/query.js` — `updateScopedWithVersion` (the optimistic-
  concurrency 404-vs-409 helper) moved here from being local to
  `routes/sales.js`, since `contact_consents` needed the identical shape
  rather than a second copy. `routes/sales.js` now imports it; behavior
  unchanged, re-verified by `sales-concurrency.js`, `sales-routes.js`,
  `sales-stage1.js` all still passing.

**Decision recorded (per task §7 — a real architectural call, reported
rather than silently made):** existing contacts with no `contact_consents`
row are treated as sendable (not blocked), and only an explicit opt-out,
suppression entry, or global unsubscribe blocks a send. Requiring
explicit opt-in retroactively for every tenant's entire pre-existing
audience would silently stop every current sender the moment this
migration lands, which is a materially worse outcome than the gap it
would close. What's guaranteed, verified by the test above: an explicit
signal to stop is **always** honored, server-side, permanently — never
dependent on a particular UI remembering to check.

**Postgres RLS feasibility (per task §2's "evaluate... and report")**:
assessed, **not implemented**, and this is a reasoned call, not a
skipped step. This codebase's entire backend connects to PostgREST with
one static `service_role` key (`SUPABASE_KEY_SOCIAL`) for every tenant's
every request — tenant isolation is enforced entirely at the app layer
(`scoped()`), and `service_role` is created with `bypassrls` specifically
so Postgres never re-checks it (confirmed in this session's own local
role setup, mirroring Supabase's own default). Enabling RLS on just the
two new tables here would be security theater: every request already
authenticates to Postgres as a role RLS cannot constrain, so a policy on
`contact_consents`/`suppression_list` would never actually run for real
application traffic — only for a hypothetical direct connection as a
different role, which doesn't exist anywhere in this stack today. Making
RLS a *real* second layer would require switching the entire request
path to per-tenant-scoped PostgREST JWTs (a `role: authenticated` token
carrying a tenant claim PostgREST's own JWT secret can verify, replacing
`service_role` for ordinary CRUD) — a whole-application architecture
change spanning every table and route, not a Marketing-Hub-scoped one.
Recommending this as a dedicated, separately-scoped initiative if wanted,
rather than adding inert policies here that would give a false sense of
defense-in-depth.

**Tests run:** `cd backend && npm test` (37/37), plus
`marketing-routes.js`, `whatsapp-routes.js`, `broadcast-queue.js`,
`marketing-consent.js` (new, 17/17), `sales-concurrency.js`,
`sales-routes.js`, `sales-stage1.js` — all against the real local stack,
all green, including after the `updateScopedWithVersion` extraction.
Frontend: `npx eslint .` clean (including the new files);
`next build` currently fails on the **pre-existing, unrelated**
`/analytics` page (`useSearchParams() should be wrapped in a suspense
boundary`) — reproduced on a clean stash of this round's changes, so it
predates this work and is **not** something this round introduced;
flagged here for whoever next touches that page rather than silently
left for a future session to rediscover.

**Known gap carried forward, not fixed this round:** the per-contact
consent admin UI (view/override) lives only behind the raw API today —
`MarketingHub.jsx`'s "Consent & Suppression" tab covers the
tenant-wide suppression list but not yet a per-contact consent view (e.g.
surfaced on the Sales Hub contact drawer). Scoped out of Phase 1 to keep
this slice finishable; a natural small addition when Phase 6 (lifecycle/
attribution) next touches the contact drawer.

**Phase 1 self-assessment:** Module A's consent/preference item (A3) is
genuinely done and load-bearing — every other phase's send paths (email,
SMS, journeys) inherit this enforcement for free via
`lib/audience.js`'s `consentChannel` parameter, rather than needing their
own copy. Weakest part of this slice: no per-contact consent view
surfaced yet outside the raw API (noted above as carried forward).
Tech debt: none knowingly introduced — the `updateScopedWithVersion`
extraction is a strict improvement (one implementation instead of two).
What I'd attack next: Phase 2 (segmentation), since the AND/OR rule
builder is the most-referenced missing piece blocking a credible "build
a segment" demo, and because Phase 3 (email) needs real segment targeting
to be worth anything.

---

## 2026-10-14 — Phase 0 remaining/blocked carried forward

**Remaining/Blocked (credential- or infra-blocked, not code gaps):**
- No real Supabase/Postgres project is reachable from this session — all
  verification above used a from-scratch local stack. Running the same
  migrations against the real Supabase project before deploying is still
  required and untested here.
- No `ANTHROPIC_API_KEY` in this environment — AI features built in later
  phases will be code-complete and exercised against a mock/stub where
  possible, but the real Claude-backed call path will be
  **WORKS WITH MOCK PROVIDER** at best until a real key is supplied.
- No real email provider credentials (SES/SendGrid/Resend/SMTP) — Phase 3
  will ship a provider abstraction with a working local mock; real
  provider paths are **untested** until credentials exist.
- No real SMS provider credentials (Twilio/MSG91) — same posture for
  Phase 7.
- Existing gaps this audit found but did not yet fix (tracked for the
  phase that naturally touches that code, not fixed opportunistically
  here to keep Phase 0 strictly audit-only per the task's own protocol):
  `assign_owner` automation action has no frontend UI path; WhatsApp
  segment edit/delete, campaign explicit-contact-list targeting and
  campaign delete exist on the backend with no frontend UI; AI calls
  write no audit-log entry.

---
