-- Per-user saved views (filters + sort + visible columns) for the main
-- Companies/Leads/Deals lists. Personal, not shared across the team —
-- owner_id scopes a view to the user who created it, same as any other
-- per-user preference; tenant_id scopes it to the tenant as usual.
create table if not exists sales_saved_views (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  list_type text not null check (list_type in ('companies', 'contacts', 'deals')),
  name text not null,
  filters jsonb not null default '{}'::jsonb,
  sort text,
  visible_columns jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_sales_saved_views_owner on sales_saved_views(tenant_id, owner_id, list_type);
