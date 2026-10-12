# Phase 3 foundation: cross-Hub AI, visual workflow builder, integrations marketplace

**Status: foundation only. Nothing in this document is activated, wired
to a route, or reachable from the UI.** Per the product gate, Phase 3
does not begin until Sales Hub and Marketing Hub themselves are
commercially cleared (first paying customer on Social Hub, then the
same for Sales Hub before Marketing Hub, per the strategy doc's
sequencing). This document exists so that when that gate is cleared,
building Phase 3 is a scoped engineering project against a schema that
already exists — not a redesign.

The only code that exists today is `migrations/015_phase3_foundation.sql`:
three inert tables (`integrations_registry`, `workflow_definitions`,
`cross_hub_ai_context`). No route reads or writes them, no worker
processes them, `workflow_definitions.is_active` has nothing that would
ever honor `true`. That is intentional — see the migration's own header
comment.

## 1. Cross-Hub AI layer

**What it is.** Today, `lib/ai.js` is Social Hub-only: it drafts a post
or an inbox reply from a brief, with no memory of anything outside that
one call. A cross-Hub AI layer would let the same Anthropic-backed
assistant reason over a contact's *entire* history — their WhatsApp
conversation, their deal stage and amount, their open sales activities,
any marketing campaigns they're in a segment for — to do things no
single-Hub feature can: summarize a contact before a sales call, draft
a follow-up that references what was actually discussed, or flag that a
"qualified" lead has gone quiet everywhere at once.

**Why it's cross-Hub and not three separate AI features.** The whole
point of the unified contact spine (`contacts`/`contact_identities`,
`migrations/003_contacts.sql`) is that one person is one row across
every channel and every Hub. An AI feature that only sees Social Hub's
half of that contact is strictly worse than what a human doing the same
job already has (they can just open three tabs). The cross-Hub context
table exists so an AI call's *input* can be assembled once, generically,
rather than every new AI feature hand-rolling its own multi-table JOIN
across `contacts`, `deals`, `inbox_messages`, `sales_activities`, and
`marketing_campaigns`.

