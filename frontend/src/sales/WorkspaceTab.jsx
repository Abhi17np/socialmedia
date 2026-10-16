'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Flame, Phone, Mail, Calendar, StickyNote, CheckSquare } from 'lucide-react';
import { Panel, PanelHeader, Banner, Skeleton, EmptyState, Chip } from '../ui';
import { money, errorMessage } from './format';

const ACTIVITY_ICON = { call: Phone, email: Mail, meeting: Calendar, note: StickyNote, task: CheckSquare };

// A full EmptyState (icon + title + description) per section looks
// fine once, but four of them stacked — the common case, since most
// days a rep clears most sections — turns the workspace into mostly
// dead space. One compact line reads as "nothing here" just as
// clearly without the padding and decoration.
function CompactEmpty({ children }) {
  return <p className="px-4 py-3 text-xs text-muted">{children}</p>;
}

function ActivityRow({ activity, onToggle }) {
  const Icon = ACTIVITY_ICON[activity.type] || StickyNote;
  return (
    <div className="px-4 py-2.5 border-b border-hairline last:border-b-0 flex items-start gap-3 hover:bg-canvas transition-colors">
      <span className="w-7 h-7 rounded-ui bg-canvas border border-hairline flex items-center justify-center shrink-0 text-muted"><Icon size={14} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-ink">{activity.subject}</div>
        {activity.due_at && <div className="text-[11px] text-muted mt-0.5">{new Date(activity.due_at).toLocaleString()}</div>}
      </div>
      <button onClick={() => onToggle(activity)} className="shrink-0">
        <Chip tone="neutral">Mark done</Chip>
      </button>
    </div>
  );
}

/**
 * The daily workspace a rep actually works from — every section here is
 * a real rollup from GET /sales/workspace, scoped to the signed-in
 * user: their own overdue/due-today/upcoming activities and their own
 * stale open deals (Pipedrive's "rotting" pattern).
 */
function WorkspaceTab({ authFetch, SALES_API_BASE }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    authFetch(`${SALES_API_BASE}/workspace`)
      .then((r) => r.json())
      .then((d) => { if (d.error) throw new Error(d.error); setData(d); })
      .catch((e) => setError(e.message));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleComplete = async (activity) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/activities/${activity.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) });
      const result = await res.json();
      if (!res.ok) throw new Error(errorMessage(result, 'Could not update activity.'));
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (data === null) return <Skeleton className="h-64" />;

  const allClear = data.overdueActivities.length === 0 && data.dueTodayActivities.length === 0
    && data.upcomingActivities.length === 0 && data.staleDeals.length === 0;

  if (allClear) {
    return (
      <>
        {error && <Banner tone="danger">{error}</Banner>}
        <EmptyState icon={CheckCircle2} title="You're all caught up" description="No overdue, due-today or upcoming follow-ups, and no deals going stale." />
      </>
    );
  }

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}

      <Panel className="overflow-hidden">
        <PanelHeader title="Overdue" meta={`${data.overdueActivities.length} past due`} />
        {data.overdueActivities.length === 0 ? (
          <CompactEmpty>Nothing overdue.</CompactEmpty>
        ) : (
          data.overdueActivities.map((a) => <ActivityRow key={a.id} activity={a} onToggle={toggleComplete} />)
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader title="Due today" meta={`${data.dueTodayActivities.length} today`} />
        {data.dueTodayActivities.length === 0 ? (
          <CompactEmpty>Nothing due today.</CompactEmpty>
        ) : (
          data.dueTodayActivities.map((a) => <ActivityRow key={a.id} activity={a} onToggle={toggleComplete} />)
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader title="Upcoming (next 7 days)" meta={`${data.upcomingActivities.length} scheduled`} />
        {data.upcomingActivities.length === 0 ? (
          <CompactEmpty>Nothing scheduled in the next 7 days.</CompactEmpty>
        ) : (
          data.upcomingActivities.map((a) => <ActivityRow key={a.id} activity={a} onToggle={toggleComplete} />)
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader title="Your stale deals" meta={`${data.staleDeals.length} need attention`} />
        {data.staleDeals.length === 0 ? (
          <CompactEmpty>No open deals going stale.</CompactEmpty>
        ) : (
          <div>
            {data.staleDeals.map((d) => (
              <div key={d.id} className="px-4 py-2.5 border-b border-hairline last:border-b-0 flex items-center justify-between hover:bg-canvas transition-colors">
                <span className="text-xs font-medium text-ink flex items-center gap-2"><Flame size={13} className="text-danger" />{d.name}</span>
                <span className="text-[11px] tabular-nums text-muted">{money(d.amount, d.currency)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

export default WorkspaceTab;
