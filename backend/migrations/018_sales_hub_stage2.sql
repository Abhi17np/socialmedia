-- Sales Hub Stage 2: CRM relationships, forecast categories, a real
-- task/tag-based sequence engine, and an idempotency guard on
-- automation runs. See SALES_HUB_IMPLEMENTATION.md for the audit this
-- migration responds to.

-- A deal previously had exactly one contact_id (the "primary"
-- contact). Real deals involve multiple stakeholders — this adds that
-- without removing deals.contact_id, which stays the primary/default
-- contact for anything that doesn't care about the full set (CSV
-- export, the kanban card's single contact line, etc).
create table if not exists deal_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  role text,                              -- free text, e.g. 'decision maker', 'champion'
  is_primary boolean not null default false,
  created_at timestamptz default now(),
  unique(deal_id, contact_id)
);
create index if not exists idx_deal_contacts_deal on deal_contacts(deal_id);
create index if not exists idx_deal_contacts_contact on deal_contacts(contact_id);
-- Only one primary contact per deal — partial unique index, since a
-- plain column constraint can't express "unique only where true".
create unique index if not exists idx_deal_contacts_one_primary on deal_contacts(deal_id) where is_primary;

-- Forecast category (Salesforce/HubSpot pattern): only meaningful for
-- open deals — a won/lost deal is reported by deals.status, not this.
-- 'omitted' means "don't count toward any forecast number" (e.g. a
-- deal someone wants tracked but doesn't believe in yet).
alter table deals add column if not exists forecast_category text not null default 'pipeline';
alter table deals drop constraint if exists deals_forecast_category_check;
alter table deals add constraint deals_forecast_category_check
  check (forecast_category in ('pipeline', 'best_case', 'commit', 'omitted'));

-- Sequences: a real, persistent multi-step engine (steps + delays +
-- enrollment + pause/stop), scoped to the two action types this app
-- can execute for real right now — create_task and add_tag/remove_tag.
-- No send_email step type exists yet because nothing can send an
-- email as the rep until a mailbox is connected (see
-- SALES_HUB_IMPLEMENTATION.md's "Blocked: Email & Calendar" section);
-- adding that step type later is a config addition to this same
-- engine, not a rewrite.
create table if not exists sequences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_sequences_tenant on sequences(tenant_id);

create table if not exists sequence_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  sequence_id uuid not null references sequences(id) on delete cascade,
  step_order int not null,
  delay_days int not null default 0,      -- days after enrollment (step 1) or after the previous step ran
  action_type text not null,              -- 'create_task' | 'add_tag' | 'remove_tag'
  action_config jsonb not null default '{}'::jsonb,
  unique(sequence_id, step_order)
);

create table if not exists sequence_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  sequence_id uuid not null references sequences(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  deal_id uuid references deals(id) on delete set null,
  status text not null default 'active',  -- 'active' | 'paused' | 'completed' | 'stopped'
  current_step int not null default 0,    -- number of steps already executed
  next_run_at timestamptz not null default now(),
  enrolled_by uuid references users(id),
  enrolled_at timestamptz default now(),
  completed_at timestamptz,
  unique(sequence_id, contact_id)
);
create index if not exists idx_sequence_enrollments_due on sequence_enrollments(tenant_id, status, next_run_at);
