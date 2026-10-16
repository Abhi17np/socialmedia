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
- **Content Repurposing Studio** (`repurposeContent`) — turn one piece of existing
  content into platform-tailored variants for every selected channel in one call, each
  checked for brand-guideline violations and near-duplicate content against the
  tenant's recent posts, plus an honest media-requirement warning (e.g. YouTube needs a
  video attached). Every variant is still loaded into Composer for review before it can
  be scheduled — nothing is created directly.
- **Brand Memory** — a per-tenant, admin-editable profile (tone, audience, preferred/
  banned terms, prohibited claims, approved messaging) applied to every draft, hashtag
  suggestion, and repurposed variant, with a post-generation check that flags (never
  silently blocks) any banned term or prohibited claim that slipped through. Optional:
  a tenant that never configures one gets byte-for-byte the same prompts as before this
  feature existed.
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

## AI Content Experiment Engine

- **A/B content experiments** — compare two already-scheduled posts (same hook,
  caption, CTA, or format, different variants) on the **same connected account**, so the
  comparison is a real apples-to-apples one, not across different-sized audiences.
- **A real two-proportion z-test** (`backend/lib/experimentStats.js`) decides a winner —
  not a "highest raw rate wins" heuristic. Audience size (the account's own follower
  count at post time) is the statistical denominator, which is what normalizes for
  different-sized audiences; each variant is evaluated a configurable number of hours
  after **its own** publish time, not a shared calendar date, which is what normalizes
  for different posting times.
- **Refuses to declare a winner below a configurable minimum audience size per
  variant** — the literal, non-negotiable requirement this feature was built around, not
  an afterthought on the statistical result. Reports the real sample size, z-score, and
  p-value alongside every decision, including "not yet significant" ones.
- Deliberately scoped to exactly two variants (classic A/B) — more than two would need a
  multiple-comparisons correction this app doesn't implement; see Known Limitations.
- A decision sweep runs every 15 minutes (`backend/lib/experimentSweep.js`); a still-
  running experiment shows a **live preview** computed the same way, so a tenant isn't
  left watching silence until it resolves.

## Revenue Attribution

- **Tracked links** — create a short, UTM-tagged redirect for any destination URL,
  paste it into a post instead of the real link. Every click is tagged with real
  `utm_source`/`utm_medium=social`/`utm_content` params and counted (`click_count`),
  independent of whether the destination has analytics installed.
- **Multi-touch revenue attribution**, reusing Marketing Hub's existing engine
  (`backend/lib/attribution.js`) completely — first-touch, last-touch, or linear —
  extended with a 5th, Social-sourced channel once a tracked link's click leads to a
  resolved contact who closes a deal. Mounted as its own **ungated** endpoint
  (`GET /social/attribution`), the same "Social Hub's own feature, not behind the
  commercial gate" posture WhatsApp broadcast already has — a tenant without Marketing
  Hub enabled still sees whether their own social posts are driving real revenue.
- Both assumptions this makes (who gets credit under each model; that a tracked link's
  `utm_content` is the join key back to its platform/label) are surfaced in the report
  itself, not hidden.

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
- **Social-to-WhatsApp Conversion Journeys**: when a contact messages you on any
  connected social channel, automatically wait a configurable amount of time, then send
  a WhatsApp template follow-up — fully reusing Marketing Hub's existing journey engine
  (delay/action execution, retry-safe sweep) and WhatsApp send pipeline under the hood,
  through a focused, ungated authoring surface (no graph editor, no Marketing Hub
  needed). Consent (global opt-out, suppression list) and template-approval status are
  enforced by the exact same code path every other WhatsApp send already goes through —
  nothing new to bypass or get wrong. A tenant who wants branching and already has
  Marketing Hub enabled can build a more complex version of the same journey there,
  using the identical trigger.

## Competitor Opportunity Radar

- **Track a competitor's public Instagram or YouTube account** — the only two
  platforms with an official, permitted way to read another account's public
  data without scraping: Instagram via Meta's **Business Discovery** API
  (`business_discovery.username(...)`), YouTube via its fully public
  `channels.list`/`search.list`/`videos.list` endpoints. Both read through one
  of the tenant's **own** connected accounts' existing OAuth token — zero new
  scopes, zero reconnection, since the scopes this app already requests for
  every Instagram/YouTube connection already cover it.
