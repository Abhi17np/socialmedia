-- Marketing Hub Phase 3: email marketing. Provider connection (one per
-- tenant, credential encrypted at rest via social/crypto.js — the same
-- helper social_accounts already uses, despite the directory name),
-- templates, campaigns, per-recipient tracking, and a per-recipient
-- event log. Deliberately separate from backend/lib/email.js (the
-- app's own global, single-SMTP-config transactional sender for
-- password-reset/verification mail) — this is per-tenant, multi-provider,
-- and only ever sends what a tenant explicitly composes and approves.
--
-- After applying against a self-hosted PostgREST setup (not needed
-- against a real Supabase project): reload PostgREST's schema cache.

create table if not exists email_provider_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null check (provider in ('mock', 'smtp', 'sendgrid', 'resend')),
  from_name text not null,
  from_email text not null,
  reply_to text,
  config jsonb not null default '{}'::jsonb,   -- non-secret fields: smtp host/port/secure, etc.
  secret_encrypted text,                        -- smtp password / provider api key, AES-256-GCM (social/crypto.js) — null for 'mock'
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

create table if not exists email_sender_domains (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  domain text not null,
  spf_verified boolean not null default false,
  dkim_selector text,
  dkim_verified boolean not null default false,
  dmarc_verified boolean not null default false,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, domain)
);

alter table tenants add column if not exists marketing_postal_address text; -- CAN-SPAM/GDPR/DPDP-required physical address footer

create table if not exists email_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  subject text not null default '',
  preheader text,
  blocks jsonb not null default '[]'::jsonb,  -- ordered array of { type, ...fields } — lib/emailRenderer.js's BLOCK_TYPES
  brand jsonb not null default '{}'::jsonb,   -- { logoUrl, primaryColor, fontFamily } — falls back to tenant-level defaults when unset
  created_by uuid references users(id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_email_templates_tenant on email_templates(tenant_id);

create table if not exists email_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  template_id uuid references email_templates(id) on delete set null,
  segment_id uuid references audience_segments(id) on delete set null,
  subject text,    -- optional override; null means "use the template's own subject" (routes/marketingEmail.js's send handler)
  preheader text,
  from_name text,
  from_email text,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'completed', 'failed', 'canceled')),
  send_mode text not null default 'immediate' check (send_mode in ('immediate', 'scheduled')),
  scheduled_at timestamptz,
  timezone text not null default 'UTC',
  ab_test jsonb,  -- { variants: [{ key, subject }], splitPercent, winnerMetric: 'opens'|'clicks', decisionAt, winnerKey } or null
  total_recipients int not null default 0,
  sent_count int not null default 0,
  delivered_count int not null default 0,
  opened_count int not null default 0,
  clicked_count int not null default 0,
  bounced_count int not null default 0,
  complained_count int not null default 0,
  unsubscribed_count int not null default 0,
  created_by uuid references users(id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_email_campaigns_tenant on email_campaigns(tenant_id, status);

create table if not exists email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references email_campaigns(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  email text not null,
  variant text,  -- A/B variant key, null outside an A/B test
  status text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'failed', 'unsubscribed', 'suppressed')),
  external_message_id text,
  error text,
  queued_at timestamptz,
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  bounced_at timestamptz,
  attempts int not null default 0,
  unique (campaign_id, contact_id)
);
create index if not exists idx_email_campaign_recipients_campaign on email_campaign_recipients(campaign_id, status);
create index if not exists idx_email_campaign_recipients_tenant on email_campaign_recipients(tenant_id);
create index if not exists idx_email_campaign_recipients_msg on email_campaign_recipients(external_message_id);

