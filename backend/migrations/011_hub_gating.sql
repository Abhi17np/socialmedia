-- Commercial gate for Sales Hub / Marketing Hub (strategy doc: both Hubs
-- are built in full now, but stay invisible/inaccessible until Social
-- Hub lands its first paying customer — a deliberate, Infopace-side
-- business decision, not something a tenant can self-serve). There is no
-- existing feature-flag column on tenants — plan (free/starter/pro/
-- enterprise) governs usage limits, not feature visibility — so this
-- adds one narrowly for Hub access, settable only via the platform-admin
-- console (routes/platform.js), never by a tenant route.
alter table tenants add column if not exists hubs_enabled jsonb not null default '{"sales": false, "marketing": false}'::jsonb;
