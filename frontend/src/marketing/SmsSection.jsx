'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Plus, Send, Ban, MessageSquare } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Textarea, Select, Field, Banner, Modal, Drawer, EmptyState, Skeleton, Chip, ConfirmDialog } from '../ui';
import AiGenerateButton from './AiGenerateButton';

const MKT_API_BASE = `${API_BASE}/marketing`;
const WA_API_BASE = `${API_BASE}/whatsapp`;

const PROVIDER_LABELS = { mock: 'Mock (local/dev — always works, sends nowhere real)', twilio: 'Twilio', msg91: 'MSG91 (India — needs TRAI DLT registration)' };
const STATUS_TONE = { draft: 'neutral', sending: 'warning', completed: 'success', failed: 'danger', canceled: 'neutral' };

/**
 * SMS (Phase 7): a provider connection (mock/Twilio/MSG91) + plain-text
 * campaigns (merge tags only, no HTML — SMS has none). "Multichannel
 * fallback" is a journey a tenant authors with the existing send_whatsapp
 * -> delay -> condition -> send_sms nodes (Phase 4), not a separate
 * feature here — see docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 7 entry.
 */
export default function SmsSection({ authFetch, canManage, canAdmin }) {
  const [connection, setConnection] = useState(undefined);
  const [campaigns, setCampaigns] = useState(null);
  const [segments, setSegments] = useState([]);
  const [error, setError] = useState(null);

  const [connForm, setConnForm] = useState({ provider: 'mock', fromNumber: '', accountSid: '', dltEntityId: '', dltTemplateId: '', secret: '' });
  const [savingConn, setSavingConn] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', body: '', segmentId: '' });
  const [detail, setDetail] = useState(null);
  const [confirmSend, setConfirmSend] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(null);

  const load = () => {
    authFetch(`${MKT_API_BASE}/sms/connection`).then((r) => r.json()).then((d) => {
      setConnection(d.connection);
      if (d.connection) setConnForm({ provider: d.connection.provider, fromNumber: d.connection.from_number, accountSid: d.connection.config?.accountSid || '', dltEntityId: d.connection.config?.dltEntityId || '', dltTemplateId: d.connection.config?.dltTemplateId || '', secret: '' });
    }).catch((e) => setError(e.message));
    authFetch(`${MKT_API_BASE}/sms/campaigns`).then((r) => r.json()).then((d) => setCampaigns(d.campaigns || [])).catch((e) => setError(e.message));
    authFetch(`${WA_API_BASE}/segments`).then((r) => r.json()).then((d) => setSegments(d.segments || [])).catch(() => {});
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveConnection = async () => {
    setSavingConn(true);
    setError(null);
    try {
      const config = connForm.provider === 'twilio' ? { accountSid: connForm.accountSid } : connForm.provider === 'msg91' ? { dltEntityId: connForm.dltEntityId, dltTemplateId: connForm.dltTemplateId } : {};
      const res = await authFetch(`${MKT_API_BASE}/sms/connection`, { method: 'PUT', body: JSON.stringify({ provider: connForm.provider, fromNumber: connForm.fromNumber, config, secret: connForm.secret || undefined }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save connection.');
      setConnection(data.connection);
      setConnForm((f) => ({ ...f, secret: '' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingConn(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await authFetch(`${MKT_API_BASE}/sms/connection/test`, { method: 'POST', body: JSON.stringify({ to: testTo }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTestResult({ ok: true, message: `Sent via ${data.provider}.` });
    } catch (err) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${MKT_API_BASE}/sms/campaigns`, { method: 'POST', body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create campaign.');
      setCampaigns((prev) => [data.campaign, ...(prev || [])]);
      setOpen(false);
      setForm({ name: '', body: '', segmentId: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (campaign) => {
    const res = await authFetch(`${MKT_API_BASE}/sms/campaigns/${campaign.id}`);
    const data = await res.json();
    setDetail(data);
  };

  const send = async () => {
    if (!confirmSend) return;
    try {
      const res = await authFetch(`${MKT_API_BASE}/sms/campaigns/${confirmSend.id}/send`, { method: 'POST' });
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
      const res = await authFetch(`${MKT_API_BASE}/sms/campaigns/${confirmCancel.id}/cancel`, { method: 'POST' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Could not cancel campaign.'); }
      setConfirmCancel(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error && <Banner tone="danger">{error}</Banner>}

      <Panel className="p-4">
        <div className="eyebrow mb-2">SMS connection</div>
        {connection === undefined ? <Skeleton className="h-9" /> : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Field label="Provider">
                <Select className="w-48" value={connForm.provider} onChange={(e) => setConnForm({ ...connForm, provider: e.target.value })} disabled={!canAdmin}>
                  {Object.entries(PROVIDER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label="From number / sender ID"><Input className="w-44" value={connForm.fromNumber} onChange={(e) => setConnForm({ ...connForm, fromNumber: e.target.value })} placeholder="+15551234567" disabled={!canAdmin} /></Field>
              {connForm.provider === 'twilio' && <Field label="Account SID"><Input className="w-56" value={connForm.accountSid} onChange={(e) => setConnForm({ ...connForm, accountSid: e.target.value })} disabled={!canAdmin} /></Field>}
              {connForm.provider === 'msg91' && (
                <>
                  <Field label="DLT Entity ID"><Input className="w-44" value={connForm.dltEntityId} onChange={(e) => setConnForm({ ...connForm, dltEntityId: e.target.value })} disabled={!canAdmin} /></Field>
                  <Field label="DLT Template ID"><Input className="w-44" value={connForm.dltTemplateId} onChange={(e) => setConnForm({ ...connForm, dltTemplateId: e.target.value })} disabled={!canAdmin} /></Field>
                </>
              )}
              {connForm.provider !== 'mock' && <Field label="Auth token / API key" hint="Write-only — blank keeps the existing one"><Input type="password" className="w-56" value={connForm.secret} onChange={(e) => setConnForm({ ...connForm, secret: e.target.value })} disabled={!canAdmin} /></Field>}
            </div>
            {canAdmin && <Button size="sm" variant="primary" onClick={saveConnection} loading={savingConn}>Save connection</Button>}
            {connection && (
              <div className="flex items-end gap-2 pt-2 border-t border-hairline">
                <Field label="Send a test SMS to"><Input className="w-44" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="+15559990000" /></Field>
                <Button size="sm" onClick={testConnection} loading={testing} disabled={!testTo}>Send test</Button>
                {testResult && <span className={`text-xs ${testResult.ok ? 'text-success' : 'text-danger'}`}>{testResult.message}</span>}
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader
          title="SMS campaigns"
          meta="Consent-checked at send time"
          action={<div className="flex items-center gap-2"><IconButton icon={RefreshCw} label="Refresh" onClick={load} />{canManage && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)} disabled={segments.length === 0}>New campaign</Button>}</div>}
        />
        {segments.length === 0 && campaigns !== null && <Banner tone="warning" className="m-3">Create at least one audience segment (WhatsApp Hub) before starting an SMS campaign.</Banner>}
        {campaigns === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : campaigns.length === 0 ? (
          <EmptyState icon={MessageSquare} title="No SMS campaigns yet" description="Write a short text (merge tags supported) and pick a segment to send your first campaign." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Status</Th><Th align="right">Sent</Th><Th align="right">Failed</Th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="hover:bg-canvas transition-colors cursor-pointer" onClick={() => openDetail(c)}>
                  <Td><span className="font-medium">{c.name}</span></Td>
                  <Td><Chip tone={STATUS_TONE[c.status] || 'neutral'}>{c.status}</Chip></Td>
                  <Td align="right" className="tabular-nums">{c.sent_count}</Td>
                  <Td align="right" className="tabular-nums">{c.failed_count}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Modal
        open={open} onClose={() => setOpen(false)} title="New SMS campaign" width={480}
        footer={<><Button onClick={() => setOpen(false)} disabled={saving}>Cancel</Button><Button variant="primary" onClick={create} loading={saving} disabled={!form.name.trim() || !form.body.trim() || !form.segmentId}>Create</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <Field label="Audience segment">
            <Select value={form.segmentId} onChange={(e) => setForm({ ...form, segmentId: e.target.value })}>
              <option value="">Select a segment…</option>
              {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <AiGenerateButton
            authFetch={authFetch}
            endpoint="sms-copy"
            label="Draft message with AI"
            placeholder="e.g. Remind about an abandoned cart, friendly tone"
            buildBody={(brief) => ({ brief })}
            onResult={({ body }) => setForm((prev) => ({ ...prev, body: body || prev.body }))}
          />
          <Field label="Message" hint={`${form.body.length}/1600 — merge tags: {{firstName|there}}, {{displayName}}`}>
            <Textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Hi {{firstName|there}}, 20% off today!" />
          </Field>
        </div>
      </Modal>

      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.campaign?.name} subtitle={detail?.campaign?.status} width={520}>
        {detail && (
          <div className="p-4 flex flex-col gap-4">
            <p className="text-sm whitespace-pre-wrap p-3 rounded-ui bg-canvas border border-hairline">{detail.campaign.body}</p>
            {detail.campaign.status === 'draft' && canAdmin && <Button variant="primary" icon={Send} onClick={() => setConfirmSend(detail.campaign)}>Send now</Button>}
            {detail.campaign.status === 'sending' && canAdmin && <Button variant="danger" icon={Ban} onClick={() => setConfirmCancel(detail.campaign)}>Cancel send</Button>}
            <div>
              <div className="eyebrow mb-1.5">Recipients</div>
              {detail.recipients.length === 0 ? <p className="text-xs text-muted">Not sent yet.</p> : (
                <Table>
                  <thead><tr><Th>Phone</Th><Th>Status</Th></tr></thead>
                  <tbody>
                    {detail.recipients.slice(0, 50).map((r) => (
                      <tr key={r.id}>
                        <Td className="text-xs">{r.phone}</Td>
                        <Td><Chip tone={r.status === 'failed' ? 'danger' : r.status === 'sent' || r.status === 'delivered' ? 'success' : 'neutral'}>{r.status}</Chip></Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmDialog open={!!confirmSend} title="Send this campaign now?" body="This will text every consented contact in the segment. Opted-out and suppressed numbers are excluded automatically." confirmLabel="Send" onConfirm={send} onCancel={() => setConfirmSend(null)} />
      <ConfirmDialog open={!!confirmCancel} title="Cancel this send?" body="Already-sent messages can't be recalled; any not-yet-sent recipients will be skipped." confirmLabel="Cancel send" onConfirm={cancel} onCancel={() => setConfirmCancel(null)} />
    </div>
  );
}
