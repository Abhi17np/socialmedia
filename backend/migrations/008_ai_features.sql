-- AI Assist usage metering (lib/ai.js, routes/ai.js) — every draft call
-- costs real money against Anthropic's API, so it's metered through the
-- same usage_counters/increment_usage machinery as whatsapp_messages and
-- posts_published, not left unbounded.
alter table usage_counters add column if not exists ai_generations int not null default 0;

create or replace function increment_usage(p_tenant_id uuid, p_period date, p_column text, p_amount int default 1)
returns void
language plpgsql
as $$
begin
  if p_column not in ('whatsapp_messages', 'posts_published', 'ai_generations') then
    raise exception 'Unknown usage column: %', p_column;
  end if;
  execute format(
    'insert into usage_counters (tenant_id, period, %1$I) values ($1, $2, $3)
     on conflict (tenant_id, period) do update set %1$I = usage_counters.%1$I + $3',
    p_column
  ) using p_tenant_id, p_period, p_amount;
end;
$$;
