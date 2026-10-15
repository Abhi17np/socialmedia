-- Social Hub: Crisis Intelligence. Detects an abnormal SURGE in inbound
-- activity (DMs + mentions/comments) across a tenant's OWN connected
-- accounts — not open-web listening (this app has none; see
-- docs/SOCIAL_HUB_GAPS_AND_ADDITIONS.md's deferred section), and not an
-- AI judgment call. A real statistical anomaly (lib/crisisDetection.js's
-- z-score against a trailing baseline, same rigor as
-- lib/experimentStats.js's two-proportion test) over real inbox_messages/
-- mentions rows this app already collects from every connected platform.
-- An alert is a prompt to go look, with the actual contributing messages
-- shown as evidence — nothing here auto-replies, auto-posts, or notifies
-- anyone outside this app.
create table if not exists crisis_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  window_start timestamptz not null,
  window_end timestamptz not null,
  message_count integer not null,
  baseline_mean numeric not null,
  baseline_stddev numeric not null,
  z_score numeric,                        -- null when baseline_stddev was 0 — see lib/crisisDetection.js's detectSpike()
  status text not null default 'open',    -- 'open' | 'acknowledged' | 'resolved'
  acknowledged_by uuid references users(id),
  acknowledged_at timestamptz,
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_crisis_alerts_tenant on crisis_alerts(tenant_id);
create index if not exists idx_crisis_alerts_tenant_status on crisis_alerts(tenant_id, status);

grant all privileges on crisis_alerts to service_role;
grant all privileges on all sequences in schema public to service_role;
