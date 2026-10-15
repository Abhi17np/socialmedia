# Social Hub — Completed Features

A plain summary of what's actually built, working, and tested in Social Hub. For gap
analysis against competitors and what shipped in which round, see
`docs/SOCIAL_HUB_GAPS_AND_ADDITIONS.md`. For the overall three-Hub architecture, see
`README.md` and `PROJECT_HANDOFF.md`.

---

## Platform Connections

- **Real OAuth** (not mocked) to **Facebook**, **Instagram**, **LinkedIn** (personal
  profile posting), **YouTube**, **Google Business**, and **WhatsApp Cloud API** —
  `backend/social/adapters/*.js`, one adapter per platform, registered through a single
  map (`adapters/index.js`) so routes/workers never `require()` a platform directly.
- **WhatsApp Embedded Signup** flow in addition to the standard OAuth connect.
- Access/refresh tokens stored **encrypted** (`backend/social/crypto.js`), never in
  plaintext.
- Per-account **disconnect**, with status tracked (`active` / `expired` / `revoked`).
- Twitter/X and TikTok are intentionally unregistered — blocked by platform API policy,
  not a gap in this codebase.

## Composer & Scheduling

- **Create & schedule posts** targeting multiple platforms and multiple accounts at once,
  with media upload.
- **Recurring posts** — set a frequency (`daily` / `weekly` / `monthly`) and an end date
  once; the next occurrence is spawned automatically the moment the current one
  *actually* finishes publishing, through the exact same creation path (and therefore the
  same approval gate, plan limits, and consent) as a one-off post. A failed occurrence
  halts the series rather than failing silently forever.
- **Draft → review → approve → publish workflow** (opt-in per tenant,
  `tenants.social_require_approval`): a member's post goes to `pending_review` and is held
  out of the publish queue until an admin/owner approves or rejects it (with an optional
  note); an admin/owner's own post still goes straight through. Every approve/reject/
  settings change is a real audit-log row.
- **"Needs review" tab** in the Posts view; creators can withdraw/discard their own
  pending or rejected post.
- **Calendar + list view** of scheduled posts, with a repeat-icon badge marking a post
  that belongs to a recurring series.
- **Publish queue**: BullMQ + Redis, one job per (post, target account) pair — a failure
  on one platform never blocks or duplicates another platform's send for the same post.
  Per-account results are merged atomically (`merge_platform_result()` Postgres
  function), not a racy read-modify-write.
- **Reconciliation sweep** (every 5 min) re-enqueues any `pending` post that doesn't have
  a live job — covers a crash or Redis outage between insert and enqueue — using a
  deterministic job ID so it can never double-publish.

## Unified Inbox

- **One inbox across every connected channel** — mentions, comments, reviews, and DMs,
  all resolved through `mentions` / `inbox_messages`.
- **One contact across channels**: a WhatsApp message, an Instagram DM, and a Facebook
  comment from the same person resolve to a single contact record
  (`backend/lib/contacts.js`, `resolve_contact()`), with a full cross-channel timeline on
  that contact.
- **Assignment, priority, and status** (open / under review / closed) per
  mention/message, settable by the team.
- **Saved replies** — reusable canned responses, create/edit/delete.
- **Reply in-thread** directly from the inbox, per platform's real reply capability.
- **AI inbox triage** — on-demand sentiment + urgency classification
  (`classifyMessage()`) shown as a chip/badge next to a message; strictly pull-based
  (never runs automatically on arrival) — a human still decides what to do with it.

## AI Assist

- **Draft a post** (`draftPost`) from a brief, tone, and target platform(s).
- **Draft an inbox reply** (`draftReply`) from the original message + optional
  instructions.
- **Suggest hashtags** (`suggestHashtags`) as a separate, independently-triggered call —
  regenerating hashtags never costs the caption you already liked. Platform-aware (more
  tags for Instagram-style platforms, fewer for LinkedIn-style ones).
- Every AI feature is **metered** (`aiGenerationsPerMonth`), gated at member role or
  above, and **fails closed** (a clear error, not a crash) if no Anthropic API key is
  configured — a human always reviews before anything sends.

## Analytics

- **Account-level snapshots** (followers, reach, engagement) polled every 6 hours per
  platform's real API (`backend/social/pollers.js`).
