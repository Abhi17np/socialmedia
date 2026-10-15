-- Social Hub: AI Content Experiment Engine. Deliberately scoped to
-- exactly two variants per experiment (classic A/B) — comparing more
-- than two correctly needs a multiple-comparisons correction this app
-- doesn't implement; see backend/lib/experimentStats.js's header. Each
-- variant IS an existing scheduled_posts row (created and approved
-- through the normal Composer/POST /social/posts path) — this table
-- only groups two already-created posts as an experiment, so nothing
-- about post creation/approval/plan-limits/consent is duplicated here.
create table if not exists content_experiments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  variable text not null check (variable in ('hook', 'caption', 'cta', 'format')),
  -- Audience-normalized engagement rate ((likes+comments+shares) /
  -- follower count at post time) is the only metric this app can
  -- honestly compute today — see experimentStats.js's header on why
  -- audience size, not a raw count, is the statistical denominator.
  metric text not null default 'engagement_rate' check (metric = 'engagement_rate'),
  status text not null default 'running' check (status in ('running', 'decided', 'not_significant', 'insufficient_data', 'cancelled')),
  min_sample_size int not null default 100,
  confidence_level numeric not null default 0.95 check (confidence_level in (0.90, 0.95, 0.99)),
  -- Each variant is evaluated this many hours after ITS OWN publish
  -- time, not a shared calendar date — the honest way to normalize for
  -- different posting times without a deeper "posting conditions"
  -- model this app doesn't have.
  min_observation_hours int not null default 24,
  winner_variant_id uuid,
  z_score numeric,
  p_value numeric,
  decision_note text,
  decided_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_content_experiments_tenant_status on content_experiments(tenant_id, status);

create table if not exists content_experiment_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  experiment_id uuid not null references content_experiments(id) on delete cascade,
  variant_key text not null,
  scheduled_post_id uuid not null references scheduled_posts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id),
  unique (experiment_id, variant_key),
  -- A given post can only ever be one variant of one experiment —
  -- without this, the same post could be silently double-counted
  -- across experiments or reused to game a result.
  unique (scheduled_post_id)
);
create index if not exists idx_content_experiment_variants_experiment on content_experiment_variants(experiment_id);

alter table content_experiments add constraint content_experiments_winner_variant_fkey
  foreign key (winner_variant_id) references content_experiment_variants(id);

grant all privileges on content_experiments to service_role;
grant all privileges on content_experiment_variants to service_role;
grant all privileges on all sequences in schema public to service_role;
