'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, TrendingUp, Mail, FileText, Workflow, MessageCircle } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Select, Field, Banner, StatStrip, Stat, EmptyState, Skeleton } from '../ui';
import { money } from '../sales/format';

const MKT_API_BASE = `${API_BASE}/marketing`;

const MODEL_LABELS = { first_touch: 'First touch', last_touch: 'Last touch', linear: 'Linear (split evenly)' };
const CHANNEL_META = {
  email: { label: 'Email', icon: Mail },
  form: { label: 'Form', icon: FileText },
  journey: { label: 'Journey', icon: Workflow },
  whatsapp: { label: 'WhatsApp', icon: MessageCircle }
};

/**
 * Marketing attribution (Phase 6): which touchpoints actually led to won
 * revenue, under first-touch/last-touch/linear models — computed live by
 * backend/lib/attribution.js from the real email/form/journey/WhatsApp
 * event tables, never a second denormalized "touchpoints" table that
 * could drift. Revenue is always shown grouped by currency, never
 * summed across them (src/sales/format.js's moneyByCurrency convention,
 * same reasoning as Sales Hub's own dashboard).
 */
export default function AttributionSection({ authFetch, canAdmin }) {
  const [model, setModel] = useState('linear');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [threshold, setThreshold] = useState(null);
  const [thresholdInput, setThresholdInput] = useState('');
  const [savingThreshold, setSavingThreshold] = useState(false);

  const load = () => {
    const params = new URLSearchParams({ model });
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    authFetch(`${MKT_API_BASE}/attribution?${params}`).then((r) => r.json()).then(setReport).catch((e) => setError(e.message));
  };
  useEffect(load, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    authFetch(`${MKT_API_BASE}/scoring-settings`).then((r) => r.json()).then((d) => { setThreshold(d.mqlThreshold); setThresholdInput(String(d.mqlThreshold)); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveThreshold = async () => {
    const value = Number(thresholdInput);
    if (!Number.isInteger(value) || value < 0) { setError('MQL threshold must be a whole number of 0 or more.'); return; }
    setSavingThreshold(true);
    setError(null);
    try {
      const res = await authFetch(`${MKT_API_BASE}/scoring-settings`, { method: 'PATCH', body: JSON.stringify({ mqlThreshold: value }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save.');
      setThreshold(data.mqlThreshold);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingThreshold(false);
    }
  };

  // Grouped by currency for display, same convention as Sales Hub's
  // DashboardTab — each currency gets its own section, never merged.
  const currencies = report ? [...new Set(report.byChannel.map((c) => c.currency))].sort() : [];

  return (
    <div className="flex flex-col gap-3">
      {error && <Banner tone="danger">{error}</Banner>}

      <Panel className="p-4">
        <div className="eyebrow mb-2">MQL auto-promotion</div>
        <p className="text-xs text-muted mb-3">A subscriber or lead is automatically promoted to Marketing Qualified Lead once their lead score (Sales Hub settings → Lead scoring, now including real marketing-engagement rules) crosses this threshold.</p>
        <div className="flex items-end gap-2">
          <Field label="Score threshold">
            <Input type="number" min={0} className="w-32" value={thresholdInput} onChange={(e) => setThresholdInput(e.target.value)} disabled={!canAdmin} />
          </Field>
          {canAdmin && <Button size="sm" onClick={saveThreshold} loading={savingThreshold} disabled={threshold !== null && Number(thresholdInput) === threshold}>Save</Button>}
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader title="Revenue attribution" action={<IconButton icon={RefreshCw} label="Refresh" onClick={load} />} />
        <div className="p-3 border-b border-hairline flex flex-wrap items-center gap-2">
          <Select className="h-8" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Attribution model">
            {Object.entries(MODEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Input type="date" className="h-8 w-36" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="From date" />
          <span className="text-xs text-muted">to</span>
          <Input type="date" className="h-8 w-36" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="To date" />
        </div>
        {report === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : report.dealCount === 0 ? (
          <EmptyState icon={TrendingUp} title="No won deals yet" description="Once a deal with a known contact is marked won, its revenue will be attributed here to the real marketing touchpoints that led to it." />
        ) : (
          <div className="p-4 flex flex-col gap-4">
            <StatStrip>
              <Stat label="Won deals" value={report.dealCount} />
              <Stat label="Attributed" value={report.attributedDealCount} hint="Had at least one tracked touchpoint before closing" />
              <Stat label="No touchpoint" value={report.unattributedDealCount} hint="Won with no tracked marketing touch on file" />
            </StatStrip>

            {report.unattributedRevenue.length > 0 && (
              <Banner tone="warning">
                {report.unattributedRevenue.map((u) => money(u.total, u.currency)).join(' + ')} in won revenue has no tracked touchpoint — likely sourced outside Marketing Hub (e.g. a direct referral or an existing relationship).
              </Banner>
            )}

            {currencies.map((currency) => (
              <div key={currency}>
                {currencies.length > 1 && <div className="eyebrow mb-1.5">{currency}</div>}
                <Table>
                  <thead><tr><Th>Channel</Th><Th>Source</Th><Th align="right">Deals</Th><Th align="right">Revenue credited</Th></tr></thead>
                  <tbody>
                    {report.byChannel.filter((c) => c.currency === currency).map((c) => {
                      const meta = CHANNEL_META[c.channel] || { label: c.channel, icon: TrendingUp };
                      const Icon = meta.icon;
                      return (
                        <tr key={`${c.channel}|${c.sourceName}|${c.currency}`}>
                          <Td><span className="flex items-center gap-1.5"><Icon size={14} className="text-muted" /> {meta.label}</span></Td>
                          <Td>{c.sourceName}</Td>
                          <Td align="right" className="tabular-nums">{c.dealCount}</Td>
                          <Td align="right" className="tabular-nums font-medium">{money(c.totalCredited, c.currency)}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
