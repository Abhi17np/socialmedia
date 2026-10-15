-- Social Hub: Brand Memory — a tenant's persistent voice/terminology/
-- claims guardrails, applied to every AI generation call (lib/ai.js)
-- and checked against every AI output before a human sees it
-- (lib/brandMemory.js's checkBrandViolations). One row per tenant —
-- this app has no multi-brand-per-tenant concept (see migrations/002's
-- header: "brand is gone — a tenant IS the segmentation boundary"), so
-- brand_profiles mirrors that: tenant_id is the primary key, not a
-- separate id, since a tenant can have at most one.
--
-- Entirely optional and additive: a tenant with no row here gets an
-- empty brand context and zero violations from every AI call — zero
-- behavior change for a tenant that never sets this up, same posture
-- every other opt-in Social Hub feature (034, 035) already takes.
create table if not exists brand_profiles (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  tone text,
  audience text,
  preferred_terms text[] not null default '{}',
  banned_terms text[] not null default '{}',
  prohibited_claims text[] not null default '{}',
  approved_messaging text[] not null default '{}',
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

grant all privileges on brand_profiles to service_role;
grant all privileges on all sequences in schema public to service_role;
