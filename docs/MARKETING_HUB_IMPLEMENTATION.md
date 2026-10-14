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

## 2026-10-14 — Phase 2: Segmentation upgrade

**Status: LIVE** (pure app DB + logic, no external credentials; verified
against the same real local Postgres/PostgREST/Redis stack).

**Files added:**
- `backend/migrations/026_segmentation.sql` — `contacts.lifecycle_stage`
  (subscriber/lead/mql/sql/opportunity/customer/evangelist/other, the
  standard lifecycle vocabulary from the benchmark research),
  `audience_segments.segment_type` ('dynamic' default / 'static'),
  `segment_members` (static-list membership).
- `backend/lib/segmentCompiler.js` — compiles an AND/OR condition tree
  into **one** PostgREST filter string executed as a single `contacts`
  query. Native fields (tags, lead_status, lifecycle_stage, lead_score,
  email/phone presence, owner/company, created_at, display_name, global
  opt-out) translate directly into the query's predicate. Cross-table
  fields (channel identity, consent status, deal stage/status/amount/has-
  open-deal) are pre-resolved to a small, bounded contact-id set (bounded
  by how many matching deals/identities/consent rows exist, never by
  total contact count) and folded into the same final query as an
  `id.in.(...)`/`id.not.in.(...)` leaf — no N+1, no full-table scan, no
  pulling the whole audience into Node to filter in JS.
- `backend/test/segmentCompiler.test.js` — 14 pure-logic unit tests (tree
  validation, every native-field PostgREST fragment, value escaping) with
  no DB dependency, run by `npm test`.
- `backend/scripts/integration-tests/marketing-segmentation.js` — 10
  assertions against the real stack: a genuine nested AND/OR tree
  resolves to exactly the right contact among 4 candidates; a
  channel-identity condition and a deal-based condition (`has_open_deal`)
  both resolve correctly via their small side-queries; an invalid field
  name 400s cleanly instead of crashing; a **pre-Phase-2 legacy-shape
  segment still resolves identically** (backward compatibility actually
  exercised, not assumed); static-list add/remove/preview all verified
  against real `segment_members` rows.
- `frontend/src/marketing/SegmentRuleBuilder.jsx` — a two-level AND/OR
  rule builder (top level combines groups, each group combines its own
  conditions) covering every field the backend supports except
  `deal_stage_id` (would need a pipeline/stage picker fetch; scoped out
  to keep this slice finishable, still reachable directly via the API).

**Files changed:**
- `backend/lib/audience.js` — `resolveSegmentContacts`/
  `resolveExplicitContacts`/`countSegment` now detect `segment_type`
  (static → `segment_members` join) and `filter_json`'s shape (v2 tree →
  `segmentCompiler`, v1 flat → the original, completely untouched
  `applyFilter`), so every existing caller (WhatsApp send, Marketing Hub
  campaigns) gets both upgrades for free.
- `backend/routes/whatsapp.js` — segment create/update validates a v2
  tree with `segmentCompiler.validateTree()` before it's ever persisted
  (a bad field/operator 400s immediately, not at the next send attempt);
  new static-list membership routes; `/segments/:id/preview` gained an
  optional `?channel=` so the segment-builder UI can get a plain or
  channel-specific count without assuming WhatsApp.
- `backend/routes/marketing.js` — new `GET /marketing/contacts/search`
  (lightweight contact lookup for the static-list member picker, gated by
  `requireHub('marketing')` only, not Sales Hub, since contacts are the
  shared unified spine, not a Sales Hub concept).
- `backend/lib/schemas.js` — recursive zod schema for the v2 tree shape
  (general shape only; `segmentCompiler.validateTree()` owns the actual
  field/operator semantics, same division of labor as every other
  `validate()` + route-level check pair in this codebase).
- `frontend/src/whatsapp/WhatsAppHub.jsx`'s `SegmentsTab` — segment type
  toggle, the new rule builder for dynamic segments, a "Manage members"
  drawer (search → add → remove) for static lists, suppressed-count
  shown alongside the eligible count.

