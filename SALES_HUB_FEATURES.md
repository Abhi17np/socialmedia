# Sales Hub — Completed Features

A plain summary of what's actually built, working, and tested in the Infopace Sales Hub. For gaps, blockers, and architecture detail, see `SALES_HUB_IMPLEMENTATION.md`.

---

## CRM Records

- **Companies**: create, edit, delete; industry/domain/phone/notes/owner; linked contacts, deals, and activity timeline shown on the company's own detail view.
- **Contacts / Leads**: create, edit; shares the same underlying record as inbound WhatsApp/Instagram/Facebook contacts (no separate "lead" table); job title, lead status, owner, tags, lead score; detail view shows linked company, deals (both as primary contact and as a secondary deal participant), and full activity timeline.
- **Deals**: create, edit, delete; name, amount, currency, expected close date, forecast category, owner, stage; detail view shows company, all linked contacts, stage-change history, and activity timeline.
- **Multi-contact deals**: a deal can have several associated contacts (not just one), with exactly one marked primary. Add/remove contacts from a deal with a role label.
- **Lead scoring**: tenant-configurable rules (has email, has phone, has company, tag match, lead-status match), each worth a point value; score recomputed automatically every time a contact is created or updated.
- **Bulk actions**: add/remove tag, set owner, set lead status, delete — on multi-selected leads/companies.
- **CSV import/export**: companies and contacts; import validates rows, skips duplicates, reports exactly how many were created/skipped/errored; export produces a real CSV of current data.
- **Duplicate detection**: flags contacts sharing a phone/email and companies sharing a name/domain.
- **Custom fields**: per-tenant extra fields on contacts, companies, or deals (text/number/date/boolean/select), enforced on create/update.

## Deal Pipeline

- **Kanban + table views**, with a pipeline selector for tenants running multiple pipelines.
- **Deal cards** show company, contact, owner, and next upcoming activity due date — not just name and amount.
- **Stage headers** show deal count, total value, *and* probability-weighted value per stage.
- **Drag-and-drop stage moves** (kanban) and a stage dropdown (table), both calling the same server-validated move — moving into a "lost" stage requires a reason, which is persisted.
- **Stale-deal flag**: computed per stage's configurable "stale after N days" threshold; resets automatically when a new activity is logged against the deal.
- **Stage editor**: rename/reorder/add/delete stages, set win probability and stale threshold per stage; a stage or pipeline with deals in it can't be deleted.
- **Forecast categories** (Pipeline / Best Case / Commit, Salesforce/HubSpot pattern): set per deal, broken down on the dashboard as a share of total open pipeline.

## Sales Workspace & Activities

- **Per-rep queue**: overdue, due-today, and upcoming activities, pulled from real logged activities, not a mockup.
- **One-click complete**, which updates the record and clears it from the queue immediately.
- **Activity log**: calls, emails, meetings, notes, tasks — loggable against a contact, company, or deal, with due dates and status.

## Global Search

- Searches companies, leads, and deals (not just companies/leads) from one box in the top bar.
- Every result **deep-links directly into that record's own detail view** — clicking a deal from search opens that deal's drawer, correctly switched to its own pipeline, not just the Pipeline tab in general.

## Sequences (Multi-Step Follow-Ups)

- Build a sequence of steps, each with a delay in days and an action: create a follow-up task, or add/remove a tag.
- Enroll any contact into a sequence; pause, resume, or stop an individual enrollment at any time.
- Runs on a persistent server-side schedule (survives a server restart — not a browser timer), with automatic retry-with-backoff and a visible error message if a step fails.
- *Does not send email* — see "Known Limitations" below.

## Automation

- Rules fire on real events: contact created, tag added, deal stage changed, deal won, deal lost.
- Actions: add/remove tag, create a follow-up task, assign an owner.
- **Duplicate-fire guard**: the same rule won't double-execute for the same event within a short window, while still correctly re-firing on a later, legitimate repeat of the same event (e.g. a deal moving through multiple stages).
- **Manual retry**: a failed automation run can be re-executed by hand once the underlying issue (e.g. a misconfigured rule) is fixed.
- Full run history, visible per rule.

## Forecasting & Reporting

- **Dashboard**: revenue (won), open pipeline value, probability-weighted forecast, conversion rate, deals won/lost, overdue activity count — all computed live from actual deal/activity rows for a chosen date range.
- **Forecast by category** panel: open pipeline split into Pipeline / Best Case / Commit.
- **Sales targets**: team or per-rep revenue targets with attainment tracking against real won revenue.
- **Team performance**: won/open deal counts and values, by rep, for the selected period.

## Admin & Governance

- 4-tier role-based access (viewer / member / admin / owner) enforced on every mutating route, not just hidden in the UI.
- **Audit log**: every meaningful Sales Hub action (create, delete, bulk change, etc.) recorded and viewable by admins.
- Sales Hub can be enabled/disabled per tenant independently of other hubs (WhatsApp, Marketing).

## Design & UX

- Dedicated Sales Hub sidebar (Dashboard, Workspace, Pipeline, Companies, Leads, Activities, Sequences, Settings), matching the Infopace design system used elsewhere in the app.
- Every list has loading, empty, and error states — nothing renders blank or crashes silently.
- Every edit action (field save, stage move, bulk action) gives real success/failure feedback tied to an actual server response.

---

## Known Limitations (not built, or built thin)

- **No email or calendar integration.** No Gmail/Outlook connect, no sending email from the CRM, no inbox sync, no meeting scheduling. Genuinely blocked on missing OAuth credentials — not something that can be faked without being dishonest about it.
- **Sequences are task/tag only**, not email — a direct consequence of the above.
- **No pagination** on the main list views yet (fine at small data volumes, will need fixing before real scale).
- **Duplicate detection flags but doesn't merge** two records into one.
- **No saved views** (per-user remembered filters).
- **No concurrent-edit warning** — two people editing the same record at once, last save wins silently.
- **Products / quotes / CPQ**: not built — no confirmed need yet.
- **Multi-currency dashboards**: each deal can store a currency, but dashboard totals currently just sum raw numbers regardless of currency.

See `SALES_HUB_IMPLEMENTATION.md` for full architecture, exact test coverage, and the precise remaining steps for the email/calendar integration once credentials are available.
