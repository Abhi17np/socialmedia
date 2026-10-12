'use client';

import { useEffect, useState } from 'react';
import {
  RefreshCw, Plus, Building2, Users, KanbanSquare, ListChecks,
  Phone, Mail, Calendar, StickyNote, CheckSquare, IndianRupee
} from 'lucide-react';
import { API_BASE } from '../apiBase';
import { atLeast } from '../roleRank';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Textarea, Select, Field,
  Banner, Modal, Drawer, EmptyState, Skeleton, Chip, FilterPill, Avatar
} from '../ui';

const SALES_API_BASE = `${API_BASE}/sales`;

const TABS = [
  { key: 'pipeline', label: 'Pipeline', icon: KanbanSquare },
  { key: 'companies', label: 'Companies', icon: Building2 },
  { key: 'contacts', label: 'Leads', icon: Users },
  { key: 'activities', label: 'Activities', icon: ListChecks }
];

const ACTIVITY_ICON = { call: Phone, email: Mail, meeting: Calendar, note: StickyNote, task: CheckSquare };
const LEAD_STATUS_TONE = { new: 'neutral', contacted: 'info', qualified: 'brand', unqualified: 'danger', customer: 'success' };

function money(amount, currency) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format(amount || 0);
}

/**
 * Sales Hub: practical CRM over the existing contacts spine. Every tab
 * calls the real routes/sales.js API — no placeholder data, no fake
 * success states. If a tenant's Sales Hub isn't enabled yet, every call
 * here 403s with HUB_NOT_ENABLED and this screen shows that plainly
 * rather than pretending the feature works.
 */
