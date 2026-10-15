'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Siren, CheckCircle2, ExternalLink, Sparkles } from 'lucide-react';
import { SOCIAL_API_BASE } from './api';
import { API_BASE } from '../apiBase';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, Chip, Banner, EmptyState, Skeleton
} from '../ui';
import { channelLabel } from '../ui/channel';
import { atLeast } from '../roleRank';

/*
 * Crisis Intelligence (migration 041) — alerts are created ONLY by the
 * backend's real surge-detection sweep (social/crisisSweep.js): a
 * genuine, trailing-baseline z-score anomaly in how many DMs/mentions a
 * tenant's own connected accounts are receiving, never an AI judgment
 * call and never open-web listening (this app has none — see
 * docs/SOCIAL_HUB_GAPS_AND_ADDITIONS.md). This page is purely the
 * human-decides lifecycle around whatever the sweep found: look at the
 * real evidence, optionally ask for an AI summary, acknowledge, resolve.
 */

const STATUS_TONE = { open: 'danger', acknowledged: 'warning', resolved: 'success' };
const STATUS_LABEL = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved' };

function fmtWindow(alert) {
  const start = new Date(alert.window_start);
  const end = new Date(alert.window_end);
  return `${start.toLocaleString()} – ${end.toLocaleTimeString()}`;
}

function SummaryPanel({ alertId, authFetch }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const analyze = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/ai/crisis-alerts/${alertId}/summarize`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not summarize this alert.');
      setSummary(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2.5 pt-2.5 border-t border-hairline">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted">AI summary</span>
        <Button size="sm" variant="ghost" icon={Sparkles} loading={loading} onClick={analyze}>
          {summary ? 'Re-summarize' : 'Summarize'}
        </Button>
      </div>
      {error && <p className="text-[11px] text-danger mt-1">{error}</p>}
      {summary && (
        <div className="mt-2 flex flex-col gap-2">
          {summary.note && <p className="text-[11px] text-subtle italic">{summary.note}</p>}
          {summary.themes.map((t, i) => (
            <div key={i} className="rounded-ui border border-hairline bg-sunken/40 p-2 text-[11px]">
              <div className="font-semibold text-ink">{t.theme}</div>
              <p className="text-muted mt-1">{t.evidence.length} message{t.evidence.length === 1 ? '' : 's'} cited below.</p>
              <div className="flex flex-col gap-1 mt-1.5">
                {t.evidence.map((m, j) => (
                  <div key={j} className="flex items-start gap-1.5 text-subtle">
                    <span className="shrink-0">[{channelLabel(m.platform)}]</span>
                    <span className="truncate">{m.text}</span>
                    {m.url && <a href={m.url} target="_blank" rel="noreferrer" className="shrink-0 text-brand"><ExternalLink size={10} /></a>}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {summary.priorityMessages.length > 0 && (
            <div className="rounded-ui border border-danger-border bg-danger-subtle/40 p-2 text-[11px]">
              <div className="font-semibold text-danger mb-1">Needs a reply soonest</div>
              {summary.priorityMessages.map((m, i) => (
                <div key={i} className="text-subtle truncate">[{channelLabel(m.platform)}] {m.text}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EvidenceList({ messages }) {
  if (!messages) return <Skeleton className="h-9 mt-2.5" />;
  return (
    <div className="mt-2.5 max-h-48 overflow-y-auto flex flex-col gap-1 rounded-ui border border-hairline bg-sunken/40 p-2">
      {messages.map((m) => (
        <div key={`${m.source}-${m.id}`} className="text-[11px] flex items-start gap-1.5">
          <span className="text-subtle shrink-0">[{channelLabel(m.platform)}]</span>
          <span className="text-muted shrink-0">{m.author || 'unknown'}:</span>
          <span className="text-ink truncate flex-1">{m.text || '(no text)'}</span>
          {m.url && <a href={m.url} target="_blank" rel="noreferrer" className="shrink-0 text-brand"><ExternalLink size={10} /></a>}
        </div>
      ))}
    </div>
  );
}

function AlertCard({ alert, detail, canAcknowledge, canResolve, onAcknowledge, onResolve, authFetch }) {
  return (
    <Panel className="p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-ink">{alert.message_count} inbound messages in 3 hours</span>
            <Chip tone={STATUS_TONE[alert.status]}>{STATUS_LABEL[alert.status]}</Chip>
          </div>
          <p className="text-[11px] text-subtle mt-0.5">
            {fmtWindow(alert)} · baseline ~{Number(alert.baseline_mean).toFixed(1)}
            {alert.z_score !== null && ` · z=${Number(alert.z_score).toFixed(1)}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {alert.status === 'open' && canAcknowledge && (
            <Button size="sm" variant="ghost" onClick={() => onAcknowledge(alert)}>Acknowledge</Button>
          )}
          {alert.status !== 'resolved' && canResolve && (
            <Button size="sm" variant="ghost" icon={CheckCircle2} onClick={() => onResolve(alert)}>Resolve</Button>
          )}
        </div>
      </div>

      <EvidenceList messages={detail?.messages} />
      <SummaryPanel alertId={alert.id} authFetch={authFetch} />
    </Panel>
  );
}

