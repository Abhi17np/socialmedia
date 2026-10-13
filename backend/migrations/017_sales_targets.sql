-- Sales Hub Stage 1 (Dashboard): real, admin-set revenue targets to
-- compare actual won-revenue against — the dashboard's "sales targets"
-- requirement can't be satisfied with a made-up number, so this is the
-- minimum real schema for one: a target amount over a period, either
-- team-wide (owner_id null) or for one rep (owner_id set).
create table if not exists sales_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  owner_id uuid references users(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  target_amount numeric(14,2) not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint sales_targets_period_valid check (period_end >= period_start)
);
create index if not exists idx_sales_targets_tenant_period on sales_targets(tenant_id, period_start, period_end);
