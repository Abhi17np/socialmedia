-- Sales Hub Stage 1 (CRM/automation parity pass): custom fields on every
-- entity (contacts already had this from 012; companies/deals didn't),
-- a real configurable lead-scoring rule set, per-stage "stale deal"
-- thresholds (the Pipedrive "rotting" pattern — a per-stage inactivity
-- window, visual only, not yet an automation trigger — see
-- routes/sales.js's header for the exact scope line), and
-- move_deal_stage gaining an optional lost_reason capture.

alter table companies add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table deals add column if not exists custom_fields jsonb not null default '{}'::jsonb;

-- Per-tenant field schema a Contact/Company/Deal form renders in
-- addition to its fixed columns — values live in that entity's own
-- custom_fields jsonb, this table only describes the schema (key,
-- label, type, options for a 'select' type, required, display order).
create table if not exists custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity_type text not null,              -- 'contact' | 'company' | 'deal'
  field_key text not null,                -- key inside the entity's custom_fields jsonb
  label text not null,
  field_type text not null default 'text',-- 'text' | 'number' | 'date' | 'boolean' | 'select'
  options jsonb not null default '[]'::jsonb, -- array of strings, only used when field_type = 'select'
  is_required boolean not null default false,
  position int not null default 0,
  created_at timestamptz default now(),
  unique(tenant_id, entity_type, field_key)
);
create index if not exists idx_custom_field_definitions_tenant on custom_field_definitions(tenant_id, entity_type);

-- Real, tenant-configurable lead scoring — not a hardcoded formula.
-- Each rule awards (or can dock, via a negative points value) points
-- when its condition matches a contact; lib/leadScoring.js sums every
-- active rule's points into contacts.lead_score, recomputed whenever a
-- contact is created or updated (see routes/sales.js).
create table if not exists lead_scoring_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  condition_type text not null,           -- 'has_email' | 'has_phone' | 'has_company' | 'tag_equals' | 'lead_status_equals'
  condition_value text,                   -- the tag name or lead_status value — null for has_email/has_phone/has_company
  points int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_lead_scoring_rules_tenant on lead_scoring_rules(tenant_id, is_active);

alter table contacts add column if not exists lead_score int not null default 0;
create index if not exists idx_contacts_lead_score on contacts(tenant_id, lead_score desc);

-- Per-stage inactivity window (days) before a deal sitting in it is
-- flagged stale in the UI — null means "never flag," the default, so
-- existing pipelines don't suddenly show every deal as stale. Computed
-- at query time against deals.updated_at (GET /sales/deals), not a
-- stored flag — nothing to keep in sync.
alter table deal_stages add column if not exists stale_after_days int;

-- create or replace function cannot change a function's parameter list in
-- place — Postgres identifies a function by name + argument types, so
-- adding p_lost_reason would otherwise leave the old 4-arg signature
-- behind as a second overload, and every existing 4-arg call site would
-- then fail with "function move_deal_stage(uuid, uuid, uuid, uuid) is not
-- unique". Drop the old signature first so only the 5-arg version remains.
drop function if exists move_deal_stage(uuid, uuid, uuid, uuid);

create or replace function move_deal_stage(
  p_deal_id uuid, p_tenant_id uuid, p_to_stage_id uuid, p_changed_by uuid, p_lost_reason text default null
)
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
      lost_reason = case when v_is_lost then coalesce(p_lost_reason, lost_reason) else lost_reason end,
      closed_at = case when v_is_won or v_is_lost then now() else null end,
      updated_at = now()
  where id = p_deal_id and tenant_id = p_tenant_id;

  insert into deal_stage_history (tenant_id, deal_id, from_stage_id, to_stage_id, changed_by)
  values (p_tenant_id, p_deal_id, v_from_stage_id, p_to_stage_id, p_changed_by);
end;
$$;
