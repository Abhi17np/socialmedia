-- The unification piece: one contact per real person, one identity row
-- per platform they're known under. This is what makes "same person on
-- WhatsApp, Instagram, and Facebook" resolve to one record instead of
-- three strangers (see backend/lib/contacts.js for the resolver that
-- fills contact_id on inbox_messages/mentions at ingestion time).
create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  display_name text,
  phone text,                             -- WhatsApp wa_id / phone number, when known
  email text,
  created_at timestamptz default now()
);
create index if not exists idx_contacts_tenant on contacts(tenant_id);
create index if not exists idx_contacts_tenant_phone on contacts(tenant_id, phone);

create table if not exists contact_identities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,  -- denormalized from contacts, so lookups scope by tenant_id directly (house style — see lib/query.js) instead of a join
  contact_id uuid not null references contacts(id) on delete cascade,
  platform text not null,                 -- 'whatsapp' | 'instagram' | 'facebook'
  external_id text not null,              -- wa_id, IG handle/PSID, FB PSID
  created_at timestamptz default now(),
  unique(tenant_id, platform, external_id) -- same phone number messaging two different tenants is two different contacts, correctly
);
create index if not exists idx_contact_identities_contact on contact_identities(contact_id);
create index if not exists idx_contact_identities_tenant on contact_identities(tenant_id);

alter table inbox_messages
  add constraint inbox_messages_contact_fk foreign key (contact_id) references contacts(id);
alter table mentions
  add constraint mentions_contact_fk foreign key (contact_id) references contacts(id);

create index if not exists idx_inbox_contact on inbox_messages(contact_id);
create index if not exists idx_mentions_contact on mentions(contact_id);

-- Find-or-create, atomic: two webhook deliveries for the same new
-- contact arriving concurrently (realistic — Meta retries webhooks)
-- must not create two contacts for one person. A plpgsql function with
-- its own conflict handling is simpler and safer here than trying to
-- coordinate two separate inserts from Node.
create or replace function resolve_contact(
  p_tenant_id uuid, p_platform text, p_external_id text, p_display_name text
)
returns uuid
language plpgsql
as $$
declare
  v_contact_id uuid;
begin
  select contact_id into v_contact_id from contact_identities
    where tenant_id = p_tenant_id and platform = p_platform and external_id = p_external_id;
  if v_contact_id is not null then
    return v_contact_id;
  end if;

  insert into contacts (tenant_id, display_name) values (p_tenant_id, p_display_name)
    returning id into v_contact_id;

  insert into contact_identities (tenant_id, contact_id, platform, external_id)
    values (p_tenant_id, v_contact_id, p_platform, p_external_id)
    on conflict (tenant_id, platform, external_id) do nothing;

  -- Lost the race after all (another concurrent call inserted first) —
  -- use the winner's contact_id, not the orphaned one we just made.
  select contact_id into v_contact_id from contact_identities
    where tenant_id = p_tenant_id and platform = p_platform and external_id = p_external_id;
  return v_contact_id;
end;
$$;
