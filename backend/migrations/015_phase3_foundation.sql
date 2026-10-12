-- Phase 3 foundation ONLY — cross-Hub AI layer, visual workflow
-- builder, integrations marketplace. Per the strategy doc's gate, none
-- of this is wired to anything: no route reads or writes these tables,
-- no worker processes them, no UI renders them. They exist so Phase 3
-- doesn't need a schema migration on day one, not so it can be turned
-- on by flipping a flag — turning it on is a real implementation
-- project, documented (not built) in docs/phase3-foundation.md.
create table if not exists integrations_registry (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,              -- 'slack', 'google_sheets', 'zapier', ...
  display_name text not null,
  category text,                          -- 'communication' | 'productivity' | 'data' | ...
  description text,
  status text not null default 'planned', -- 'planned' only, until Phase 3 — nothing sets any other value
  created_at timestamptz default now()
);

create table if not exists workflow_definitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  graph_json jsonb not null default '{}'::jsonb, -- node/edge graph shape, not interpreted by any code yet
  is_active boolean not null default false,       -- stays false; no executor exists to honor true
  created_by uuid references users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_workflow_definitions_tenant on workflow_definitions(tenant_id);

create table if not exists cross_hub_ai_context (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_hub text not null,               -- 'social' | 'sales' | 'marketing'
  context_type text not null,             -- e.g. 'contact_summary', 'deal_summary' — shape TBD in Phase 3 design
  ref_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists idx_cross_hub_ai_context_tenant on cross_hub_ai_context(tenant_id, source_hub);
