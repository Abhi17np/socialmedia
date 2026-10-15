-- Social Hub: post approval/review workflow (closes the single biggest
-- gap vs. every competitor surveyed — Agorapulse/Sprout/Hootsuite all
-- have a draft-review-approve pipeline; this app let any member schedule
-- directly). Opt-in per tenant via social_require_approval, default
-- false — zero behavior change for a tenant that never turns it on.
alter table tenants add column if not exists social_require_approval boolean not null default false;

alter table scheduled_posts add column if not exists created_by uuid references users(id);
alter table scheduled_posts add column if not exists reviewed_by uuid references users(id);
alter table scheduled_posts add column if not exists reviewed_at timestamptz;
alter table scheduled_posts add column if not exists review_note text;
-- status already accepts arbitrary text (no check constraint) — this
-- migration adds 'pending_review' and 'rejected' as new values a
-- member-created post can hold before/instead of the existing
-- 'pending' | 'publishing' | 'published' | 'failed' lifecycle. The
-- reconciliation sweep (social/scheduler.js) and BullMQ queue only ever
-- look for status = 'pending', so a 'pending_review' post is never
-- enqueued until routes/social.js's approve endpoint flips it.
create index if not exists idx_scheduled_posts_created_by on scheduled_posts(created_by);

-- On-demand AI inbox triage (lib/ai.js's classifyMessage, routes/ai.js's
-- POST /ai/inbox/:id/analyze) — pull-based like every other AI feature
-- in this app, never computed automatically on message arrival.
alter table inbox_messages add column if not exists ai_sentiment text;
alter table inbox_messages add column if not exists ai_urgent boolean;
