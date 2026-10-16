-- Social Hub: Marketing Decision Simulator. Projects the effect of a
-- single, real, honestly-modelable lever — "what if I post N times as
-- often on this account?" — from the tenant's OWN historical data
-- (lib/decisionSimulator.js's pure math over real post_analytics/
-- analytics_snapshots/scheduled_posts rows), never from a fabricated
-- baseline or an AI guess. Nothing here is computed live-only and
-- thrown away: every run is persisted so a tenant can review what was
-- actually asked and projected, including the real inputs that went
-- into it (for audit/trust, not just the headline numbers).
create table if not exists decision_scenarios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  created_by uuid references users(id),
  frequency_multiplier numeric not null,
  lookback_weeks integer not null,
  baseline jsonb not null,     -- { postsPerWeek, engagementRate, followerGrowthPerWeek: {mean,stddev,weeksOfData}, followers }
  projection jsonb not null,   -- { postsPerWeek, engagementRate, followerGrowthPerWeek: {mean,low,high}, confidence }
  created_at timestamptz not null default now()
);
create index if not exists idx_decision_scenarios_tenant on decision_scenarios(tenant_id);

grant all privileges on decision_scenarios to service_role;
grant all privileges on all sequences in schema public to service_role;
