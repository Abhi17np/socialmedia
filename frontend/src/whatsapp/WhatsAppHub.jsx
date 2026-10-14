'use client';

import { useEffect, useState } from 'react';
import {
  RefreshCw, Plus, Send, Ban, Trash2, FileText, Users, Megaphone,
  CheckCircle2, Clock, XCircle, Radio
} from 'lucide-react';
import { API_BASE } from '../apiBase';
import { atLeast } from '../roleRank';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Textarea, Select, Field,
  Banner, Modal, ConfirmDialog, EmptyState, Skeleton, Chip, FilterPill, StatStrip, Stat, Drawer, PillSelect
} from '../ui';
import SegmentRuleBuilder, { emptySegmentRoot } from '../marketing/SegmentRuleBuilder';

const WA_API_BASE = `${API_BASE}/whatsapp`;
const SOCIAL_API_BASE = `${API_BASE}/social`;
const MKT_API_BASE = `${API_BASE}/marketing`;

const TABS = [
  { key: 'templates', label: 'Templates', icon: FileText },
  { key: 'segments', label: 'Audience', icon: Users },
  { key: 'campaigns', label: 'Campaigns', icon: Megaphone }
];

const APPROVAL_TONE = { draft: 'neutral', pending: 'warning', approved: 'success', rejected: 'danger' };
const CAMPAIGN_TONE = { draft: 'neutral', scheduled: 'info', sending: 'warning', completed: 'success', failed: 'danger', canceled: 'neutral' };

/**
 * WhatsApp outbound: template management, audience segmentation and
 * broadcast campaigns — the UI half of routes/whatsapp.js. Every action
 * here calls the real backend; nothing is a placeholder. The one thing
 * that genuinely can't be made to work from this screen is a template
 * actually reaching real customers before Meta approves it — that
 * boundary is surfaced directly (the Send button is disabled with an
 * explanation) rather than hidden.
 */
function WhatsAppHub({ authFetch, role }) {
  const [tab, setTab] = useState('templates');
  const [templates, setTemplates] = useState(null);
  const [segments, setSegments] = useState(null);
  const [campaigns, setCampaigns] = useState(null);
  const [whatsappAccounts, setWhatsappAccounts] = useState(null);
  const [error, setError] = useState(null);

  const canManage = atLeast(role, 'member');
  const canSend = atLeast(role, 'admin');

  const load = () => {
    authFetch(`${SOCIAL_API_BASE}/accounts`).then((r) => r.json()).then((d) => setWhatsappAccounts((d.accounts || []).filter((a) => a.platform === 'whatsapp'))).catch((e) => setError(e.message));
    authFetch(`${WA_API_BASE}/templates`).then((r) => r.json()).then((d) => setTemplates(d.templates || [])).catch((e) => setError(e.message));
    authFetch(`${WA_API_BASE}/segments`).then((r) => r.json()).then((d) => setSegments(d.segments || [])).catch((e) => setError(e.message));
    authFetch(`${WA_API_BASE}/campaigns`).then((r) => r.json()).then((d) => setCampaigns(d.campaigns || [])).catch((e) => setError(e.message));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Page>
      <PageBar
        title="WhatsApp Broadcast"
        actions={<IconButton icon={RefreshCw} label="Refresh" onClick={load} />}
      >
        <div className="flex items-center gap-1 ml-2">
          {TABS.map((t) => (
            <FilterPill key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
              <t.icon size={12} />
              {t.label}
            </FilterPill>
          ))}
        </div>
      </PageBar>

      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {whatsappAccounts !== null && whatsappAccounts.length === 0 && (
          <Banner tone="warning">
            No WhatsApp account is connected yet. Connect one under Channels before creating templates or campaigns.
          </Banner>
        )}

        {tab === 'templates' && (
          <TemplatesTab
            authFetch={authFetch}
            templates={templates}
            setTemplates={setTemplates}
            accounts={whatsappAccounts}
            canManage={canManage}
            canSubmit={canSend}
            setError={setError}
          />
        )}
        {tab === 'segments' && (
          <SegmentsTab authFetch={authFetch} segments={segments} setSegments={setSegments} canManage={canManage} setError={setError} />
        )}
        {tab === 'campaigns' && (
          <CampaignsTab
            authFetch={authFetch}
            campaigns={campaigns}
            setCampaigns={setCampaigns}
            templates={templates || []}
            segments={segments || []}
            accounts={whatsappAccounts}
            canManage={canManage}
            canSend={canSend}
            setError={setError}
          />
        )}
      </PageBody>
    </Page>
  );
}

