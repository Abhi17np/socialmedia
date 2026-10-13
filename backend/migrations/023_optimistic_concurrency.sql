-- Optimistic concurrency control for the three main detail-view
-- records. A PATCH request now has to say which version it was
-- editing (loaded from the GET just before); if the row has moved on
-- since, the write is rejected with a conflict instead of silently
-- overwriting whatever the other editor just saved. The trigger does
-- the incrementing so no route can forget it.
alter table contacts add column if not exists version integer not null default 1;
alter table companies add column if not exists version integer not null default 1;
alter table deals add column if not exists version integer not null default 1;

create or replace function bump_version()
returns trigger
language plpgsql
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

drop trigger if exists trg_contacts_bump_version on contacts;
create trigger trg_contacts_bump_version before update on contacts
  for each row execute function bump_version();

drop trigger if exists trg_companies_bump_version on companies;
create trigger trg_companies_bump_version before update on companies
  for each row execute function bump_version();

drop trigger if exists trg_deals_bump_version on deals;
create trigger trg_deals_bump_version before update on deals
  for each row execute function bump_version();
