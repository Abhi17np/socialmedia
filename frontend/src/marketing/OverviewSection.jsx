'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Mail, MessageCircle, MessageSquare, FileText, Workflow, TrendingUp, ScrollText } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { IconButton, Panel, PanelHeader, StatStrip, Stat, Table, Th, Td, EmptyState, Skeleton, Pagination } from '../ui';
import { money } from '../sales/format';

const MKT_API_BASE = `${API_BASE}/marketing`;

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

      <Panel className="overflow-hidden">
        <PanelHeader title="Overview" action={<IconButton icon={RefreshCw} label="Refresh" onClick={load} />} />
        {overview === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : (
          <div className="p-4 flex flex-col gap-4">
            <div>
              <div className="eyebrow mb-1.5 flex items-center gap-1.5"><Mail size={12} /> Email</div>
              <StatStrip>
                <Stat label="Campaigns" value={overview.email.campaigns} />
                <Stat label="Sent" value={overview.email.sent} />
                <Stat label="Opened" value={overview.email.opened} />
                <Stat label="Clicked" value={overview.email.clicked} />
              </StatStrip>
            </div>
            <div>
              <div className="eyebrow mb-1.5 flex items-center gap-1.5"><MessageCircle size={12} /> WhatsApp</div>
              <StatStrip>
                <Stat label="Campaigns" value={overview.whatsapp.campaigns} />
                <Stat label="Sent" value={overview.whatsapp.sent} />
                <Stat label="Delivered" value={overview.whatsapp.delivered} />
                <Stat label="Read" value={overview.whatsapp.read} />
              </StatStrip>
            </div>
            <div>
              <div className="eyebrow mb-1.5 flex items-center gap-1.5"><MessageSquare size={12} /> SMS</div>
              <StatStrip>
                <Stat label="Campaigns" value={overview.sms.campaigns} />
                <Stat label="Sent" value={overview.sms.sent} />
                <Stat label="Failed" value={overview.sms.failed} />
              </StatStrip>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Panel className="p-3 flex items-center gap-2"><FileText size={16} className="text-muted" /><div><div className="text-[11px] text-muted">Form submissions</div><div className="text-lg font-semibold tabular-nums">{overview.forms.submissions}</div></div></Panel>
              <Panel className="p-3 flex items-center gap-2"><Workflow size={16} className="text-muted" /><div><div className="text-[11px] text-muted">Active journeys</div><div className="text-lg font-semibold tabular-nums">{overview.journeys.active}</div></div></Panel>
              <Panel className="p-3 flex items-center gap-2"><TrendingUp size={16} className="text-muted" /><div><div className="text-[11px] text-muted">Won deals (attributed)</div><div className="text-lg font-semibold tabular-nums">{overview.revenue.attributedDeals}/{overview.revenue.wonDeals}</div></div></Panel>
            </div>
            {overview.revenue.byChannel.length > 0 && (
              <div>
                <div className="eyebrow mb-1.5">Revenue by channel (linear model)</div>
                <div className="flex flex-col gap-1">
                  {overview.revenue.byChannel.slice(0, 5).map((c) => (
                    <div key={`${c.channel}|${c.sourceName}|${c.currency}`} className="flex items-center justify-between text-xs">
                      <span>{c.sourceName}</span>
                      <span className="font-medium tabular-nums">{money(c.totalCredited, c.currency)}</span>
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
