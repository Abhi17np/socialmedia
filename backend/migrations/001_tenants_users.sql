-- Foundation: tenants + users, replacing the single hardcoded JWT secret
-- and flat data/users.json the old admin-panel code used. Every other
-- table in this app hangs off tenants(id).
create extension if not exists pgcrypto;

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan text not null default 'free',              -- 'free' | 'starter' | 'pro' | 'enterprise'
  razorpay_customer_id text,
  razorpay_subscription_id text,
  subscription_status text not null default 'active', -- 'active' | 'past_due' | 'canceled'
  created_at timestamptz default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text not null,
  password_hash text not null,
  role text not null default 'owner',             -- 'owner' | 'admin' | 'member' | 'viewer'
  created_at timestamptz default now(),
  unique(tenant_id, email)
);

create index if not exists idx_users_email on users(email);
create index if not exists idx_users_tenant on users(tenant_id);

-- Signup creates a tenant AND its owner user; both inserts need to
-- succeed or neither does (a tenant with no owner, or an owner pointing
-- at a half-created tenant, are both broken states). supabase-js's REST
-- client has no multi-statement transaction primitive, so this is a
-- plpgsql function called via .rpc() instead of two separate .insert()
-- calls from Node.
create or replace function create_tenant_with_owner(
  p_tenant_name text, p_tenant_slug text, p_email text, p_password_hash text
)
returns table (tenant_id uuid, user_id uuid)
language plpgsql
as $$
declare
  v_tenant_id uuid;
  v_user_id uuid;
begin
  insert into tenants (name, slug) values (p_tenant_name, p_tenant_slug)
    returning id into v_tenant_id;
  insert into users (tenant_id, email, password_hash, role) values (v_tenant_id, p_email, p_password_hash, 'owner')
    returning id into v_user_id;
  return query select v_tenant_id, v_user_id;
end;
$$;