function CrisisAlerts({ authFetch, role }) {
  const canAcknowledge = atLeast(role, 'member');
  const canResolve = atLeast(role, 'admin');
  const [alerts, setAlerts] = useState(null);
  const [details, setDetails] = useState({}); // id -> { messages }
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadDetail = async (id) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/crisis-alerts/${id}`);
      const data = await res.json();
      if (res.ok) setDetails((prev) => ({ ...prev, [id]: data }));
    } catch {
      // a failed detail fetch just leaves that card without evidence — the list itself still renders
    }
  };

  const load = async () => {
    setRefreshing(true);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/crisis-alerts`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load crisis alerts.');
      setAlerts(data.alerts || []);
      (data.alerts || []).forEach((a) => loadDetail(a.id));
      setError(null);
    } catch (err) {
      setError(err.message);
      setAlerts([]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (alert, action) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/crisis-alerts/${alert.id}/${action}`, { method: 'PATCH' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Could not ${action} this alert.`);
      setAlerts((prev) => prev.map((a) => (a.id === alert.id ? data.alert : a)));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Page>
      <PageBar
        title="Crisis Alerts"
        count={alerts === null ? undefined : `${alerts.length} alert${alerts.length === 1 ? '' : 's'}`}
        actions={<IconButton icon={RefreshCw} label="Refresh" onClick={load} className={refreshing ? 'animate-[spin_1s_linear_infinite]' : undefined} />}
      />

      <PageBody width="narrow">
        {error && <Banner tone="danger">{error}</Banner>}

        <Banner tone="info" className="mb-0">
          An alert fires only from a real, measured surge in inbound DMs/mentions/comments across your own connected
          accounts, against your own trailing baseline — never from sentiment or an AI guess, and never from open-web
          listening (this app only ever reads your own accounts' data, through official APIs).
        </Banner>

        {alerts === null ? (
          <Panel className="p-4 space-y-3">
            <Skeleton className="h-16" />
          </Panel>
        ) : alerts.length === 0 ? (
          <Panel>
            <EmptyState
              icon={Siren}
              title="No crisis alerts"
              description="This fills in automatically if inbound DMs/mentions/comments across your connected accounts ever surge well above your normal volume."
            />
          </Panel>
        ) : (
          <div className="flex flex-col gap-3">
            {alerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                detail={details[alert.id]}
                canAcknowledge={canAcknowledge}
                canResolve={canResolve}
                onAcknowledge={(a) => act(a, 'acknowledge')}
                onResolve={(a) => act(a, 'resolve')}
                authFetch={authFetch}
              />
            ))}
          </div>
        )}
      </PageBody>
    </Page>
  );
}

export default CrisisAlerts;
