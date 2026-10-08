-- POST /social/posts accepts an optional client-generated idempotencyKey
-- (routes/social.js). A unique index scoped per tenant means a retried
-- request with the same key is caught by the DB itself, not by a
-- check-then-insert race in application code.
alter table scheduled_posts add column if not exists idempotency_key text;

create unique index if not exists idx_scheduled_posts_tenant_idempotency
  on scheduled_posts (tenant_id, idempotency_key)
  where idempotency_key is not null;
