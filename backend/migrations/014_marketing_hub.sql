-- Marketing Hub. Deliberately built as an orchestration layer over the
-- channels that already exist and genuinely work (scheduled social
-- posts, WhatsApp broadcast campaigns — 012_whatsapp_broadcast.sql)
-- rather than inventing a parallel email-send pipeline this app has no
-- provider configured for: a "campaign" bundles one or more of those
-- real sends against one audience_segment and rolls their real
-- analytics up into one view. See routes/marketing.js's header for
-- the exact boundary.
create table if not exists marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text,
  segment_id uuid references audience_segments(id) on delete set null,
  status text not null default 'draft',   -- 'draft' | 'active' | 'completed' | 'archived'
  start_date date,
  end_date date,
  created_by uuid references users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_marketing_campaigns_tenant on marketing_campaigns(tenant_id, status);

-- Many-to-many: a campaign can bundle several scheduled posts (e.g. one
-- per platform) and/or several WhatsApp broadcasts over its lifetime.
create table if not exists marketing_campaign_posts (
  campaign_id uuid not null references marketing_campaigns(id) on delete cascade,
  scheduled_post_id uuid not null references scheduled_posts(id) on delete cascade,
  primary key (campaign_id, scheduled_post_id)
);

create table if not exists marketing_campaign_whatsapp (
  campaign_id uuid not null references marketing_campaigns(id) on delete cascade,
  whatsapp_campaign_id uuid not null references whatsapp_campaigns(id) on delete cascade,
  primary key (campaign_id, whatsapp_campaign_id)
);

-- A small, auditable automation engine: rows describe "when X happens,
-- do Y" declaratively; lib/automation.js's evaluator is the only code
-- that interprets trigger_config/action_config, called from the exact
-- points those triggers correspond to (contact creation in
-- lib/contacts.js's resolve_contact() caller, deal stage moves in
-- routes/sales.js). automation_runs is an append-only log of every
-- firing — including failures — so "why didn't this tag get added" is
-- answerable without re-running anything.
create table if not exists automation_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  trigger_type text not null,             -- 'contact_created' | 'contact_tag_added' | 'deal_stage_changed' | 'deal_won' | 'deal_lost'
  trigger_config jsonb not null default '{}'::jsonb,
  action_type text not null,              -- 'add_tag' | 'remove_tag' | 'create_task' | 'add_to_segment'
  action_config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_automation_rules_tenant on automation_rules(tenant_id, trigger_type, is_active);

create table if not exists automation_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  rule_id uuid not null references automation_rules(id) on delete cascade,
  trigger_ref_type text not null,         -- 'contact' | 'deal'
  trigger_ref_id uuid not null,
  status text not null,                   -- 'success' | 'failed' | 'skipped'
  result jsonb,
  error text,
  ran_at timestamptz default now()
);
create index if not exists idx_automation_runs_rule on automation_runs(rule_id, ran_at desc);
create index if not exists idx_automation_runs_tenant on automation_runs(tenant_id, ran_at desc);
