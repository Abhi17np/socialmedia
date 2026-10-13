'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Plus, ListChecks,
  Phone, Mail, Calendar, StickyNote, CheckSquare
} from 'lucide-react';
import { API_BASE } from '../apiBase';
import { atLeast } from '../roleRank';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, Panel, PanelHeader, Input, Textarea, Select, Field,
  Banner, Modal, EmptyState, Skeleton, Chip
} from '../ui';
import DashboardTab from './DashboardTab';
import WorkspaceTab from './WorkspaceTab';
import SettingsTab from './SettingsTab';
import PipelineTab from './PipelineTab';
import CompaniesTab from './CompaniesTab';
import ContactsTab from './ContactsTab';
import SequencesTab from './SequencesTab';

const SALES_API_BASE = `${API_BASE}/sales`;

const ACTIVITY_ICON = { call: Phone, email: Mail, meeting: Calendar, note: StickyNote, task: CheckSquare };

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
  const openId = searchParams.get('open') || null;
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
        {tab === 'pipeline' && <PipelineTab authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} canManage={canManage} canAdmin={canAdmin} canDelete={canDelete} openId={openId} />}
        {tab === 'companies' && <CompaniesTab authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} canManage={canManage} canDelete={canDelete} openId={openId} />}
        {tab === 'contacts' && <ContactsTab authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} canManage={canManage} canDelete={canDelete} openId={openId} />}
        {tab === 'activities' && <ActivitiesTab authFetch={authFetch} canManage={canManage} canDelete={canDelete} />}
        {tab === 'sequences' && <SequencesTab authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} canAdmin={canAdmin} />}
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
