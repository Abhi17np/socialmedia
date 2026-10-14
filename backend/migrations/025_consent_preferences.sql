-- Marketing Hub Phase 1: consent & preference model, per contact per
-- channel (email/whatsapp/sms), plus a tenant-wide suppression list for
-- hard bounces/complaints/manual suppression that survives even if the
-- contact row is later deleted or re-created, and a global-unsubscribe
-- flag that overrides every channel at once regardless of per-channel
-- status.
--
-- This migration only adds storage. Nothing sends differently until the
-- same commit's backend/lib/consent.js + routes/whatsapp.js changes read
-- it — see docs/MARKETING_HUB_IMPLEMENTATION.md for the enforcement
-- changes made alongside this file.
--
-- After applying against a self-hosted PostgREST setup (not needed
-- against a real Supabase project, where service_role already has
-- blanket schema access): reload PostgREST's schema cache
-- (`kill -SIGUSR1 <postgrest_pid>`, or NOTIFY pgrst, 'reload schema' if
-- the LISTEN/NOTIFY channel is configured) so the new tables/columns are
-- visible over the REST API.

alter table contacts add column if not exists global_opt_out_at timestamptz;

-- An unguessable per-contact token for the public preference-center page
-- (no login — a marketing email/WhatsApp recipient manages their own
-- preferences from a link, the same way every ESP's unsubscribe link
-- works). 128 bits of randomness is the access control; nothing else
-- gates GET/POST on it, by design, same as any transactional-email
-- "manage preferences" link.
alter table contacts add column if not exists preference_token uuid not null default gen_random_uuid();
create unique index if not exists contacts_preference_token_key on contacts(preference_token);

create table if not exists contact_consents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  channel text not null check (channel in ('email', 'whatsapp', 'sms')),
  status text not null check (status in ('opted_in', 'opted_out')),
  source text,                    -- 'manual' | 'import' | 'form' | 'preference_center' | 'api' | 'bounce' | 'complaint'
  opted_in_at timestamptz,
  opted_out_at timestamptz,
  opted_out_reason text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, contact_id, channel)
);
create index if not exists contact_consents_tenant_contact_idx on contact_consents(tenant_id, contact_id);
create index if not exists contact_consents_tenant_channel_status_idx on contact_consents(tenant_id, channel, status);

-- Reuses the bump_version() trigger function migrations/023 already
-- defined (same optimistic-concurrency shape as contacts/companies/deals)
-- rather than inventing a second version-bumping function.
drop trigger if exists trg_contact_consents_bump_version on contact_consents;
create trigger trg_contact_consents_bump_version before update on contact_consents
  for each row execute function bump_version();

-- Suppression is keyed by the raw identifier (email address / phone
-- number), not contact_id, on purpose: a hard-bounce or spam-complaint
-- webhook arrives against an address, which must stay suppressed even if
-- the contact row that address belonged to is later deleted, merged, or
-- re-imported as a "new" contact. identifier is normalized (lowercased
-- email; digits-only phone) by the application layer before insert/
-- lookup, same as the rest of this codebase normalizes rather than
-- relying on the database to.
create table if not exists suppression_list (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  channel text not null check (channel in ('email', 'whatsapp', 'sms')),
  identifier text not null,
  reason text not null check (reason in ('hard_bounce', 'complaint', 'manual', 'unsubscribe_link', 'global_unsubscribe')),
  source text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, channel, identifier)
);
create index if not exists suppression_list_tenant_channel_idx on suppression_list(tenant_id, channel);

grant all privileges on contact_consents to service_role;
grant all privileges on suppression_list to service_role;
grant all privileges on all sequences in schema public to service_role;
