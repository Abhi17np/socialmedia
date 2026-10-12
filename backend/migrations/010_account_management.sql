-- Password reset + email verification tokens, and the column signup
-- never set. One table for both purposes (distinguished by `purpose`)
-- rather than two near-identical tables — the shape (user, token hash,
-- expiry, single use) is identical either way.
create table if not exists auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  purpose text not null check (purpose in ('password_reset', 'email_verification')),
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_auth_tokens_lookup on auth_tokens(token_hash, purpose) where used_at is null;

alter table users add column if not exists email_verified_at timestamptz;
