-- Small addendum to 018's sequence_enrollments: a place to record why
-- an enrollment's most recent step failed, so "why didn't this
-- contact get their task" is answerable from the data (same reasoning
-- as automation_runs.error for rule-based automation) without a whole
-- separate per-step run log table.
alter table sequence_enrollments add column if not exists last_error text;
