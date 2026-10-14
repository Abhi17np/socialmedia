-- Per-user email/calendar OAuth connections (Gmail, Microsoft 365) for
-- the Sales Hub — see SALES_HUB_IMPLEMENTATION.md's "Blocked: Email &
-- Calendar" section. This table and its routes are safe to ship with no
-- live OAuth credentials configured: connecting simply isn't offered
-- (isConfigured() gates it, same pattern as social_accounts/ADAPTERS),
-- so no row is ever written until a real provider token exchange
-- actually succeeds. Personal like sales_saved_views (user_id scopes it
-- to the person who connected their own inbox, not a shared tenant
-- resource) — one connection per provider per user.
create table if not exists email_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'microsoft365')),
  email_address text not null,
  access_token text not null,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'revoked')),
  connected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, provider)
);
create index if not exists idx_email_connections_user on email_connections(tenant_id, user_id);
