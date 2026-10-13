'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, Target } from 'lucide-react';
import { Panel, PanelHeader, Table, Th, Td, Banner, Skeleton, StatStrip, Stat, EmptyState, Input, Avatar } from '../ui';
import { money } from './format';

function monthRange() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { from, to };
}

/**
 * The Sales Hub landing tab — every number here is a real rollup from
 * GET /sales/dashboard (routes/sales.js), computed at request time from
 * actual deals/activities/targets rows. No placeholder metrics.
 */
function DashboardTab({ authFetch, SALES_API_BASE }) {
  const [range, setRange] = useState(monthRange());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    authFetch(`${SALES_API_BASE}/dashboard?from=${range.from}&to=${range.to}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) throw new Error(d.error); setData(d); })
      .catch((e) => setError(e.message));
  };

  useEffect(load, [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}

      <div className="flex items-center gap-2">
        <span className="eyebrow">Period</span>
        <Input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="w-40 h-8" />
        <span className="text-xs text-subtle">to</span>
        <Input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="w-40 h-8" />
      </div>

      {data === null ? (
        <Skeleton className="h-24" />
      ) : (
        <StatStrip>
          <Stat label="Revenue (won)" value={money(data.revenue)} hint="Sum of deals won in this period" />
          <Stat label="Pipeline value" value={money(data.pipelineValue)} hint="Sum of all currently open deals" />
          <Stat label="Weighted forecast" value={money(data.weightedForecast)} hint="Open deals expected to close in this period, weighted by stage probability" />
          <Stat
            label="Conversion rate"
            value={data.conversionRate === null ? '—' : `${Math.round(data.conversionRate * 100)}%`}
            hint="Won / (Won + Lost) in this period"
          />
          <Stat label="Deals won / lost" value={`${data.wonCount} / ${data.lostCount}`} />
          <Stat
            label="Overdue activities"
            value={data.overdueActivitiesCount}
            deltaTone={data.overdueActivitiesCount > 0 ? 'down' : 'neutral'}
          />
        </StatStrip>
      )}

      <Panel className="overflow-hidden">
        <PanelHeader title="Sales targets" meta="Set in Settings → Targets" />
        {data === null ? (
          <div className="p-4"><Skeleton className="h-9" /></div>
        ) : data.targets.length === 0 ? (
          <EmptyState icon={Target} title="No target set for this period" description="An admin can set a revenue target under Settings → Targets." />
        ) : (
          <div className="p-4 flex flex-col gap-3">
            {data.targets.map((t) => {
              const pct = Math.min(100, t.attainmentPct ?? 0);
              return (
                <div key={t.id}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium text-ink">{t.owner_id ? 'Rep target' : 'Team target'}</span>
                    <span className="tabular-nums text-muted">{money(t.actualAmount)} / {money(t.target_amount)} ({t.attainmentPct ?? 0}%)</span>
                  </div>
                  <div className="h-2 rounded-full bg-sunken overflow-hidden">
                    <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader title="Team performance" meta="This period, by deal owner" />
        {data === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : data.teamPerformance.length === 0 ? (
          <EmptyState icon={TrendingUp} title="No owned deals yet" description="Assign deals to an owner to see performance here." />
        ) : (
          <Table>
            <thead><tr><Th>Rep</Th><Th align="right">Won</Th><Th align="right">Won value</Th><Th align="right">Open</Th><Th align="right">Open value</Th></tr></thead>
            <tbody>
              {data.teamPerformance.map((p) => (
                <tr key={p.ownerId} className="hover:bg-canvas transition-colors">
                  <Td><span className="flex items-center gap-2"><Avatar name={p.ownerEmail || '?'} size={22} />{p.ownerEmail || p.ownerId}</span></Td>
                  <Td align="right">{p.wonCount}</Td>
                  <Td align="right">{money(p.wonAmount)}</Td>
                  <Td align="right">{p.openCount}</Td>
                  <Td align="right">{money(p.openValue)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}

export default DashboardTab;
