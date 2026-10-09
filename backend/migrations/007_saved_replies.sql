-- Canned responses for the Inbox — the actual reply workflow (POST
-- /social/inbox/:id/reply, routes/social.js) existed with no fast way to
-- use it: every reply had to be typed from scratch. Tenant-wide, not
-- per-user, so a team shares one set of responses the way a real support
-- inbox (Zoho Desk, HubSpot) does.
create table if not exists saved_replies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null,
  body text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_saved_replies_tenant on saved_replies(tenant_id);
