-- Phase 10: closes three previously-deferred gaps named in
-- docs/MARKETING_HUB_AUDIT.md's gap matrix.

-- 1) Website tracking snippet (F3). Anonymous visitors are tracked by a
-- client-generated UUID (no server-side PII until they identify
-- themselves, e.g. by submitting a lead form); contact_id is filled in
-- once that happens. No page-content capture, just url/referrer — the
-- minimum a tenant needs to see "this contact visited pricing twice
-- before converting."
create table if not exists site_visitors (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists idx_site_visitors_tenant on site_visitors(tenant_id);
create index if not exists idx_site_visitors_contact on site_visitors(contact_id) where contact_id is not null;

create table if not exists site_visits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  visitor_id uuid not null references site_visitors(id) on delete cascade,
  url text not null,
  referrer text,
  created_at timestamptz not null default now()
);
create index if not exists idx_site_visits_tenant on site_visits(tenant_id, created_at desc);
create index if not exists idx_site_visits_visitor on site_visits(visitor_id);

grant all privileges on site_visitors to service_role;
grant all privileges on site_visits to service_role;

-- 2) True delivery-status journey condition (Phase 7's named gap: "only
-- sends both channels unconditionally, not truly conditionally"). The
-- engine tracks the (channel, recipientId) of the most recent send_*
-- action per enrollment; a later condition node (after a delay, once a
-- webhook/worker has had time to update the real recipient row) reads
-- the actual delivery status from it — see lib/journeyEngine.js.
alter table workflow_enrollments add column if not exists last_message_channel text;
alter table workflow_enrollments add column if not exists last_message_recipient_id uuid;

-- 3) Automatic A/B winner selection. email_campaigns.ab_test already
-- reserved a `winnerKey` slot (migration 027's comment) that nothing
-- ever populated. completed_at (set once, forward-only, the first time
-- every recipient leaves 'pending') is the real "campaign finished
-- sending" timestamp a decision-window sweep measures hours-after from.
alter table email_campaigns add column if not exists completed_at timestamptz;

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
      end,
      completed_at = case when s.pending_count = 0 then coalesce(c.completed_at, now()) else c.completed_at end
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
