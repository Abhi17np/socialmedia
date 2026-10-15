# Social Hub — competitive gap analysis + Phase 1 additions

**Date:** 2026-10-15. Written the same way `docs/MARKETING_HUB_AUDIT.md` was:
an honest gap analysis against real competitors, followed by what was
actually built this round (verified end to end) versus what's
deliberately deferred with a reason on record — never silently dropped.

## 1. What Social Hub already had (before this round)

Real OAuth (not mocked) to Facebook, Instagram, LinkedIn, YouTube, Google
Business, and WhatsApp Cloud API — publish, fetch mentions/inbox, and
analytics per platform's real capabilities. A BullMQ publish queue with a
calendar + list view, a unified inbox across platforms with
assignment/priority/saved replies, and AI Assist (`lib/ai.js`'s
`draftPost`/`draftReply`) — pull-based, metered, a human always reviews
before sending. Account-level analytics snapshots (followers, reach,
engagement) on a 6-hour poll. Twitter/X and TikTok are unavailable by
platform policy (API access blocked), not a gap in this codebase.

## 2. Gap analysis vs. Zoho Social, Hootsuite, Sprout Social, Agorapulse

(Sourced from G2/Gartner comparison pages and 2025 social-media-tooling
roundups — see this round's web research; treat vendor-affiliated
listicles as directional, not authoritative.)

| Capability | Competitors | This app, before this round |
|---|---|---|
| Draft → review → approve → publish | Agorapulse, Sprout, Hootsuite all have it | **Missing** — any member could schedule directly |
| AI hashtag/caption generation | Standard across 2025 tools | Only a single-draft caption generator existed |
| AI inbox sentiment/urgency | Sprout's flagship "Smart Inbox" feature | **Missing** |
| Best-time-to-post suggestion | Table stakes | **Missing** |
| Bulk/recurring post scheduling | Common | **Missing** — single-post create only |
| Per-post analytics | Standard | Only account-level rollups exist |
| Social listening (keywords/hashtags beyond owned accounts) | Often a paid add-on even for competitors | **Missing** |

## 3. What was built this round (verified against a real stack, not just lint)

**Post approval/review workflow** — `tenants.social_require_approval`
(opt-in, default `false`: zero behavior change for a tenant that never
turns it on). When on, a member's post is created with
`status = 'pending_review'` and is **not** enqueued; an admin/owner's own
post still goes straight through (nobody needs to rubber-stamp their own
work). New endpoints: `PATCH /social/posts/:id/approve`,
`PATCH /social/posts/:id/reject` (with an optional note), and
`GET`/`PATCH /social/approval-settings`. A rejected or still-pending-review
post can be withdrawn/discarded by its creator. Every approve/reject/
settings-change is a real `audit_log` row. A "Needs review" tab in
`Posts.jsx` surfaces it; a toggle in `Team.jsx` turns it on.

**AI hashtag suggestion** — `lib/ai.js`'s `suggestHashtags()`, a second,
separately-triggered call (not folded into `draftPost`) so regenerating
hashtags never costs a caption you already liked. Platform-aware (more
tags for Instagram-style platforms, fewer for LinkedIn-style ones).
`POST /ai/compose/hashtags`, same `aiGenerationsPerMonth` metering and
member+ gating as the existing draft generator. A "Suggest hashtags"
button in Composer appends the result to whatever's already in the editor.

**AI inbox triage** — `lib/ai.js`'s `classifyMessage()` returns
`{sentiment, urgent}` for one message, on demand (`POST
/ai/inbox/:id/analyze`) — the same pull-based posture as every other AI
feature in this app: it is **never** computed automatically on message
arrival (that would be a real philosophy change for this codebase, and a
real cost driver on a busy inbox). An "Analyze" button next to "AI
suggest" in `Inbox.jsx` shows a sentiment chip + an urgent badge a human
reads to prioritize — nothing routes, replies, or closes a conversation
on its own.

**Files added:** `backend/migrations/034_social_approval.sql`
(`tenants.social_require_approval`; `scheduled_posts.created_by`/
`reviewed_by`/`reviewed_at`/`review_note`; `inbox_messages.ai_sentiment`/
`ai_urgent`); `backend/scripts/integration-tests/social-approval.js`
(10 assertions: the full approve/reject state machine, admin-only gating,
cross-tenant isolation via a real 404, audit-log rows, and the fail-closed
503 for both new AI endpoints).

**Files changed:** `backend/lib/ai.js` (`suggestHashtags`,
`classifyMessage`), `backend/routes/ai.js`, `backend/routes/social.js`
(approval gate on POST, approve/reject/settings endpoints, DELETE now
also accepts `pending_review`/`rejected`), `backend/lib/schemas.js`
(`hashtagSuggestSchema`); `frontend/src/social/Composer.jsx` (hashtag
button), `Inbox.jsx` (Analyze button + sentiment/urgent chips),
`Posts.jsx` (Needs review tab, approve/reject/withdraw actions),
`Team.jsx` (approval-setting toggle), `app/(app)/posts/page.jsx` (passes
`role` through, which it never did before).

**Tests run:** `npm test`: **126/126** (unchanged — no new pure logic;
the two AI functions require a real Anthropic client, same as the
existing `draftPost`/`draftReply`, which also have no unit coverage).
`npm run test:integration`: new `social-approval.js`, 10/10, added to the
chain. `npm run test:all`: exit 0. Frontend `eslint .` clean on every
changed file; `next build` compiles (same pre-existing, unrelated
`/account` Suspense issue). **Visual verification**: lint/build-checked
only this round, consistent with the time-boxed tradeoff used throughout
the Marketing Hub's later phases — not a full Playwright pass.

## 4. Round 2 — recurring posts, plus a real bug the new test caught

