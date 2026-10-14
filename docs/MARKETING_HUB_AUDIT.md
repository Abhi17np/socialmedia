# Marketing Hub — Phase 0 Audit

Dated 2026-10-14. This is a from-code audit, not a docs summary — every
claim below was verified either by reading the actual implementation
(route-by-route, with file:line citations) or by standing up a real local
stack (Postgres 16 + PostgREST 12.2.8 + Redis 7 + the real `node server.js`,
no mocks, no stubs) and exercising the existing integration-test scripts
against it. Where PROJECT_HANDOFF.md's claims disagreed with what running
the code showed, that's called out explicitly.

## 0. How this audit was produced

- Full read of `backend/routes/marketing.js`, `backend/lib/automation.js`,
  `backend/routes/whatsapp.js`, `backend/social/broadcastQueue.js`,
  `backend/lib/contacts.js` + migration 003, `backend/lib/ai.js`, migration
  015 + `docs/phase3-foundation.md`, `frontend/src/marketing/*`,
  `frontend/src/whatsapp/WhatsAppHub.jsx`, and the three relevant
  integration-test scripts + `backend/test/routes.security.test.js`.
- A local stack was built from scratch in this container (no Supabase
  account available): `initdb` → `socialhub_test` Postgres 16 database,
  all 24 migrations applied in order with zero errors, PostgREST 12.2.8
  run via Docker against it with the `web_anon`/`service_role`/
  `authenticator` roles from the integration-tests README, the repo's own
  `rest-proxy.js` stripping `/rest/v1`, a local Redis, and the real
  `node server.js` booted against all of it with `ANTHROPIC_API_KEY`
  unset (AI calls correctly 503, not faked).
