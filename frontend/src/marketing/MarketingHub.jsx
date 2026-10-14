'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  RefreshCw, Plus, Megaphone, Zap, Link2, CalendarDays, MessageCircle, ShieldCheck, Trash2
} from 'lucide-react';
import { API_BASE } from '../apiBase';
import { atLeast } from '../roleRank';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Textarea, Select, Field,
  Banner, Modal, Drawer, EmptyState, Skeleton, Chip, StatStrip, Stat, Pagination, ConfirmDialog
} from '../ui';
import EmailTab from './EmailTab';
import JourneysSection from './JourneysSection';
import FormsSection from './FormsSection';
import SmsSection from './SmsSection';
import OverviewSection from './OverviewSection';
import AttributionSection from './AttributionSection';

const MKT_API_BASE = `${API_BASE}/marketing`;
const WA_API_BASE = `${API_BASE}/whatsapp`;
const SOCIAL_API_BASE = `${API_BASE}/social`;

const CAMPAIGN_TONE = { draft: 'neutral', active: 'info', completed: 'success', archived: 'neutral' };
const TRIGGER_LABELS = {
  contact_created: 'A contact is created',
  contact_tag_added: 'A tag is added to a contact',
  deal_stage_changed: 'A deal changes stage',
  deal_won: 'A deal is won',
  deal_lost: 'A deal is lost'
};
const ACTION_LABELS = { add_tag: 'Add a tag', remove_tag: 'Remove a tag', create_task: 'Create a follow-up task' };

/**
 * Marketing Hub: campaigns that bundle real sends (scheduled social
 * posts, WhatsApp broadcasts) against a shared audience segment, and
 * the automation rules that fire from Sales Hub events. Every number
 * shown here is pulled live from routes/marketing.js — there is no
 * email/SMS channel wired up in this app, so a campaign's reach is
 * exactly what its linked real sends report, nothing invented.
 */
