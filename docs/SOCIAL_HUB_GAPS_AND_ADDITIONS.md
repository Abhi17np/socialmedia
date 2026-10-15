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

## 5. What's still deliberately deferred (not silently dropped)

- **Real, personalized best-time-to-post.** `analytics_snapshots` is
  account-level daily data (followers/reach/engagement), not per-post
  engagement broken out by hour — there's no real signal to compute a
  genuine "best hour" from yet. Building it honestly means first adding
  per-post analytics collection across 5 adapters (a real, separate
  undertaking), not shipping a generic industry-average lookup table
  dressed up as personalized intelligence.
- **Per-post analytics.** Same root cause as above — `fetchAnalytics` in
  every adapter is page/account-level only today.
- **Series-wide edit/cancel** for a recurring post — each occurrence is
  managed individually for now (see above).
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
