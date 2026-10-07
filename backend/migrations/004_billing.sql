-- Usage metering per tenant per month — instrumented from day one even
-- while pricing stays flat-rate, so switching to usage-based limits
-- later doesn't require a backfill (see the strategy doc's Pricing &
-- Packaging section for why).
create table if not exists usage_counters (
  tenant_id uuid not null references tenants(id) on delete cascade,
  period date not null,                   -- first day of the month, e.g. 2026-10-01
  whatsapp_messages int not null default 0,
  posts_published int not null default 0,
  primary key (tenant_id, period)
);

create or replace function increment_usage(p_tenant_id uuid, p_period date, p_column text, p_amount int default 1)
returns void
language plpgsql
as $$
begin
  if p_column not in ('whatsapp_messages', 'posts_published') then
    raise exception 'Unknown usage column: %', p_column;
  end if;
  execute format(
    'insert into usage_counters (tenant_id, period, %1$I) values ($1, $2, $3)
     on conflict (tenant_id, period) do update set %1$I = usage_counters.%1$I + $3',
    p_column
  ) using p_tenant_id, p_period, p_amount;
end;
$$;
