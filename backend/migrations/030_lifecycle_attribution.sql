-- Marketing Hub Phase 6: scoring, lifecycle & attribution. Two additive
-- pieces over existing tables — no new "events" table, no second source
-- of truth: engagement scoring and attribution are both computed live
-- from the real event tables Phases 3-5 already write (email_events,
-- lead_form_submissions, workflow_enrollments, whatsapp_campaign_recipients),
-- the same way routes/journeys.js's analytics endpoint computes live from
-- workflow_enrollment_events rather than maintaining a denormalized
-- rollup that could drift. See lib/leadScoring.js and lib/attribution.js.
--
-- A website tracking snippet (benchmark gap F3) is explicitly deferred —
-- flagged as deferrable in the task brief itself; see
-- docs/MARKETING_HUB_AUDIT.md's build plan.

-- The score at which a contact automatically becomes a Marketing
-- Qualified Lead (lib/leadScoring.js's recomputeLeadScore) — tenant-
-- configurable, not a hardcoded number, same reasoning as lead scoring
-- rules themselves being tenant-defined rather than baked in.
alter table tenants add column if not exists marketing_mql_threshold int not null default 50;

-- Per-contact touchpoint lookups (lib/attribution.js's getContactTouchpoints,
-- lib/leadScoring.js's behavioral condition types) need these to avoid a
-- full-table scan on every lookup — none of these three existed yet
-- because nothing before Phase 6 ever queried "every touch THIS contact
-- had", only "every recipient of THIS campaign" (already indexed).
create index if not exists idx_email_campaign_recipients_contact on email_campaign_recipients(contact_id);
create index if not exists idx_workflow_enrollments_contact on workflow_enrollments(contact_id);
create index if not exists idx_whatsapp_campaign_recipients_contact on whatsapp_campaign_recipients(contact_id);
