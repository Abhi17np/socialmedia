# Sales Hub — Implementation Status

Factual record of what exists, what was verified, and what remains. Updated as work progresses — this is not a design document.

## Architecture (verified against the actual code, not assumed)

- **Stack**: Express/Node backend (`backend/`), Next.js App Router frontend (`frontend/`), Postgres via Supabase/PostgREST (`backend/social/db.js`), Redis + BullMQ for queued work (WhatsApp broadcast today).
- **Auth**: JWT (`backend/lib/auth.js`), tenant/role resolved in `middleware/tenant.js` (`requireAuth`, `requireRole`, 4-tier RBAC `viewer < member < admin < owner`). Platform-admin auth is a fully separate system (`middleware/platform.js`).
- **Tenant isolation**: every tenant-scoped query goes through `lib/query.js`'s `scoped()`, which stamps `tenant_id` onto every filter — a route that uses `client.from()` directly on a tenant table instead is the review smell to catch. `test/routes.security.test.js` greps for the specific anti-pattern of mounting `requireHub()` as a blanket `router.use()` instead of per-route.
- **Hub gating**: `tenants.hubs_enabled` jsonb (`sales`/`marketing`), enforced per-route via `requireHub('sales')` in `middleware/hubs.js`. Every Sales route applies it individually (verified: `grep -c "requireHub('sales')" routes/sales.js` matches the route count).
- **Data model**: Sales Hub extends the existing `contacts` spine (`003_contacts.sql`) rather than a parallel "lead" entity — a contact that arrived via inbound WhatsApp and one entered by hand in the CRM are the same row. Core tables: `companies`, `contacts` (+CRM columns), `deal_pipelines`, `deal_stages`, `deals`, `deal_stage_history`, `sales_activities`, `custom_field_definitions`, `lead_scoring_rules`, `sales_targets`, `automation_rules`/`automation_runs` (shared with Marketing Hub's engine).
- **Migrations**: `013_sales_crm.sql` (core), `016_sales_crm_enhancements.sql` (custom fields, lead scoring, stale threshold, lost reason), `017_sales_targets.sql`, `018_sales_hub_stage2.sql` (`deal_contacts` many-to-many + primary-contact partial unique index, `deals.forecast_category`, `sequences`/`sequence_steps`/`sequence_enrollments`), `019_sequence_enrollment_errors.sql` (`sequence_enrollments.last_error`). All applied and integration-tested against a real Postgres/PostgREST stack (`backend/scripts/integration-tests/`, 8 Sales-specific scripts, not part of `npm test` — see that directory's README for why).
- **Frontend**: `frontend/src/sales/` — `SalesHub.jsx` (tab router), `DashboardTab`, `WorkspaceTab`, `PipelineTab` (+ `DealDetailDrawer`), `CompaniesTab`, `ContactsTab` (+ `ContactDetailDrawer`), `SequencesTab`, `SettingsTab` (sub-panels: custom fields, lead scoring, targets, automation, audit log). Shared UI kit in `frontend/src/ui/`. Cross-hub `frontend/src/shell/GlobalSearch.jsx` deep-links into company/contact/deal detail drawers via `?open=<id>`.

## Verified existing functionality (Stage 1, shipped and tested)

| Area | What's real | Verified by |
|---|---|---|
| Dashboard | Revenue/pipeline-value/weighted-forecast/conversion-rate/overdue-count from live deals/activities for a date range; target attainment; team performance by owner | `sales-dashboard.js` integration test (exact numbers asserted against seeded deals) |
| Workspace | Per-user overdue/due-today/upcoming activities; stale deals; mark-done | `sales-dashboard.js` |
| Pipeline | Kanban + table views; stage CRUD (rename/reorder/probability/won/lost/stale-threshold); drag-and-select stage moves call `move_deal_stage()` RPC (atomic update + history insert) | `sales-stage1.js` |
| Lost-reason enforcement | Moving into an `is_lost` stage requires a reason, persisted on the deal | `sales-stage1.js` |
| Stale-deal flag | Computed at query time from `stage.stale_after_days` vs `deal.updated_at`; completing a logged activity against a deal resets it | `sales-stage1.js` |
| Lead scoring | Tenant-configurable rules (has_email/has_phone/has_company/tag_equals/lead_status_equals), recomputed on contact create/update | `sales-lead-scoring.js` |
| Bulk actions / CSV | Contacts: add/remove tag, set owner, set lead status. Companies: set owner, delete. Both: CSV export, CSV import (validates rows, skips duplicates, reports created/skipped/errors), duplicate detection | `sales-bulk-import.js` |
| Custom fields | Per-tenant field definitions (contact/company/deal), wired into create/update so values persist in each record's `custom_fields` jsonb | `sales-custom-fields.js` |
| Automation | `add_tag`/`remove_tag`/`create_task`/`assign_owner` actions, firing on `contact_created`/`contact_tag_added`/`deal_stage_changed`/`deal_won`/`deal_lost`; now manageable from Sales Hub's own Settings (previously only reachable behind Marketing Hub — a real gap, fixed) | `sales-custom-fields.js` |
| Audit log | Real `audit_log` rows surfaced read-only, scoped to `sales.*` actions | `sales-custom-fields.js` |
| Deal detail view | Editable name/amount/close date/forecast category/owner, stage change (reuses lost-reason flow), company display, multi-contact association (add/remove via `deal_contacts`, one primary enforced by partial unique index), stage history, activity timeline, delete | `sales-deal-relationships.js` + Playwright (`ui-check-deal-detail.js`) |
| Contact detail view | Editable display name/phone/email/job title/lead status/owner/tags; lead score; company chip; deals merged from both primary `contact_id` and secondary `deal_contacts` links; activity timeline | Playwright (`ui-check-contact-company-detail.js`) |
| Company detail view (now editable) | Editable name/industry/domain/phone/owner/notes (full-form PATCH, since the backend validates the complete schema); contacts, deals, activity timeline | Playwright (`ui-check-contact-company-detail.js`) |
| Deal cards & stage headers | Kanban cards show company/contact/owner/next-activity-due; stage headers show deal count, total amount, **and** weighted amount (`Σ amount × stage.probability`) | Manual + `sales-deal-relationships.js` (`GET /sales/deals` enrichment) |
| Forecast categories | `deals.forecast_category` (`pipeline`/`best_case`/`commit`/`omitted`), editable from the deal detail view; dashboard "Forecast by category" panel breaks down open pipeline by category as % of total | `sales-deal-relationships.js` (`forecastByCategory` assertion) + Playwright (`ui-check-sequences-forecast.js`) |
| GlobalSearch deep-linking | Companies/Leads/Deals categories all link to `?open=<id>`, which the Pipeline/Companies/Contacts tabs read to open that record's own detail drawer directly (not just the tab); Deals category added with server-side `search`/`pageSize` support | Playwright (`ui-check-global-search-deeplink.js`) |
| Automation idempotency + retry | 10-second time-windowed duplicate-fire guard (`ranRecently()`, deliberately not a DB unique constraint — see reasoning in `lib/automation.js`); manual retry endpoint reconstructs context from a stored run and re-executes | `sales-sequences.js` |
| Sequences (task/tag follow-ups) | Multi-step, delay-based enrollment engine (`create_task`/`add_tag`/`remove_tag` steps only — no `send_email` step, see below); persistent sweep (`sequenceScheduler.js`, not browser timers); pause/resume/stop; failed-step backoff with `last_error` diagnostic; full Settings-equivalent UI (`SequencesTab.jsx`) for CRUD, step authoring, contact enrollment, and enrollment lifecycle control | `sales-sequences.js` (15 assertions) + Playwright (`ui-check-sequences-forecast.js`) |

All 33 backend unit tests, 22 security regression tests, and 8 Sales-specific integration scripts pass as of this doc's last update (see "Test results" below).

## Gap matrix (verified by reading the actual frontend/backend, not assumed)

| Gap | Severity | Status |
|---|---|---|
| No deal detail view in the frontend at all — `GET /sales/deals/:id` exists and returns activities+history, but nothing in the UI ever calls it. Deals are only ever seen as kanban cards or table rows. | **High** — blocked "editable deal detail page" requirement | **Done** — `DealDetailDrawer.jsx` |
| No contact detail view — contacts are only ever a table row with an inline status `<select>`. No way to see a lead's deals/activities or edit anything but lead status from the list. | **High** | **Done** — `ContactDetailDrawer.jsx` |
| Company detail is a read-only summary drawer (name/contacts/deals) — not editable, no activity timeline. | **Medium** | **Done** — editable + activity timeline added to `CompaniesTab.jsx` |
| Deals have one `contact_id` (single FK) — no way to associate multiple contacts with a deal. | **Medium** | **Done** — `deal_contacts` join table, one primary enforced by partial unique index |
| Deal cards (kanban) show only name + amount. No company/contact, no owner, no next activity. Stage headers show count + total but not a *weighted* amount. | **Medium** | **Done** |
| Global search covers companies and leads but not deals, and every result links to the *tab*, not the specific record (no deep link exists to link to, since there's no detail view) | **Medium** | **Done** — Deals category added, all results deep-link via `?open=<id>` |
| No forecast categories (Pipeline/Best Case/Commit/Closed) — only a flat probability-weighted total. | **Medium** | **Done** — `deals.forecast_category` + dashboard breakdown panel |
| Automation has no duplicate-execution guard — nothing currently calls `fireTrigger()` twice for one event, but there's no DB-level safeguard if it ever did. | **Low** | **Done** — time-windowed (`ranRecently()`) guard; deliberately not a DB unique constraint (see `lib/automation.js`) |
| No multi-step sequences (time-delayed follow-ups). | **Medium** | **Done** — task/tag-based sequence engine + `SequencesTab.jsx` |
| Gmail / Microsoft 365 email send, inbox sync, meeting scheduling, reply detection, tracking | **Blocked** | No real OAuth credentials exist in this environment (`GOOGLE_OAUTH_CLIENT_ID`/`SECRET` are present only as empty placeholders in `.env.example`, used today for Google Business/YouTube social-account scopes, not Gmail/Calendar scopes; no Microsoft/Azure app registration exists anywhere in the repo). A separate, already-built one-way SMTP sender (`lib/email.js`, via `nodemailer`) exists for password-reset/verification email, but `SMTP_HOST`/`USER`/`PASS` are also unconfigured in this environment — so even that lower-bar path isn't usable here, and it still couldn't satisfy thread sync/reply detection on its own. See "Blocked: Email & Calendar" below — this is not something safe to fake. |
| Products / line items / quotes / CPQ | **Not started** | No evidence in this codebase of a product catalogue need beyond the generic request; deferred — see reasoning below |
| Saved views (persistent per-user filter/sort state) | **Low** | Deferred — see Definition of Done report |

### Why "sequences" ships as task/tag automation, not email automation

A real multi-step *email* sequence needs a connected mailbox to send from. That's blocked (see below). What's buildable right now, with zero external dependency, is the same step/delay/enrollment/pause-stop machinery HubSpot/Salesforce sequences use, scoped to the two action types this app can already execute for real: creating a follow-up task and tagging a contact. The engine is built so that adding a `send_email` step type later is a config addition, not a rewrite — but no email step ships now, because an email step that doesn't send would be exactly the "fake success message" the brief prohibits.

### Blocked: Email & Calendar

Checked and confirmed:
- `backend/.env.example` lists `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` as empty placeholders, consumed today by `social/adapters/google-business.js` and `social/adapters/youtube.js` — Google Business Profile and YouTube scopes, not Gmail/Calendar scopes. No credential for those scopes exists.
- No Microsoft/Azure/Graph API credential, library, or adapter exists anywhere in the repo.
- This environment has no way to register a new OAuth app (no browser access to Google Cloud Console / Azure Portal, no way to receive a verified redirect).

**What this blocks**: real email send-as-the-rep, inbox/thread sync to CRM records, calendar event creation/sync, reply detection, open/click tracking, and an actual "Connect Gmail/Outlook" button that does anything.

**What is NOT done as a workaround**: no fake "Connected" UI, no simulated send, no mocked thread sync. Building that would violate the brief's explicit prohibition on fake success states and is actively misleading to a future integrator.

**Exact remaining steps for whoever has the credentials**:
1. Create a Google Cloud OAuth 2.0 client (Gmail API + Calendar API scopes: `gmail.send`, `gmail.readonly` or `gmail.modify`, `calendar.events`) and set `GMAIL_OAUTH_CLIENT_ID`/`GMAIL_OAUTH_CLIENT_SECRET` (new env vars — don't reuse the Google Business ones, different scopes/consent screen).
2. Register a Microsoft Entra ID (Azure AD) app with Mail.Send/Mail.Read/Calendars.ReadWrite Graph API permissions; set `MS365_CLIENT_ID`/`MS365_CLIENT_SECRET`/`MS365_TENANT_ID`.
3. Add two new adapters under `backend/social/adapters/` (or a new `backend/sales/adapters/` if keeping Sales-specific OAuth separate from Social's), following the existing `_google-oauth.js` pattern for the Google side.
4. New tables: `sales_email_accounts` (tenant_id, user_id, provider, access_token (encrypted, same pattern as `SOCIAL_TOKEN_ENCRYPTION_KEY`), refresh_token, expires_at, email_address), `sales_emails` (thread_id, message_id, contact_id/deal_id association, direction, sent_at, tracking state).
5. Routes: connect/disconnect (OAuth callback pattern identical to `routes/social.js`'s existing account-connect flow), send, and a webhook or poll-based sync job (reuse the `social/scheduler.js` sweep pattern).
6. Wire the sequence engine's `send_email` step type once (5) exists.

## Progress log

- 2026-10-13: Audit complete, this document created. Beginning Phase 2 (migration 018, deal detail views, forecast categories, sequences).
- 2026-10-13: Migration 018 (`deal_contacts`, `forecast_category`, sequences schema) + 019 (`last_error`) applied and integration-tested. Backend: deal/contact/company detail enrichment, `deal_contacts` CRUD, forecast category, automation idempotency + manual retry, sequences engine (`lib/sequences.js` + `lib/sequenceScheduler.js`) all built and covered by `sales-deal-relationships.js` (9 assertions) and `sales-sequences.js` (15 assertions).
- 2026-10-13: Frontend: `DealDetailDrawer.jsx`, `ContactDetailDrawer.jsx`, editable `CompaniesTab.jsx` detail drawer, enriched deal cards/stage headers (weighted amount), `GlobalSearch.jsx` Deals category + `?open=<id>` deep-linking into all three detail views, `SequencesTab.jsx`, and a dashboard "Forecast by category" panel. All verified against the real backend via Playwright (headless Chromium), not just rendered-without-crashing: field edits confirmed to persist across a hard reload, not just update in-memory state. One real bug caught and fixed this way — `CompaniesTab.jsx`'s save payload included an empty `size` field, which failed the backend's `z.enum(...).optional()` validation and silently rejected the *entire* PATCH (including unrelated field edits) until fixed to omit it when unset.
- 2026-10-13: Email/Calendar blocker re-confirmed unchanged (no new OAuth credentials appeared in the environment); also checked `lib/email.js`, a separate pre-existing one-way SMTP sender used for password-reset emails — not usable for this either, since `SMTP_HOST`/`USER`/`PASS` are also unconfigured here, and it couldn't satisfy reply-detection/thread-sync on its own regardless. No new code written for this blocker; see "Blocked: Email & Calendar" for the unchanged remaining steps.
