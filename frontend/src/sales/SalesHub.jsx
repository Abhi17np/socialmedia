'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Plus, Building2, Users, ListChecks,
  Phone, Mail, Calendar, StickyNote, CheckSquare
} from 'lucide-react';
import { API_BASE } from '../apiBase';
import { atLeast } from '../roleRank';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, Panel, PanelHeader, Table, Th, Td, Input, Textarea, Select, Field,
  Banner, Modal, Drawer, EmptyState, Skeleton, Chip, Avatar
} from '../ui';
import DashboardTab from './DashboardTab';
import WorkspaceTab from './WorkspaceTab';
import SettingsTab from './SettingsTab';
import PipelineTab from './PipelineTab';
import { money } from './format';

const SALES_API_BASE = `${API_BASE}/sales`;

const ACTIVITY_ICON = { call: Phone, email: Mail, meeting: Calendar, note: StickyNote, task: CheckSquare };
const LEAD_STATUS_TONE = { new: 'neutral', contacted: 'info', qualified: 'brand', unqualified: 'danger', customer: 'success' };

/**
 * Sales Hub: practical CRM over the existing contacts spine. Every tab
 * calls the real routes/sales.js API — no placeholder data, no fake
 * success states. If a tenant's Sales Hub isn't enabled yet, every call
 * here 403s with HUB_NOT_ENABLED and this screen shows that plainly
 * rather than pretending the feature works.
 *
 * Section (Pipeline/Companies/Leads/Activities) is driven by the
 * sidebar now (src/sales/SalesNav.jsx), via a ?tab= query param instead
 * of an in-page tab row — useSearchParams() needs a Suspense boundary
 * around it, hence the wrapper default export below.
 */
function SalesHubInner({ authFetch, role }) {
  const searchParams = useSearchParams();
  const tab = searchParams.get('tab') || 'dashboard';
  const [gateError, setGateError] = useState(null);
  const canManage = atLeast(role, 'member');
  const canDelete = atLeast(role, 'admin');
  const canAdmin = atLeast(role, 'admin');

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
      <PageBar title="Sales Hub" />
      <PageBody>
        {tab === 'dashboard' && <DashboardTab authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} />}
        {tab === 'workspace' && <WorkspaceTab authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} />}
        {tab === 'pipeline' && <PipelineTab authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} canManage={canManage} canAdmin={canAdmin} />}
        {tab === 'companies' && <CompaniesTab authFetch={authFetch} canManage={canManage} canDelete={canDelete} />}
        {tab === 'contacts' && <ContactsTab authFetch={authFetch} canManage={canManage} />}
        {tab === 'activities' && <ActivitiesTab authFetch={authFetch} canManage={canManage} canDelete={canDelete} />}
        {tab === 'settings' && canAdmin && <SettingsTab authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} />}
      </PageBody>
    </Page>
  );
}

function SalesHub(props) {
  return (
    <Suspense fallback={null}>
      <SalesHubInner {...props} />
    </Suspense>
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
