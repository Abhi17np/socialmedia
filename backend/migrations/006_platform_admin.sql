-- Infopace's own internal ops login — deliberately separate from
-- tenants/users. A platform admin is not scoped to any tenant and must
-- never be reachable through a tenant's JWT; see lib/auth.js's
-- signPlatformToken() (a distinct `scope: 'platform'` claim, not a
-- tenantId) and middleware/platform.js's requirePlatformAdmin.
create table if not exists platform_admins (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz default now()
);
