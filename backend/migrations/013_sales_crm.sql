-- Sales Hub core schema. Extends the existing contacts spine
-- (003_contacts.sql) rather than introducing a parallel "lead" or
-- "person" concept — a contact that first appeared via a WhatsApp
-- inbound message and one entered by hand in the CRM are the same
-- table, same resolve_contact() identity rules. Gated behind
-- tenants.hubs_enabled->>'sales' (011_hub_gating.sql) until the
-- commercial gate is satisfied — see middleware/hubs.js.
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  domain text,
  industry text,
  size text,                              -- '1-10' | '11-50' | '51-200' | '201-500' | '500+'
  phone text,
  address text,
  notes text,
  owner_id uuid references users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_companies_tenant on companies(tenant_id);

alter table contacts add column if not exists company_id uuid references companies(id) on delete set null;
alter table contacts add column if not exists job_title text;
alter table contacts add column if not exists lead_status text not null default 'new'; -- 'new' | 'contacted' | 'qualified' | 'unqualified' | 'customer'
alter table contacts add column if not exists lead_source text;                        -- 'whatsapp' | 'manual' | 'import' | 'web_form' | ...
alter table contacts add column if not exists owner_id uuid references users(id);
create index if not exists idx_contacts_company on contacts(company_id);
create index if not exists idx_contacts_lead_status on contacts(tenant_id, lead_status);

-- A pipeline is a named, ordered set of stages (most tenants will have
-- exactly one, "Sales Pipeline", auto-created — see routes/sales.js —
-- but the schema doesn't assume that, so a tenant can add a second one
-- later without a migration).
create table if not exists deal_pipelines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  created_at timestamptz default now()
);
create index if not exists idx_deal_pipelines_tenant on deal_pipelines(tenant_id);

create table if not exists deal_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  pipeline_id uuid not null references deal_pipelines(id) on delete cascade,
  name text not null,
  position int not null,
  probability int not null default 0,     -- 0-100, used for weighted pipeline value
  is_won boolean not null default false,
  is_lost boolean not null default false,
  created_at timestamptz default now(),
  unique(pipeline_id, position)
);
create index if not exists idx_deal_stages_pipeline on deal_stages(pipeline_id);

create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  pipeline_id uuid not null references deal_pipelines(id),
  stage_id uuid not null references deal_stages(id),
  name text not null,
  amount numeric(14,2) not null default 0,
  currency text not null default 'INR',
  contact_id uuid references contacts(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  owner_id uuid references users(id),
  expected_close_date date,
  status text not null default 'open',    -- 'open' | 'won' | 'lost'
  lost_reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  closed_at timestamptz
);
create index if not exists idx_deals_tenant_stage on deals(tenant_id, stage_id);
create index if not exists idx_deals_pipeline on deals(pipeline_id);
create index if not exists idx_deals_contact on deals(contact_id);
create index if not exists idx_deals_company on deals(company_id);

-- Stage-change history — the audit_log (009_audit_log.sql) already
-- records "who changed what" generically, but a pipeline view also
-- wants "how long did this deal sit in each stage", which needs its own
-- append-only table rather than parsing audit_log's jsonb metadata.
create table if not exists deal_stage_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  from_stage_id uuid references deal_stages(id),
  to_stage_id uuid not null references deal_stages(id),
  changed_by uuid references users(id),
  changed_at timestamptz default now()
);
create index if not exists idx_deal_stage_history_deal on deal_stage_history(deal_id);

create table if not exists sales_activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  type text not null,                     -- 'call' | 'email' | 'meeting' | 'note' | 'task'
  subject text not null,
  notes text,
  contact_id uuid references contacts(id) on delete cascade,
  company_id uuid references companies(id) on delete cascade,
  deal_id uuid references deals(id) on delete cascade,
  due_at timestamptz,
  completed_at timestamptz,
  status text not null default 'open',    -- 'open' | 'completed'
  assigned_to uuid references users(id),
  created_by uuid references users(id),
  created_at timestamptz default now()
);
create index if not exists idx_sales_activities_tenant on sales_activities(tenant_id, status);
create index if not exists idx_sales_activities_deal on sales_activities(deal_id);
create index if not exists idx_sales_activities_contact on sales_activities(contact_id);

-- One atomic move: update the deal's stage AND append the history row,
-- so a dropped request between the two writes can't leave a deal on a
-- new stage with no record of how it got there.
create or replace function move_deal_stage(p_deal_id uuid, p_tenant_id uuid, p_to_stage_id uuid, p_changed_by uuid)
returns void
language plpgsql
as $$
declare
  v_from_stage_id uuid;
  v_is_won boolean;
  v_is_lost boolean;
begin
  select stage_id into v_from_stage_id from deals where id = p_deal_id and tenant_id = p_tenant_id;
  if v_from_stage_id is null then
    raise exception 'Deal % not found for tenant %', p_deal_id, p_tenant_id;
  end if;

  select is_won, is_lost into v_is_won, v_is_lost from deal_stages where id = p_to_stage_id and tenant_id = p_tenant_id;
  if v_is_won is null then
    raise exception 'Stage % not found for tenant %', p_to_stage_id, p_tenant_id;
  end if;

  update deals
  set stage_id = p_to_stage_id,
      status = case when v_is_won then 'won' when v_is_lost then 'lost' else 'open' end,
      closed_at = case when v_is_won or v_is_lost then now() else null end,
      updated_at = now()
  where id = p_deal_id and tenant_id = p_tenant_id;

  insert into deal_stage_history (tenant_id, deal_id, from_stage_id, to_stage_id, changed_by)
  values (p_tenant_id, p_deal_id, v_from_stage_id, p_to_stage_id, p_changed_by);
end;
$$;