// ------------------------------------------------------------- Templates

function TemplatesTab({ authFetch, templates, setTemplates, accounts, canManage, canSubmit, setError }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState({ name: '', language: 'en_US', category: 'utility', bodyText: '', socialAccountId: '' });

  const create = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`${WA_API_BASE}/templates`, {
        method: 'POST',
        body: JSON.stringify({ ...form, variableSamples: [] })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create template.');
      setTemplates((prev) => [data.template, ...(prev || [])]);
      setOpen(false);
      setForm({ name: '', language: 'en_US', category: 'utility', bodyText: '', socialAccountId: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const submit = async (tpl) => {
    try {
      const res = await authFetch(`${WA_API_BASE}/templates/${tpl.id}/submit`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit template to Meta.');
      setTemplates((prev) => prev.map((t) => (t.id === tpl.id ? data.template : t)));
    } catch (err) {
      setError(err.message);
    }
  };

  const sync = async (accountId) => {
    try {
      const res = await authFetch(`${WA_API_BASE}/templates/sync`, { method: 'POST', body: JSON.stringify({ socialAccountId: accountId }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not sync template statuses.');
      const refreshed = await authFetch(`${WA_API_BASE}/templates`).then((r) => r.json());
      setTemplates(refreshed.templates || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (tpl) => {
    try {
      const res = await authFetch(`${WA_API_BASE}/templates/${tpl.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not delete template.');
      }
      setTemplates((prev) => prev.filter((t) => t.id !== tpl.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <>
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Message templates"
          meta="Pre-approved by Meta before they can be sent outside an open conversation"
          action={
            canManage && (
              <div className="flex items-center gap-2">
                {accounts && accounts.length > 0 && (
                  <Button size="sm" icon={RefreshCw} onClick={() => sync(accounts[0].id)}>
                    Sync status
                  </Button>
                )}
                <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)} disabled={!accounts || accounts.length === 0}>
                  New template
                </Button>
              </div>
            )
          }
        />
        {templates === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : templates.length === 0 ? (
          <EmptyState icon={FileText} title="No templates yet" description="Create a template, submit it for Meta's review, then use it in a campaign once approved." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Category</Th><Th>Language</Th><Th>Status</Th><Th align="right"> </Th></tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="hover:bg-canvas transition-colors">
                  <Td><span className="font-mono text-[12px]">{t.name}</span></Td>
                  <Td className="capitalize">{t.category}</Td>
                  <Td>{t.language}</Td>
                  <Td>
                    <Chip tone={APPROVAL_TONE[t.approval_status] || 'neutral'}>{t.approval_status}</Chip>
                    {t.rejected_reason && <span className="ml-2 text-[11px] text-danger">{t.rejected_reason}</span>}
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-1.5">
                      {canSubmit && t.approval_status === 'draft' && (
                        <Button size="sm" onClick={() => submit(t)}>Submit to Meta</Button>
                      )}
                      {canManage && (
                        <IconButton icon={Trash2} label="Delete" onClick={() => setConfirmDelete(t)} />
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New template"
        subtitle="Use {{1}}, {{2}}… for placeholders Meta will ask for sample values when reviewing."
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={create} loading={saving} disabled={!form.name.trim() || !form.bodyText.trim() || !form.socialAccountId}>
              Create
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="WhatsApp account">
            <Select value={form.socialAccountId} onChange={(e) => setForm({ ...form, socialAccountId: e.target.value })}>
              <option value="">Select account…</option>
              {(accounts || []).map((a) => <option key={a.id} value={a.id}>{a.account_label || a.id.slice(0, 8)}</option>)}
            </Select>
          </Field>
          <Field label="Template name" hint="Lowercase letters, numbers and underscores only.">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} placeholder="order_update" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option value="utility">Utility</option>
                <option value="marketing">Marketing</option>
                <option value="authentication">Authentication</option>
              </Select>
            </Field>
            <Field label="Language">
              <Input value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} placeholder="en_US" />
            </Field>
          </div>
          <Field label="Message body">
            <Textarea rows={4} value={form.bodyText} onChange={(e) => setForm({ ...form, bodyText: e.target.value })} placeholder="Hi {{1}}, your order {{2}} has shipped." />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete this template?"
        body={`"${confirmDelete?.name}" will be removed. Campaigns that already used it keep their history.`}
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => remove(confirmDelete)}
      />
    </>
  );
}

// -------------------------------------------------------------- Segments

function segmentSummary(segment) {
  if (segment.segment_type === 'static') return 'Hand-picked list';
  const filter = segment.filter_json;
  if (filter?.version === 2) {
    const groupCount = filter.root?.children?.length || 0;
    const condCount = (filter.root?.children || []).reduce((n, g) => n + (g.children?.length || 0), 0);
    return `${condCount} condition${condCount === 1 ? '' : 's'} in ${groupCount} group${groupCount === 1 ? '' : 's'}`;
  }
  const parts = [];
  if (filter?.tags?.length) parts.push(`tagged ${filter.tags.join(', ')}`);
  if (filter?.hasPhone) parts.push('has phone');
  return parts.join(' · ') || 'All contacts';
}

function SegmentsTab({ authFetch, segments, setSegments, canManage, setError }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState({});
  const [form, setForm] = useState({ name: '', description: '', segmentType: 'dynamic', legacyTags: '', hasPhone: true, root: emptySegmentRoot() });
  const [members, setMembers] = useState(null); // the static segment currently open in the "Manage members" drawer

  const resetForm = () => setForm({ name: '', description: '', segmentType: 'dynamic', legacyTags: '', hasPhone: true, root: emptySegmentRoot() });

  const create = async () => {
    setSaving(true);
    try {
      const filter = form.segmentType === 'static' ? {} : { version: 2, root: form.root };
      const res = await authFetch(`${WA_API_BASE}/segments`, {
        method: 'POST',
        body: JSON.stringify({ name: form.name, description: form.description, segmentType: form.segmentType, filter })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create segment.');
      setSegments((prev) => [data.segment, ...(prev || [])]);
      setOpen(false);
      resetForm();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const loadPreview = async (segment) => {
    try {
      const res = await authFetch(`${WA_API_BASE}/segments/${segment.id}/preview`);
      const data = await res.json();
      if (res.ok) setPreview((prev) => ({ ...prev, [segment.id]: { count: data.whatsappEligibleCount, suppressed: data.suppressedCount || 0 } }));
    } catch {
      /* preview is a convenience, not critical — leave blank on failure */
    }
  };

  const refreshPreview = (segment) => loadPreview(segment);

  useEffect(() => {
    (segments || []).forEach((s) => { if (preview[s.id] === undefined) loadPreview(s); });
  }, [segments]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Audience segments"
          meta="Dynamic segments re-resolve every time a campaign sends; static lists are hand-picked"
          action={canManage && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New segment</Button>}
        />
        {segments === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : segments.length === 0 ? (
          <EmptyState icon={Users} title="No segments yet" description="Build a rule-based segment or a hand-picked list, then target it from a campaign." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Type</Th><Th>Rule</Th><Th>WhatsApp-eligible</Th>{canManage && <Th align="right"> </Th>}</tr></thead>
            <tbody>
              {segments.map((s) => (
                <tr key={s.id} className="hover:bg-canvas transition-colors">
                  <Td><span className="font-medium">{s.name}</span>{s.description && <div className="text-[11px] text-muted">{s.description}</div>}</Td>
                  <Td><Chip tone={s.segment_type === 'static' ? 'neutral' : 'brand'}>{s.segment_type === 'static' ? 'Static' : 'Dynamic'}</Chip></Td>
                  <Td><span className="text-xs text-muted">{segmentSummary(s)}</span></Td>
                  <Td>
                    <span className="tabular-nums font-medium">{preview[s.id]?.count ?? '…'}</span>
                    {!!preview[s.id]?.suppressed && <span className="text-[11px] text-muted ml-1">({preview[s.id].suppressed} suppressed)</span>}
                  </Td>
                  {canManage && (
                    <Td align="right">
                      {s.segment_type === 'static' && <Button size="sm" onClick={() => setMembers(s)}>Manage members</Button>}
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New segment"
        width={640}
        footer={<><Button onClick={() => setOpen(false)} disabled={saving}>Cancel</Button><Button variant="primary" onClick={create} loading={saving} disabled={!form.name.trim()}>Create</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="VIP customers" autoFocus /></Field>
          <Field label="Description (optional)"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Type">
            <PillSelect value={form.segmentType} onChange={(e) => setForm({ ...form, segmentType: e.target.value })} aria-label="Segment type">
              <option value="dynamic">Dynamic — matches a rule</option>
              <option value="static">Static — a hand-picked list</option>
            </PillSelect>
          </Field>
          {form.segmentType === 'dynamic' ? (
            <SegmentRuleBuilder value={form.root} onChange={(root) => setForm({ ...form, root })} authFetch={authFetch} />
          ) : (
            <p className="text-xs text-muted">Add contacts to the list after creating it, from "Manage members".</p>
          )}
        </div>
      </Modal>

      <SegmentMembersDrawer
        segment={members}
        authFetch={authFetch}
        onClose={() => setMembers(null)}
        onChanged={() => members && refreshPreview(members)}
      />
    </>
  );
}

function SegmentMembersDrawer({ segment, authFetch, onClose, onChanged }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [memberList, setMemberList] = useState(null);
  const [error, setError] = useState(null);

  const loadMembers = async () => {
    if (!segment) return;
    try {
      const res = await authFetch(`${WA_API_BASE}/segments/${segment.id}/preview`);
      const data = await res.json();
      setMemberList(data.whatsappEligibleCount ?? 0);
    } catch {
      setMemberList(null);
    }
  };

  useEffect(() => { setQuery(''); setResults([]); loadMembers(); }, [segment]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async (q) => {
    setQuery(q);
    if (!q.trim()) return setResults([]);
    try {
      const res = await authFetch(`${MKT_API_BASE}/contacts/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setResults(data.contacts || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const add = async (contact) => {
    try {
      const res = await authFetch(`${WA_API_BASE}/segments/${segment.id}/members`, { method: 'POST', body: JSON.stringify({ contactIds: [contact.id] }) });
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Could not add contact.'); }
      setResults((prev) => prev.filter((c) => c.id !== contact.id));
      loadMembers();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Drawer open={!!segment} onClose={onClose} title={segment?.name} subtitle="Manage members" width={440}>
      <div className="p-4 flex flex-col gap-3">
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="text-xs text-muted">{memberList ?? '…'} contact{memberList === 1 ? '' : 's'} in this list</div>
        <Field label="Add a contact" hint="Search by name, phone or email">
          <Input value={query} onChange={(e) => search(e.target.value)} placeholder="Search contacts…" aria-label="Search contacts to add" />
        </Field>
        {results.length > 0 && (
          <div className="flex flex-col gap-1 border border-hairline rounded-ui overflow-hidden">
            {results.map((c) => (
              <button key={c.id} onClick={() => add(c)} className="flex items-center justify-between px-3 py-2 text-xs hover:bg-canvas transition-colors text-left">
                <span>{c.display_name || c.phone || c.email}</span>
                <span className="text-muted">{c.phone || c.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Drawer>
  );
}

// ------------------------------------------------------------- Campaigns

function CampaignsTab({ authFetch, campaigns, setCampaigns, templates, segments, accounts, canManage, canSend, setError }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(null);
  const [form, setForm] = useState({ name: '', socialAccountId: '', templateId: '', segmentId: '' });

  const approvedTemplates = templates.filter((t) => t.approval_status === 'approved');

  const create = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`${WA_API_BASE}/campaigns`, {
        method: 'POST',
        body: JSON.stringify({ name: form.name, socialAccountId: form.socialAccountId, templateId: form.templateId, segmentId: form.segmentId, variableValues: [] })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create campaign.');
      setCampaigns((prev) => [data.campaign, ...(prev || [])]);
      setOpen(false);
      setForm({ name: '', socialAccountId: '', templateId: '', segmentId: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const send = async (campaign) => {
    try {
      const res = await authFetch(`${WA_API_BASE}/campaigns/${campaign.id}/send`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send campaign.');
      const refreshed = await authFetch(`${WA_API_BASE}/campaigns`).then((r) => r.json());
      setCampaigns(refreshed.campaigns || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const cancel = async (campaign) => {
    try {
      const res = await authFetch(`${WA_API_BASE}/campaigns/${campaign.id}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not cancel campaign.');
      const refreshed = await authFetch(`${WA_API_BASE}/campaigns`).then((r) => r.json());
      setCampaigns(refreshed.campaigns || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmCancel(null);
    }
  };

  const openDetail = async (campaign) => {
    try {
      const res = await authFetch(`${WA_API_BASE}/campaigns/${campaign.id}`);
      const data = await res.json();
      if (res.ok) setDetail(data);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Campaigns"
          action={
            canManage && (
              <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)} disabled={approvedTemplates.length === 0}>
                New campaign
              </Button>
            )
          }
        />
        {approvedTemplates.length === 0 && canManage && (
          <div className="px-4 py-2 border-b border-hairline">
            <Banner tone="warning">No approved templates yet — submit one in the Templates tab and wait for Meta's review before a campaign can send.</Banner>
          </div>
        )}
        {campaigns === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : campaigns.length === 0 ? (
          <EmptyState icon={Megaphone} title="No campaigns yet" description="Pick a template and an audience, then send." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Status</Th><Th>Recipients</Th><Th>Delivered / Read</Th><Th align="right"> </Th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="hover:bg-canvas transition-colors cursor-pointer" onClick={() => openDetail(c)}>
                  <Td><span className="font-medium">{c.name}</span></Td>
                  <Td><Chip tone={CAMPAIGN_TONE[c.status] || 'neutral'}>{c.status}</Chip></Td>
                  <Td><span className="tabular-nums">{c.sent_count}/{c.total_recipients}</span></Td>
                  <Td><span className="tabular-nums">{c.delivered_count} / {c.read_count}</span></Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                      {canSend && ['draft', 'scheduled'].includes(c.status) && (
                        <Button size="sm" variant="primary" icon={Send} onClick={() => send(c)}>Send</Button>
                      )}
                      {canSend && c.status === 'sending' && (
                        <Button size="sm" variant="danger" icon={Ban} onClick={() => setConfirmCancel(c)}>Cancel</Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New campaign"
        footer={<><Button onClick={() => setOpen(false)} disabled={saving}>Cancel</Button><Button variant="primary" onClick={create} loading={saving} disabled={!form.name.trim() || !form.socialAccountId || !form.templateId || !form.segmentId}>Create</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Launch announcement" /></Field>
          <Field label="WhatsApp account">
            <Select value={form.socialAccountId} onChange={(e) => setForm({ ...form, socialAccountId: e.target.value })}>
              <option value="">Select account…</option>
              {(accounts || []).map((a) => <option key={a.id} value={a.id}>{a.account_label || a.id.slice(0, 8)}</option>)}
            </Select>
          </Field>
          <Field label="Template" hint={approvedTemplates.length === 0 ? 'Only Meta-approved templates can be selected.' : undefined}>
            <Select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })}>
              <option value="">Select approved template…</option>
              {approvedTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Audience segment">
            <Select value={form.segmentId} onChange={(e) => setForm({ ...form, segmentId: e.target.value })}>
              <option value="">Select segment…</option>
              {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.campaign?.name} subtitle="Delivery breakdown" width={560}>
        {detail && (
          <div className="flex flex-col gap-4">
            <StatStrip>
              <Stat label="Total" value={detail.campaign.total_recipients} />
              <Stat label="Sent" value={detail.campaign.sent_count} />
              <Stat label="Delivered" value={detail.campaign.delivered_count} />
              <Stat label="Read" value={detail.campaign.read_count} />
              <Stat label="Failed" value={detail.campaign.failed_count} deltaTone={detail.campaign.failed_count > 0 ? 'down' : 'neutral'} />
            </StatStrip>
            <div className="max-h-80 overflow-y-auto border border-hairline rounded-ui">
              <Table>
                <thead><tr><Th>Phone</Th><Th>Status</Th><Th>Error</Th></tr></thead>
                <tbody>
                  {(detail.recipients || []).map((r) => (
                    <tr key={r.id}>
                      <Td className="font-mono text-[12px]">{r.phone}</Td>
                      <Td>
                        <span className="inline-flex items-center gap-1">
                          {r.status === 'delivered' || r.status === 'read' || r.status === 'sent' ? <CheckCircle2 size={13} className="text-success" /> :
                            r.status === 'failed' ? <XCircle size={13} className="text-danger" /> :
                              r.status === 'queued' ? <Radio size={13} className="text-warning" /> : <Clock size={13} className="text-subtle" />}
                          {r.status}
                        </span>
                      </Td>
                      <Td className="text-[11px] text-danger">{r.error}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirmCancel}
        title="Cancel this campaign?"
        body="Recipients not yet sent will be marked failed. Already-sent messages are not affected."
        confirmLabel="Cancel campaign"
        onCancel={() => setConfirmCancel(null)}
        onConfirm={() => cancel(confirmCancel)}
      />
    </>
  );
}

export default WhatsAppHub;