**Recurring posts** (migration 035): a tenant sets `freq`
(`daily`/`weekly`/`monthly`) + an end date once; `social/queue.js`'s
`maybeFinalize()` spawns the real next occurrence itself, the moment the
current one actually finishes publishing successfully — through the
*exact same* creation path a one-off post takes (so a recurring post is
still gated by the approval workflow, plan limits, and consent, never a
parallel code path that could drift). Re-evaluates `determineInitialStatus`
fresh at spawn time (not inherited from the series' first post), so a
tenant turning approval on mid-series correctly starts holding later
occurrences for review. A **failed** occurrence does **not** advance the
series — it stops so a human notices and fixes it, rather than silently
failing forever on autopilot. One real scope cut, named here rather than
hidden: there's no series-wide edit/cancel yet — each occurrence is
managed individually, same as any other post.

**A real pre-existing bug this round's own integration test found and
fixed**: `maybeFinalize()`'s usage-metering call chained `.catch(...)`
directly onto `client.rpc(...)`, but supabase-js's query builder is only
`.then`-able, not a real `Promise` — `.catch()` silently never attached.
A post reaching 'published' would have thrown this uncaught instead of
just logging it, in production, the first time `increment_usage` ever
errored. Nothing in the pre-existing test suite exercised a post all the
way to a real 'published' terminal state, so this had never been
triggered. Fixed with a plain `try`/`await`/`catch`, the same pattern
every other `.rpc()` call site in this codebase already uses.

**Files added:** `backend/migrations/035_social_recurring_posts.sql`;
`backend/test/socialRecurrence.test.js` (4 pure-logic unit tests for
`nextOccurrenceDate()`, including the "Jan 31 + 1 month" edge case).

**Files changed:** `backend/social/queue.js` (`determineInitialStatus`,
`nextOccurrenceDate`, `spawnNextOccurrence`, the `.rpc().catch()` fix),
`backend/lib/schemas.js` (`recurrenceSchema`), `backend/routes/social.js`
(accepts `recurrence`, sets `recurrence_series_id`);
`frontend/src/social/Composer.jsx` (a "Repeat" checkbox + freq/until
controls when scheduling), `Posts.jsx` (a repeat-icon badge on a post
that's part of a series). `social-approval.js`'s integration script
grew two more assertions (12 total): a published occurrence spawning its
real next one one day later, and a failed occurrence correctly not
advancing the series.

**Tests run:** `npm test`: **130/130** (126 prior + 4 new). `npm run
test:integration`: `social-approval.js` now 12/12. `npm run test:all`:
exit 0. Frontend `eslint .` clean; `next build` compiles (same
pre-existing, unrelated `/account` Suspense issue).

## 5. Round 3 — a real per-post analytics pipeline

**What was built**: `post_analytics` (migration 036) — ingestion,
storage, and normalization for per-post engagement, closing the gap
Round 1/2 both named here. `social/pollers.js`'s new `sweepPostAnalytics()`
(same 6h cadence as the existing account-level sweep, no new timer
constant) walks every `published` post from the last
`POST_ANALYTICS_LOOKBACK_DAYS` (30) — which also doubles as this
feature's backfill, since the first sweep after this migration picks up
every already-published post in that window, not just new ones — reads
each target account's real `externalPostId` out of
`platform_results` (`social/pollers.js`'s `externalPostIdFor()`, unit
tested), and calls a new `fetchPostAnalytics(account, externalPostId)`
per adapter.

**Real, verified against current API docs, not assumed**: Facebook and
Instagram's adapters deliberately use the same stable object fields
`fetchPosts`/`normalizePost`/`normalizeMedia` already used
(`likes`/`comments`/`shares` summary counts), **not** a call to either
platform's post-level Insights endpoint — Meta deprecated
`post_impressions` (Nov 15 2025) and Instagram's `impressions`/`views`/
`total_interactions` are listed on Meta's own current docs as "Metric in
development," with `post_engaged_users`'s status unresolved even across
Meta's own pages. Shipping a call to a metric name that may 400 in
production would fail rule 2's "no placeholders" bar in the opposite
direction — looking built while silently not working — so reach/
impressions for a specific post are honestly not collected yet. YouTube
gets real `views`/`likes`/`comments` via `videos.list?part=statistics`,
no new scope needed. **LinkedIn and Google Business deliberately do not
get a `fetchPostAnalytics` export** — confirmed via LinkedIn's own Social
Actions API docs that reading a personal post's social actions needs
`r_member_social`, granted to select developers only (not the self-serve
tier this app's LinkedIn connect already uses); Google Business's only
metrics API (`businessprofileperformance`) is location-level, with no
per-post insights anywhere in the Business Profile APIs. The sweep's
existing `typeof adapter.fetchPostAnalytics === 'function'` capability
check is the honest "not available" signal for both — the same idiom
`fetchAnalytics`/`fetchMentions`/`fetchInbox` already use, not a new flag
system.

**New endpoint**: `GET /social/posts/:id/analytics` — tenant-scoped (a
different tenant's post is a real 404, verified against a live
Postgres+PostgREST stack, not just a forged-JWT unit check), returns the
metric history plus a per-platform `availability` map so the frontend
can show "not available for X" honestly instead of a stuck loading
state. Surfaced in `Posts.jsx` as a per-post expandable panel on
published posts.

**Entitlements**: deliberately NOT metered or plan-gated in this round —
per-post analytics is visible to every tenant regardless of plan right
now, the same posture `analytics_snapshots` (account-level) already has.
Whether to gate it is a packaging decision, not made unilaterally here.

**Files added**: `backend/migrations/036_post_analytics.sql`;
`backend/test/postAnalytics.test.js` (5 unit tests for
`externalPostIdFor()`); `backend/scripts/integration-tests/social-post-analytics.js`
(5 assertions against a live local Postgres+PostgREST stack: stored-row
retrieval, mixed per-platform availability, same-day upsert-in-place,
real cross-tenant 404, nonexistent-post 404).

**Files changed**: `backend/social/adapters/{facebook,instagram,youtube}.js`
(`fetchPostAnalytics`), `backend/social/adapters/{linkedin,google-business}.js`
(documented, deliberate non-export), `backend/social/pollers.js`
(`sweepPostAnalytics`, `pollPostAnalytics`, `externalPostIdFor`),
`backend/routes/social.js` (`GET /social/posts/:id/analytics`),
`frontend/src/social/Posts.jsx` (per-post analytics panel),
`backend/package.json` / `backend/scripts/integration-tests/README.md`
(wired the new integration test into the chain).

**Tests run**: `npm test`: **135/135** (130 prior + 5 new), backend
`eslint .` clean on every changed file. Integration: stood up a real
local Postgres 16 + PostgREST + the rest-proxy this round specifically
to get genuine evidence instead of claiming this without it (closes a
sliver of the "no CI coverage of the integration suite" risk the
architecture audit flagged) — `social-post-analytics.js` **5/5**,
`social-approval.js` re-run as a regression check on the touched
`routes/social.js` **12/12**, both against the live stack. Frontend
`eslint .` clean; `next build` compiles (same pre-existing, unrelated
`/account` Suspense issue every prior round already hit).

**Blockers / deployment requirements**: none new — no new env vars, no
new external credentials, no new provider dependency (every adapter
change reuses scopes/products this app already has). The local
Postgres+PostgREST+Redis stand-up used for testing is this session's
own scratch infrastructure, not committed and not required in
production (Supabase fills that role there, same as every prior round).

## 6. Round 4 — Brand Memory, brand-aware generation, and a Content Repurposing Studio

**What was built**: `brand_profiles` (migration 037) — one row per
tenant (this app has no multi-brand-per-tenant concept, see 002's own
header), covering tone, audience, preferred/banned terms, prohibited
claims, and approved messaging. `lib/brandMemory.js`'s
`buildBrandContext()` turns it into a prompt-injectable block appended
to every AI system prompt; `checkBrandViolations()` runs AFTER
generation (belt-and-suspenders — an LLM instruction is a strong nudge,
not a guarantee) and is deliberately literal/substring matching, not
semantic — documented as a real limitation (it won't catch a paraphrase
of a prohibited claim), not papered over. Wired into all three existing
AI endpoints (`/ai/compose/draft`, `/ai/compose/hashtags`,
`/ai/inbox/:id/draft-reply`), each now returning a `brandViolations`
array alongside its draft — a warning a human reads in Composer/Inbox,
never a block, since every draft here is already reviewed before it can
send. Admin-editable in `Team.jsx`; fully optional — an unconfigured
tenant's prompts are byte-for-byte what they were before this feature
existed.

**AI Content Repurposing Studio** — `repurposeContent()` turns one
piece of source content into platform-tailored variants for every
selected channel in a single AI call (metered as 1 generation
regardless of platform count, same unit `draftPost` already uses).
Each variant gets the same brand-violation check as every other AI
output, plus two new, honestly-scoped checks (`lib/repurposing.js`,
pure/DB-free/unit-tested): a token-overlap (Jaccard) near-duplicate
check against the tenant's last 90 days of posts — explicitly lexical,
not semantic, so it reliably catches a near-verbatim repost but not a
paraphrase of the same idea — and a media-requirement warning for
YouTube specifically, the one per-platform constraint this app can
actually verify (`social/adapters/youtube.js`'s `publish()` already
throws on this). Deliberately not a larger invented list of
dimension/duration/format checks this app has no way to verify. Every
resulting variant is a draft loaded into Composer for review — it
never creates a `scheduled_posts` row directly, so it inherits the
normal approval/plan-limit/consent gates through the exact same
Composer → `POST /social/posts` path every other post takes.

**New endpoints**: `GET`/`PATCH /social/brand-memory` (read: any
authenticated tenant user; write: admin+, audit-logged, same bar as
`/social/approval-settings`); `POST /ai/compose/repurpose` (member+,
same bar as `/compose/draft`).

**Entitlements**: zero new metering infrastructure — repurposing reuses
the existing `aiGenerationsPerMonth` counter; brand-memory reads/writes
aren't AI calls and aren't metered at all, same as every other settings
endpoint in this app.

**Files added**: `backend/migrations/037_brand_memory.sql`;
`backend/lib/brandMemory.js`, `backend/lib/repurposing.js`;
`backend/test/brandMemory.test.js` (9 unit tests),
`backend/test/repurposing.test.js` (10 unit tests);
`backend/scripts/integration-tests/social-brand-memory.js` (7
assertions against a live Postgres+PostgREST stack).

**Files changed**: `backend/lib/ai.js` (`brandContext` threaded through
`draftPost`/`draftReply`/`suggestHashtags`; new `repurposeContent`),
`backend/routes/ai.js` (brand context + violations wired into all three
existing endpoints; new `/compose/repurpose`), `backend/routes/social.js`
(`GET`/`PATCH /social/brand-memory`), `backend/lib/schemas.js`
(`repurposeSchema`, `brandMemorySchema`); `frontend/src/social/Team.jsx`
(Brand Memory settings panel), `frontend/src/social/Composer.jsx`
(brand-violation warnings on draft/hashtag results; a Repurposing
Studio panel with per-platform variant cards and an honest "use this
variant" review step).

**Tests run**: `npm test`: **154/154** (135 prior + 19 new). Backend
`eslint .` clean on every changed file. Integration (live local
Postgres+PostgREST, same stack stood up in Round 3): new
`social-brand-memory.js` **7/7** (defaults for an unconfigured tenant,
admin-only write, real persistence through a second GET, a real
audit_log row, tenant isolation, and a regression check that wiring
brand memory into the AI endpoints didn't change their fail-closed 503
behavior). `social-approval.js` and `social-post-analytics.js` re-run
as regression checks on the touched `routes/social.js`: both still
**12/12** and **5/5**. Frontend `eslint .` clean; `next build` compiles
(same pre-existing, unrelated `/account` Suspense issue every prior
round also hit).

**Blockers / deployment requirements**: none new — no new env vars, no
new external credentials, no new provider dependency.

## 7. Round 5 — a real AI Content Experiment Engine

**What was built**: `content_experiments` + `content_experiment_variants`
(migration 038) — every experiment groups exactly two ALREADY-EXISTING
`scheduled_posts` rows as its variants (created and approved through
the normal Composer/`POST /social/posts` path, never a parallel
creation path). `backend/lib/experimentStats.js` implements a real
two-proportion z-test (Abramowitz & Stegun erf approximation, no stats
library dependency), exhaustively unit-tested against known standard-
normal critical values and hand-verified p-values — deliberately NOT a
copy of Marketing Hub's existing `abWinnerSweep.js`/`pickWinner()`,
which has no significance or minimum-sample check at all (its own test
file literally asserts "80% beats 10%, even with 100x fewer sends" as
correct behavior). This feature's bar is higher on purpose, per the
build's own brief: it refuses to declare a winner when either variant's
audience is below a configurable minimum, before the statistical test
is even run — not as an afterthought on the result.

**Normalization, done honestly with what this app actually has**:
"audience size" normalization uses each variant's connected account's
own follower count (`analytics_snapshots`, nearest row at or before the
post's `scheduled_at`) as the statistical denominator, not a raw
engagement count — a variant with 10x the followers needs
proportionally more engagement to "win," not just more in absolute
terms. "Posting conditions" normalization is handled by requiring both
variants to target the **same connected account** (enforced at creation,
400 otherwise) and by evaluating each variant a configurable number of
hours after **its own** publish time (approximated by `scheduled_at`,
since there's no separate `published_at` column), not a shared calendar
date — so two variants posted a week apart are each judged on an equal
window of their own. Both are named, honest assumptions, not a deeper
causal model this app doesn't have — stated to the tenant in the
experiment's own detail view, not buried.

**Deliberately scoped to exactly two variants** (classic A/B), not
A/B/C/.../n — correctly comparing more than two needs a multiple-
comparisons correction (e.g. Bonferroni) this app doesn't implement;
shipping an uncorrected multi-variant test would systematically
overstate confidence. A named scope cut, not a silently missing
capability.

**New endpoints**: `POST /experiments` (member+, validates same-
account/single-account-per-post/no-reusing-a-post), `GET /experiments`
(list), `GET /experiments/:id` (stored decision plus, for a still-
`running` experiment, a **live preview** computed the exact same way
the sweep will — so a tenant isn't left watching silence until it
resolves), `PATCH /experiments/:id/cancel` (admin+, audit-logged). A
new 15-min decision sweep (`lib/experimentSweep.js`) — slower than
`abWinnerSweep`'s 5-min cadence since this does more per-tick DB work
(two joined selects per experiment) and a decision an hour late doesn't
matter here either.

**Files added**: `backend/migrations/038_content_experiments.sql`;
`backend/lib/experimentStats.js`, `backend/lib/experimentSweep.js`,
`backend/lib/socialMetrics.js` (the `FOLLOWER_METRIC` map, extracted
out of `routes/social.js` so this feature and the existing analytics
summary share one mapping instead of maintaining two); `backend/routes/experiments.js`;
`backend/test/experimentStats.test.js` (13 unit tests, including
verified — not guessed — p-values for every "decided"/"not
significant"/confidence-level-boundary case), `backend/test/experimentSweep.test.js`
(4 unit tests); `backend/scripts/integration-tests/social-experiments.js`
(9 assertions against a live Postgres+PostgREST stack, including a
real end-to-end run of the actual sweep against seeded `post_analytics`/
`analytics_snapshots` data — not hand-fed numbers — that correctly
decides a winner, and a tiny-audience case that correctly refuses to
decide despite a 90%-vs-5% raw rate gap); `frontend/src/social/Experiments.jsx`,
`frontend/app/(app)/experiments/page.jsx`.

**Files changed**: `backend/routes/social.js` (imports the extracted
`FOLLOWER_METRIC` instead of its own copy), `backend/server.js` (mounts
`routes/experiments.js`, starts/stops `experimentSweep`), `backend/lib/schemas.js`
(`createExperimentSchema`); `frontend/src/social/SocialNav.jsx` (new
"Experiments" nav item), `frontend/src/viewPaths.js`.

**A real bug this round's own integration test caught before it
shipped**: the first draft of `POST /experiments` threw a
validation error with a real `statusCode` (400/404) from a helper
function, but the route was wrapped in `asyncHandler` alone — which
forwards any rejection to `server.js`'s generic catch-all middleware,
and that middleware always responds 500 regardless of `err.statusCode`
(confirmed by reading it: it does not check the field at all). Every
validation failure would have come back as an opaque 500 instead of
the intended 400/404. Fixed by wrapping that one call in its own
try/catch and responding with `err.statusCode || 500`, the same
pattern `POST /social/posts` already uses for `assertWithinLimit` —
caught by `social-experiments.js`'s own assertions on the exact status
codes, not just that *a* response came back.

**Tests run**: `npm test`: **171/171** (154 prior + 17 new). Backend
`eslint .` clean on every changed file. Integration (live local
Postgres+PostgREST): new `social-experiments.js` **9/9**.
`social-approval.js`, `social-post-analytics.js`, and
`social-brand-memory.js` re-run as regression checks on the touched
`routes/social.js`/`server.js`: all still fully passing. Frontend
`eslint .` clean; `next build` compiles (22 pages now, same
pre-existing, unrelated `/account` Suspense issue every prior round
also hit).

**Blockers / deployment requirements**: none new.

## 8. Round 6 — real Social Revenue Attribution, reusing Marketing Hub's engine completely

**What was built**: `tracked_links` + five new UTM columns on
`site_visits` (migration 039) — the missing plumbing
`lib/attribution.js`'s existing, already-channel-agnostic multi-touch
engine needed to ever see a social-sourced touchpoint at all.
`distributeCredit()`/`getAttributionReport()` needed **zero changes**
to support the new channel — proof this engine was built right the
first time (Phase 6). A tenant creates a Tracked Link
(`POST /social/tracked-links`) for a destination URL, pastes the
returned short redirect into a post instead of the real link; every
click (`GET /t/:id`) gets real UTM params appended
(`utm_source=<platform>`, `utm_medium=social`, `utm_content=<this
link's own id>`) before redirecting, and `click_count` is reliably
incremented (awaited, not fire-and-forget, after the first draft of
this traded a slightly riskier async pattern for a few ms of extra
redirect latency — a sound trade for a non-hot path). If the
destination is the tenant's own site with the Marketing Hub tracking
snippet already installed (migration 033), the resulting pageview
carries those same UTM params straight into `site_visits`
(`routes/tracking.js` now parses and stores them via
`lib/trackedLinks.js`'s `parseUtmParams()`) — which is exactly what
`lib/attribution.js`'s new social channel reads, once that visit's
`site_visitors` row resolves to a real contact (the same resolution
`routes/leadForms.js` already performs on lead-form submit).

**Mounted ungated, deliberately** — `GET /social/attribution` is a
*second*, Social-Hub-owned mount of the identical report Marketing
Hub's existing `GET /marketing/attribution` already serves, the same
"WhatsApp broadcast is Social Hub's own feature, not behind the
commercial gate" posture this codebase already established (see
README.md). A tenant with Marketing Hub NOT enabled can call
`/social/attribution` and see real revenue-by-channel for their own
social activity, while `/marketing/attribution` on that exact same
tenant correctly stays 403'd — verified directly in the integration
test, not assumed.

**Honest about what it can't see**: a social-sourced conversion is
only attributable when the person actually clicked through a Tracked
Link — a bare like/comment on a broadcast post, or someone who saw a
post and visited the site directly later without clicking the link,
genuinely can't be tied to that post. This is the same limitation
every UTM-based attribution system has (including every competitor's,
per Phase 1's research — none of Zoho/Buffer/Later/Agorapulse compute
closed-loop revenue natively either), not something unique or hidden
here.

**New endpoints**: `POST`/`GET /social/tracked-links`,
`PATCH /social/tracked-links/:id` (attach a real post after the fact —
optional enrichment, not required for attribution to work, since
`utm_content` already carries the link's own id), the public
`GET /t/:id` redirect, `GET /social/attribution`.

**Files added**: `backend/migrations/039_social_attribution.sql`;
`backend/lib/trackedLinks.js` (pure `appendUtmParams`/`parseUtmParams`/
`shortUrlFor`); `backend/routes/trackedLinks.js`;
`backend/test/trackedLinks.test.js` (10 unit tests);
`backend/scripts/integration-tests/social-attribution.js` (6
assertions against a live Postgres+PostgREST stack — the full real
pipeline: create a link, click its real redirect, feed the resulting
pageview through the real tracking endpoint, resolve to a contact,
close a deal, and read the real report — plus the hub-gating proof
above); `frontend/src/social/RevenueAttribution.jsx`.

**Files changed**: `backend/lib/attribution.js` (the new social
channel — 3 additional fixed queries, still O(1) not per-contact;
`CHANNEL_LABELS` gains `social: 'Social'`), `backend/routes/tracking.js`
(parses and stores UTM params on every pageview), `backend/routes/social.js`
(`GET /social/attribution`), `backend/server.js` (mounts
`routes/trackedLinks.js`), `backend/lib/schemas.js`
(`createTrackedLinkSchema`, `updateTrackedLinkSchema`);
`frontend/src/social/Analytics.jsx` (a new "Revenue attribution" tab).

**A second bug this round's own integration-test discipline caught
before it shipped** (same class as Round 5's): the PATCH
`/social/tracked-links/:id` handler's first draft chained
`.update(patch).eq('id', id).select().single()` directly — `.single()`
errors (not just a null `data`) on zero matched rows, so a wrong-tenant
or nonexistent link id would have surfaced as a confusing 500 instead
of a clean 404. Caught by re-reading the code against the exact
pattern this bug follows from Round 5, before even running the test —
fixed with the same fetch-then-404-then-update pattern every other
PATCH in this codebase already uses.

**Tests run**: `npm test`: **181/181** (171 prior + 10 new). Backend
`eslint .` clean on every changed file. Integration (live local
Postgres+PostgREST): new `social-attribution.js` **6/6**.
`social-approval.js`, `social-post-analytics.js`,
`social-brand-memory.js`, and `social-experiments.js` re-run as
regression checks on the touched `routes/social.js`/`server.js`: all
still fully passing. Frontend `eslint .` clean; `next build` compiles
(same pre-existing, unrelated `/account` Suspense issue every prior
round also hit).

**Blockers / deployment requirements**: none new.

## 9. Round 7 — Social-to-WhatsApp Conversion Journeys, reusing the journey engine completely

**What was built**: a new `social_message_received` journey trigger
type and a focused, ungated authoring surface
(`routes/conversionJourneys.js`) over the SAME journey engine
Marketing Hub's full graph builder already runs on
(`lib/journeyEngine.js`, `lib/journeyGraph.js`, `lib/journeyActions.js`).
`social/pollers.js`'s existing inbound-message sweep now fires this
trigger for every genuinely NEW inbound social DM that resolves to a
real contact — `.select()` added to its existing upsert is what makes
"genuinely new" knowable (PostgREST's `ignoreDuplicates` upsert returns
only the rows it actually inserted), so this never re-fires on the same
historical message every 10-minute poll. No DB migration was needed at
all: `workflow_definitions.trigger_type` (migration 028) is a plain
text column with no check constraint, so a new trigger type is purely
an application-layer addition.

**Zero duplication of the hard parts**: `lib/journeyActions.js`'s
`sendWhatsapp()` — consent gate (`filterConsentedContacts`), template-
approval enforcement, campaign/recipient creation, `broadcastQueue`
enqueue — runs completely unchanged for a journey created through this
surface. `lib/journeyTemplates.js`'s existing `chain()` helper (now
also exported) builds the fixed trigger → delay → send_whatsapp graph;
`lib/journeyGraph.js`'s `validateGraph()` checks it before it's ever
saved or activated. The only genuinely new code is the trigger-firing
hook in `pollers.js` and this file's CRUD — everything that actually
*runs* a journey was already built and already tested (Phase 4).

**Deliberately NOT the full graph editor** — every journey created
here is a fixed trigger → delay → send_whatsapp shape, no conditions
or splits. A named scope cut: a tenant who wants branching and already
has Marketing Hub enabled can still build one with the full
`journeySchema`, using this exact same trigger type — nothing about
`social_message_received` is exclusive to this ungated surface at the
data layer, only at the authoring layer. Every query here additionally
filters `trigger_type = 'social_message_received'`, so this surface
can only ever see/touch journeys of its own kind, never an unrelated
Marketing Hub journey, even though both live in `workflow_definitions`.

**Mounted ungated, the same posture as Round 6's attribution
endpoint and WhatsApp broadcast itself** — verified directly: a tenant
with Marketing Hub NOT enabled can create, activate, and run a full
conversion journey end to end (confirmed in the integration test,
including a real `whatsapp_campaigns`/`whatsapp_campaign_recipients`
row and the consent gate correctly blocking an opted-out contact).

**New endpoints**: `POST`/`GET /social/conversion-journeys`,
`GET /social/conversion-journeys/:id`,
`PATCH /social/conversion-journeys/:id/{activate,pause}`,
`DELETE /social/conversion-journeys/:id`,
`GET /social/conversion-journeys/:id/enrollments`.

**Files added**: `backend/routes/conversionJourneys.js`;
`backend/scripts/integration-tests/social-conversion-journeys.js` (8
assertions against a live Postgres+PostgREST stack: role gating,
WhatsApp-account-type validation, an inactive journey correctly
enrolling no one, activation really enrolling and pausing at the
delay, resuming past the delay really creating a real WhatsApp
campaign/recipient row, an opted-out contact correctly skipped with no
send, tenant isolation, and the full CRUD working ungated);
`frontend/src/whatsapp/ConversionJourneysTab.jsx`.

**Files changed**: `backend/lib/schemas.js` (`social_message_received`
added to `JOURNEY_TRIGGER_TYPES`, new `conversionJourneySchema`),
`backend/lib/journeyTemplates.js` (exports `chain()` for reuse, zero
behavior change), `backend/social/pollers.js` (fires the new trigger
for genuinely-new resolved inbound messages), `backend/server.js`
(mounts the new routes); `frontend/src/whatsapp/WhatsAppHub.jsx` (a
new "Conversion journeys" tab).

**A real pre-existing environment-setup gap found while testing, not
caused by this round**: `marketing-journeys.js`'s and
`marketing-consent.js`'s own integration tests assume a
`platform_admins` row already exists; it didn't in this environment,
and the failure mode was a confusing "Cannot read properties of null,"
not a clear message. Confirmed this is pre-existing (not a regression
from this round's changes) by seeding the one missing row and
re-running `marketing-journeys.js` clean, 22/22, with no code changes
— documented in `scripts/integration-tests/README.md`'s setup section
so the next person doesn't hit the same confusing failure.

**Tests run**: `npm test`: **181/181** (no new pure logic this round —
the trigger-firing hook and the CRUD are both DB/HTTP-dependent, same
posture as every other route file in this codebase). Backend
`eslint .` clean on every changed file. Integration (live local
Postgres+PostgREST): new `social-conversion-journeys.js` **8/8**.
`social-approval.js`, `social-post-analytics.js`,
`social-brand-memory.js`, `social-experiments.js`, and
`social-attribution.js` re-run as regression checks: all still fully
passing. `marketing-journeys.js` (the existing, pre-existing Phase 4
suite, touched indirectly via the shared `journeyTemplates.js`/
`pollers.js` files) re-run after fixing the environment gap above:
**22/22**, confirming zero regression to the existing journey engine.
Frontend `eslint .` clean; `next build` compiles (same pre-existing,
unrelated `/account` Suspense issue every prior round also hit).

**Blockers / deployment requirements**: none new.

## 10. Round 8 — Competitor Opportunity Radar

**Reclassified, not a true differentiator**: Phase 1's original research
assumed this was "very high differentiation"; a second pass found 7 of
8 researched competitors (Hootsuite, Metricool, Agorapulse, Sprout,
Later, Zoho, HubSpot) already ship some form of competitor benchmarking
— this is table-stakes/catch-up, built anyway at the user's explicit
request, with the same rigor as every differentiated slice.

**What was built**: `tracked_competitors`/`competitor_snapshots` tables
(migration 040); a daily sweep (`backend/social/competitorSweep.js`,
deliberately its own file and its own slower cadence — see its header)
that calls a new `fetchCompetitor(account, handle)` export on the
Instagram and YouTube adapters and stores followers/media count/
posts-in-a-30-day-window/average engagement rate per day; a CRUD +
comparison route (`backend/routes/competitors.js`); and a pull-based AI
content-gap endpoint (`POST /ai/compose/competitor-gaps`,
`lib/ai.js`'s `analyzeCompetitorGaps`).

**Only Instagram and YouTube have a real, honest way to do this** —
confirmed by research against each provider's own docs before writing
any adapter code, not assumed:
- **Instagram**: Meta's official **Business Discovery** feature
  (`business_discovery.username(...)`) is built for exactly this "look
  at a public account you don't own" case, through the tenant's OWN
  connected account's existing token. Needs `pages_read_engagement`/
  `instagram_basic`/`instagram_manage_insights` — all already requested
  by every Instagram connection this app creates (see
  `instagram.js`'s `SCOPES`). Zero new OAuth scope, zero reconnection.
- **YouTube**: `channels.list(forHandle=...)`/`search.list`/
  `videos.list` are fully public GET endpoints, not restricted to the
  token owner's own channel — callable through an existing connected
  channel's OAuth token with no new scope either.
- **Facebook was deliberately excluded.** Its equivalent, **Page Public
  Content Access**, requires Meta Business Verification *plus* a
  separate App Review this app doesn't have — unlike
  `pages_read_engagement`'s Standard/Advanced Access split, there's no
  partial capability to fall back to; a live-mode call would 100% fail
  for virtually every real tenant. Honestly omitting `fetchCompetitor`
  from `facebook.js` (documented in that file's own header) was judged
  better than shipping a call certain to fail.
- **LinkedIn and Google Business have no equivalent at all** — LinkedIn
  has no public lookup API for a personal profile (all this adapter
  ever connects); a competitor's public Google Business listing lives
  in a separate Places API/credential this app doesn't integrate. Both
  documented the same way, in each adapter's own header.

**The comparison reuses data this app already collects for its own
accounts**, rather than spending a second live call: the detail route
computes the tenant's own average engagement rate from its already-
stored `post_analytics`/`analytics_snapshots` rows (Round 3's pipeline),
using the exact same `(likes+comments)/post/followers` formula
`lib/competitorRadar.js` uses for the competitor side, so the two
numbers are directly comparable and the "rate, not raw count"
normalization (the same principle the Content Experiment Engine's
statistics use) holds on both sides of the comparison.

**AI content-gap analysis is grounded, not trusted blindly**: the model
reads the tenant's own recent captions and the competitor's real,
live-fetched recent captions and must cite which specific numbered
competitor post(s) support each suggested theme. Those citation indices
are re-validated server-side against the real post count before
anything reaches the UI — any index outside the real range is silently
dropped rather than ever reaching a human as "evidence." This never
runs automatically; a tenant explicitly requests it, metered against
the same `aiGenerationsPerMonth` cap as every other AI Assist feature,
and fails closed (503) with no `ANTHROPIC_API_KEY` — checked up front,
before spending the live `fetchCompetitor()` call against the viewer
account's own API quota, not after.

**New endpoints**: `POST`/`GET /social/competitors`,
`GET /social/competitors/:id`, `DELETE /social/competitors/:id`,
`POST /ai/compose/competitor-gaps`.

**Files added**: `backend/migrations/040_competitor_radar.sql`;
`backend/lib/competitorRadar.js` (pure `averageEngagementRate()`/
`postsInWindow()`, DB/network-free); `backend/social/competitorSweep.js`;
`backend/routes/competitors.js`; `backend/test/competitorRadar.test.js`
(7 unit tests); `backend/scripts/integration-tests/social-competitors.js`
(12 assertions against a live Postgres+PostgREST stack).

**Files changed**: `backend/social/adapters/instagram.js` and
`youtube.js` (new `fetchCompetitor()` export each); `facebook.js`,
`linkedin.js`, `google-business.js` (documentation-only header
additions explaining the exclusion, no code); `backend/lib/ai.js`
(`analyzeCompetitorGaps`); `backend/lib/schemas.js`
(`createTrackedCompetitorSchema`, `competitorGapsSchema`);
`backend/routes/ai.js` (the new endpoint); `backend/server.js` (mounts
the routes, starts/stops the sweep).

**Tests run**: `npm test`: **188/188** (7 new `competitorRadar.test.js`
cases, zero regressions). Backend `eslint .` clean on every
changed/added file. Integration (live local Postgres+PostgREST): new
`social-competitors.js` **12/12** — platform validation (schema-level
enum plus the route's own "does this adapter have fetchCompetitor"
check), viewer-account ownership and platform-matching, duplicate-
handle conflict (409), role gating (member+ to track, admin+ to
untrack), tenant isolation (404, not a leak), a REAL end-to-end run of
`competitorSweep.sweep()` against a stubbed adapter call proving the
actual DB upsert and `lib/competitorRadar.js` math from real seeded
data (not hand-fed numbers), the detail route's own-vs-competitor
comparison computed from real seeded `post_analytics`/
`analytics_snapshots`, fetch-then-404-then-delete, and the AI
endpoint's fail-closed 503. Every prior integration test re-run as a
regression check: all still fully passing (see the full
`npm run test:integration` log for this round).

**Blockers / deployment requirements**: none new.

## 11. Round 9 — Crisis Intelligence

**No documented scope existed for this one, unlike every prior round**:
Phase 1's original prioritization of "Crisis Intelligence" happened
outside this repo — nothing in `SOCIAL_HUB_FEATURES.md`, this file, or
any commit described what it should mean here. Designed from scratch
against this app's own established constraints instead of a written
spec: Global Rule 1 (official APIs/permitted data only) plus this app's
own existing, documented limitation that there is no social listening
beyond owned accounts (Round 8's "deferred" list above) ruled out the
most obvious reading of "crisis intelligence" — open-web/news/hashtag
monitoring for a brewing PR crisis the tenant hasn't felt yet. What's
actually buildable honestly, with real data this app already collects,
is different and still valuable: detecting an abnormal SURGE in how
much a tenant's own audience is suddenly messaging/mentioning them,
across their own connected accounts.

**What was built**: a `crisis_alerts` table (migration 041); a 15-minute
sweep (`backend/social/crisisSweep.js`) that counts real inbound
`inbox_messages` + `mentions` rows in a trailing 3-hour window per
tenant and compares that count against a trailing 14-window (42-hour)
baseline using a real z-score (`backend/lib/crisisDetection.js`); a
CRUD + lifecycle route (`backend/routes/crisis.js`: list, detail with
real evidence, acknowledge, resolve); and a pull-based AI summary
endpoint (`POST /ai/crisis-alerts/:id/summarize`,
`lib/ai.js`'s `summarizeCrisis`).

**Deliberately NOT sentiment-based, and zero AI in the decision to
alert at all** — a genuine crisis is first and foremost a volume
anomaly, which this app can measure honestly with zero AI involvement;
sentiment classification already exists in this app
(`classifyMessage`, Phase 1) but is single-message and pull-based by
design, which doesn't compose into "alert me automatically." Keeping
detection itself 100% statistical, with AI strictly as an optional,
human-triggered second step on top of an already-detected surge,
preserves this app's existing "AI is pull-based, human decides, nothing
auto-sent" philosophy rather than quietly breaking it to get automatic
alerting — see Round 5's `lib/experimentStats.js` for the precedent of
"real statistics, not an AI judgment call, for anything this app treats
as a decision."

**The same statistical rigor as the Content Experiment Engine, applied
to volume instead of engagement rate**: a non-negotiable minimum-count
floor (`minCount`, default 5) is checked BEFORE any z-score math runs —
a tenant going from 0 to 2 messages is never a "crisis" by this app's
own definition, however large the relative jump looks, the same
"refuse below a floor" principle `evaluateExperiment()` applies to
audience size. When the trailing baseline has zero variance (every
historical window had the identical count, often 0), a z-score is
undefined, not infinite — `detectSpike()` falls back to an honest
"did this clear baseline + floor" check and reports `zScore: null`
rather than fabricating a number.

**An open alert is one ongoing incident, not a new row every tick**:
the sweep skips creating a new alert for a tenant that already has one
open, so a sustained surge reads as one alert through to resolution;
a fresh surge after a previous alert is resolved correctly opens a new
one — confirmed directly in the integration test, not just asserted.

**Every alert carries its real evidence**: the detail route resolves an
alert's window back to the actual `inbox_messages`/`mentions` rows that
made it up (`lib/crisisEvidence.js`, shared by the detail route and the
AI summary endpoint so they can never see two different realities of
the same window). The AI summary names dominant themes and which
messages most need a reply, every theme required to cite the specific
numbered message(s) it's drawn from — citations re-validated
server-side against the real message count before reaching the UI,
the exact same discipline Round 8's `analyzeCompetitorGaps()`
established. Nothing in this feature auto-replies, auto-posts, or
notifies anyone outside this app — an alert is a prompt to go look,
surfaced as a banner on the Dashboard.

**New endpoints**: `GET /social/crisis-alerts`,
`GET /social/crisis-alerts/:id`,
`PATCH /social/crisis-alerts/:id/{acknowledge,resolve}`,
`POST /ai/crisis-alerts/:id/summarize`. There is deliberately no
"create alert" endpoint — alerts only ever come from the real sweep,
never from a human typing in a number this app didn't measure.

**Files added**: `backend/migrations/041_crisis_intelligence.sql`;
`backend/lib/crisisDetection.js` (pure `computeBaseline()`/
`detectSpike()`, DB/network-free); `backend/social/crisisSweep.js`;
`backend/lib/crisisEvidence.js`; `backend/routes/crisis.js`;
`backend/test/crisisDetection.test.js` (8 unit tests);
`backend/scripts/integration-tests/social-crisis.js` (9 assertions
against a live Postgres+PostgREST stack); `frontend/src/social/
CrisisAlerts.jsx`.

**Files changed**: `backend/lib/ai.js` (`summarizeCrisis`);
`backend/routes/ai.js` (the new endpoint); `backend/server.js` (mounts
the routes, starts/stops the sweep); `frontend/src/social/Dashboard.jsx`
(an open-alert banner); `frontend/src/social/SocialNav.jsx` and
`frontend/src/viewPaths.js` (new nav item).

**Tests run**: `npm test`: **196/196** (8 new `crisisDetection.test.js`
cases, zero regressions). Backend `eslint .` clean on every
changed/added file (5 pre-existing lint errors in unrelated files not
touched this round, not newly introduced). Integration (live local
Postgres+PostgREST): new `social-crisis.js` **9/9** — no alert before
the sweep runs even with baseline data seeded, a REAL end-to-end sweep
run against seeded `inbox_messages`/`mentions` correctly computing a
20-vs-baseline-2 surge with z=18 and opening an alert, a second sweep
tick not duplicating that open alert, the detail view resolving to the
real 15 inbox + 5 mention messages that made up the window, tenant
isolation, acknowledge (member+) and resolve (admin+) role gating and
real persistence with 409 on a repeat action, a fresh surge after
resolution opening a new alert, and the AI endpoint's fail-closed 503.
Full `npm run test:integration` (32 scripts) re-run clean, zero
regressions anywhere. Frontend `eslint .` clean; `next build` compiles
(same pre-existing, unrelated `/account` Suspense issue every prior
round also hit).

**Blockers / deployment requirements**: none new.

## 12. What's still deliberately deferred (not silently dropped)

- **Real, personalized best-time-to-post**, specifically. Per-post data
  now exists (likes/comments/shares/views — see Round 3 above), but
  there still isn't an hour-of-day breakdown for any metric on any
  platform's API as currently exposed — the per-post rows are daily
  snapshots, not intraday. A genuine "best hour" still needs that finer
  grain, which no adapter's API currently offers at the post level.
- **Per-post reach/impressions specifically**, and **any per-post metric
  at all for LinkedIn and Google Business** — see Round 3's adapter
  notes above for the exact, current, per-platform reason (a metric
  that's mid-deprecation/"in development," or a permission tier this app
  doesn't hold, or an API that's structurally location-level only — not
  "haven't gotten to it yet").
- **Series-wide edit/cancel** for a recurring post — each occurrence is
  managed individually for now (see Round 2 above).
- **Conversion journeys only trigger on inbound DMs, not comments/
  mentions** — same root cause as per-post analytics' platform limits:
  mentions/comments can't resolve to a contact yet (no stable author id
  from those adapter calls). No branching/conditions either — see
  Round 7 above for the deliberate scope cut and its escape hatch.
- **Social listening beyond owned accounts and tracked competitors**
  (open-web keyword/hashtag monitoring). Competitor benchmarking itself
  is now built for Instagram/YouTube (Round 8 above); everything else is
  still scoped to the tenant's own connected accounts' mentions/
  comments/reviews.
- **Competitor Opportunity Radar has no Facebook, LinkedIn, or Google
  Business support** — three different real reasons, not one gap; see
  Round 8 above.
- **Crisis Intelligence only detects a surge on a tenant's own connected
  accounts** — the same open-web-listening gap as the bullet above,
  applied to crisis detection specifically: a crisis unfolding somewhere
  this app can't see won't trigger an alert until it reaches your own
  channels as real inbound volume. See Round 9 above for why this was
  the honest scope, not a smaller version of real social listening.
- **A drag-and-drop visual content calendar editor** beyond the existing
  month-view calendar (which is read/schedule, not a kanban-style
  approval board).

Each of these is a real, separable piece of work — not something that
belongs bolted on quietly under a time-boxed round. Picking this round's
items (approval workflow, AI hashtags, AI inbox triage, recurring posts)
was a deliberate call: highest value-to-effort ratio against what the
market actually ships, with zero new external dependencies and zero risk
to a tenant who doesn't opt in.
