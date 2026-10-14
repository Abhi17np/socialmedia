-- Marketing Hub Phase 7: SMS + multichannel fallback. Same provider-
-- abstraction shape as migrations/027_email_marketing.sql (one
-- connection per tenant, secret encrypted via social/crypto.js, falls
-- back to a mock provider). SMS has no HTML/blocks — a campaign body is
-- plain text with the same {{field|fallback}} merge tags
-- lib/emailRenderer.js's applyMergeTags() already implements, reused
-- as-is rather than re-invented. "Multichannel fallback" is NOT a new
-- primitive: a journey already composes send_whatsapp -> delay ->
-- condition -> send_sms with the condition/delay nodes Phase 4 built;
-- see docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 7 entry.
--
-- After applying against a self-hosted PostgREST setup: reload
-- PostgREST's schema cache.

create table if not exists sms_provider_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null check (provider in ('mock', 'twilio', 'msg91')),
  from_number text not null,          -- Twilio sender number, or MSG91 sender id (6-char alphanumeric, India DLT)
  config jsonb not null default '{}'::jsonb,   -- non-secret: account_sid (twilio), dlt_entity_id/dlt_template_id (msg91/India TRAI compliance)
  secret_encrypted text,               -- twilio auth token / msg91 api key, AES-256-GCM
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

create table if not exists sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  body text not null,                  -- plain text, merge tags only — no HTML
  segment_id uuid references audience_segments(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'sending', 'completed', 'failed', 'canceled')),
  total_recipients int not null default 0,
  sent_count int not null default 0,
  failed_count int not null default 0,
  created_by uuid references users(id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sms_campaigns_tenant on sms_campaigns(tenant_id);

drop trigger if exists trg_sms_campaigns_bump_version on sms_campaigns;
create trigger trg_sms_campaigns_bump_version before update on sms_campaigns
  for each row execute function bump_version();

create table if not exists sms_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references sms_campaigns(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  phone text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'failed', 'suppressed')),
  external_message_id text,
  error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  attempts int not null default 0,
  unique (campaign_id, contact_id)
);
create index if not exists idx_sms_campaign_recipients_campaign on sms_campaign_recipients(campaign_id, status);
create index if not exists idx_sms_campaign_recipients_contact on sms_campaign_recipients(contact_id);

-- Same forward-only status-advancement reasoning as
-- recompute_whatsapp_campaign_counts/recompute_email_campaign_counts —
-- a delivery webhook can arrive out of order or more than once.
create or replace function recompute_sms_campaign_counts(p_campaign_id uuid)
returns void
language plpgsql
as $$
declare
  v_total int; v_sent int; v_failed int; v_pending int;
begin
  select count(*), count(*) filter (where status in ('sent','delivered')), count(*) filter (where status = 'failed'), count(*) filter (where status = 'pending')
  into v_total, v_sent, v_failed, v_pending
  from sms_campaign_recipients where campaign_id = p_campaign_id;

  update sms_campaigns set
    total_recipients = v_total, sent_count = v_sent, failed_count = v_failed,
    status = case when v_pending = 0 and status = 'sending' then (case when v_failed = v_total and v_total > 0 then 'failed' else 'completed' end) else status end,
    updated_at = now()
  where id = p_campaign_id;
end;
$$;

alter table usage_counters add column if not exists sms_sends int not null default 0;

create or replace function increment_usage(p_tenant_id uuid, p_period date, p_column text, p_amount int default 1)
returns void
language plpgsql
as $$
begin
  if p_column not in ('whatsapp_messages', 'posts_published', 'ai_generations', 'whatsapp_broadcast_sends', 'email_sends', 'sms_sends') then
    raise exception 'Unknown usage column: %', p_column;
  end if;
  execute format(
    'insert into usage_counters (tenant_id, period, %1$I) values ($1, $2, $3)
     on conflict (tenant_id, period) do update set %1$I = usage_counters.%1$I + $3',
    p_column
  ) using p_tenant_id, p_period, p_amount;
end;
$$;

grant all privileges on sms_provider_connections to service_role;
grant all privileges on sms_campaigns to service_role;
grant all privileges on sms_campaign_recipients to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on function recompute_sms_campaign_counts(uuid) to service_role;