- **Per-post analytics** (likes/comments/shares for Facebook and Instagram, views/likes/
  comments for YouTube), ingested every 6 hours per published post via each platform's
  real, currently-stable API fields, stored historically in `post_analytics`, and
  surfaced per post in `Posts.jsx` with an honest per-platform availability indicator.
  Not available for LinkedIn or Google Business (real platform/permission limits, not
  unbuilt — see `docs/SOCIAL_HUB_GAPS_AND_ADDITIONS.md`'s Round 3), and reach/impressions
  specifically aren't collected for any platform yet (Meta's own metrics are mid-
  deprecation as of this build — shipping a call to an unstable metric name would be
  worse than not having it).
- **Analytics dashboard** with per-platform breakdowns and a tenant-wide summary view.
- A genuinely personalized "best time to post" is explicitly **not** built yet (see
  Known Limitations) — the per-post data above is daily, not broken out by hour, so
  there's still no real signal to compute a genuine "best hour" from.

## WhatsApp Broadcast (Social Hub's own always-on feature, not behind the commercial gate)

- **Template management**: create, submit to Meta for review, sync real approval status
  back from the Graph API.
- **Audience segments**: build against the real contacts table, preview membership,
  add/remove members.
- **Broadcast campaigns**: create, schedule, send, cancel, delete — recipient resolution
  against a segment, real send pipeline (`backend/social/broadcastQueue.js`) with retry
  and delivery-status tracking from the webhook.
- **Meta's own gates enforced, not faked**: a template can only be sent once Meta has
  approved it (hard `409`, not a warning); Development Mode is capped at Meta's own
  5-test-number limit until the WABA clears business verification — both are Meta-side
  facts this code surfaces honestly rather than working around.

## Billing & Usage

- **Razorpay subscriptions** + real usage metering (`increment_usage` Postgres RPC),
  instrumented from day one — `posts_published`, `whatsapp_messages`,
  `aiGenerationsPerMonth` all tracked per billing period, even while pricing stays
  flat-rate.
- Billing view in the app surfaces current plan + usage against it.

## Team & Governance

- **Role-based access** (viewer / member / admin / owner) enforced on every mutating
  route — connect/disconnect accounts, approve/reject posts, delete saved replies,
  manage WhatsApp templates/campaigns, etc.
- **Approval-setting toggle** (admin-only) to turn the review workflow on/off per tenant.
- **Audit log** of meaningful actions (approve, reject, settings change, disconnect,
  etc.).
- Multi-tenant from the ground up: every table carries `tenant_id`, enforced at the app
  layer, with cross-tenant access verified to 404 (not leak) in integration tests.

## Design & UX

- Dedicated Social Hub sidebar — Dashboard, Posts & schedule, Inbox (with a live open-
  count badge), Analytics, WhatsApp Broadcast — each item gated to the same minimum role
  as its backend route, so the UI never shows a link that would just 403.
- Dedicated views: `Dashboard`, `Composer`, `Posts`, `Inbox`, `Analytics`,
  `ConnectAccounts`, `Team`, `Billing`, `ContactTimeline`, `SavedReplies`.

---

## Known Limitations (not built, or deliberately deferred)

- **No per-post analytics for LinkedIn or Google Business**, and **no per-post reach/
  impressions for any platform** — real, current platform/permission limits, not an
  unbuilt feature (see `docs/SOCIAL_HUB_GAPS_AND_ADDITIONS.md`'s Round 3 for the exact
  reason per platform).
- **No genuinely personalized best-time-to-post.** Per-post data is daily, not broken
  out by hour, so there's still no real signal to compute a genuine "best hour" from —
  not shipped as a generic lookup-table guess dressed up as intelligence.
- **No series-wide edit/cancel for recurring posts** — each occurrence in a series is
  managed individually.
- **No social listening beyond owned accounts** — everything is scoped to the tenant's
  own connected accounts' mentions/comments/reviews, not keyword/hashtag/competitor
  monitoring.
- **No drag-and-drop kanban-style content calendar** — the calendar view is read/
  schedule only, not a visual approval board.
- **Twitter/X and TikTok are unavailable** — blocked by platform API policy, not
  something this codebase chose to skip.
- **WhatsApp broadcast at production volume is Meta-gated**, not code-gated: real
  customer-base sending needs the WABA to clear Meta's own business verification.
