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
    billing.js        Razorpay checkout + webhook
  social/            Platform adapters, OAuth token crypto, publish queue, pollers —
                     ported close to as-is; these operate on an already-tenant-scoped
                     account row, not on tenant_id directly
  server.js

frontend/
  src/
    auth/            Login, Signup
    social/          Dashboard, Composer, Posts, Inbox, Analytics, ConnectAccounts —
                     ported as-is; they already took an authFetch prop
    App.jsx          Auth state, authFetch, view routing
```

## Getting started

1. Create one Supabase (Postgres) project. Run `backend/migrations/*.sql` against it, in order.
2. `cp backend/.env.example backend/.env` and fill in: `SUPABASE_URL_SOCIAL`/`SUPABASE_KEY_SOCIAL`, `JWT_SECRET` (generate, don't reuse a default), `SOCIAL_TOKEN_ENCRYPTION_KEY`, Redis, and the platform OAuth credentials for whichever channels you're connecting first.
3. `npm run install:all`
4. `npm run dev` — backend on :5000, frontend on :5174 (set `VITE_API_BASE` in `frontend/.env` if the backend isn't on localhost).

## What's deliberately not here yet

WhatsApp outbound template/broadcast sending (needs Meta template approval — regulatory lead time, not a code gap), SMS, the visual workflow builder, an integrations marketplace, and the AI layer. These are Sales Hub and Marketing Hub territory — not built until this Hub has a paying customer. See the strategy doc's MVP vs. Roadmap section for why, and the Scalability Risks section for the Meta App Review dependency this Hub needs started early regardless.