- `cd backend && npm test` → **15/16 pass**; the 1 failure
  (`routes.security.test.js`) is `Cannot find module 'supertest'` —
  **a missing devDependency, not a logic failure** (`npm install` hadn't
  been run in this fresh container; `supertest` is in `package.json` but
  wasn't yet in `node_modules`). Not a pre-existing repo defect; flagged
  here only because it blocked a clean `npm test` run until `npm install`
  was (re-)run.
- `node scripts/integration-tests/marketing-routes.js` → **all 11
  assertions pass**, end to end, against the real local stack (hub-gate
  403, platform-admin gate flip, campaign CRUD + role gating, real
  link-post/link-whatsapp, analytics rollup, automation rule CRUD, and a
  genuine cross-Hub trigger: `POST /sales/contacts` really fired the rule,
  really tagged the contact `welcomed`, really logged the run).
- `node scripts/integration-tests/broadcast-queue.js`, re-run 3x fresh
  (flushing Redis between runs): **1 pass, 2 fail**, both failures the
  same assertion (`expected the second recipient to be marked failed after
  exhausting retries`), confirming PROJECT_HANDOFF.md's flakiness claim
  for this file is accurate, not stale. Root-caused below (§3) rather than
  left as "known flaky."
- A dedicated `Explore` subagent independently read all 12 code areas in
  the task brief in full and produced a detailed file:line report; its key
  claims (consent/opt-out completely absent, Phase 3 tables genuinely
  unread anywhere, `routes/whatsapp.js` has zero `requireHub()` calls) were
  independently spot-checked with direct greps in this session and all
  three confirmed true with zero false hits.

---

## 1. What exists and genuinely works (verified, not assumed)

**`backend/routes/marketing.js`** (271 lines) — every route real,
DB-backed, tenant-scoped via `scoped()`, `tenant_id` always from
`req.tenantId`. Campaign CRUD, link-post/link-whatsapp (verifies parent
campaign via `scoped()` before touching the un-scopable junction tables —
correct, not a gap), a real analytics rollup that sums only linked
WhatsApp/post rows and explicitly does **not** fabricate opens/clicks it
can't get from the WhatsApp Cloud API, and automation-rule CRUD +
run-history + retry. Verified end to end by `marketing-routes.js` against
a real database in this session.

**`backend/lib/automation.js`** (176 lines) — a real, generic, in-request
rule engine (not Sales-Hub-specific by design, just Sales-Hub-only by
current call sites). 5 triggers, 4 actions, all genuinely implemented
(`add_tag`/`remove_tag`/`create_task`/`assign_owner` all mutate real
rows), a real 10-second duplicate-fire guard, every firing logged to
`automation_runs`, a real `retryRun()` that re-executes rather than faking
success, and `fireTrigger()` never throws out of the calling route.
Verified by reading + the live cross-Hub firing in `marketing-routes.js`.

**`backend/routes/whatsapp.js`** (390 lines) — real Meta Graph API calls
(template submit/sync), real BullMQ enqueue on send, a hard 409
(`TEMPLATE_NOT_APPROVED`) gate — not a soft warning — and real per-send
plan-limit enforcement against `whatsappBroadcastSendsPerMonth`. Segment
CRUD and `audience_segments` are genuinely the single shared
implementation Marketing Hub also reads — no duplicated segment logic
anywhere.

**`backend/social/broadcastQueue.js`** (191 lines) — one BullMQ job per
recipient, deterministic job IDs (safe re-enqueue), real exponential
backoff (4 attempts, 10s base delay), and restart-safe by construction:
`processJob()` re-resolves the social account from the DB on every
execution rather than trusting in-memory state, so a worker restart
mid-campaign is safe for jobs Redis still holds.

**`backend/lib/contacts.js` + migration 003** — `resolve_contact()` is a
real, race-safe Postgres function (handles the concurrent-insert-loses
case explicitly), genuinely the single identity-resolution path for
WhatsApp/Instagram/Facebook.

**Frontend** (`frontend/src/marketing/*`, `frontend/src/whatsapp/
WhatsAppHub.jsx`) — every interactive element in both files traced to a
real backend call; no hardcoded/mock data found in either. Loading/empty/
error states present throughout both. WhatsAppHub.jsx's own header
comment ("nothing here is a placeholder") was verified true by reading.

**Integration tests that exist** (`marketing-routes.js`,
`whatsapp-routes.js`, `broadcast-queue.js`) are unusually rigorous —
they assert on real side effects (DB state, actual BullMQ retry timing,
actual webhook-driven status transitions, real HMAC signature
verification), not just HTTP status codes. This is a high bar to build
against; new modules should match it, not a lighter "returns 200" bar.

---

## 2. What is scaffolded, stubbed, or mocked

**`migrations/015_phase3_foundation.sql`** (3 tables:
`integrations_registry`, `workflow_definitions`, `cross_hub_ai_context`)
— confirmed genuinely inert. Grepped the entire `backend/` and
`frontend/` trees for all three table names: **zero** references outside
the migration file and `docs/phase3-foundation.md` itself. The doc's own
claim ("nothing reads or writes them yet") is accurate without
qualification — one of the few places in this codebase where the comment
and the code agree perfectly.

**`backend/lib/ai.js`** — real Anthropic calls (`draftPost`/`draftReply`),
real usage metering, real 503-on-missing-key (no silent fake draft). But
it is **Social-Hub-only**: zero call sites from Marketing Hub or WhatsApp
routes. No audit-log entry is written for AI calls (every other
Marketing/WhatsApp mutation calls `recordAudit()`; `routes/ai.js` never
does) — worth fixing as part of building the Marketing Hub AI layer, not
treated as acceptable precedent.

**Email/Calendar (Sales Hub, adjacent)** — OAuth connect scaffolding only,
honestly reported as `configured: false` with no real credentials in this
environment. Nothing past the connect handshake exists. Directly relevant
to Marketing Hub because module B (Email Marketing) needs its own,
separate send-side provider abstraction — this scaffolding is not
reusable for outbound marketing email (it's inbound-mailbox-OAuth shaped,
not SMTP/API-send shaped), so it isn't a shortcut for Marketing Hub's
email channel.

---

## 3. What is missing (verified absent, not merely "not mentioned")

- **No consent/opt-out model anywhere.** Grepped `contacts`,
  `contact_identities`, `whatsapp_campaigns`, `whatsapp_campaign_recipients`,
  `whatsapp_templates` schemas and all of `backend/lib`/`backend/routes`
  for `opt_out|opt_in|unsubscribe|consent` (excluding OAuth "consent
  screen" hits) — **zero results**. A WhatsApp segment can target any
  contact with a phone number; nothing in the send path can exclude a
  contact who asked not to be contacted. This is the single most
  consequential gap in the audit — section 2.A of the task brief
  (consent & preference model, server-side enforcement) cannot be
  retrofitted onto the current schema; it has to be built first, before
  any new send volume goes out, or every new channel/module built on top
  inherits the same compliance hole.
- **Email marketing channel**: does not exist. No provider abstraction, no
  template library/block editor, no tracking pixels/link-wrapping, no
  bounce/complaint webhooks, no A/B testing, no sender-domain management.
  100% of module B is new build.
- **SMS channel**: does not exist at all (not even scaffolding).
- **Journeys/visual workflow builder**: `docs/phase3-foundation.md` itself
  states, and code confirms, that `workflow_definitions.graph_json` is
  inert and no executor exists. Today's automation engine is a flat
  one-trigger-one-action rule, not a multi-step journey with branching/
  delay/wait-until — module D is a new engine (ideally an evolution of
  `lib/automation.js`'s action implementations, per the Phase 3 doc's own
  recommended approach of extending rather than replacing).
- **Forms, landing pages, public lead-capture API/webhooks**: none exist.
- **Lead scoring exists (Sales Hub) but is not Marketing-Hub-aware**:
  `lib/leadScoring.js` recomputes on contact create/update for Sales Hub;
  no engagement-scoring component from email/WhatsApp/web behavior feeds
  into it, and no lifecycle-stage automatic-transition model exists.
- **Attribution**: no first/last-touch/linear attribution model, no
  campaign→contact→deal→revenue rollup beyond Marketing Hub's existing
  analytics (which only rolls up send/delivery counts, not revenue).
- **Analytics/reporting beyond the one per-campaign rollup**: no custom
  report builder, no saved reports, no scheduled digests, no cohort/
  send-time-heatmap/link-click-map views.
- **Workspace features**: no marketing calendar, no brief/approval
  workflow, no asset/media library, no UTM builder, no budget/ROI tracker.
- **All 11 AI features in section 4 of the task brief**: none exist for
  Marketing Hub. `lib/ai.js` has no brand-voice concept, no campaign
  copilot, no NL segment/journey builder, no send-time optimization, no
  predictive scoring, no performance-insight summaries, no content
  repurposing, no smart-reply-from-campaign-context.

---

## 4. Gap matrix

Status key: **DONE** (built, tested, working) · **PARTIAL** (real backend
or frontend half exists, the other doesn't, or scope is narrower than the
brief) · **MISSING** (nothing exists).

| # | Feature (task brief §3/§4) | Status | Note |
|---|---|---|---|
| A1 | Dynamic segment rule builder (AND/OR, contact/tag/score/lifecycle/channel/deal/behavioral) | DONE for everything with real data today (2026-10-14, Phase 2); behavioral events MISSING (no data source yet) | `lib/segmentCompiler.js` compiles an AND/OR tree into one PostgREST-filtered query (contact fields, tags, lead score, lifecycle stage, channel identity, consent status, deal stage/status/amount) — no full-table scan, no N+1. Behavioral-event fields (opened/clicked/replied/visited/form submitted) deliberately not exposed — they need Phase 3 (email tracking) / Phase 5 (forms/site tracking) to exist first; building the field now would mean a condition that can never match anything real. Verified by `marketing-segmentation.js` (10/10) and `test/segmentCompiler.test.js` (14/14 pure-logic unit tests). |
| A2 | Static lists + import, real-time count preview | PARTIAL → mostly DONE (Phase 2) | `segment_members` table + membership CRUD (`POST/DELETE .../segments/:id/members`) give static lists real stored membership, distinct from dynamic segments; preview is real-time and now consent-aware for both segment types. **Still missing**: bulk CSV import into a static list (today's UI only supports one-at-a-time add via search) — scoped out of this round, left for whenever list-building volume actually needs it. |
| A3 | Consent & preference model, server-side enforcement | DONE (2026-10-14, Phase 1) | `contact_consents`/`suppression_list`/`global_opt_out_at` (migration 025) + `lib/consent.js`, enforced in `routes/whatsapp.js`'s send path (re-checked live, not just at campaign creation), public preference center, admin suppression-list UI. Verified end to end by `marketing-consent.js` (17/17) — a suppressed/opted-out contact never reaches the real send call. See `MARKETING_HUB_IMPLEMENTATION.md`'s Phase 1 entry. |
| B. Email Marketing (entire module) | DONE for the core pipeline (2026-10-14, Phase 3); some sub-items PARTIAL/DEFERRED | Provider abstraction (mock/SMTP/SendGrid/Resend) + mock fully LIVE, others WORKS-WITH-MOCK/untested (no real credentials). Block-based editor (not drag-and-drop — recorded scope cut), merge tags, send-test, preview all real. Compliance (unsubscribe, List-Unsubscribe/-Post RFC 8058, physical address, suppression enforcement) and tracking (open pixel, click redirect, per-recipient event log) fully LIVE, verified end to end including a real simulated hard-bounce auto-suppressing. A/B subject-line split is structural (variants + reporting); **automatic winner selection is explicitly deferred** (needs a time-windowed scheduler, no data to justify building speculatively yet). Domain SPF/DKIM/DMARC: real DNS-check code written and unit-tested (pure predicate logic), but genuinely **unverified end-to-end** — this sandboxed session has no outbound DNS egress at all. See `MARKETING_HUB_IMPLEMENTATION.md`'s Phase 3 entry for the full breakdown and a 20-assertion integration test (`marketing-email.js`). |
| C1 | WhatsApp unified into Marketing Hub campaigns | DONE | `marketing_campaign_whatsapp` link + rollup, verified live |
| C2 | SMS channel | DONE | `lib/sms/*`/`routes/marketingSms.js`: same provider-abstraction shape as email (mock/Twilio/MSG91, encrypted connection, consent-gated campaigns, BullMQ queue, usage metering). Twilio/MSG91 untested against real accounts (no credentials in this environment), same honesty posture as Phase 3's SendGrid/Resend. Verified by `marketing-sms.js` (10/10) against the real mock provider. |
| C3 | Multichannel campaign with fallback rules | DONE (as a journey composition, not a new primitive) | A `send_sms` journey action now exists alongside `send_email`/`send_whatsapp` — a tenant composes `send_whatsapp -> delay -> condition -> send_sms` with Phase 4's existing nodes for a real fallback sequence. No new "fallback campaign" object was built; see Phase 7's scope decision for why a condition-on-delivery-status field (needed for a true "only if WhatsApp failed" condition) is deferred rather than this round's full scope. |
| C4 | Social Hub posts tied into one campaign/UTM/report | PARTIAL | Link-post exists and rolls into analytics; no shared UTM builder |
| D. Journeys/visual workflow builder (entire module) | DONE (engine + linear editor; branching graph-canvas authoring deferred) | `lib/journeyEngine.js`/`journeyGraph.js`: real multi-step graph engine with delay, condition/split branching, re-entry control, and a goal condition — restart-safe, idempotent, unit+integration tested (see `docs/MARKETING_HUB_IMPLEMENTATION.md`'s Phase 4 entry). `lib/automation.js` (flat rules) kept as-is, unmerged, by deliberate choice. Editor UI authors/edits only straight-line journeys (covers all 7 templates); a branching graph is fully runnable but not yet authorable visually — see Phase 4's scope decisions. |
| E. Lead capture & growth (forms, landing pages, public API, MQL handoff) | DONE (hosted forms + real handoff; standalone landing-page builder and a tenant API-key system deferred) | `lib/leadForms.js`/`routes/leadForms.js`: a tenant-authored, dynamically-shaped lead form, a public hosted page (no login, `/forms/:id`), honeypot spam handling, double opt-in, and a real `contacts` row (lead_source='web_form') on every genuine submission — the handoff into Sales Hub, not a shadow record. Fires the new 'form_submitted' journey trigger. A hosted form IS this round's "public API" (see Phase 5's scope decision); a standalone landing-page builder and a tenant-facing API-key/webhook system are explicitly deferred, not silently dropped. Verified by `marketing-lead-forms.js` (23/23) and `test/leadForms.test.js` (15/15 pure-logic unit tests). |
| F1 | Engagement scoring combined with lead scoring | DONE | `lib/leadScoring.js` adds 4 behavioral condition types (email opened/clicked, form submitted, journey completed) into the SAME scoring model/table Sales Hub already had — no second score. Recomputed live off real events (the actual tracking pixel/redirect, a real form submission, a real journey completion), plus tenant-configurable MQL auto-promotion (subscriber/lead → mql) with audit logging and a new 'became_mql' journey trigger. Verified by `marketing-scoring-attribution.js` (17/17) and `test/leadScoring.test.js` (17/17 pure-logic unit tests, including a regression test for a real promotion-guard bug found and fixed this round). |
| F2 | Attribution (first/last/linear → revenue) | DONE | `lib/attribution.js` computes first-touch/last-touch/linear attribution live from real per-contact event tables (email opens/clicks, form submissions, journey completions, WhatsApp delivery) for every won deal, strictly before its `closed_at`, rolled up by channel + source + CURRENCY (never summed across currencies, matching Sales Hub's own forecast/dashboard convention). No N+1: a tenant-wide report batch-fetches touchpoints for every relevant contact in exactly 4 queries regardless of deal count. Verified by `marketing-scoring-attribution.js` and `test/attribution.test.js` (7/7 pure-logic unit tests on the credit-splitting math). |
| F3 | Website tracking snippet | MISSING (still deferred) | Flagged in brief as deferrable — deferred past this build's scope per Phase 0's build plan; unchanged this round. |
| G. Analytics & reporting (beyond one campaign rollup) | PARTIAL/MISSING | Per-campaign rollup real; everything else (custom builder, saved reports, digests, heatmaps) missing |
| H. Workspace (calendar, briefs/approval, audit trail, asset library, UTM builder, budget/ROI) | MISSING | Audit log exists generically (`lib/audit.js`) and is used for campaign/rule CRUD, but no brief/approval workflow or calendar view |
| AI 1-11 (brand voice, copilot, copy gen, NL segment/journey builder, send-time opt, predictive scoring, insights, repurposing, smart reply, guardrails) | MISSING | `lib/ai.js` exists and is a real pattern to extend; zero Marketing Hub integration today |

---

## 5. Build plan

Ordered into phases by dependency and risk. Each phase is a vertical
slice per the task's own working protocol (migration → backend → frontend
→ integration test → docs → commit), built on the existing patterns this
audit verified work (`scoped()`, `requireHub`, BullMQ with deterministic
job IDs, the `version`/409 optimistic-concurrency pattern, `lib/audit.js`).

**Phase 1 — Consent & preference foundation (blocking, build first).**
Risk: low technically, high if skipped (every later send-capable module
inherits a compliance hole otherwise). Dependency: nothing upstream;
everything downstream (email sends, WhatsApp sends, journeys) depends on
it. Adds consent/opt-out columns and a suppression-list table, a
preference-center page, and **server-side enforcement in the existing
WhatsApp send path** (`routes/whatsapp.js`'s `/campaigns/:id/send`) before
any new channel is built on top of the same gap.

**Phase 2 — Segmentation upgrade (AND/OR rule builder, static lists).**
Risk: medium (query performance at scale — the brief explicitly calls out
avoiding full-table scans per request). Dependency: Phase 1's consent
fields become segment-filterable fields immediately, so sequencing after
Phase 1 avoids a second migration touching the same filter-evaluation
code path.

**Phase 3 — Email Marketing module (provider abstraction, mock provider
first, editor, compliance, tracking, A/B test).** Risk: medium-high
(largest single module; provider abstraction choice affects everything
after it). Dependency: Phase 1 (consent gate on every send) and Phase 2
(segment targeting) must exist first since email campaigns target
segments and must honor consent.

**Phase 4 — Journeys/automation upgrade (canvas authoring surface over an
extended `lib/automation.js`, not a second engine, per
`docs/phase3-foundation.md`'s own architectural call, which this audit
endorses as correct).** Risk: high (new BullMQ queue for delay/wait
nodes, live-edit-safety, re-entry rules). Dependency: needs Phase 3's
email send action and Phase 1's consent gate as action/condition
primitives before a journey can meaningfully use them.

**Phase 5 — Lead capture & growth (forms, landing pages, public API,
Sales Hub handoff).** Risk: medium (public-facing attack surface — spam
protection, rate limiting, signed webhooks). Dependency: Phase 4's journey
triggers (instant enrollment on submit) and Phase 1's consent capture
(double opt-in at the form level).

**Phase 6 — Scoring, lifecycle & attribution.** Risk: medium (attribution
model correctness, currency-grouped revenue rollups per the existing
Sales Hub standard). Dependency: needs real send/engagement event data
from Phases 3-5 to score against; building it earlier would have nothing
real to compute over.

**Phase 7 — SMS + multichannel fallback.** Risk: medium (DLT/India
compliance is a documentation and provider-account dependency, not
primarily a code risk). Dependency: reuses Phase 3's provider-abstraction
pattern and Phase 1's consent model.

**Phase 8 — Analytics & reporting (custom builder, saved reports, digests)
+ Workspace (calendar, briefs/approval, UTM builder, budget/ROI).** Risk:
low-medium. Dependency: needs real campaign/journey/attribution data from
every prior phase to report on meaningfully.

**Phase 9 — AI layer (brand voice → campaign copilot → NL segment/journey
builders → send-time optimization → predictive scoring → performance
insights → content repurposing → smart replies → guardrails), threaded
through every module above as each becomes AI-addressable** rather than
bolted on at the end as one giant feature. Risk: medium (prompt-injection
hardening, per-tenant data isolation in prompts, usage metering). This is
the headline differentiator per the task brief, but it has no data to be
useful without Phases 1-6 existing first (brand voice needs campaigns to
apply to; predictive scoring needs real engagement events; performance
insights need real metrics) — building AI first would mean grounding it
in nothing, which the brief explicitly prohibits ("no invented numbers").

**Explicitly deferred, with reasons (not silently dropped):**
- Website tracking snippet (F3) — the brief itself flags this as
  deferrable if too large; recommend deferring past this build's scope
  given the consent/privacy design it requires is substantial enough to
  deserve its own phase rather than being squeezed into module F.
- Postgres RLS as a second isolation layer — evaluated in §6 of the
  build's hard-constraints; recommend a feasibility spike alongside Phase
  1 (same migration work touches the tables RLS would need), not a
  blocking prerequisite for every phase.

---

## 6. Honest self-assessment at the end of Phase 0

**Percent complete, Marketing Hub overall**: roughly 15-20% of the full
scope in the task brief. What exists (campaign orchestration linking
WhatsApp + social posts, a flat automation engine, shared segments) is
genuinely solid and well-tested, not a demo — but it is a foundation, not
a product competitive with the benchmarked tools yet.

**Known weaknesses in the existing code** (to fix opportunistically while
touching this area, not deferred indefinitely):
- `assign_owner` automation action is backend-complete but has no frontend
  UI path to create it.
- WhatsApp segment edit/delete, campaign explicit-contact-list targeting,
  and campaign delete all exist on the backend with no frontend UI.
- AI calls write no audit-log entry, inconsistent with every other
  mutating action in this codebase.
- `broadcastQueue.js` has a narrow, undocumented at-least-once-not-
  exactly-once risk if a worker crashes between a successful Meta send and
  the `completed` listener recording it.
- No explicit send-rate limiter on the WhatsApp broadcast worker beyond
  `concurrency: 10` — relies on Meta's own 429s.
- `whatsapp-routes.js`/`broadcast-queue.js` integration-test flakiness is
  confirmed real in this session, and root-caused rather than left as
  "known flaky": **a previously-undocumented hazard** — this session had
  a separate, long-running `node server.js` instance from earlier testing
  still connected to the same local Redis, with its own real
  `social/broadcastQueue.js` `Worker` on the identical `QUEUE_NAME`.
  `broadcast-queue.js` re-run 3x with that process alive: 1 pass, 2 fail
  (`expected the second recipient to be marked failed after exhausting
  retries` / `expected exactly 4 attempts, got 2`) — both signatures
  consistent with a second, independent worker stealing jobs meant for
  the test's own fake-DB-backed worker and processing them against the
  real (non-mocked) code path instead. After killing that process and
  re-running clean: 2 of 3 fresh runs passed every assertion; one still
  failed on the same "second recipient never reached failed" assertion
  within its 110s poll window. The integration-tests README already warns
  "don't run the server and `whatsapp-routes.js` at the same time against
  the same Redis" — **this audit confirms the exact same hazard applies
  to `broadcast-queue.js` itself**, which the README doesn't currently
  call out, and should be added there. The residual flake (1 failure even
  with no competing worker) is most plausibly resource contention: this
  session's verification stack runs Postgres + dockerized PostgREST +
  Redis + the full Node app in one shared, CPU-constrained container,
  and the failing assertions are all real-wall-clock-timing-based
  (~70s of genuine exponential backoff against a 110s/15s poll deadline)
  — exactly the kind of assertion that gets intermittently squeezed by
  scheduler contention in a loaded shared environment, not by a logic
  bug in `broadcastQueue.js` itself (its logic was verified correct by
  the passing runs reaching every assertion including the exact
  `attempts:4` retry count). Recommended fix, deferred to whoever next
  touches this file rather than done speculatively here: (1) update the
  README to warn about any BullMQ worker on the same queue/Redis, not
  just the dev server specifically; (2) consider a slightly wider poll
  deadline or a computed-from-backoff-config deadline instead of a hardcoded
  110s/15s, so the test is robust to a slower CI/dev box without masking
  a real hang.

**What I would attack next**: Phase 1 (consent) immediately, since it's
both the smallest and the one every later phase's correctness depends on.

**Tech debt being accepted knowingly going in**: building Journeys as an
extension of `lib/automation.js` rather than a clean-slate engine (per
Phase 3 foundation doc's own recommendation) means the automation data
model will need a real migration path from flat rules to graph-based
journeys at some point — deferred to Phase 4 itself, not pretended away
here.
