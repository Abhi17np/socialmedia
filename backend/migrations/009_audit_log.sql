-- Who did what — team changes, billing actions, and account
-- disconnects had no record at all; after the fact there was no way to
-- answer "who removed that teammate" or "who disconnected our Facebook
-- page." Append-only, tenant-scoped like everything else.
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_audit_log_tenant on audit_log(tenant_id, created_at desc);
