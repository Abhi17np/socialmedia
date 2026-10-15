'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Mail, MessageCircle, MessageSquare, TrendingUp, ScrollText, Sparkles } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Button, IconButton, Panel, PanelHeader, StatStrip, Stat, Table, Th, Td, EmptyState, Skeleton, Pagination } from '../ui';
import { money } from '../sales/format';

const MKT_API_BASE = `${API_BASE}/marketing`;

/* One flat, bordered channel tile — a compact 2-column stat grid instead
 * of the full-width StatStrip-per-channel this replaced, so Email/
 * WhatsApp/SMS sit side by side as one scannable row instead of three
 * stacked full-width strips. */
function ChannelCard({ icon: Icon, label, tone, stats }) {
  return (
    <div className="border border-hairline rounded-card p-3.5 bg-card flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <Icon size={14} className={tone} />
        <span className="text-xs font-medium text-ink">{label}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        {stats.map(([statLabel, value]) => (
          <div key={statLabel} className="min-w-0">
            <div className="eyebrow truncate">{statLabel}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-ink leading-none">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Phase 8: the cross-channel overview (Module G, "beyond one campaign
 * rollup") plus Marketing Hub's half of the audit trail (Module H) — see
 * backend/routes/attribution.js's GET /marketing/overview and
 * GET /marketing/audit-log. A full custom report builder/saved reports/
 * digests/calendar/briefs/asset-library/UTM-builder/budget-ROI tracker
 * (the rest of Modules G/H) are explicitly deferred — see
 * docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 8 scope decision.
 */
export default function OverviewSection({ authFetch, canAdmin }) {
  const [overview, setOverview] = useState(null);
  const [auditEntries, setAuditEntries] = useState(null);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotal, setAuditTotal] = useState(null);
  const [error, setError] = useState(null);
  const [insights, setInsights] = useState(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState(null);

  const generateInsights = async () => {
    setInsightsLoading(true);
    setInsightsError(null);
    try {
      const res = await authFetch(`${MKT_API_BASE}/ai/insights`, { method: 'POST', body: JSON.stringify({ overview }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI Assist failed.');
      setInsights(data.summary);
    } catch (e) {
      setInsightsError(e.message);
    } finally {
      setInsightsLoading(false);
    }
  };

  const load = () => {
    authFetch(`${MKT_API_BASE}/overview`).then((r) => r.json()).then(setOverview).catch((e) => setError(e.message));
    if (canAdmin) {
      authFetch(`${MKT_API_BASE}/audit-log?page=1&pageSize=25`).then((r) => r.json()).then((d) => { setAuditEntries(d.entries || []); setAuditTotal(d.total ?? 0); }).catch(() => {});
    }
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!canAdmin || auditPage === 1) return;
    authFetch(`${MKT_API_BASE}/audit-log?page=${auditPage}&pageSize=25`).then((r) => r.json()).then((d) => { setAuditEntries(d.entries || []); setAuditTotal(d.total ?? 0); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditPage]);

  return (
    <div className="flex flex-col gap-3">
      {error && <div className="text-xs text-danger">{error}</div>}

      {overview !== null && (
        <Panel className="p-3.5">
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <div className="flex items-center gap-1.5">
              <Sparkles size={14} className="text-brand" />
              <span className="text-xs font-medium text-ink">AI insights</span>
            </div>
            <Button size="sm" variant="ghost" icon={Sparkles} loading={insightsLoading} onClick={generateInsights}>
              {insights ? 'Regenerate' : 'Generate insights'}
            </Button>
          </div>
          {insightsError && <div className="text-xs text-danger">{insightsError}</div>}
          {insights && (
            <div className="bg-brand-subtle/60 border border-hairline rounded-ui px-3 py-2.5">
              <p className="text-xs text-ink leading-relaxed">{insights}</p>
            </div>
          )}
          {!insights && !insightsError && <p className="text-xs text-muted">A short AI-written summary of the numbers below, highlighting the most actionable one.</p>}
        </Panel>
      )}

      <Panel className="overflow-hidden">
        <PanelHeader title="Overview" meta="Across every channel" action={<IconButton icon={RefreshCw} label="Refresh" onClick={load} />} />
        {overview === null ? (
          <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" />
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <ChannelCard
                icon={Mail}
                label="Email"
                tone="text-brand"
                stats={[
                  ['Campaigns', overview.email.campaigns],
                  ['Sent', overview.email.sent],
                  ['Opened', overview.email.opened],
                  ['Clicked', overview.email.clicked]
                ]}
              />
              <ChannelCard
                icon={MessageCircle}
                label="WhatsApp"
                tone="text-success"
                stats={[
                  ['Campaigns', overview.whatsapp.campaigns],
                  ['Sent', overview.whatsapp.sent],
                  ['Delivered', overview.whatsapp.delivered],
                  ['Read', overview.whatsapp.read]
                ]}
              />
              <ChannelCard
                icon={MessageSquare}
                label="SMS"
                tone="text-info"
                stats={[
                  ['Campaigns', overview.sms.campaigns],
                  ['Sent', overview.sms.sent],
                  ['Failed', overview.sms.failed]
                ]}
              />
            </div>

            <div>
              <div className="eyebrow mb-1.5">Pipeline & engagement</div>
              <StatStrip>
                <Stat label="Submissions" value={overview.forms.submissions} hint="Non-spam submissions across every hosted form" />
                <Stat label="Journeys" value={overview.journeys.active} hint="Journeys currently enrolling contacts" />
                <Stat label="Won deals" value={`${overview.revenue.attributedDeals}/${overview.revenue.wonDeals}`} hint="Won deals with at least one tracked touchpoint, out of all won deals" />
              </StatStrip>
            </div>

            {overview.revenue.byChannel.length > 0 && (
              <div>
                <div className="eyebrow mb-1.5 flex items-center gap-1.5"><TrendingUp size={12} /> Revenue by channel (linear model)</div>
                <div className="border border-hairline rounded-card divide-y divide-hairline overflow-hidden">
                  {overview.revenue.byChannel.slice(0, 5).map((c) => (
                    <div key={`${c.channel}|${c.sourceName}|${c.currency}`} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs">
                      <span className="text-ink truncate">{c.sourceName}</span>
                      <span className="font-semibold tabular-nums text-ink shrink-0">{money(c.totalCredited, c.currency)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Panel>

      {canAdmin && (
        <Panel className="overflow-hidden">
          <PanelHeader title="Audit log" action={<ScrollText size={14} className="text-muted" />} />
          {auditEntries === null ? (
            <div className="p-4 space-y-3"><Skeleton className="h-9" /></div>
          ) : auditEntries.length === 0 ? (
            <EmptyState icon={ScrollText} title="No activity yet" description="Every Marketing Hub mutation (journeys, forms, email/SMS campaigns, consent changes) is recorded here." />
          ) : (
            <>
              <Table>
                <thead><tr><Th>Action</Th><Th>Target</Th><Th>When</Th></tr></thead>
                <tbody>
                  {auditEntries.map((e) => (
                    <tr key={e.id}>
                      <Td className="text-xs font-mono">{e.action.replace('marketing.', '')}</Td>
                      <Td className="text-xs text-muted">{e.target_type || '—'}</Td>
                      <Td className="text-xs text-muted">{new Date(e.created_at).toLocaleString()}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={auditPage} pageSize={25} total={auditTotal} onPageChange={setAuditPage} />
            </>
          )}
        </Panel>
      )}
    </div>
  );
}
