'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Megaphone, Send, Ban, Eye } from 'lucide-react';
import { API_BASE } from '../apiBase';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Select, Field, Checkbox,
  Banner, Modal, Drawer, EmptyState, Skeleton, Chip, StatStrip, Stat, ConfirmDialog
} from '../ui';

const MKT_API_BASE = `${API_BASE}/marketing`;
const WA_API_BASE = `${API_BASE}/whatsapp`;

const STATUS_TONE = { draft: 'neutral', scheduled: 'info', sending: 'warning', completed: 'success', failed: 'danger', canceled: 'neutral' };

function emptyForm() {
  return { name: '', templateId: '', segmentId: '', subject: '', fromName: '', fromEmail: '', sendMode: 'immediate', scheduledAt: '', abEnabled: false, variantASubject: '', variantBSubject: '', abAutoDecide: false, abDecisionHours: 24 };
}

export default function EmailCampaignsSection({ authFetch, canManage, canAdmin }) {
  const [campaigns, setCampaigns] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [segments, setSegments] = useState([]);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [detail, setDetail] = useState(null);
  const [report, setReport] = useState(null);
  const [confirmSend, setConfirmSend] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(null);

  const load = () => {
    authFetch(`${MKT_API_BASE}/email/campaigns`).then((r) => r.json()).then((d) => setCampaigns(d.campaigns || [])).catch((e) => setError(e.message));
    authFetch(`${MKT_API_BASE}/email/templates`).then((r) => r.json()).then((d) => setTemplates(d.templates || [])).catch(() => {});
    authFetch(`${WA_API_BASE}/segments`).then((r) => r.json()).then((d) => setSegments(d.segments || [])).catch(() => {});
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: form.name, templateId: form.templateId, segmentId: form.segmentId,
        subject: form.subject || undefined, fromName: form.fromName || undefined, fromEmail: form.fromEmail || undefined,
        sendMode: form.sendMode, scheduledAt: form.sendMode === 'scheduled' ? form.scheduledAt : undefined
      };
      if (form.abEnabled && form.variantASubject.trim() && form.variantBSubject.trim()) {
        body.abTest = {
          variants: [{ key: 'A', subject: form.variantASubject }, { key: 'B', subject: form.variantBSubject }], splitPercent: 50, winnerMetric: 'opens',
          decisionHours: form.abAutoDecide ? Number(form.abDecisionHours) || 24 : undefined
        };
      }
      const res = await authFetch(`${MKT_API_BASE}/email/campaigns`, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create campaign.');
      setCampaigns((prev) => [data.campaign, ...(prev || [])]);
      setOpen(false);
      setForm(emptyForm());
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (campaign) => {
    try {
      const [detailRes, reportRes] = await Promise.all([
        authFetch(`${MKT_API_BASE}/email/campaigns/${campaign.id}`).then((r) => r.json()),
        authFetch(`${MKT_API_BASE}/email/campaigns/${campaign.id}/report`).then((r) => r.json())
      ]);
      setDetail(detailRes);
      setReport(reportRes);
    } catch (err) {
      setError(err.message);
    }
  };

  const send = async () => {
    if (!confirmSend) return;
    try {
      const res = await authFetch(`${MKT_API_BASE}/email/campaigns/${confirmSend.id}/send`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send campaign.');
      setConfirmSend(null);
      load();
      if (detail?.campaign?.id === confirmSend.id) openDetail(confirmSend);
    } catch (err) {
      setError(err.message);
    }
  };

  const cancel = async () => {
    if (!confirmCancel) return;
    try {
      const res = await authFetch(`${MKT_API_BASE}/email/campaigns/${confirmCancel.id}/cancel`, { method: 'POST' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Could not cancel campaign.'); }
      setConfirmCancel(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Email campaigns"
          meta="Consent-checked at send time"
          action={<div className="flex items-center gap-2"><IconButton icon={RefreshCw} label="Refresh" onClick={load} />{canManage && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)} disabled={templates.length === 0 || segments.length === 0}>New campaign</Button>}</div>}
        />
        {(templates.length === 0 || segments.length === 0) && campaigns !== null && (
          <Banner tone="warning" className="m-3">Create at least one email template and one audience segment before starting a campaign.</Banner>
        )}
        {campaigns === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : campaigns.length === 0 ? (
          <EmptyState icon={Megaphone} title="No email campaigns yet" description="Pick a template and a segment to send your first campaign." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Status</Th><Th>Recipients</Th><Th>Opened</Th><Th>Clicked</Th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="hover:bg-canvas transition-colors cursor-pointer" onClick={() => openDetail(c)}>
                  <Td><span className="font-medium">{c.name}</span></Td>
                  <Td><Chip tone={STATUS_TONE[c.status] || 'neutral'}>{c.status}</Chip></Td>
                  <Td className="tabular-nums">{c.total_recipients}</Td>
                  <Td className="tabular-nums">{c.opened_count}</Td>
                  <Td className="tabular-nums">{c.clicked_count}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New email campaign"
        width={560}
        footer={<><Button onClick={() => setOpen(false)} disabled={saving}>Cancel</Button><Button variant="primary" onClick={create} loading={saving} disabled={!form.name.trim() || !form.templateId || !form.segmentId}>Create</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <Field label="Template">
            <Select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })}>
              <option value="">Select a template…</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Audience segment">
            <Select value={form.segmentId} onChange={(e) => setForm({ ...form, segmentId: e.target.value })}>
              <option value="">Select a segment…</option>
              {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Subject override (optional)" hint="Leave blank to use the template's own subject">
            <Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          </Field>
          <Field label="Send">
            <Select value={form.sendMode} onChange={(e) => setForm({ ...form, sendMode: e.target.value })}>
              <option value="immediate">Immediately, once sent</option>
              <option value="scheduled">At a scheduled time</option>
            </Select>
          </Field>
          {form.sendMode === 'scheduled' && (
            <Field label="Scheduled at"><Input type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} /></Field>
          )}
          <div className="pt-2 border-t border-hairline">
            <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
              <Checkbox checked={form.abEnabled} onChange={(e) => setForm({ ...form, abEnabled: e.target.checked })} />
              <span className="text-sm">A/B test the subject line</span>
            </label>
            {form.abEnabled && (
              <div className="flex flex-col gap-2">
                <Input placeholder="Variant A subject" value={form.variantASubject} onChange={(e) => setForm({ ...form, variantASubject: e.target.value })} />
                <Input placeholder="Variant B subject" value={form.variantBSubject} onChange={(e) => setForm({ ...form, variantBSubject: e.target.value })} />
                <p className="text-[11px] text-muted">Recipients split 50/50. Reporting breaks out opens/clicks per variant.</p>
                <label className="flex items-center gap-2 cursor-pointer select-none mt-1">
                  <Checkbox checked={form.abAutoDecide} onChange={(e) => setForm({ ...form, abAutoDecide: e.target.checked })} />
                  <span className="text-sm">Automatically pick the winner by open rate</span>
                </label>
                {form.abAutoDecide && (
                  <div className="flex items-center gap-2">
                    <Input type="number" min={1} max={168} className="h-8 w-20" value={form.abDecisionHours} onChange={(e) => setForm({ ...form, abDecisionHours: e.target.value })} />
                    <span className="text-xs text-muted">hours after sending finishes</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Modal>

      <Drawer open={!!detail} onClose={() => { setDetail(null); setReport(null); }} title={detail?.campaign?.name} subtitle={detail?.campaign?.status} width={560}>
        {detail && report && (
          <div className="p-4 flex flex-col gap-4">
            <StatStrip>
              <Stat label="Sent" value={report.campaign.sent} />
              <Stat label="Opened" value={report.campaign.opened} />
              <Stat label="Clicked" value={report.campaign.clicked} />
              <Stat label="Bounced" value={report.campaign.bounced} />
              <Stat label="Unsubscribed" value={report.campaign.unsubscribed} />
            </StatStrip>

            {report.byVariant && (
              <div>
                <div className="eyebrow mb-1.5 flex items-center gap-1.5">
                  A/B variants
                  {report.abTest?.winnerKey && <Chip tone="success">Winner: {report.abTest.winnerKey}</Chip>}
                  {!report.abTest?.winnerKey && report.abTest?.decisionHours && <Chip tone="neutral">Auto-decides {report.abTest.decisionHours}h after sending finishes</Chip>}
                </div>
                <div className="flex flex-col gap-1">
                  {Object.entries(report.byVariant).map(([key, v]) => (
                    <div key={key} className="flex items-center justify-between text-xs">
                      <span className="font-medium">{key}{report.abTest?.winnerKey === key ? ' 🏆' : ''}</span>
                      <span className="text-muted">{v.sent} sent · {v.opened} opened · {v.clicked} clicked</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {['draft', 'scheduled'].includes(detail.campaign.status) && canAdmin && (
              <Button variant="primary" icon={Send} onClick={() => setConfirmSend(detail.campaign)}>Send now</Button>
            )}
            {detail.campaign.status === 'sending' && canAdmin && (
              <Button variant="danger" icon={Ban} onClick={() => setConfirmCancel(detail.campaign)}>Cancel send</Button>
            )}

            <div>
              <div className="eyebrow mb-1.5 flex items-center gap-1.5"><Eye size={12} /> Recipients</div>
              {detail.recipients.length === 0 ? <p className="text-xs text-muted">Not sent yet.</p> : (
                <Table>
                  <thead><tr><Th>Email</Th><Th>Status</Th></tr></thead>
                  <tbody>
                    {detail.recipients.slice(0, 50).map((r) => (
                      <tr key={r.id}>
                        <Td className="text-xs">{r.email}</Td>
                        <Td><Chip tone={r.status === 'bounced' || r.status === 'failed' ? 'danger' : r.status === 'clicked' || r.status === 'opened' ? 'success' : 'neutral'}>{r.status}</Chip></Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={!!confirmSend}
        title="Send this campaign now?"
        body={confirmSend ? `This will email every consented contact in the segment. Opted-out and suppressed contacts are excluded automatically.` : ''}
        confirmLabel="Send"
        onConfirm={send}
        onCancel={() => setConfirmSend(null)}
      />
      <ConfirmDialog
        open={!!confirmCancel}
        title="Cancel this send?"
        body="Already-sent emails can't be recalled; any not-yet-sent recipients will be skipped."
        confirmLabel="Cancel send"
        onConfirm={cancel}
        onCancel={() => setConfirmCancel(null)}
      />
    </>
  );
}
