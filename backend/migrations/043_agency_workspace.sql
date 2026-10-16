-- Social Hub: Agency Workspace. Lets one tenant (the "agency") see a
-- READ-ONLY aggregate rollup — connected accounts, total followers,
-- open interactions, pending-approval posts, open crisis alerts — across
-- other tenants (its "clients") it manages, without logging into each
-- one separately. Mutual, explicit consent only: the CLIENT proposes the
-- link by the agency's tenant slug (already a public-ish identifier,
-- used at signup); the AGENCY must separately approve it before any
-- data is ever shared. Either side can revoke at any time. No raw
-- content (messages, post text) ever crosses this boundary — only
-- counts and sums, computed fresh from the client's own real data on
-- every read, never cached or duplicated into the agency's tenant.
create table if not exists agency_links (
  id uuid primary key default gen_random_uuid(),
  agency_tenant_id uuid not null references tenants(id) on delete cascade,
  client_tenant_id uuid not null references tenants(id) on delete cascade,
  status text not null default 'pending',  -- 'pending' | 'active' | 'revoked'
  proposed_by uuid references users(id),   -- client-side user who proposed it
  approved_by uuid references users(id),   -- agency-side user who approved it
  revoked_by uuid references users(id),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  revoked_at timestamptz,
  check (agency_tenant_id != client_tenant_id),
  unique (agency_tenant_id, client_tenant_id)
);
create index if not exists idx_agency_links_agency on agency_links(agency_tenant_id, status);
create index if not exists idx_agency_links_client on agency_links(client_tenant_id, status);

grant all privileges on agency_links to service_role;
grant all privileges on all sequences in schema public to service_role;