**What exists:**
- `cross_hub_ai_context` (migration 015): `{ id, tenant_id, source_hub,
  context_type, ref_id, payload, created_at }` — a generic append-only
  table a future `lib/crossHubContext.js` would write into (e.g. "this
  deal just moved to Proposal" → a `deal_summary` row) and read from
  (to assemble an AI prompt's context window without five live JOINs).

**What Phase 3 actually has to build, in order:**
1. `lib/crossHubContext.js` — write-side hooks in `routes/sales.js`
   (deal stage moves, activity completion) and `routes/whatsapp.js`
   (campaign sends) that populate `cross_hub_ai_context` incrementally,
   the same way `lib/automation.js`'s triggers are already called from
   those exact routes. This is the only part that touches existing
   route files.
2. A context-assembly function — given a `contact_id`, pull its latest
   `cross_hub_ai_context` rows plus the contact/deal rows themselves,
   and produce a bounded prompt (token budget matters — Anthropic calls
   are metered per the existing `aiGenerationsPerMonth` plan limit in
   `lib/plans.js`, which this would reuse, not duplicate).
3. The actual AI call sites — "summarize this contact," "draft a
   cross-Hub follow-up" — as new, explicit, human-reviewed-before-send
   features (same non-autonomous posture `lib/ai.js`'s header comment
   already commits to: nothing in this app sends or acts on a model's
   output without a human clicking Send/Publish first). This is a
   product-design decision as much as an engineering one (what exactly
   does "summarize a contact" show, where does it live in the UI) and
   should not be rushed to fit an estimate.
4. New usage-metering column if this is billed separately from today's
   `aiGenerationsPerMonth` cap, following the exact `migrations/008_ai_features.sql`
   precedent (`alter table usage_counters add column ...` +
   `increment_usage()`'s column allowlist).

**Open product question, deliberately not answered here:** whether
cross-Hub AI output should ever be allowed to *act* (e.g. auto-send a
drafted follow-up, auto-update a lead's status) rather than only draft
for review. Every AI feature shipped so far in this app is strictly
draft-and-review. Changing that is a real trust and liability decision,
not an implementation detail, and belongs in a product conversation
before Phase 3 work starts, not buried in a PR description.

## 2. Visual workflow builder

**What it is.** A drag-and-drop canvas (think: a trigger node →
condition nodes → action nodes) that produces the same kind of
automation `lib/automation.js` already runs today, except visually
composed instead of configured through a form, and with richer
branching than today's one-trigger-one-action rule shape allows.

**Why build on the existing automation engine instead of a new one.**
`lib/automation.js` + `automation_rules`/`automation_runs`
(`migrations/014_marketing_hub.sql`) is a real, running, tested engine
today — it fires on `contact_created`, `contact_tag_added`,
`deal_stage_changed`, `deal_won`, `deal_lost`, with three actions
(`add_tag`, `remove_tag`, `create_task`), and every firing is logged.
A visual workflow builder's job is to be a *better authoring surface*
for a strictly more expressive version of the same thing — multi-step
chains, branching conditions, delays — not a parallel execution engine.
Building a second engine would mean two places that can tag a contact
or create a task, with two audit trails, which is exactly the kind of
inconsistency this app has avoided everywhere else (one contact spine,
one entitlements check, one audit log).

**What exists:**
- `workflow_definitions` (migration 015): `{ id, tenant_id, name,
  graph_json, is_active, created_by }`. `graph_json` is an inert
  node/edge shape — nothing parses it. `is_active` defaults to and
  stays `false`, by design, until an executor exists to honor it.

**What Phase 3 actually has to build, in order:**
1. **Graph schema** — a versioned JSON shape for `graph_json` (node
   types: trigger, condition, action, delay; edges: which node feeds
   which). This needs a real design pass against what `lib/automation.js`
   can already express today, so a trigger/action node in the new graph
   maps onto the existing `trigger_type`/`action_type` enums wherever
   possible, extending them rather than replacing them.
2. **Executor** — a function that walks a `graph_json`, evaluates
   condition nodes against the same `context` shape
   `lib/automation.js`'s `fireTrigger()` already builds, and calls the
   same action implementations `runRule()` already has (`add_tag`,
   `remove_tag`, `create_task`, plus whatever new action types the
   graph format adds — e.g. "send WhatsApp template," which would call
   `social/broadcastQueue.js` the same way `routes/whatsapp.js`'s
   campaign-send path does). This is the piece that turns
   `workflow_definitions` from inert storage into something that runs.
3. **Delay/wait nodes** need a scheduler, not just a synchronous
   function call — likely a new BullMQ queue (mirroring
   `social/broadcastQueue.js`'s delayed-job pattern) rather than a
   setInterval poller, since a workflow step can legitimately wait
   days.
4. **The canvas UI itself** — a genuinely separate, sizeable frontend
   effort (a drag-and-drop graph editor is not a form), likely a new
   `src/workflows/` directory following the existing `src/ui/`
   component library, plus a graph-rendering library decision this
   document deliberately does not make.
5. **Migrate or coexist** — once the executor exists, decide whether
   existing `automation_rules` rows get a one-time migration into
   `workflow_definitions.graph_json` (a single trigger→action rule is a
   two-node graph) or the two simply coexist indefinitely (simple rules
   stay in the form-based UI, complex ones go to the canvas). Either is
   defensible; deferred to when there's a real executor to migrate
   onto.

## 3. Integrations marketplace

**What it is.** A catalog of third-party connectors (Slack, Google
Sheets, Zapier, etc.) a tenant can browse and connect, the way the
existing Connect Accounts page lets a tenant connect a Facebook/
Instagram/WhatsApp/YouTube/Google Business account.

**Why this is the most separable of the three.** Unlike the AI layer
and the workflow builder, an integration marketplace entry is
self-contained per integration — adding Slack doesn't require touching
Sales Hub or Marketing Hub's existing code, the same way adding a sixth
social adapter today doesn't require touching the other five (see
`social/adapters/`'s one-file-per-platform shape). This makes it the
easiest of the three to build incrementally, one integration at a time,
without a big-bang launch.

**What exists:**
- `integrations_registry` (migration 015): `{ id, slug, display_name,
  category, description, status }`. `status` stays `'planned'` for
  every row — nothing sets it to anything else, and no route reads this
  table at all yet. It is a catalog shape, not a connection mechanism.

**What Phase 3 actually has to build, in order, and this is the
one place where "relevant dependencies" in the literal sense
(npm packages, OAuth app registrations) matters most:**
1. **A generic connector framework** — `social/adapters/`'s
   `{ isConfigured, connect: { getAuthUrl, exchangeCode }, ... }` shape
   (see `social/adapters/whatsapp.js` for the fullest example, or
   `_meta-oauth.js` for the shared OAuth helper two adapters already
   reuse) is the template to generalize, not reinvent: a connector is
   "OAuth in, some capability out," and that pattern already works for
   5 providers. A `connectors/` directory mirroring `social/adapters/`'s
   shape, with its own `connected_integrations` table (mirroring
   `social_accounts`'s encrypted-token-at-rest pattern via
   `social/crypto.js`) is the natural port of this, not a new framework
   from scratch.
2. **Per-integration work** is genuinely per-integration: Slack needs a
   Slack App registration + `@slack/web-api`; Google Sheets needs
   Google Cloud OAuth scopes + `googleapis` (already a cousin of the
   Google Business/YouTube adapters' OAuth pattern); Zapier is
   structurally different (it's Zapier calling *this app's* webhook,
   not this app calling an outbound API) and needs its own inbound
   auth story. Each is its own scoped PR, not one that tries to ship
   three providers at once.
3. **The marketplace UI** — a browse/connect grid, likely a new
   `src/integrations/` page reusing `src/ui/`'s `Panel`/`EmptyState`/
   `Table` components the same way every other Hub's UI in this app
   does, with `integrations_registry.status` finally meaning something
   (`planned` → `beta` → `available`) once a connector is real.
4. **What an integration actually *does* once connected** is the real
   design question this document does not answer: a Slack integration
   that only posts "a deal was won" to a channel is a small, scoped
   build; a Slack integration that lets someone reply to a WhatsApp
   message from Slack is a much bigger one. Scope this per-integration
   when it's actually built, against real demand, not speculatively
   here.

## What this document is not

This is architecture and sequencing, not a commitment to build any of
it on a particular timeline, and not a substitute for the actual
engineering and design work each section flags as still open. Nothing
here should be read as "mostly done" — the SQL exists; everything that
makes it do something does not.
