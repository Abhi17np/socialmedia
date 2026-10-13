-- Safe, transactional duplicate merging for Contacts and Companies.
-- Everything the loser record is linked to gets reassigned to the
-- survivor — deals, deal_contacts, activities, sequence enrollments —
-- before the loser row is deleted, all inside one Postgres function so
-- a mid-merge failure can't leave relationships half-reassigned (the
-- same atomicity pattern as move_deal_stage() in migration 016).
--
-- Two unique constraints need care when reassigning deal_contacts/
-- sequence_enrollments: if the survivor is ALREADY linked to the same
-- deal/sequence as the loser, blindly reassigning the loser's row
-- would violate unique(deal_id, contact_id) / unique(sequence_id,
-- contact_id). Each function resolves that by keeping the survivor's
-- existing row (promoting it to primary if the loser's was), then
-- deleting the now-redundant loser row, before reassigning whatever's
-- left.

create or replace function merge_contacts(
  p_tenant_id uuid, p_survivor_id uuid, p_loser_id uuid, p_merged_fields jsonb default '{}'::jsonb
)
returns void
language plpgsql
as $$
declare
  v_loser_tags text[];
  v_loser_custom_fields jsonb;
begin
  if p_survivor_id = p_loser_id then
    raise exception 'Cannot merge a contact into itself';
  end if;

  select tags, custom_fields into v_loser_tags, v_loser_custom_fields
  from contacts where id = p_loser_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'Loser contact % not found for tenant %', p_loser_id, p_tenant_id;
  end if;
  if not exists (select 1 from contacts where id = p_survivor_id and tenant_id = p_tenant_id) then
    raise exception 'Survivor contact % not found for tenant %', p_survivor_id, p_tenant_id;
  end if;

  update deals set contact_id = p_survivor_id, updated_at = now()
  where contact_id = p_loser_id and tenant_id = p_tenant_id;

  update sales_activities set contact_id = p_survivor_id
  where contact_id = p_loser_id and tenant_id = p_tenant_id;

  -- deal_contacts: for a deal where BOTH are already linked, the
  -- loser's row must be deleted FIRST (never promote-then-delete —
  -- that leaves two is_primary=true rows for the same deal_id at
  -- once, tripping idx_deal_contacts_one_primary mid-statement), then
  -- the survivor's surviving row is promoted only if the one just
  -- deleted was primary. Finally, whatever's left of the loser's rows
  -- (deals where the survivor had no link at all) gets reassigned.
  with removed_conflicts as (
    delete from deal_contacts lc using deal_contacts sc
    where lc.contact_id = p_loser_id and sc.contact_id = p_survivor_id
      and lc.deal_id = sc.deal_id and lc.tenant_id = p_tenant_id and sc.tenant_id = p_tenant_id
    returning lc.deal_id, lc.is_primary
  )
  update deal_contacts sc set is_primary = true
  from removed_conflicts rc
  where sc.contact_id = p_survivor_id and sc.deal_id = rc.deal_id and sc.tenant_id = p_tenant_id
    and rc.is_primary = true and sc.is_primary = false;

  update deal_contacts set contact_id = p_survivor_id
  where contact_id = p_loser_id and tenant_id = p_tenant_id;

  -- sequence_enrollments: same pattern, no "primary" concept — just
  -- keep the survivor's existing enrollment and drop the loser's.
  delete from sequence_enrollments le using sequence_enrollments se
  where le.contact_id = p_loser_id and se.contact_id = p_survivor_id
    and le.sequence_id = se.sequence_id and le.tenant_id = p_tenant_id and se.tenant_id = p_tenant_id;

  update sequence_enrollments set contact_id = p_survivor_id
  where contact_id = p_loser_id and tenant_id = p_tenant_id;

  update contacts c set
    display_name = coalesce(p_merged_fields->>'displayName', c.display_name),
    phone = coalesce(p_merged_fields->>'phone', c.phone),
    email = coalesce(p_merged_fields->>'email', c.email),
    job_title = coalesce(p_merged_fields->>'jobTitle', c.job_title),
    lead_status = coalesce(p_merged_fields->>'leadStatus', c.lead_status),
    owner_id = coalesce(nullif(p_merged_fields->>'ownerId', '')::uuid, c.owner_id),
    company_id = coalesce(nullif(p_merged_fields->>'companyId', '')::uuid, c.company_id),
    tags = (select coalesce(array_agg(distinct t), '{}') from unnest(c.tags || coalesce(v_loser_tags, '{}')) as t),
    custom_fields = coalesce(v_loser_custom_fields, '{}'::jsonb) || c.custom_fields
  where c.id = p_survivor_id and c.tenant_id = p_tenant_id;

  delete from contacts where id = p_loser_id and tenant_id = p_tenant_id;
end;
$$;

create or replace function merge_companies(
  p_tenant_id uuid, p_survivor_id uuid, p_loser_id uuid, p_merged_fields jsonb default '{}'::jsonb
)
returns void
language plpgsql
as $$
declare
  v_loser_custom_fields jsonb;
begin
  if p_survivor_id = p_loser_id then
    raise exception 'Cannot merge a company into itself';
  end if;

  select custom_fields into v_loser_custom_fields from companies where id = p_loser_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'Loser company % not found for tenant %', p_loser_id, p_tenant_id;
  end if;
  if not exists (select 1 from companies where id = p_survivor_id and tenant_id = p_tenant_id) then
    raise exception 'Survivor company % not found for tenant %', p_survivor_id, p_tenant_id;
  end if;

  update contacts set company_id = p_survivor_id
  where company_id = p_loser_id and tenant_id = p_tenant_id;

  update deals set company_id = p_survivor_id, updated_at = now()
  where company_id = p_loser_id and tenant_id = p_tenant_id;

  update sales_activities set company_id = p_survivor_id
  where company_id = p_loser_id and tenant_id = p_tenant_id;

  update companies c set
    name = coalesce(p_merged_fields->>'name', c.name),
    domain = coalesce(p_merged_fields->>'domain', c.domain),
    industry = coalesce(p_merged_fields->>'industry', c.industry),
    size = coalesce(p_merged_fields->>'size', c.size),
    phone = coalesce(p_merged_fields->>'phone', c.phone),
    address = coalesce(p_merged_fields->>'address', c.address),
    notes = coalesce(p_merged_fields->>'notes', c.notes),
    owner_id = coalesce(nullif(p_merged_fields->>'ownerId', '')::uuid, c.owner_id),
    custom_fields = coalesce(v_loser_custom_fields, '{}'::jsonb) || c.custom_fields,
    updated_at = now()
  where c.id = p_survivor_id and c.tenant_id = p_tenant_id;

  delete from companies where id = p_loser_id and tenant_id = p_tenant_id;
end;
$$;
