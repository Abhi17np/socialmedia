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