- A **daily sweep** (`backend/social/competitorSweep.js`) captures followers,
  media count, posts-in-the-last-30-days, and average engagement rate
  (`(likes+comments)/post/followers` — the same audience-normalized "rate, not
  raw count" principle the Content Experiment Engine's statistics use) —
  deliberately slower than the 6-hourly own-account analytics cadence, since
  every lookup spends the tenant's own account's API quota to read someone
  else's data.
- **Side-by-side comparison against the tenant's own account**, computed from
  data this app already collects for its own accounts (per-post
  `post_analytics`, follower `analytics_snapshots`) — not a second live API
  call — using the exact same engagement-rate formula so the two numbers are
  directly comparable.
- **AI content-gap analysis** (pull-based, metered against the same
  `aiGenerationsPerMonth` cap as every other AI Assist feature): compares the
  tenant's own recent captions against the competitor's real, live-fetched
  recent captions and surfaces themes the competitor covers that the tenant
  hasn't — every suggestion must cite the specific competitor post(s) it's
  drawn from, and the model's citations are **re-validated server-side**
  against the real post list before reaching the UI, so a hallucinated
  citation can never surface as evidence.
- **Facebook, LinkedIn, and Google Business are deliberately excluded** — see
  Known Limitations below for the specific, real reason per platform.

## Crisis Intelligence

- **Real surge detection, not sentiment and not open-web listening** — a
  background sweep (`backend/social/crisisSweep.js`, every 15 minutes)
  counts actual inbound DMs/mentions/comments across a tenant's own
  connected accounts in a trailing 3-hour window and compares it against
  a real 14-window (42-hour) trailing baseline using a z-score
  (`backend/lib/crisisDetection.js`) — the exact same "real statistics,
  non-negotiable minimum-data floor" rigor the Content Experiment
  Engine's two-proportion test uses, applied here to volume instead of
  engagement rate. Zero AI involved in deciding whether to alert at all.
- **A non-negotiable minimum-count floor** before any statistics run —
  a quiet tenant going from 0 to 2 messages is never a "crisis" by this
  app's own definition, however large the relative jump looks.
- **An open alert never gets silently duplicated** while it's still
  open, and a fresh surge after a resolved one opens a new alert — one
  ongoing incident reads as one alert, not a new row every 15 minutes.
- **Every alert shows its real evidence** — the actual messages/mentions
  that made up the flagged window, not just the count that triggered it.
- **An optional, pull-based AI summary** (same metered,
  `ANTHROPIC_API_KEY`-gated posture as every other AI Assist feature):
  reads the real flagged messages and names the dominant theme(s) and
  which messages most need a reply — every theme must cite which actual
  numbered message(s) support it, re-validated server-side before
  reaching the UI, so a hallucinated citation can never surface as
  evidence. Nothing in this feature auto-replies, auto-posts, or
  notifies anyone outside this app.
- **Acknowledge (member+) / resolve (admin+) lifecycle**, audit-logged,
  surfaced as a banner on the Social Hub Dashboard when an alert is open.

## Marketing Decision Simulator

- **One real, owned lever: posting frequency on a connected account** —
  deliberately not a general ad-budget/multi-channel allocator, since
  this app tracks no ad spend at all; a "reallocate budget" simulator
  would have to invent numbers it doesn't have. "What if I post N× as
  often?" is the one decision with real historical data behind it.
- **Every baseline number comes from the tenant's own real history**,
  gathered fresh server-side on every run — current posts/week,
  current engagement rate (the same audience-normalized formula
  Competitor Opportunity Radar uses), and real week-over-week follower
  growth. There is no way to supply a baseline from the client.
- **A simple, transparent linear model, not a black-box forecast** — the
  requested multiplier is clamped to a credible range (reported back
  when it was clamped), engagement rate is projected unchanged (an
  explicitly stated assumption, not a hidden one), and follower growth
  scales proportionally with the same real historical variance used to
  build a 95% interval around it.
- **Confidence is honestly flagged, not implied by false precision** — a
  projection built on fewer than 4 weeks of real follower-growth history
  is marked "low confidence" rather than shown with the same visual
  weight as one backed by months of data.
- **An optional, pull-based AI narrative** (same metered,
  `ANTHROPIC_API_KEY`-gated posture as every other AI Assist feature)
  puts the already-final numbers into plain English — the model never
  computes or adjusts a number itself, is told exactly which figures it
  may reference, and is instructed never to narrow the stated
  uncertainty range.
- Every run is persisted (not computed-and-discarded) so a tenant can
  review exactly what was asked and projected later.

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

- **Crisis Intelligence only sees volume on a tenant's own connected accounts** — it
  has no open-web listening (no keyword/hashtag/news monitoring), so a crisis
  unfolding somewhere this app can't see (a viral post on someone else's account, a
  news story that hasn't yet driven DMs/mentions your way) won't trigger an alert
  until it actually reaches your own channels as real inbound volume. This is the
  same "official APIs/own accounts only" boundary Competitor Opportunity Radar and
  the rest of this app respect — not a smaller version of real social listening.
- **The Marketing Decision Simulator only projects posting frequency, never ad
  spend or budget allocation** — this app has no connected ad platform and tracks
  no spend data at all, so a budget-reallocation simulator would have no real
  numbers to project from. It also doesn't predict whether posting more would raise
  or dilute engagement rate — that's modeled as unchanged, an explicit, stated
  simplifying assumption, not a claim this app can actually back with data.
- **No per-post analytics for LinkedIn or Google Business**, and **no per-post reach/
  impressions for any platform** — real, current platform/permission limits, not an
  unbuilt feature (see `docs/SOCIAL_HUB_GAPS_AND_ADDITIONS.md`'s Round 3 for the exact
  reason per platform).
- **No genuinely personalized best-time-to-post.** Per-post data is daily, not broken
  out by hour, so there's still no real signal to compute a genuine "best hour" from —
  not shipped as a generic lookup-table guess dressed up as intelligence.
- **No series-wide edit/cancel for recurring posts** — each occurrence in a series is
  managed individually.
- **Conversion journeys only trigger on inbound DMs, not comments/mentions** — the
  same reason comments/mentions can't resolve to a contact at all today (no stable
  author id from those adapter calls yet). A conversion journey is also deliberately a
  fixed trigger → delay → send-WhatsApp shape, not a branching graph — a named scope
  cut, not a missing capability (see Revenue... section above for the escape hatch via
  Marketing Hub's full builder).
- **Social revenue attribution only sees a visit that went through a Tracked Link.** A
  person who sees a post, remembers the brand, and visits directly later (no click
  through the link) isn't attributable to that post — the same honest limitation every
  UTM-based attribution system has, not unique to this one. No cross-device stitching
  either (an anonymous visitor on their phone who later converts on their laptop is two
  separate, unlinked visitor records).
- **Content experiments are limited to exactly 2 variants (A/B, not A/B/C/…/n)** and to
  two posts on the **same** connected account — a named scope cut (multi-variant needs a
  multiple-comparisons correction this app doesn't implement; cross-account comparison
  needs a deeper audience-normalization model), not a silently missing capability.
- **No social listening beyond owned accounts and tracked competitors** —
  mentions/comments/reviews are still scoped to the tenant's own connected
  accounts; there's no keyword/hashtag monitoring across the open web.
- **Competitor Opportunity Radar has no Facebook, LinkedIn, or Google Business
  support** — each for a different, real reason, not an oversight: Facebook's
  equivalent (**Page Public Content Access**) requires Meta Business
  Verification plus a separate App Review this app doesn't have, and unlike
  `pages_read_engagement` there's no partial/fallback call worth attempting
  live-mode; LinkedIn has no public lookup API for a personal profile (which
  is all this adapter ever connects); a competitor's public Google Business
  listing lives in a separate Places API/credential this app doesn't
  integrate. See `backend/social/adapters/facebook.js`,`linkedin.js`, and
  `google-business.js`'s own header comments for each.
- **No drag-and-drop kanban-style content calendar** — the calendar view is read/
  schedule only, not a visual approval board.
- **Twitter/X and TikTok are unavailable** — blocked by platform API policy, not
  something this codebase chose to skip.
- **WhatsApp broadcast at production volume is Meta-gated**, not code-gated: real
  customer-base sending needs the WABA to clear Meta's own business verification.