function MarketingHubInner({ authFetch, role }) {
  const searchParams = useSearchParams();
  const tab = searchParams.get('tab') || 'campaigns';
  const [gateError, setGateError] = useState(null);
  const canManage = atLeast(role, 'member');
  const canAdmin = atLeast(role, 'admin');

  const checkGate = () => {
    authFetch(`${MKT_API_BASE}/campaigns`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => setGateError(ok ? null : data.code === 'HUB_NOT_ENABLED' ? data.error : null))
      .catch(() => {});
  };

  useEffect(checkGate, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (gateError) {
    return (
      <Page>
        <PageBar title="Marketing Hub" />
        <PageBody width="narrow">
          <Banner tone="warning">{gateError}</Banner>
        </PageBody>
      </Page>
    );
  }

  return (
    <Page>
      <PageBar title="Marketing Hub" />
      <PageBody>
        {tab === 'campaigns' && <CampaignsTab authFetch={authFetch} canManage={canManage} canAdmin={canAdmin} />}
        {tab === 'forms' && <FormsSection authFetch={authFetch} canManage={canManage} canAdmin={canAdmin} />}
        {tab === 'sms' && <SmsSection authFetch={authFetch} canManage={canManage} canAdmin={canAdmin} />}
        {tab === 'overview' && <OverviewSection authFetch={authFetch} canAdmin={canAdmin} />}
        {tab === 'attribution' && <AttributionSection authFetch={authFetch} canAdmin={canAdmin} />}
        {tab === 'journeys' && <JourneysSection authFetch={authFetch} canManage={canManage} canAdmin={canAdmin} />}
        {tab === 'automation' && <AutomationTab authFetch={authFetch} canAdmin={canAdmin} />}
        {tab === 'audience' && <SuppressionTab authFetch={authFetch} canAdmin={canAdmin} />}
        {tab === 'email' && <EmailTab authFetch={authFetch} canManage={canManage} canAdmin={canAdmin} />}
      </PageBody>
    </Page>
  );
}

function MarketingHub(props) {
  return (
    <Suspense fallback={null}>
      <MarketingHubInner {...props} />
    </Suspense>
  );
}

// -------------------------------------------------------------- Campaigns

function CampaignsTab({ authFetch, canManage, canAdmin }) {
  const [campaigns, setCampaigns] = useState(null);
  const [segments, setSegments] = useState([]);
  const [posts, setPosts] = useState([]);
  const [waCampaigns, setWaCampaigns] = useState([]);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({ name: '', description: '', segmentId: '' });
  const [linkPostId, setLinkPostId] = useState('');
  const [linkWaId, setLinkWaId] = useState('');

  const load = () => {
    authFetch(`${MKT_API_BASE}/campaigns`).then((r) => r.json()).then((d) => setCampaigns(d.campaigns || [])).catch((e) => setError(e.message));
    authFetch(`${WA_API_BASE}/segments`).then((r) => r.json()).then((d) => setSegments(d.segments || [])).catch(() => {});
    authFetch(`${SOCIAL_API_BASE}/posts`).then((r) => r.json()).then((d) => setPosts(d.posts || [])).catch(() => {});
    authFetch(`${WA_API_BASE}/campaigns`).then((r) => r.json()).then((d) => setWaCampaigns(d.campaigns || [])).catch(() => {});
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const res = await authFetch(`${MKT_API_BASE}/campaigns`, { method: 'POST', body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create campaign.');
      setCampaigns((prev) => [data.campaign, ...(prev || [])]);
      setOpen(false);
      setForm({ name: '', description: '', segmentId: '' });
    } catch (err) {
      setError(err.message);
    }
  };

  const openDetail = async (campaign) => {
    try {
      const [detailRes, analyticsRes] = await Promise.all([
        authFetch(`${MKT_API_BASE}/campaigns/${campaign.id}`).then((r) => r.json()),
        authFetch(`${MKT_API_BASE}/campaigns/${campaign.id}/analytics`).then((r) => r.json())
      ]);
      setDetail({ ...detailRes, analytics: analyticsRes });
    } catch (err) {
      setError(err.message);
    }
  };

  const linkPost = async () => {
    if (!linkPostId || !detail) return;
    try {
      const res = await authFetch(`${MKT_API_BASE}/campaigns/${detail.campaign.id}/link-post`, { method: 'POST', body: JSON.stringify({ scheduledPostId: linkPostId }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not link post.');
      setLinkPostId('');
      openDetail(detail.campaign);
    } catch (err) {
      setError(err.message);
    }
  };

  const linkWhatsapp = async () => {
    if (!linkWaId || !detail) return;
    try {
      const res = await authFetch(`${MKT_API_BASE}/campaigns/${detail.campaign.id}/link-whatsapp`, { method: 'POST', body: JSON.stringify({ whatsappCampaignId: linkWaId }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not link WhatsApp campaign.');
      setLinkWaId('');
      openDetail(detail.campaign);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Campaigns"
          meta="Bundles your real sends — social posts and WhatsApp broadcasts — under one name"
          action={<div className="flex items-center gap-2"><IconButton icon={RefreshCw} label="Refresh" onClick={load} />{canManage && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New campaign</Button>}</div>}
        />
        {campaigns === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : campaigns.length === 0 ? (
          <EmptyState icon={Megaphone} title="No campaigns yet" description="Create a campaign, then link the social posts and WhatsApp broadcasts that make it up." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Status</Th><Th>Segment</Th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="hover:bg-canvas transition-colors cursor-pointer" onClick={() => openDetail(c)}>
                  <Td><span className="font-medium">{c.name}</span></Td>
                  <Td><Chip tone={CAMPAIGN_TONE[c.status] || 'neutral'}>{c.status}</Chip></Td>
                  <Td>{segments.find((s) => s.id === c.segment_id)?.name || '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Modal open={open} onClose={() => setOpen(false)} title="New campaign" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.name.trim()}>Create</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <Field label="Description"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Audience segment (optional)">
            <Select value={form.segmentId} onChange={(e) => setForm({ ...form, segmentId: e.target.value })}>
              <option value="">No segment</option>
              {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
      </Modal>

      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.campaign?.name} subtitle={detail?.campaign?.description} width={560}>
        {detail && (
          <div className="p-4 flex flex-col gap-4">
            <StatStrip>
              <Stat label="WhatsApp sent" value={detail.analytics.whatsapp.sent} />
              <Stat label="Delivered" value={detail.analytics.whatsapp.delivered} />
              <Stat label="Read" value={detail.analytics.whatsapp.read} />
              <Stat label="Posts published" value={detail.analytics.socialPosts.published} />
            </StatStrip>

            <div>
              <div className="eyebrow mb-1.5 flex items-center gap-1.5"><CalendarDays size={12} /> Linked social posts</div>
              {detail.posts.length === 0 ? <p className="text-xs text-muted">None linked yet.</p> : (
                <div className="flex flex-col gap-1">
                  {detail.posts.map((p) => <div key={p.id} className="text-xs flex items-center justify-between"><span className="truncate">{p.content || '(no text)'}</span><Chip tone={p.status === 'published' ? 'success' : 'neutral'}>{p.status}</Chip></div>)}
                </div>
              )}
              {canManage && (
                <div className="flex gap-1.5 mt-2">
                  <Select className="h-7 flex-1" value={linkPostId} onChange={(e) => setLinkPostId(e.target.value)}>
                    <option value="">Link an existing post…</option>
                    {posts.map((p) => <option key={p.id} value={p.id}>{(p.content || '(no text)').slice(0, 40)}</option>)}
                  </Select>
                  <Button size="sm" icon={Link2} onClick={linkPost} disabled={!linkPostId}>Link</Button>
                </div>
              )}
            </div>

            <div>
              <div className="eyebrow mb-1.5 flex items-center gap-1.5"><MessageCircle size={12} /> Linked WhatsApp campaigns</div>
              {detail.whatsappCampaigns.length === 0 ? <p className="text-xs text-muted">None linked yet.</p> : (
                <div className="flex flex-col gap-1">
                  {detail.whatsappCampaigns.map((c) => <div key={c.id} className="text-xs flex items-center justify-between"><span>{c.name}</span><span className="tabular-nums text-muted">{c.sent_count}/{c.total_recipients} sent</span></div>)}
                </div>
              )}
              {canManage && (
                <div className="flex gap-1.5 mt-2">
                  <Select className="h-7 flex-1" value={linkWaId} onChange={(e) => setLinkWaId(e.target.value)}>
                    <option value="">Link an existing WhatsApp campaign…</option>
                    {waCampaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                  <Button size="sm" icon={Link2} onClick={linkWhatsapp} disabled={!linkWaId}>Link</Button>
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}

// ------------------------------------------------------------ Automation

function AutomationTab({ authFetch, canAdmin }) {
  const [rules, setRules] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [runsFor, setRunsFor] = useState(null);
  const [runs, setRuns] = useState(null);
  const [form, setForm] = useState({ name: '', triggerType: 'contact_created', actionType: 'add_tag', tag: '', taskSubject: '' });

  const load = () => { authFetch(`${MKT_API_BASE}/automation-rules`).then((r) => r.json()).then((d) => setRules(d.rules || [])).catch((e) => setError(e.message)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const actionConfig = form.actionType === 'create_task' ? { subject: form.taskSubject } : { tag: form.tag };
      const res = await authFetch(`${MKT_API_BASE}/automation-rules`, {
        method: 'POST',
        body: JSON.stringify({ name: form.name, triggerType: form.triggerType, actionType: form.actionType, actionConfig })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create rule.');
      setRules((prev) => [data.rule, ...(prev || [])]);
      setOpen(false);
      setForm({ name: '', triggerType: 'contact_created', actionType: 'add_tag', tag: '', taskSubject: '' });
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleActive = async (rule) => {
    try {
      const res = await authFetch(`${MKT_API_BASE}/automation-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !rule.is_active }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update rule.');
      setRules((prev) => prev.map((r) => (r.id === rule.id ? data.rule : r)));
    } catch (err) {
      setError(err.message);
    }
  };

  const viewRuns = async (rule) => {
    setRunsFor(rule);
    const res = await authFetch(`${MKT_API_BASE}/automation-rules/${rule.id}/runs`);
    const data = await res.json();
    setRuns(data.runs || []);
  };

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Automation rules"
          meta="Fires from real Sales Hub events — contact and deal changes"
          action={canAdmin && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New rule</Button>}
        />
        {rules === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : rules.length === 0 ? (
          <EmptyState icon={Zap} title="No automation rules yet" description="E.g. tag a contact when a deal is won, or create a follow-up task when one is lost." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>When</Th><Th>Then</Th><Th>Active</Th><Th align="right"> </Th></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="hover:bg-canvas transition-colors">
                  <Td><span className="font-medium">{r.name}</span></Td>
                  <Td>{TRIGGER_LABELS[r.trigger_type]}</Td>
                  <Td>{ACTION_LABELS[r.action_type]}{r.action_config?.tag ? ` "${r.action_config.tag}"` : ''}</Td>
                  <Td>
                    {canAdmin ? (
                      <button onClick={() => toggleActive(r)}><Chip tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'active' : 'paused'}</Chip></button>
                    ) : (
                      <Chip tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'active' : 'paused'}</Chip>
                    )}
                  </Td>
                  <Td align="right"><Button size="sm" onClick={() => viewRuns(r)}>Runs</Button></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New automation rule"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.name.trim() || (form.actionType !== 'create_task' && !form.tag.trim()) || (form.actionType === 'create_task' && !form.taskSubject.trim())}>Create</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <Field label="When">
            <Select value={form.triggerType} onChange={(e) => setForm({ ...form, triggerType: e.target.value })}>
              {Object.entries(TRIGGER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Then">
            <Select value={form.actionType} onChange={(e) => setForm({ ...form, actionType: e.target.value })}>
              {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          {form.actionType === 'create_task' ? (
            <Field label="Task subject"><Input value={form.taskSubject} onChange={(e) => setForm({ ...form, taskSubject: e.target.value })} placeholder="Follow up with contact" /></Field>
          ) : (
            <Field label="Tag"><Input value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} placeholder="vip" /></Field>
          )}
        </div>
      </Modal>

      <Drawer open={!!runsFor} onClose={() => setRunsFor(null)} title={runsFor?.name} subtitle="Recent firings">
        <div className="p-4">
          {runs === null ? <Skeleton className="h-9" /> : runs.length === 0 ? (
            <p className="text-xs text-muted">This rule hasn&apos;t fired yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {runs.map((run) => (
                <div key={run.id} className="flex items-center justify-between text-xs border-b border-hairline pb-2">
                  <span>{new Date(run.ran_at).toLocaleString()}</span>
                  <Chip tone={run.status === 'success' ? 'success' : 'danger'}>{run.status}</Chip>
                </div>
              ))}
            </div>
          )}
        </div>
      </Drawer>
    </>
  );
}

// ------------------------------------------------------- Consent & suppression

const CHANNEL_LABELS = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };
const REASON_LABELS = {
  hard_bounce: 'Hard bounce', complaint: 'Spam complaint', manual: 'Manual',
  unsubscribe_link: 'Unsubscribe link', global_unsubscribe: 'Global unsubscribe'
};

/**
 * The admin-facing half of backend/lib/consent.js's model — a contact's
 * own preference-center page (no login, reached from a send's
 * unsubscribe link) is the self-service half; this is where support/ops
 * record a suppression manually (e.g. a customer emails asking to be
 * removed) or review who's been suppressed and why. Every row here is
 * the exact same data every send path checks server-side before
 * queueing — see routes/whatsapp.js's /campaigns/:id/send.
 */
function SuppressionTab({ authFetch, canAdmin }) {
  const [entries, setEntries] = useState(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(null);
  const [channel, setChannel] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ channel: 'whatsapp', identifier: '', reason: 'manual' });
  const [pendingDelete, setPendingDelete] = useState(null);
  const pageSize = 25;

  const load = () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (channel) params.set('channel', channel);
    if (search) params.set('search', search);
    authFetch(`${MKT_API_BASE}/suppression-list?${params}`)
      .then((r) => r.json())
      .then((d) => { setEntries(d.entries || []); setTotal(d.total ?? 0); })
      .catch((e) => setError(e.message));
  };
  useEffect(load, [page, channel, search]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const res = await authFetch(`${MKT_API_BASE}/suppression-list`, { method: 'POST', body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add suppression entry.');
      setOpen(false);
      setForm({ channel: 'whatsapp', identifier: '', reason: 'manual' });
      setPage(1);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      const res = await authFetch(`${MKT_API_BASE}/suppression-list/${pendingDelete.id}`, { method: 'DELETE' });
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Could not remove entry.'); }
      setPendingDelete(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <Banner tone="info" className="mb-3">
        Suppressed identifiers are blocked from every send server-side, automatically — this list is for visibility and manual
        additions, not something a sender needs to check by hand. A contact can also unsubscribe themselves from their own
        preference-center link.
      </Banner>
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Suppression list"
          meta={total !== null ? `${total} total` : undefined}
          action={
            <div className="flex items-center gap-2">
              <Input placeholder="Search identifier…" value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} className="h-8 w-44" aria-label="Search suppression list" />
              <Select value={channel} onChange={(e) => { setPage(1); setChannel(e.target.value); }} className="h-8" aria-label="Filter by channel">
                <option value="">All channels</option>
                {Object.entries(CHANNEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
              <IconButton icon={RefreshCw} label="Refresh" onClick={load} />
              {canAdmin && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>Add suppression</Button>}
            </div>
          }
        />
        {entries === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : entries.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="Nothing suppressed" description="Hard bounces, spam complaints, global unsubscribes and manual additions will show up here." />
        ) : (
          <Table>
            <thead><tr><Th>Channel</Th><Th>Identifier</Th><Th>Reason</Th><Th>Added</Th>{canAdmin && <Th align="right"> </Th>}</tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-canvas transition-colors">
                  <Td><Chip tone="neutral">{CHANNEL_LABELS[e.channel] || e.channel}</Chip></Td>
                  <Td><span className="font-mono text-xs">{e.identifier}</span></Td>
                  <Td>{REASON_LABELS[e.reason] || e.reason}</Td>
                  <Td>{new Date(e.created_at).toLocaleDateString()}</Td>
                  {canAdmin && (
                    <Td align="right">
                      <IconButton icon={Trash2} label={`Remove suppression for ${e.identifier}`} onClick={() => setPendingDelete(e)} />
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
      </Panel>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a manual suppression"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.identifier.trim()}>Add</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Channel">
            <Select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              {Object.entries(CHANNEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label={form.channel === 'email' ? 'Email address' : 'Phone number'}>
            <Input value={form.identifier} onChange={(e) => setForm({ ...form, identifier: e.target.value })} placeholder={form.channel === 'email' ? 'name@company.com' : '91XXXXXXXXXX'} autoFocus />
          </Field>
          <Field label="Reason">
            <Select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              {Object.entries(REASON_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Remove this suppression?"
        body={pendingDelete ? `${pendingDelete.identifier} will become eligible for ${CHANNEL_LABELS[pendingDelete.channel] || pendingDelete.channel} sends again.` : ''}
        confirmLabel="Remove"
        onConfirm={remove}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}

export default MarketingHub;