**Tests run:** `npm test` (51/51, up from 37 — 14 new pure-logic
segment-compiler tests), `marketing-routes.js`, `whatsapp-routes.js`,
`marketing-consent.js`, `marketing-segmentation.js` (new, 10/10),
`sales-concurrency.js`, `sales-routes.js` — all green against the real
local stack. Frontend `eslint .` clean; `next build` compiles the new
code successfully (the **pre-existing** `/analytics` prerender failure
from Phase 1's notes is unchanged — still not introduced by this round,
and still not fixed: tracing it further showed the root cause is
`app/(app)/layout.jsx` itself calling `useSearchParams()` with no
Suspense boundary, which is the shared shell for every page in the app,
not something scoped to Marketing Hub — fixing it safely needs
regression-testing Sales Hub, Social Hub and Billing's pages too, not
just Marketing Hub's, so it's left flagged rather than attempted
mid-slice).

**Decision recorded:** behavioral-event segment fields (opened email,
clicked link, replied on WhatsApp, visited a page, submitted a form) are
not exposed in the v2 field registry yet, even as a stub — see the gap
matrix (A1) for why: Phase 3/5 haven't created the underlying event
tables, and a condition that can never match real data is worse than no
condition at all (looks supported, silently returns nothing). The field
registry is additive by design — adding `email_opened_count` etc. once
Phase 3 exists is a new `CROSS_RESOLVERS` entry, not a redesign.

**Known gaps carried forward:**
- No bulk CSV import into a static list — only one-at-a-time add via the
  search picker. The brief's "+ import" for module A2 is partially
  unaddressed; worth revisiting if/when list-building volume makes
  one-at-a-time impractical.
