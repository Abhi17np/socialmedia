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

## 6. What's still deliberately deferred (not silently dropped)

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
- **Social listening beyond owned accounts** (keyword/hashtag/competitor
  monitoring). Everything today is scoped to the tenant's own connected
  accounts' mentions/comments/reviews.
- **A drag-and-drop visual content calendar editor** beyond the existing
  month-view calendar (which is read/schedule, not a kanban-style
  approval board).

Each of these is a real, separable piece of work — not something that
belongs bolted on quietly under a time-boxed round. Picking this round's
items (approval workflow, AI hashtags, AI inbox triage, recurring posts)
was a deliberate call: highest value-to-effort ratio against what the
market actually ships, with zero new external dependencies and zero risk
to a tenant who doesn't opt in.