-- Full per-recipient event log (task brief: "per-recipient event log") —
-- email_campaign_recipients.status is the current state; this is the
-- append-only history behind it (a recipient can open 3 times, click 2
-- different links — the status column can't hold that, this table does).
create table if not exists email_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references email_campaigns(id) on delete cascade,
  recipient_id uuid not null references email_campaign_recipients(id) on delete cascade,
  event_type text not null check (event_type in ('sent', 'delivered', 'open', 'click', 'bounce', 'complaint', 'unsubscribe', 'failed')),
  url text,       -- the destination url, for 'click' events
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_email_events_campaign on email_events(campaign_id, event_type);
create index if not exists idx_email_events_recipient on email_events(recipient_id);

-- Same shape as migrations/012's recompute_whatsapp_campaign_counts —
-- one atomic re-derivation of the campaign's rollup counts + status from
-- its recipients, called after every recipient status write (worker
-- completion, webhook-driven open/click/bounce), so the counts can never
-- drift out of sync with the rows they're summarizing.
create or replace function recompute_email_campaign_counts(p_campaign_id uuid)
returns void
language plpgsql
as $$
begin
  update email_campaigns c
  set sent_count = s.sent_count,
      delivered_count = s.delivered_count,
      opened_count = s.opened_count,
      clicked_count = s.clicked_count,
      bounced_count = s.bounced_count,
      complained_count = s.complained_count,
      unsubscribed_count = s.unsubscribed_count,
      status = case
        when s.pending_count = 0 then
          case when s.failed_count > 0 and s.failed_count = s.total then 'failed' else 'completed' end
        else c.status
      end
  from (
    select
      count(*) filter (where status in ('sent', 'delivered', 'opened', 'clicked')) as sent_count,
      count(*) filter (where status in ('delivered', 'opened', 'clicked')) as delivered_count,
      count(*) filter (where status in ('opened', 'clicked')) as opened_count,
      count(*) filter (where status = 'clicked') as clicked_count,
      count(*) filter (where status = 'bounced') as bounced_count,
      count(*) filter (where status = 'complained') as complained_count,
      count(*) filter (where status = 'unsubscribed') as unsubscribed_count,
      count(*) filter (where status = 'failed') as failed_count,
      count(*) filter (where status = 'pending') as pending_count,
      count(*) as total
    from email_campaign_recipients where campaign_id = p_campaign_id
  ) s
  where c.id = p_campaign_id;
end;
$$;

-- Marks a recipient's current status from a tracking event (open pixel
-- hit, click redirect, or a provider webhook for bounce/complaint) —
-- NOT a straight overwrite: status only ever moves forward through
-- sent < delivered < opened < clicked (an open after a click is still
-- "clicked", not demoted back to "opened"), matching
-- mark_whatsapp_recipient_status's same forward-only reasoning
-- (migrations/012) for exactly the same reason — webhooks/pixel hits can
-- arrive out of order or more than once.
create or replace function mark_email_recipient_event(p_recipient_id uuid, p_event_type text, p_url text default null)
returns void
language plpgsql
as $$
declare
  v_campaign_id uuid;
  v_tenant_id uuid;
  v_rank_order text[] := array['pending', 'sent', 'delivered', 'opened', 'clicked'];
  v_new_status text;
  v_current_status text;
begin
  select campaign_id, tenant_id, status into v_campaign_id, v_tenant_id, v_current_status
  from email_campaign_recipients where id = p_recipient_id;
  if v_campaign_id is null then return; end if;

  v_new_status := case p_event_type when 'open' then 'opened' when 'click' then 'clicked' else null end;

  if v_new_status is not null and array_position(v_rank_order, v_new_status) > coalesce(array_position(v_rank_order, v_current_status), 0) then
    update email_campaign_recipients set status = v_new_status,
      opened_at = case when p_event_type = 'open' and opened_at is null then now() else opened_at end,
      clicked_at = case when p_event_type = 'click' and clicked_at is null then now() else clicked_at end
    where id = p_recipient_id;
  elsif p_event_type in ('bounce', 'complaint', 'unsubscribe') then
    update email_campaign_recipients set status = case p_event_type when 'bounce' then 'bounced' when 'complaint' then 'complained' else 'unsubscribed' end,
      bounced_at = case when p_event_type = 'bounce' then now() else bounced_at end
    where id = p_recipient_id;
  end if;

  insert into email_events (tenant_id, campaign_id, recipient_id, event_type, url)
  values (v_tenant_id, v_campaign_id, p_recipient_id, case p_event_type when 'bounce' then 'bounce' when 'complaint' then 'complaint' when 'unsubscribe' then 'unsubscribe' else p_event_type end, p_url);

  perform recompute_email_campaign_counts(v_campaign_id);
end;
$$;

-- Same optimistic-concurrency trigger function migrations/023 defined —
-- reused, not redefined, for every new user-editable record here.
drop trigger if exists trg_email_templates_bump_version on email_templates;
create trigger trg_email_templates_bump_version before update on email_templates
  for each row execute function bump_version();

drop trigger if exists trg_email_campaigns_bump_version on email_campaigns;
create trigger trg_email_campaigns_bump_version before update on email_campaigns
  for each row execute function bump_version();

-- Email sends get their own usage-metering column, following migration
-- 012's exact precedent for whatsapp_broadcast_sends — a marketing email
-- send is its own cost center, distinct from whatsapp_broadcast_sends,
-- ai_generations, etc.
alter table usage_counters add column if not exists email_sends int not null default 0;

create or replace function increment_usage(p_tenant_id uuid, p_period date, p_column text, p_amount int default 1)
returns void
language plpgsql
as $$
begin
  if p_column not in ('whatsapp_messages', 'posts_published', 'ai_generations', 'whatsapp_broadcast_sends', 'email_sends') then
    raise exception 'Unknown usage column: %', p_column;
  end if;
  execute format(
    'insert into usage_counters (tenant_id, period, %1$I) values ($1, $2, $3)
     on conflict (tenant_id, period) do update set %1$I = usage_counters.%1$I + $3',
    p_column
  ) using p_tenant_id, p_period, p_amount;
end;
$$;

grant all privileges on email_provider_connections to service_role;
grant all privileges on email_sender_domains to service_role;
grant all privileges on email_templates to service_role;
grant all privileges on email_campaigns to service_role;
grant all privileges on email_campaign_recipients to service_role;
grant all privileges on email_events to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on function recompute_email_campaign_counts(uuid) to service_role;
grant execute on function mark_email_recipient_event(uuid, text, text) to service_role;
