-- Social Hub: Revenue Attribution. Reuses Marketing Hub's existing
-- multi-touch attribution engine (lib/attribution.js) end to end —
-- distributeCredit()/getAttributionReport() are already channel-
-- agnostic, so adding a 5th "social" channel needed zero changes
-- there. What this migration adds is the missing plumbing that engine
-- needs to ever SEE a social-sourced touchpoint at all:
--
-- 1) tracked_links — a tenant creates one of these for a destination
--    URL (e.g. a landing page), gets back a short redirect URL to paste
--    into a social post's content, and the redirect appends real UTM
--    params (utm_source=<platform>, utm_medium=social,
--    utm_content=<this link's own id>) before sending the browser on —
--    the honest, minimal version of "tracked links" this app can
--    deliver without a full link-shortener product.
create table if not exists tracked_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  destination_url text not null,
  platform text,
  label text,
  scheduled_post_id uuid references scheduled_posts(id) on delete set null,
  click_count int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_tracked_links_tenant on tracked_links(tenant_id);

-- 2) UTM columns on site_visits (migration 033) — until now this table
-- stored the raw pageview URL as an opaque string with no structured
-- UTM fields, so nothing could ever query "which visits came from a
-- social-tagged link" without re-parsing every url at read time, for
-- every read. Parsed once, server-side, at ingest (routes/tracking.js,
-- lib/trackedLinks.js's parseUtmParams) — existing rows before this
-- migration simply have all five null, which is correct: those really
-- do carry no known UTM source, not an unknown one.
alter table site_visits add column if not exists utm_source text;
alter table site_visits add column if not exists utm_medium text;
alter table site_visits add column if not exists utm_campaign text;
alter table site_visits add column if not exists utm_content text;
alter table site_visits add column if not exists utm_term text;
create index if not exists idx_site_visits_utm_medium on site_visits(tenant_id, utm_medium) where utm_medium is not null;

grant all privileges on tracked_links to service_role;
grant all privileges on all sequences in schema public to service_role;
