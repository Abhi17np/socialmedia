-- Marketing Hub Phase 2: segmentation upgrade. Adds the one column the
-- v2 AND/OR rule builder needs that didn't already exist
-- (lifecycle_stage — lead_status already existed from Sales Hub), a
-- segment_type discriminator (dynamic segments stay filter_json-driven,
-- exactly as before; static lists get real stored membership), and the
-- membership table for static lists.
--
-- Backward compatible by construction: every existing audience_segments
-- row keeps segment_type='dynamic' and its existing filter_json (the v1
-- shape: {tags, hasPhone, hasEmail, leadStatus, search}) continues to be
-- interpreted exactly as before by backend/lib/audience.js — see
-- backend/lib/segmentCompiler.js's header for the v1/v2 detection rule.
--
-- After applying against a self-hosted PostgREST setup (not needed
-- against a real Supabase project): reload PostgREST's schema cache.

alter table contacts add column if not exists lifecycle_stage text not null default 'subscriber'
  check (lifecycle_stage in ('subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist', 'other'));
create index if not exists idx_contacts_lifecycle_stage on contacts(tenant_id, lifecycle_stage);

alter table audience_segments add column if not exists segment_type text not null default 'dynamic'
  check (segment_type in ('dynamic', 'static'));

create table if not exists segment_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  segment_id uuid not null references audience_segments(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by uuid references users(id),
  unique (segment_id, contact_id)
);
create index if not exists idx_segment_members_segment on segment_members(segment_id);
create index if not exists idx_segment_members_tenant on segment_members(tenant_id);

grant all privileges on segment_members to service_role;
grant all privileges on all sequences in schema public to service_role;
