-- Sales targets were compared against won-revenue with no currency of
-- their own, silently assuming every deal (and every target) was in
-- the same currency. Give each target an explicit currency so the
-- dashboard can compute "actual vs target" only from deals that
-- actually share it, instead of summing amounts across currencies.
alter table sales_targets add column if not exists currency text not null default 'INR';
