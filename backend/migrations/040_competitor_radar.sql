-- Social Hub: Competitor Opportunity Radar. Tracks a competitor's
-- PUBLIC account via official, permitted APIs only — never scraping,
-- never the competitor's own credentials:
--   - Instagram: Business Discovery (business_discovery.username(...)),
--     using one of the TENANT's own connected Instagram accounts'
--     existing token — needs pages_read_engagement/instagram_basic/
--     instagram_manage_insights, which every Instagram connection in
--     this app already requests (see social/adapters/instagram.js's
--     SCOPES) — zero new OAuth scope, zero reconnection.
--   - YouTube: channels.list(forHandle=...)/search.list, fully public
--     endpoints, through an existing connected YouTube account's token.
-- Facebook/LinkedIn/Google Business/WhatsApp deliberately have no
-- fetchCompetitor() — see each adapter's own header for the specific,
-- real reason (Facebook's own Page Public Content Access needs Meta
-- Business Verification this app doesn't have; the others have no
-- analogous public-lookup API at all).
create table if not exists tracked_competitors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  platform text not null,
  handle text not null,                   -- IG username / YouTube handle, exactly as entered
  label text,
  viewer_account_id uuid not null references social_accounts(id) on delete cascade, -- which of OUR connected accounts makes the lookup call
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, platform, handle)
);
create index if not exists idx_tracked_competitors_tenant on tracked_competitors(tenant_id);

-- Same shape as analytics_snapshots (migration 002) — one row per
-- metric per day, deliberately not reusing that table directly since
-- these rows are keyed by tracked_competitor_id, not social_account_id,
-- and mixing "our own account" and "a competitor we don't own" rows in
-- one table risked a future query silently including a competitor's
-- numbers in a tenant's own account rollup.
create table if not exists competitor_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  tracked_competitor_id uuid not null references tracked_competitors(id) on delete cascade,
  metric text not null,                   -- 'followers' | 'media_count' | 'posts_in_window' | 'avg_engagement_rate'
  value numeric,
  captured_date date not null,
  unique (tracked_competitor_id, metric, captured_date)
);
create index if not exists idx_competitor_snapshots_competitor on competitor_snapshots(tracked_competitor_id, metric, captured_date);

grant all privileges on tracked_competitors to service_role;
grant all privileges on competitor_snapshots to service_role;
grant all privileges on all sequences in schema public to service_role;