- `deal_stage_id` has no UI picker (needs a pipeline/stage fetch the
  builder doesn't do yet) — backend-complete, frontend gap, same pattern
  as `assign_owner` from Phase 0's audit.
- The rule builder is two levels deep (groups of conditions, not
  arbitrarily nested groups-of-groups) — the backend has no such limit;
  this is a UI scope decision, not a backend one.

**Phase 2 self-assessment:** the compiler design (single compiled query +
small bounded side-queries, never N+1/full-scan) is the piece I'm most
confident is production-grade — it was built and tested against real
cross-table data (deals, contact_identities, contact_consents), not just
the happy path of contacts-native fields. Weakest part: the UI's
two-level cap and missing deal-stage picker are real, if minor, scope
cuts. Tech debt: none knowingly introduced. What I'd attack next: Phase 3
(email), since segments now have enough real targeting power to be worth
sending something to.

---

## 2026-10-14 — Phase 3: Email marketing module

**Status by piece (honesty key from this doc's header):**
- Provider abstraction + mock provider: **LIVE** (exercised end to end against a real local stack, no stubbing).
- SMTP/SendGrid/Resend providers: **WORKS WITH MOCK PROVIDER** — code-complete against each provider's documented API, genuinely untested against a real account (none available in this environment). SES is deliberately **not** a separate hand-rolled API/SigV4 client — covered via the SMTP provider, which SES's own SMTP interface supports; see `lib/email/providers/smtp.js`'s header for why that's a smaller, more honestly-verifiable surface than reimplementing AWS request signing untested.
- Compliance (unsubscribe, RFC 8058 List-Unsubscribe/-Post, physical address footer, suppression enforcement) and tracking (open pixel, click redirect, per-recipient event log): **LIVE**, verified end to end.
- Block-based template editor, merge tags, live preview, send-test: **LIVE**.
- Campaigns (one-off + scheduled, consent-gated send): **LIVE**.
- A/B subject-line testing: **LIVE** for the split + per-variant reporting; automatic winner selection is **DEFERRED** (see below).
- Domain SPF/DKIM/DMARC checks: predicate logic **LIVE** (unit-tested without network); the actual DNS lookup wrapper is **code-complete, unverified** — this sandboxed session has no outbound DNS egress at all (confirmed: even `dns.resolveTxt('google.com')` fails with ENOTFOUND here).

**Files added (backend):**
- `backend/migrations/027_email_marketing.sql` — `email_provider_connections` (one per tenant, secret encrypted via the existing `social/crypto.js`), `email_sender_domains`, `email_templates`, `email_campaigns`, `email_campaign_recipients`, `email_events` (the per-recipient event log), plus `recompute_email_campaign_counts()` and `mark_email_recipient_event()` Postgres functions mirroring migration 012's WhatsApp precedent exactly (forward-only status advancement, since tracking pixels/webhooks can arrive out of order or more than once). `tenants.marketing_postal_address` for the compliance footer. `usage_counters.email_sends` + `increment_usage()`'s allowlist extended, following migration 012's exact pattern.
- `backend/lib/email/providers/{mock,smtp,sendgrid,resend}.js` — the provider abstraction, same `{ isConfigured, send }` shape as `social/adapters/`.
- `backend/lib/email/providerRegistry.js` — loads a tenant's active connection (decrypted fresh per call, never persisted into a BullMQ job payload) and falls back to the mock provider when nothing is configured, so campaigns work in dev/trial with zero setup.
- `backend/lib/email/emailQueue.js` — BullMQ send queue, same restart-safe shape as `social/broadcastQueue.js` (one job per recipient, deterministic job id, exponential backoff). Two deliberate improvements over that file's own documented gaps (Phase 0 audit): (1) per-tenant send pacing via a computed per-recipient stagger delay (`EMAIL_SENDS_PER_MINUTE_PER_TENANT`, default 60/min) — `broadcastQueue.js` has no rate limiter at all; (2) a hard bounce throws BullMQ's `UnrecoverableError` so it's never retried 4 times pointlessly, and auto-adds the address to `suppression_list` tenant-wide.
- `backend/lib/emailRenderer.js` — pure block-to-HTML/text rendering + merge-tag substitution (`{{field|fallback}}`), HTML-escaped (contact data is untrusted input). 11 unit tests.
- `backend/lib/email/compliance.js` — unsubscribe/preference-center URLs, RFC 8058 `List-Unsubscribe`/`List-Unsubscribe-Post` headers, the compliance footer, open-pixel and click-tracking URL builders.
- `backend/lib/email/sendPipeline.js` — composes the above into the exact message a provider receives; used identically by the real send path and the send-test endpoint, so a test send can never drift from a real one.
- `backend/lib/email/campaignSender.js` — the actual "send this campaign" logic (resolve consented recipients, check the plan limit, render each recipient, enqueue), extracted so both the manual `/send` route and the scheduled-send sweep below call the exact same path. See "Scheduled-send gap closed" further down — this file didn't exist until that fix.
- `backend/lib/email/scheduledSendSweep.js` — the restart-safe sweep that actually promotes a due `scheduled` campaign, same shape as `lib/sequenceScheduler.js`.
- `backend/lib/emailDomainCheck.js` — SPF/DKIM/DMARC record-matching predicates (pure, unit-tested) + the DNS-resolving wrapper (honesty note on its unverified status in its own header).
- `backend/routes/marketingEmail.js` — provider connection CRUD + test-send, sender-domain CRUD + DNS check, templates CRUD + preview + send-test, campaigns CRUD + send + cancel + report, and the public tracking/one-click-unsubscribe endpoints. Every mutation audit-logged; templates/campaigns use `updateScopedWithVersion` (optimistic concurrency, same as Sales Hub).
- `backend/test/{emailRenderer,emailDomainCheck}.test.js` — 20 pure-logic unit tests, no DB/network.
- `backend/scripts/integration-tests/marketing-email.js` — 20 assertions against the real stack. The critical ones: a campaign to 2 eligible + 1 excluded contact sends for real through the mock provider; a contact crafted to simulate a hard bounce (`+bounce@` convention, matching `broadcastQueue.js`'s own test-address pattern) is immediately marked bounced (not retried) and auto-suppressed tenant-wide; the real open-pixel and click-redirect endpoints advance a recipient's status `sent → opened → clicked` and write a real `email_events` row for each; one-click unsubscribe really opts the contact out and rejects a mismatched token.

**Files added (frontend):**
- `frontend/src/marketing/EmailBlockEditor.jsx` — a structured block-list editor (add/reorder/remove heading/text/image/button/divider/spacer blocks). **Not** a free-form drag-and-drop canvas — see "Scope decisions" below.
- `frontend/src/marketing/Email{Templates,Campaigns,Settings}Section.jsx` + `EmailTab.jsx` — the full UI: template list + editor + live preview (an `iframe` rendering the exact backend-generated HTML) + send-test; campaign list + creation (template/segment pickers, scheduling, A/B toggle) + detail drawer with a real report and recipient table; settings (provider connection form, sender-domain list with a real "Check now" DNS button, physical address).

**Files changed:**
- `backend/server.js` — mounts `marketingEmailRoutes.{router,publicRouter}`, starts/stops `emailQueue` alongside `broadcastQueue` in the same lifecycle hooks.
- `backend/lib/plans.js` / `lib/entitlements.js` — `emailSendsPerMonth` limit + usage-column mapping, following the exact `whatsappBroadcastSendsPerMonth` precedent.
- `frontend/src/marketing/MarketingNav.jsx` / `MarketingHub.jsx` — new "Email" sidebar item routing to `EmailTab`.

**Real bug found and fixed via actual browser testing (not just API tests)**: `EmailTemplatesSection.jsx`'s preview fetch called `authFetch(...)` with no `method`, defaulting to GET against a POST-only route — a silent 404 that left the live preview stuck on a loading skeleton forever, masked entirely by the backend integration test (which calls the API directly with the correct method) and by `eslint`. Caught only by actually opening the page in a real browser with Playwright and watching the preview never resolve, per the task's own testing requirement ("Verify every screen visually... Type checking and test suites verify code correctness, not feature correctness"). Fixed and re-verified: the iframe now renders real merge-tag-substituted HTML with the real compliance footer. This is exactly the category of bug a thorough visual pass is for — recorded here as justification for why that step isn't optional busywork.

**Scope decisions recorded (per task §7):**
1. **Block-based editor, not drag-and-drop.** A true visual canvas (drag to reorder, inline WYSIWYG text editing, resizable images) is a substantially larger frontend effort than a structured block list with add/remove/reorder controls and a live preview. The block list covers the brief's functional requirement (merge tags, responsive HTML, brand-consistent blocks) without the multi-week canvas-editor effort; reorder-by-button exists, drag-and-drop doesn't.
2. **A/B automatic winner selection deferred.** Building the split, variant tracking, and per-variant reporting was in scope and is done; automatically declaring a winner after N hours and auto-sending the remainder needs a new time-windowed scheduler component (comparable in shape to `lib/sequenceScheduler.js`) that has no other immediate use yet. Shipping the manual half (pick the better variant from the real report, send a follow-up) now, and building the scheduler when a second time-windowed need (e.g. send-time optimization, Phase 9) makes it worth the shared infrastructure, is the better sequencing than building a single-purpose scheduler early.
3. **SES via SMTP, not a dedicated API client.** See the SMTP provider's own header — reusing one well-understood, already-proven-in-this-codebase path (`nodemailer`, already used by `lib/email.js` for transactional mail) for every SMTP-speaking provider is a smaller, safer surface than hand-rolling AWS SigV4 signing that this environment has no SES account to verify against anyway.
4. **Domain DNS checks: real logic, untestable here.** Rather than mock DNS resolution to make a test pass, the predicate logic (what counts as a valid SPF/DKIM/DMARC record) is unit-tested in complete isolation from the network, and the thin DNS-calling wrapper is clearly flagged as unverified in its own code comments and in this log — honest about the exact boundary of what's proven versus what's merely written.

**Tests run:** `npm test` (71/71, up from 51 — 20 new: 11 `emailRenderer`, 9 `emailDomainCheck`), `marketing-email.js` (new, 20/20), plus the full existing suite (`marketing-routes`, `whatsapp-routes`, `marketing-consent`, `marketing-segmentation`, `sales-concurrency`, `sales-routes`) all still green — re-confirmed clean after discovering and ruling out the same BullMQ-worker-race hazard (a leftover `node server.js` from this round's own visual-testing session caused two spurious failures on an unclean run; killing it and re-running produced the expected 100% pass, consistent with the root cause documented in Phase 0's audit). Frontend `eslint .` clean; `next build` compiles the new code successfully (pre-existing, unrelated `/analytics` prerender failure persists, not touched — see Phase 2's entry). **Visual verification performed**: real Playwright screenshots at desktop (1440px) and mobile (390px) widths against the actual running app (not a storybook/isolated render) — template editor, live preview, campaign creation modal (including the A/B toggle), settings page, and empty states all confirmed rendering correctly; a genuine mobile layout issue (`PanelHeader`'s title getting truncated to "S..." when paired with a long `meta` string and no `action`) was found, confirmed as a **pre-existing** bug already visible on the untouched WhatsApp Templates tab's mobile view (not introduced this round), and worked around on this round's own three affected panels by shortening their `meta` text — the shared `PanelHeader` component itself was deliberately left alone, same reasoning as the `/analytics` Suspense issue: fixing a component used by every Hub's every page needs whole-app regression testing outside this slice's scope.

**Known gaps carried forward:**
- SMTP/SendGrid/Resend need a real account to move from "code-complete" to "LIVE" — exact steps: set `provider`/`config`/`secret` via `PUT /marketing/email/connection`, then `POST /marketing/email/connection/test` to a real inbox and confirm delivery.
- Domain DNS checks need an environment with outbound DNS egress to verify `checkDomainDns()` itself (the predicate logic it calls is already proven).
- A/B automatic winner selection, drag-and-drop block editor, and bulk CSV import into the editor's image blocks (no asset upload — image blocks take a URL, not a file) are explicitly deferred, not silently dropped.
- ~~No scheduled-send sweep~~ **Fixed same day, before this entry was closed out** (see "Scheduled-send gap closed" below) — left visible here, struck through, as a record that the gap was real and caught, not quietly edited out of the history.

**Scheduled-send gap closed (same round):** a campaign created with `sendMode: 'scheduled'` correctly stored `status='scheduled'` + `scheduled_at`, but nothing read it back — a real functional gap, not a documentation nicety, since a tenant could schedule a send today and it would simply never fire. Fixed by extracting the send logic out of `routes/marketingEmail.js`'s `/send` handler into `backend/lib/email/campaignSender.js` (`sendCampaign()`, with `.statusCode`/`.code` on thrown errors so the route can still translate them to the right HTTP response), and adding `backend/lib/email/scheduledSendSweep.js` — a 60-second restart-safe interval sweep, same shape as `lib/sequenceScheduler.js`, that finds every `scheduled` campaign whose `scheduled_at` has passed and calls the identical `sendCampaign()` the manual "Send now" button uses (never a second, drifting reimplementation). A campaign that fails at its scheduled time (template deleted, plan limit hit since scheduling, etc.) is marked `failed` with the real error logged, not retried forever or left silently `scheduled`. Verified by a new assertion in `marketing-email.js`: create a campaign scheduled 1 second in the past, call the sweep directly (not waiting on the real 60s interval), and confirm it actually transitions to `sending`. Wired into `server.js`'s startup/shutdown lifecycle alongside the other queues/sweeps. Full regression re-run clean after this change (71 unit tests, 6 integration scripts, 21/21 on `marketing-email.js` including the new assertion).

**Phase 3 self-assessment:** this is the largest single slice so far and the one with the most genuinely LIVE, end-to-end-verified surface area (consent enforcement, hard-bounce suppression, tracking, one-click unsubscribe, and now a verified scheduled-send path) — not just CRUD. Catching the scheduled-send gap via this document's own closing self-assessment, then actually fixing it in the same round rather than carrying it forward, is the discipline this whole audit/implementation-log pattern is for. What I'd attack next: Phase 4 (journeys), since email now has a real, scheduled-send-capable channel to trigger from a workflow.

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
