-- WhatsApp outbound template & broadcast sending. Builds on the
-- existing contacts spine (003_contacts.sql) rather than a parallel
-- audience concept, and on the same BullMQ-backed send pattern
-- queue.js/002_social_schema.sql already established for scheduled
-- posts (see social/broadcastQueue.js).
--
-- What's genuinely testable today vs. blocked on Meta: every table and
-- status value below is designed so the "blocked" states are just
-- states — not missing columns — so nothing here needs re-migrating
-- once Meta approves a template or clears an app for production
-- messaging. See routes/whatsapp.js's header comment for the exact
-- split.

-- Segmentation needs something on contacts to filter by — this didn't
-- exist at all before (migrations/003_contacts.sql has only
-- display_name/phone/email). Both WhatsApp audiences and the Sales Hub
-- CRM (013_sales_crm.sql) build on these same two columns rather than
-- each inventing its own tagging scheme.
alter table contacts add column if not exists tags text[] not null default '{}';
alter table contacts add column if not exists custom_fields jsonb not null default '{}'::jsonb;
create index if not exists idx_contacts_tags on contacts using gin(tags);

-- A template's lifecycle has two independent axes: whether it's been
-- submitted to Meta at all (draft -> pending -> approved/rejected), and
-- whether this app's own WABA/number is cleared to send it at
-- production volume (a separate, account-level Meta gate, not tracked
-- per-template — see routes/whatsapp.js).
create table if not exists whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  social_account_id uuid references social_accounts(id) on delete set null,
  name text not null,                     -- Meta template name: lowercase, underscores only
  language text not null default 'en_US',
  category text not null default 'utility',   -- 'utility' | 'marketing' | 'authentication' (Meta's own categories)
  body_text text not null,                -- with {{1}}, {{2}}... placeholders
  variable_samples jsonb not null default '[]'::jsonb, -- sample values Meta's review requires, one per placeholder
  approval_status text not null default 'draft',  -- 'draft' | 'pending' | 'approved' | 'rejected'
  meta_template_id text,                  -- set once submitted via POST /{waba-id}/message_templates
  rejected_reason text,
  created_by uuid references users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(tenant_id, name, language)
);
create index if not exists idx_whatsapp_templates_tenant on whatsapp_templates(tenant_id);

-- Dynamic segments (filter_json evaluated against contacts at campaign
-- creation time, not a stored membership list) — shared with Marketing
-- Hub's own campaigns (014_marketing_hub.sql references this same
-- table rather than inventing a second one).
create table if not exists audience_segments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text,
  filter_json jsonb not null default '{}'::jsonb, -- { tags: [...], hasPhone: true, hasEmail: true, search: '...' }
  created_by uuid references users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_audience_segments_tenant on audience_segments(tenant_id);

create table if not exists whatsapp_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  template_id uuid not null references whatsapp_templates(id),
  segment_id uuid references audience_segments(id) on delete set null,
  variable_values jsonb not null default '[]'::jsonb, -- static values for the template's {{1}}, {{2}}... (per-recipient personalization is a later iteration)
  status text not null default 'draft',   -- 'draft' | 'scheduled' | 'sending' | 'completed' | 'failed' | 'canceled'
  scheduled_at timestamptz,
  total_recipients int not null default 0,
  sent_count int not null default 0,
  delivered_count int not null default 0,
  read_count int not null default 0,
  failed_count int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_whatsapp_campaigns_tenant on whatsapp_campaigns(tenant_id, status);

create table if not exists whatsapp_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references whatsapp_campaigns(id) on delete cascade,
  contact_id uuid not null references contacts(id),
  phone text not null,
  status text not null default 'pending', -- 'pending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
  external_message_id text,
  error text,
  queued_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  attempts int not null default 0,
  unique(campaign_id, contact_id)
);
create index if not exists idx_wa_campaign_recipients_campaign on whatsapp_campaign_recipients(campaign_id, status);
create index if not exists idx_wa_campaign_recipients_tenant on whatsapp_campaign_recipients(tenant_id);
-- Delivery-status webhooks key off Meta's message id, not campaign_id —
-- this is the lookup routes/social.js's extended webhook handler uses.
create index if not exists idx_wa_campaign_recipients_msg on whatsapp_campaign_recipients(external_message_id);

-- Same atomic-merge reasoning as 002_social_schema.sql's
-- merge_platform_result(): a recipient row's status is written once at
-- enqueue time (app layer) and again, independently, whenever a webhook
-- status event arrives for it (any order, any number of times — Meta
-- can and does deliver sent/delivered/read out of order or more than
-- once). A single UPDATE keyed on external_message_id avoids a
-- read-modify-write race between the worker and concurrent webhook
-- deliveries.
create or replace function mark_whatsapp_recipient_status(
  p_external_message_id text, p_status text, p_error text default null
)
returns void
language plpgsql
as $$
declare
  v_campaign_id uuid;
begin
  update whatsapp_campaign_recipients
  set status = p_status,
      error = coalesce(p_error, error),
      sent_at = case when p_status = 'sent' then coalesce(sent_at, now()) else sent_at end,
      delivered_at = case when p_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
      read_at = case when p_status = 'read' then coalesce(read_at, now()) else read_at end,
      failed_at = case when p_status = 'failed' then coalesce(failed_at, now()) else failed_at end
  where external_message_id = p_external_message_id
  returning campaign_id into v_campaign_id;

  if v_campaign_id is not null then
    perform recompute_whatsapp_campaign_counts(v_campaign_id);
  end if;
end;
$$;

create or replace function recompute_whatsapp_campaign_counts(p_campaign_id uuid)
returns void
language plpgsql
as $$
begin
  update whatsapp_campaigns c
  set sent_count = s.sent_count,
      delivered_count = s.delivered_count,
      read_count = s.read_count,
      failed_count = s.failed_count,
      status = case
        when s.pending_count = 0 and s.queued_count = 0 then
          case when s.failed_count > 0 and s.failed_count = s.total then 'failed' else 'completed' end
        else c.status
      end
  from (
    select
      count(*) filter (where status in ('sent', 'delivered', 'read')) as sent_count,
      count(*) filter (where status in ('delivered', 'read')) as delivered_count,
      count(*) filter (where status = 'read') as read_count,
      count(*) filter (where status = 'failed') as failed_count,
      count(*) filter (where status = 'pending') as pending_count,
      count(*) filter (where status = 'queued') as queued_count,
      count(*) as total
    from whatsapp_campaign_recipients where campaign_id = p_campaign_id
  ) s
  where c.id = p_campaign_id;
end;
$$;

-- Separate counter from whatsapp_messages (inbound/reply traffic,
-- 004_billing.sql) — broadcast sends are metered on their own so a
-- tenant's conversational WhatsApp usage and its marketing-send volume
-- don't share one cap.
alter table usage_counters add column if not exists whatsapp_broadcast_sends int not null default 0;

create or replace function increment_usage(p_tenant_id uuid, p_period date, p_column text, p_amount int default 1)
returns void
language plpgsql
as $$
begin
  if p_column not in ('whatsapp_messages', 'posts_published', 'ai_generations', 'whatsapp_broadcast_sends') then
    raise exception 'Unknown usage column: %', p_column;
  end if;
  execute format(
    'insert into usage_counters (tenant_id, period, %1$I) values ($1, $2, $3)
     on conflict (tenant_id, period) do update set %1$I = usage_counters.%1$I + $3',
    p_column
  ) using p_tenant_id, p_period, p_amount;
end;
$$;
