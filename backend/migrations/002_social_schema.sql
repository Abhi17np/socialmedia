-- Social Hub core schema, ported from admin-panel's 001-003_social_*.sql
-- with one change throughout: every table carries tenant_id, and `brand`
-- is gone — in admin-panel `brand` was a free-text label used to segment
-- Infopace's own internal accounts; here a tenant IS the segmentation
-- boundary, enforced in the app layer (see backend/middleware/tenant.js),
-- not by a string a caller could spoof.
create table if not exists social_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  platform text not null,                 -- 'facebook' | 'instagram' | 'whatsapp' | 'linkedin' | 'youtube' | 'google_business'
  account_label text,
  external_account_id text,
  access_token text not null,             -- encrypted, see backend/social/crypto.js
  refresh_token text,
  expires_at timestamptz,
  connected_at timestamptz default now(),
  status text default 'active'            -- 'active' | 'expired' | 'revoked'
);
create index if not exists idx_social_accounts_tenant on social_accounts(tenant_id);

create table if not exists scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  content text,
  media_urls text[],
  target_platforms text[] not null,
  target_account_ids uuid[] not null,
  scheduled_at timestamptz not null,
  status text default 'pending',          -- 'pending' | 'publishing' | 'published' | 'failed'
  platform_results jsonb default '{}',
  created_at timestamptz default now()
);
create index if not exists idx_scheduled_posts_tenant_status on scheduled_posts(tenant_id, status, scheduled_at);

-- Same atomic-merge function admin-panel's 002_social_phase2.sql added,
-- needed once BullMQ processes one job per (post, account) pair.
create or replace function merge_platform_result(p_post_id uuid, p_key text, p_result jsonb)
returns void
language sql
as $$
  update scheduled_posts
  set platform_results = coalesce(platform_results, '{}'::jsonb) || jsonb_build_object(p_key, p_result)
  where id = p_post_id;
$$;

create table if not exists mentions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  social_account_id uuid references social_accounts(id),
  contact_id uuid,                        -- filled in by 003_contacts.sql's FK
  platform text not null,
  external_id text not null,
  author text,
  text text,
  url text,
  captured_at timestamptz default now(),
  interaction_status text not null default 'open',  -- 'open' | 'under_review' | 'closed'
  priority text not null default 'medium',          -- 'low' | 'medium' | 'high'
  assigned_to uuid references users(id),
  unique(platform, external_id)
);
create index if not exists idx_mentions_tenant on mentions(tenant_id);
create index if not exists idx_mentions_social_account on mentions(social_account_id);
create index if not exists idx_mentions_status on mentions(interaction_status);

create table if not exists inbox_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  social_account_id uuid references social_accounts(id),
  contact_id uuid,                        -- filled in by 003_contacts.sql's FK
  platform text not null,
  external_thread_id text not null,
  external_message_id text not null,
  sender text,
  message text,
  direction text default 'inbound',       -- 'inbound' | 'outbound'
  status text default 'unread',           -- 'unread' | 'read' | 'replied'
  interaction_status text not null default 'open',
  priority text not null default 'medium',
  assigned_to uuid references users(id),
  received_at timestamptz default now(),
  unique(platform, external_message_id)
);
create index if not exists idx_inbox_tenant on inbox_messages(tenant_id);
create index if not exists idx_inbox_social_account on inbox_messages(social_account_id);
create index if not exists idx_inbox_status on inbox_messages(interaction_status);

create table if not exists analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  social_account_id uuid references social_accounts(id),
  platform text not null,
  metric text not null,
  value numeric,
  captured_date date not null,
  unique(social_account_id, metric, captured_date)
);
create index if not exists idx_analytics_tenant on analytics_snapshots(tenant_id);
create index if not exists idx_analytics_account_metric on analytics_snapshots(social_account_id, metric, captured_date);
