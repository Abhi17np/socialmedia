-- Social Hub: recurring posts (the next item off
-- docs/SOCIAL_HUB_GAPS_AND_ADDITIONS.md's deferred list). A tenant sets
-- a freq + end date once; social/queue.js's maybeFinalize() spawns the
-- next occurrence itself after each one actually publishes — no cron,
-- no separate scheduler, reusing the exact same publish pipeline every
-- other post goes through (so a recurring post is gated by the same
-- approval-workflow/consent/plan-limit checks as a one-off post, not a
-- parallel code path that could drift).
alter table scheduled_posts add column if not exists recurrence jsonb; -- { freq: 'daily'|'weekly'|'monthly', until: ISO date string } or null
alter table scheduled_posts add column if not exists recurrence_series_id uuid; -- shared by every occurrence spawned from the same original post (the root's own id)
create index if not exists idx_scheduled_posts_recurrence_series on scheduled_posts(recurrence_series_id) where recurrence_series_id is not null;