function SalesHub({ authFetch, role }) {
  const [tab, setTab] = useState('pipeline');
  const [gateError, setGateError] = useState(null);
  const canManage = atLeast(role, 'member');
  const canDelete = atLeast(role, 'admin');

  const checkGate = () => {
    authFetch(`${SALES_API_BASE}/pipelines`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => setGateError(ok ? null : data.code === 'HUB_NOT_ENABLED' ? data.error : null))
      .catch(() => {});
  };

  useEffect(checkGate, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (gateError) {
    return (
      <Page>
        <PageBar title="Sales Hub" />
        <PageBody width="narrow">
          <Banner tone="warning">{gateError}</Banner>
        </PageBody>
      </Page>
    );
  }

  return (
    <Page>
      <PageBar title="Sales Hub">
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
        {tab === 'pipeline' && <PipelineTab authFetch={authFetch} canManage={canManage} />}
        {tab === 'companies' && <CompaniesTab authFetch={authFetch} canManage={canManage} canDelete={canDelete} />}
        {tab === 'contacts' && <ContactsTab authFetch={authFetch} canManage={canManage} />}
        {tab === 'activities' && <ActivitiesTab authFetch={authFetch} canManage={canManage} canDelete={canDelete} />}
      </PageBody>
    </Page>
  );
}

// -------------------------------------------------------------- Pipeline

function PipelineTab({ authFetch, canManage }) {
  const [pipelines, setPipelines] = useState(null);
  const [activePipelineId, setActivePipelineId] = useState(null);
  const [deals, setDeals] = useState(null);
  const [error, setError] = useState(null);
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newDealOpen, setNewDealOpen] = useState(null); // stageId or null
  const [pipelineName, setPipelineName] = useState('');
  const [dealForm, setDealForm] = useState({ name: '', amount: '' });
  const [draggingDeal, setDraggingDeal] = useState(null);

  const loadPipelines = () => {
    authFetch(`${SALES_API_BASE}/pipelines`).then((r) => r.json()).then((d) => {
      setPipelines(d.pipelines || []);
      if (!activePipelineId && d.pipelines && d.pipelines.length > 0) setActivePipelineId(d.pipelines[0].id);
    }).catch((e) => setError(e.message));
  };

  const loadDeals = (pipelineId) => {
    if (!pipelineId) return;
    authFetch(`${SALES_API_BASE}/deals?pipelineId=${pipelineId}`).then((r) => r.json()).then((d) => setDeals(d.deals || [])).catch((e) => setError(e.message));
  };

  useEffect(loadPipelines, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => loadDeals(activePipelineId), [activePipelineId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pipeline = (pipelines || []).find((p) => p.id === activePipelineId);

  const createPipeline = async () => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/pipelines`, { method: 'POST', body: JSON.stringify({ name: pipelineName }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create pipeline.');
      setPipelines((prev) => [...(prev || []), data.pipeline]);
      setActivePipelineId(data.pipeline.id);
      setNewPipelineOpen(false);
      setPipelineName('');
    } catch (err) {
      setError(err.message);
    }
  };

  const createDeal = async (stageId) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/deals`, {
        method: 'POST',
        body: JSON.stringify({ name: dealForm.name, pipelineId: activePipelineId, stageId, amount: Number(dealForm.amount) || 0 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create deal.');
      setDeals((prev) => [...(prev || []), data.deal]);
      setNewDealOpen(null);
      setDealForm({ name: '', amount: '' });
    } catch (err) {
      setError(err.message);
    }
  };

  const moveDeal = async (deal, stageId) => {
    if (deal.stage_id === stageId) return;
    setDeals((prev) => prev.map((d) => (d.id === deal.id ? { ...d, stage_id: stageId } : d))); // optimistic
    try {
      const res = await authFetch(`${SALES_API_BASE}/deals/${deal.id}/move`, { method: 'POST', body: JSON.stringify({ stageId }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not move deal.');
      setDeals((prev) => prev.map((d) => (d.id === deal.id ? data.deal : d)));
    } catch (err) {
      setError(err.message);
      loadDeals(activePipelineId); // revert optimistic update on failure
    }
  };

  if (pipelines === null) return <Skeleton className="h-64" />;

  if (pipelines.length === 0) {
    return (
      <>
        <EmptyState icon={KanbanSquare} title="No pipeline yet" description="Create a pipeline to start tracking deals." action={canManage && <Button variant="primary" icon={Plus} onClick={() => setNewPipelineOpen(true)}>New pipeline</Button>} />
        <PipelineModal open={newPipelineOpen} name={pipelineName} setName={setPipelineName} onClose={() => setNewPipelineOpen(false)} onCreate={createPipeline} />
      </>
    );
  }

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="flex items-center justify-between">
        <Select value={activePipelineId || ''} onChange={(e) => setActivePipelineId(e.target.value)} className="w-56">
          {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <div className="flex items-center gap-2">
          <IconButton icon={RefreshCw} label="Refresh" onClick={() => loadDeals(activePipelineId)} />
          {canManage && <Button size="sm" icon={Plus} onClick={() => setNewPipelineOpen(true)}>New pipeline</Button>}
        </div>
      </div>

      {deals === null || !pipeline ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {pipeline.stages.map((stage) => {
            const stageDeals = deals.filter((d) => d.stage_id === stage.id);
            const total = stageDeals.reduce((sum, d) => sum + Number(d.amount || 0), 0);
            return (
              <div
                key={stage.id}
                className="w-72 shrink-0 bg-sunken border border-hairline rounded-card flex flex-col"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => draggingDeal && moveDeal(draggingDeal, stage.id)}
              >
                <div className="px-3 py-2.5 border-b border-hairline flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs font-semibold text-ink truncate">{stage.name}</span>
                    <span className="text-[11px] text-subtle shrink-0">{stageDeals.length}</span>
                  </div>
                  <span className="text-[11px] tabular-nums text-muted shrink-0">{money(total)}</span>
                </div>
                <div className="p-2 flex flex-col gap-2 min-h-[80px]">
                  {stageDeals.map((deal) => (
                    <div
                      key={deal.id}
                      draggable={canManage}
                      onDragStart={() => setDraggingDeal(deal)}
                      onDragEnd={() => setDraggingDeal(null)}
                      className="bg-card border border-hairline rounded-ui p-2.5 cursor-grab active:cursor-grabbing hover:border-brand transition-colors"
                    >
                      <div className="text-xs font-medium text-ink truncate">{deal.name}</div>
                      <div className="flex items-center gap-1 mt-1 text-[11px] text-muted tabular-nums">
                        <IndianRupee size={10} />{money(deal.amount, deal.currency).replace(/^[^\d]+/, '')}
                      </div>
                    </div>
                  ))}
                  {canManage && (
                    newDealOpen === stage.id ? (
                      <div className="bg-card border border-hairline rounded-ui p-2 flex flex-col gap-1.5">
                        <Input autoFocus placeholder="Deal name" value={dealForm.name} onChange={(e) => setDealForm({ ...dealForm, name: e.target.value })} className="h-7 text-xs" />
                        <Input placeholder="Amount" type="number" value={dealForm.amount} onChange={(e) => setDealForm({ ...dealForm, amount: e.target.value })} className="h-7 text-xs" />
                        <div className="flex gap-1.5">
                          <Button size="sm" variant="primary" disabled={!dealForm.name.trim()} onClick={() => createDeal(stage.id)}>Add</Button>
                          <Button size="sm" onClick={() => setNewDealOpen(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => setNewDealOpen(stage.id)} className="text-[11px] text-muted hover:text-ink flex items-center gap-1 px-1.5 py-1">
                        <Plus size={12} /> Add deal
                      </button>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <PipelineModal open={newPipelineOpen} name={pipelineName} setName={setPipelineName} onClose={() => setNewPipelineOpen(false)} onCreate={createPipeline} />
    </>
  );
}

function PipelineModal({ open, name, setName, onClose, onCreate }) {
  return (
    <Modal open={open} onClose={onClose} title="New pipeline" subtitle="Starts with 5 practical stages — New, Qualified, Proposal, Won, Lost." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={onCreate} disabled={!name.trim()}>Create</Button></>}>
      <Field label="Pipeline name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Enterprise sales" autoFocus /></Field>
    </Modal>
  );
}

// -------------------------------------------------------------- Companies

function CompaniesTab({ authFetch, canManage, canDelete }) {
  const [companies, setCompanies] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({ name: '', domain: '', industry: '' });

  const load = () => { authFetch(`${SALES_API_BASE}/companies`).then((r) => r.json()).then((d) => setCompanies(d.companies || [])).catch((e) => setError(e.message)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/companies`, { method: 'POST', body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create company.');
      setCompanies((prev) => [data.company, ...(prev || [])]);
      setOpen(false);
      setForm({ name: '', domain: '', industry: '' });
    } catch (err) {
      setError(err.message);
    }
  };

  const openDetail = async (company) => {
    const res = await authFetch(`${SALES_API_BASE}/companies/${company.id}`);
    const data = await res.json();
    if (res.ok) setDetail(data);
  };

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <Panel className="overflow-hidden">
        <PanelHeader title="Companies" action={canManage && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New company</Button>} />
        {companies === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : companies.length === 0 ? (
          <EmptyState icon={Building2} title="No companies yet" description="Track the organizations your contacts belong to." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Industry</Th><Th>Domain</Th></tr></thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="hover:bg-canvas transition-colors cursor-pointer" onClick={() => openDetail(c)}>
                  <Td><span className="font-medium">{c.name}</span></Td>
                  <Td>{c.industry || '—'}</Td>
                  <Td>{c.domain || '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Modal open={open} onClose={() => setOpen(false)} title="New company" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.name.trim()}>Create</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <Field label="Industry"><Input value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} /></Field>
          <Field label="Domain"><Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="acme.com" /></Field>
        </div>
      </Modal>

      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.company?.name} subtitle={detail?.company?.industry}>
        {detail && (
          <div className="p-4 flex flex-col gap-4">
            <div>
              <div className="eyebrow mb-1.5">Contacts ({detail.contacts.length})</div>
              {detail.contacts.length === 0 ? <p className="text-xs text-muted">No contacts linked yet.</p> : (
                <div className="flex flex-col gap-1.5">
                  {detail.contacts.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 text-xs"><Avatar name={c.display_name} size={22} /><span>{c.display_name}</span><Chip tone={LEAD_STATUS_TONE[c.lead_status]}>{c.lead_status}</Chip></div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="eyebrow mb-1.5">Deals ({detail.deals.length})</div>
              {detail.deals.length === 0 ? <p className="text-xs text-muted">No deals yet.</p> : (
                <div className="flex flex-col gap-1.5">
                  {detail.deals.map((d) => (
                    <div key={d.id} className="flex items-center justify-between text-xs"><span>{d.name}</span><span className="tabular-nums text-muted">{money(d.amount)}</span></div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}

// --------------------------------------------------------------- Contacts

function ContactsTab({ authFetch, canManage }) {
  const [contacts, setContacts] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ displayName: '', phone: '', email: '' });

  const load = () => { authFetch(`${SALES_API_BASE}/contacts`).then((r) => r.json()).then((d) => setContacts(d.contacts || [])).catch((e) => setError(e.message)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/contacts`, { method: 'POST', body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create lead.');
      setContacts((prev) => [data.contact, ...(prev || [])]);
      setOpen(false);
      setForm({ displayName: '', phone: '', email: '' });
    } catch (err) {
      setError(err.message);
    }
  };

  const changeStatus = async (contact, leadStatus) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/contacts/${contact.id}`, { method: 'PATCH', body: JSON.stringify({ leadStatus }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update lead.');
      setContacts((prev) => prev.map((c) => (c.id === contact.id ? data.contact : c)));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <Panel className="overflow-hidden">
        <PanelHeader title="Leads" meta="Every contact across your channels, with CRM status" action={canManage && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New lead</Button>} />
        {contacts === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : contacts.length === 0 ? (
          <EmptyState icon={Users} title="No leads yet" description="Leads also appear here automatically from inbound WhatsApp, Instagram and Facebook messages." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Phone</Th><Th>Email</Th><Th>Status</Th></tr></thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="hover:bg-canvas transition-colors">
                  <Td><span className="flex items-center gap-2"><Avatar name={c.display_name} size={24} />{c.display_name}</span></Td>
                  <Td>{c.phone || '—'}</Td>
                  <Td>{c.email || '—'}</Td>
                  <Td>
                    {canManage ? (
                      <Select className="h-7" value={c.lead_status} onChange={(e) => changeStatus(c, e.target.value)}>
                        {['new', 'contacted', 'qualified', 'unqualified', 'customer'].map((s) => <option key={s} value={s}>{s}</option>)}
                      </Select>
                    ) : (
                      <Chip tone={LEAD_STATUS_TONE[c.lead_status]}>{c.lead_status}</Chip>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Modal open={open} onClose={() => setOpen(false)} title="New lead" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.displayName.trim()}>Create</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} autoFocus /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

// ------------------------------------------------------------ Activities

function ActivitiesTab({ authFetch, canManage }) {
  const [activities, setActivities] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ type: 'call', subject: '', notes: '' });

  const load = () => { authFetch(`${SALES_API_BASE}/activities`).then((r) => r.json()).then((d) => setActivities(d.activities || [])).catch((e) => setError(e.message)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/activities`, { method: 'POST', body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not log activity.');
      setActivities((prev) => [data.activity, ...(prev || [])]);
      setOpen(false);
      setForm({ type: 'call', subject: '', notes: '' });
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleComplete = async (activity) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/activities/${activity.id}`, { method: 'PATCH', body: JSON.stringify({ status: activity.status === 'completed' ? 'open' : 'completed' }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update activity.');
      setActivities((prev) => prev.map((a) => (a.id === activity.id ? data.activity : a)));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <Panel className="overflow-hidden">
        <PanelHeader title="Activities" meta="Calls, emails, meetings, notes and tasks" action={canManage && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>Log activity</Button>} />
        {activities === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : activities.length === 0 ? (
          <EmptyState icon={ListChecks} title="No activities logged yet" description="Calls, emails and follow-ups show up here." />
        ) : (
          <div>
            {activities.map((a) => {
              const Icon = ACTIVITY_ICON[a.type] || StickyNote;
              return (
                <div key={a.id} className="px-4 py-3 border-b border-hairline flex items-start gap-3 hover:bg-canvas transition-colors">
                  <span className="w-7 h-7 rounded-ui bg-canvas border border-hairline flex items-center justify-center shrink-0 text-muted"><Icon size={14} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-ink">{a.subject}</div>
                    {a.notes && <p className="text-[11px] text-muted mt-0.5">{a.notes}</p>}
                  </div>
                  <button onClick={() => toggleComplete(a)} className="shrink-0">
                    <Chip tone={a.status === 'completed' ? 'success' : 'neutral'}>{a.status}</Chip>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Modal open={open} onClose={() => setOpen(false)} title="Log activity" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.subject.trim()}>Save</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {['call', 'email', 'meeting', 'note', 'task'].map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Subject"><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} autoFocus /></Field>
          <Field label="Notes"><Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

export default SalesHub;
