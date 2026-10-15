-- Social Hub: reliable per-post analytics (closes the gap recorded in
-- docs/SOCIAL_HUB_GAPS_AND_ADDITIONS.md's "What's still deliberately
-- deferred" section — confirmed by an architecture audit that
-- analytics_snapshots is account-level only and scheduled_posts.
-- platform_results is publish-confirmation metadata only, never
-- engagement numbers). Additive: neither of those is touched.
--
-- Shaped like analytics_snapshots (platform/metric/captured_date, one
-- row per day per metric) but scoped to one post on one target account,
-- since a single post can target several accounts/platforms at once
-- and each gets its own independent metric history and own
-- external_post_id.
create table if not exists post_analytics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  scheduled_post_id uuid not null references scheduled_posts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  platform text not null,
  external_post_id text not null,
  metric text not null,
  value numeric,
  captured_date date not null,
  unique (scheduled_post_id, social_account_id, metric, captured_date)
);
create index if not exists idx_post_analytics_tenant on post_analytics(tenant_id);
create index if not exists idx_post_analytics_post on post_analytics(scheduled_post_id);
create index if not exists idx_post_analytics_account on post_analytics(social_account_id, metric, captured_date);

grant all privileges on post_analytics to service_role;
grant all privileges on all sequences in schema public to service_role;
