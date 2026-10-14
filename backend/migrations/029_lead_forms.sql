-- Marketing Hub Phase 5: lead capture & growth. A tenant builds a lead
-- form (field definitions, consent requirement), hosts it publicly (a
-- GET/POST pair under routes/leadForms.js's publicRouter, keyed by the
-- form's own uuid — no login, no tenant slug needed since ids are
-- globally unique and unguessable), and every real submission resolves
-- or creates a real Sales Hub contact (lead_source='web_form'), captures
-- UTM attribution, optionally gates on double opt-in before the contact
-- is usable for sends, and fires the new 'form_submitted' journey
-- trigger — the second real entry point into Phase 4's journeys besides
-- tag/deal events and email engagement.
--
-- "Landing pages" and a generic API-key-authenticated public lead API
-- are deliberately NOT built this round — see
-- docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 5 entry for the scope
-- decision (a hosted form IS the public lead-capture surface; a
-- standalone page builder and a tenant-facing API-key/credential system
-- are both substantial, separable features with no existing precedent
-- anywhere in this codebase to build on).
--
-- After applying against a self-hosted PostgREST setup (not needed
-- against a real Supabase project): reload PostgREST's schema cache.

create table if not exists lead_forms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text,
  fields jsonb not null default '[]'::jsonb,       -- ordered [{ key, label, type, required, options? }] — lib/leadForms.js's FIELD_TYPES
  consent_required boolean not null default true,  -- gates on double opt-in (confirm_token) before the contact is send-eligible
  consent_text text not null default 'I agree to receive marketing communications.',
  thank_you_message text not null default 'Thanks — we''ll be in touch shortly.',
  redirect_url text,                               -- optional: hosted page redirects here instead of showing thank_you_message
  is_active boolean not null default false,
  submit_count int not null default 0,
  version integer not null default 1,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lead_forms_tenant on lead_forms(tenant_id);

drop trigger if exists trg_lead_forms_bump_version on lead_forms;
create trigger trg_lead_forms_bump_version before update on lead_forms
  for each row execute function bump_version();

create table if not exists lead_form_submissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  form_id uuid not null references lead_forms(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  data jsonb not null default '{}'::jsonb,         -- the raw { [fieldKey]: value } the visitor submitted, kept verbatim for audit/debugging even after mapping onto the contact
  utm_source text, utm_medium text, utm_campaign text, utm_term text, utm_content text,
  ip_address text,
  user_agent text,
  consent_status text not null default 'not_required' check (consent_status in ('not_required', 'pending', 'confirmed')),
  confirm_token text unique,                       -- set only when consent_required; the double opt-in confirmation link's access control, same shape as contacts.preference_token
  confirmed_at timestamptz,
  spam_flagged boolean not null default false,     -- honeypot tripped or similar — kept (not dropped) for visibility, but excluded from contact creation and journey triggers
  created_at timestamptz not null default now()
);
create index if not exists idx_lead_form_submissions_tenant_form on lead_form_submissions(tenant_id, form_id);
create index if not exists idx_lead_form_submissions_contact on lead_form_submissions(contact_id);

grant all privileges on lead_forms to service_role;
grant all privileges on lead_form_submissions to service_role;
grant all privileges on all sequences in schema public to service_role;
