-- Marketing Hub Phase 4: journeys/automation upgrade. Activates
-- migrations/015's previously-inert workflow_definitions table (adds
-- the denormalized trigger columns an executor needs to find candidate
-- workflows efficiently, re-entry/goal settings) and adds the two
-- tables an executor needs that didn't exist yet: workflow_enrollments
-- (one row per contact's run through a workflow) and
-- workflow_enrollment_events (the per-node step log journey analytics
-- read from).
--
-- Deliberately built as an ADDITIONAL authoring surface over the same
-- primitives lib/automation.js's flat rules already use (contacts,
-- deals, sales_activities), not a second parallel engine — see
-- docs/phase3-foundation.md's own architectural call, which the Phase 0
-- audit endorsed. automation_rules/automation_runs are untouched by
-- this migration; a journey is a genuinely new, more expressive
-- authoring surface (branching, delay, multi-step), not a replacement.
--
-- After applying against a self-hosted PostgREST setup (not needed
-- against a real Supabase project): reload PostgREST's schema cache.

alter table workflow_definitions add column if not exists description text;
alter table workflow_definitions add column if not exists trigger_type text;
alter table workflow_definitions add column if not exists trigger_config jsonb not null default '{}'::jsonb;
alter table workflow_definitions add column if not exists reentry_allowed boolean not null default false;
alter table workflow_definitions add column if not exists goal_config jsonb; -- { field, operator, value } evaluated against the enrollment's contact after every step; met -> status 'goal_met'
alter table workflow_definitions add column if not exists version integer not null default 1;
create index if not exists idx_workflow_definitions_trigger on workflow_definitions(tenant_id, trigger_type, is_active);

drop trigger if exists trg_workflow_definitions_bump_version on workflow_definitions;
create trigger trg_workflow_definitions_bump_version before update on workflow_definitions
  for each row execute function bump_version();

create table if not exists workflow_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  workflow_id uuid not null references workflow_definitions(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'completed', 'exited', 'goal_met', 'failed')),
  current_node_id text,           -- the graph_json node id this enrollment is waiting at/resumes from
  next_action_at timestamptz,     -- null while actively executing a tick; set when paused at a delay node
  context jsonb not null default '{}'::jsonb,
  enrolled_at timestamptz not null default now(),
  completed_at timestamptz,
  deal_id uuid references deals(id) on delete set null  -- optional, when a deal-stage trigger enrolled this contact
);
create index if not exists idx_workflow_enrollments_tenant on workflow_enrollments(tenant_id, workflow_id);
create index if not exists idx_workflow_enrollments_due on workflow_enrollments(status, next_action_at) where status = 'active';
-- Partial unique index, not a plain unique constraint: re-entry is
-- allowed per-workflow (reentry_allowed), so "one active enrollment at a
-- time" is enforced only for the non-re-entrant case, in application
-- code (a partial unique index can't reference another table's column).
create unique index if not exists idx_workflow_enrollments_one_active on workflow_enrollments(workflow_id, contact_id) where status = 'active';

create table if not exists workflow_enrollment_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  enrollment_id uuid not null references workflow_enrollments(id) on delete cascade,
  node_id text not null,
  node_type text not null,   -- 'trigger' | 'delay' | 'condition' | 'action' | 'split'
  event_type text not null check (event_type in ('entered', 'completed', 'skipped', 'failed')),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_workflow_enrollment_events_enrollment on workflow_enrollment_events(enrollment_id);
create index if not exists idx_workflow_enrollment_events_workflow_node on workflow_enrollment_events(tenant_id, node_id);

grant all privileges on workflow_enrollments to service_role;
grant all privileges on workflow_enrollment_events to service_role;
grant all privileges on all sequences in schema public to service_role;
