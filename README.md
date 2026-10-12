# Social Hub

Social Media Automation Hub of a three-Hub SaaS (Sales / Marketing / Social) — built and sold first, alone, before the other two Hubs exist. See the full strategy and architecture review (vision, ICP, pricing, roadmap) in the linked doc from the planning conversation this repo came out of.

## What this is

Multi-tenant WhatsApp + social media scheduling, inbox, and analytics — ported from an internal single-tenant tool (`admin-panel`) and rebuilt as a real SaaS:

- **Multi-tenant from the ground up**: `tenants` + `users`, every other table carries `tenant_id`, enforced at the app layer (see `backend/lib/query.js` for why that's the right call here, not Postgres RLS).
- **One contact across every channel** — the actual selling feature. A `contacts` table + `contact_identities` resolve a WhatsApp message, an Instagram DM, and a Facebook comment from the same person into one record (`backend/lib/contacts.js`, `resolve_contact()` in `migrations/003_contacts.sql`). No competitor (scheduling tools or WhatsApp tools) does this.
- **Connect accounts, schedule posts, unified inbox, brand-health analytics** — ported from the existing adapters (Facebook, Instagram, LinkedIn, YouTube, Google Business, WhatsApp) and BullMQ publish queue.
- **Razorpay subscriptions + usage metering**, instrumented from day one even while pricing stays flat-rate.

## Repo layout

```
backend/
  migrations/        Run these in order against one shared Supabase/Postgres project
  lib/
    auth.js          Password hashing + JWT sign/verify (no hardcoded fallback secret)
    query.js         scoped() — the tenant-filtering helper every route must use
    contacts.js       resolveContact() — the unification feature
  middleware/
    tenant.js        requireAuth / requireRole — resolves tenant/user/role from the JWT
  routes/
    auth.js          Signup (creates tenant + owner user) / login
    social.js        Everything else — ported from admin-panel, tenant-scoped throughout
    whatsapp.js      Template management, audience segments, broadcast campaigns
    sales.js         Companies, leads, deal pipelines, sales activities (requireHub('sales'))
    marketing.js     Campaign orchestration + automation-rule CRUD (requireHub('marketing'))
    billing.js        Razorpay checkout + webhook
  social/            Platform adapters, OAuth token crypto, publish queue, pollers —
                     ported close to as-is; these operate on an already-tenant-scoped
                     account row, not on tenant_id directly
    broadcastQueue.js  BullMQ queue for WhatsApp template sends, mirrors queue.js's pattern
  lib/automation.js Small rule engine (add_tag/remove_tag/create_task) fired from Sales Hub events
  server.js

docs/
  phase3-foundation.md  Architecture notes for cross-Hub AI, workflow builder, integrations
                        marketplace — inert schema only (migrations/015), nothing wired up

frontend/              Next.js (App Router) — real per-page URLs, not a single-page view switch
  app/
    (app)/             Authenticated shell (sidebar + auth check) wrapping dashboard,
                       compose, posts, inbox, analytics, connect-accounts, team, billing
    login/, signup/    Public auth pages
    platform/          Infopace's own internal console — separate login/token from
                       the tenant app entirely (see backend/middleware/platform.js)
  src/
    auth/              Login, Signup (the actual components; app/login etc. just mount them)
    social/            Dashboard, Composer, Posts, Inbox, Analytics, ConnectAccounts,
                       Team, Billing, ContactTimeline — ported close to as-is, each
                       still takes an authFetch prop
    platform/          PlatformLogin, PlatformDashboard
    whatsapp/          WhatsAppHub — templates, audience segments, campaigns
    sales/             SalesHub — pipeline kanban, companies, leads, activities
    marketing/         MarketingHub — campaigns, automation rules
    AuthContext.js     authFetch/role, provided by app/(app)/layout.jsx, consumed via useAuth()
```

## Getting started

1. Create one Supabase (Postgres) project. Run `backend/migrations/*.sql` against it, in order.
2. `cp backend/.env.example backend/.env` and fill in: `SUPABASE_URL_SOCIAL`/`SUPABASE_KEY_SOCIAL`, `JWT_SECRET` (generate, don't reuse a default), `SOCIAL_TOKEN_ENCRYPTION_KEY`, Redis, and the platform OAuth credentials for whichever channels you're connecting first.
3. `npm run install:all`
4. `npm run dev` — backend on :5001, frontend on :3000 (Next.js's own default; set `NEXT_PUBLIC_API_BASE` in `frontend/.env.local` if the backend isn't on localhost — Next.js only inlines `NEXT_PUBLIC_`-prefixed env vars into the client bundle).
5. Platform admin console (Infopace-internal, not customer-facing): seed a row in `platform_admins` (migrations/006) with a bcrypt password hash, then visit `/platform`. The Hubs column there is also where you flip `tenants.hubs_enabled` to unlock Sales Hub / Marketing Hub for a given tenant.

Running it in Docker instead, or deploying it somewhere real? See [DEPLOYMENT.md](./DEPLOYMENT.md).

## Sales Hub, Marketing Hub, and the commercial gate

Both Hubs are fully built — practical CRM (companies, leads, deal pipelines, sales activities) in `backend/routes/sales.js`/`frontend/src/sales/`, and campaign orchestration + automation (`backend/routes/marketing.js`/`frontend/src/marketing/`) on top of the real channels that already send (scheduled social posts, WhatsApp broadcasts) — but invisible and 403'd (`middleware/hubs.js`'s `requireHub()`) until a platform admin flips `tenants.hubs_enabled` for that tenant from the `/platform` console's Hubs column. That flag is deliberately not self-service: "first paying customer" is Infopace's own call per the strategy doc's sequencing, not a plan-tier perk.

WhatsApp outbound template/broadcast sending (`backend/routes/whatsapp.js`/`frontend/src/whatsapp/`) is live and ungated — it's Social Hub's own feature, not behind the Sales/Marketing commercial gate. What's still blocked is specifically Meta's own approval, not a code gap: a template can only actually send once Meta approves it (enforced server-side with a 409), and production-volume sending needs the WABA to clear Meta's business verification — see that route file's header for the exact split of what's testable today vs. Meta-gated.

## What's deliberately not here yet

SMS, the visual workflow builder, an integrations marketplace, and the *cross-Hub* AI layer (AI Assist itself — Compose/Inbox drafting backed by Claude — is built and lives inside Social Hub; see `backend/lib/ai.js`). These are Phase 3: the schema exists (`backend/migrations/015_phase3_foundation.sql`) but nothing reads or writes it — see [`docs/phase3-foundation.md`](./docs/phase3-foundation.md) for what's there and what Phase 3 actually has to build. Phase 3 doesn't start until the commercial gate above is cleared for both Hubs.
