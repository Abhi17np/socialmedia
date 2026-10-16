'use client';

import { useEffect, useState } from 'react';
import { Plus, Workflow, Trash2, UserPlus, Pause, Play, Square } from 'lucide-react';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Textarea, Select, Field,
  Banner, Modal, Drawer, ConfirmDialog, EmptyState, Skeleton, Chip
} from '../ui';
import { errorMessage } from './format';

const ACTION_LABELS = { create_task: 'Create a task', add_tag: 'Add tag', remove_tag: 'Remove tag' };
const ENROLLMENT_STATUS_TONE = { active: 'brand', paused: 'neutral', completed: 'success', stopped: 'danger' };

/**
 * Task/tag follow-up sequences — real CRUD + enrollment management over
 * lib/sequences.js + lib/sequenceScheduler.js (migration 018/019). There
 * is no send_email step type: Email/Calendar provider integration is a
 * documented, genuine blocker (see SALES_HUB_IMPLEMENTATION.md), so this
 * only drives create_task/add_tag/remove_tag steps on a persistent sweep.
 */
function SequencesTab({ authFetch, SALES_API_BASE, canAdmin }) {
  const [sequences, setSequences] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });
  const [detailId, setDetailId] = useState(null);

  const load = () => { authFetch(`${SALES_API_BASE}/sequences`).then((r) => r.json()).then((d) => setSequences(d.sequences || [])).catch((e) => setError(e.message)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/sequences`, { method: 'POST', body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not create sequence.'));
      setSequences((prev) => [{ ...data.sequence, stepCount: 0, activeEnrollmentCount: 0 }, ...(prev || [])]);
      setOpen(false);
      setForm({ name: '', description: '' });
      setDetailId(data.sequence.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleActive = async (seq) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/sequences/${seq.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !seq.is_active }) });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not update sequence.'));
      setSequences((prev) => prev.map((s) => (s.id === seq.id ? { ...s, ...data.sequence } : s)));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Sequences"
          meta="Multi-step follow-ups: tasks and tag changes on a timed schedule"
          action={canAdmin && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New sequence</Button>}
        />
        {sequences === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : sequences.length === 0 ? (
          <EmptyState icon={Workflow} title="No sequences yet" description="Build a multi-step follow-up — e.g. a task on day 0, a tag on day 3 — and enroll contacts into it." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th align="right">Steps</Th><Th align="right">Active enrollments</Th><Th>Status</Th><Th align="right"> </Th></tr></thead>
            <tbody>
              {sequences.map((s) => (
                <tr key={s.id} className="hover:bg-canvas transition-colors">
                  <Td className="cursor-pointer" onClick={() => setDetailId(s.id)}>
                    <span className="font-medium">{s.name}</span>
                    {s.description && <p className="text-[11px] text-muted mt-0.5">{s.description}</p>}
                  </Td>
                  <Td align="right" className="tabular-nums">{s.stepCount}</Td>
                  <Td align="right" className="tabular-nums">{s.activeEnrollmentCount}</Td>
                  <Td>
                    {canAdmin ? (
                      <button onClick={() => toggleActive(s)}><Chip tone={s.is_active ? 'success' : 'neutral'}>{s.is_active ? 'active' : 'paused'}</Chip></button>
                    ) : (
                      <Chip tone={s.is_active ? 'success' : 'neutral'}>{s.is_active ? 'active' : 'paused'}</Chip>
                    )}
                  </Td>
                  <Td align="right"><Button size="sm" onClick={() => setDetailId(s.id)}>Open</Button></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Modal
        open={open} onClose={() => setOpen(false)} title="New sequence"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.name.trim()}>Create</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <Field label="Description"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        </div>
      </Modal>

      {detailId && (
        <SequenceDetailDrawer
          sequenceId={detailId} onClose={() => setDetailId(null)}
          authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} canAdmin={canAdmin}
          onChanged={load}
        />
      )}
    </>
  );
}

// ------------------------------------------------------- Sequence detail

function SequenceDetailDrawer({ sequenceId, onClose, authFetch, SALES_API_BASE, canAdmin, onChanged }) {
  const [data, setData] = useState(null);
  const [enrollments, setEnrollments] = useState(null);
  const [error, setError] = useState(null);
  const [stepForm, setStepForm] = useState({ delayDays: 0, actionType: 'create_task', subject: '', tag: '' });
  const [confirmDeleteStep, setConfirmDeleteStep] = useState(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState([]);

  const load = () => {
    authFetch(`${SALES_API_BASE}/sequences/${sequenceId}`).then((r) => r.json()).then((d) => { if (d.error) throw new Error(d.error); setData(d); }).catch((e) => setError(e.message));
    authFetch(`${SALES_API_BASE}/sequences/${sequenceId}/enrollments`).then((r) => r.json()).then((d) => setEnrollments(d.enrollments || [])).catch(() => {});
  };
  useEffect(() => { if (sequenceId) load(); }, [sequenceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const addStep = async () => {
    try {
      const actionConfig = stepForm.actionType === 'create_task' ? { subject: stepForm.subject } : { tag: stepForm.tag };
      const res = await authFetch(`${SALES_API_BASE}/sequences/${sequenceId}/steps`, {
        method: 'POST', body: JSON.stringify({ delayDays: Number(stepForm.delayDays) || 0, actionType: stepForm.actionType, actionConfig })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not add step.');
      setData((prev) => ({ ...prev, steps: [...prev.steps, result.step] }));
      setStepForm({ delayDays: 0, actionType: 'create_task', subject: '', tag: '' });
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  };

  const removeStep = async (step) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/sequence-steps/${step.id}`, { method: 'DELETE' });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not remove step.');
      setData((prev) => ({ ...prev, steps: prev.steps.filter((s) => s.id !== step.id) }));
      setConfirmDeleteStep(null);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  };

  const searchContacts = async (q) => {
    setContactQuery(q);
    if (q.trim().length < 2) { setContactResults([]); return; }
    const res = await authFetch(`${SALES_API_BASE}/contacts?search=${encodeURIComponent(q.trim())}&pageSize=8`);
    const result = await res.json();
    setContactResults(result.contacts || []);
  };

  const enroll = async (contact) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/sequences/${sequenceId}/enroll`, { method: 'POST', body: JSON.stringify({ contactId: contact.id }) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not enroll contact.');
      setEnrollOpen(false);
      setContactQuery('');
      setContactResults([]);
      load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  };

  const setEnrollmentStatus = async (enrollment, status) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/sequence-enrollments/${enrollment.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not update enrollment.');
      setEnrollments((prev) => prev.map((e) => (e.id === enrollment.id ? { ...e, ...result.enrollment } : e)));
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  };

  const stepAddDisabled = stepForm.actionType === 'create_task' ? !stepForm.subject.trim() : !stepForm.tag.trim();

  return (
    <Drawer open={!!sequenceId} onClose={onClose} title={data?.sequence?.name || 'Sequence'} subtitle={data?.sequence?.description} width={560}>
      {error && <div className="px-4 pt-3"><Banner tone="danger">{error}</Banner></div>}
      {!data ? (
        <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
      ) : (
        <div className="p-4 flex flex-col gap-5">
          <div>
            <div className="eyebrow mb-1.5">Steps ({data.steps.length})</div>
            {data.steps.length === 0 ? <p className="text-xs text-muted mb-2">No steps yet — add the first one below.</p> : (
              <div className="flex flex-col gap-1.5 mb-2">
                {data.steps.map((s, i) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 text-xs bg-canvas rounded-ui px-2 py-1.5">
                    <span className="tabular-nums text-muted w-10 shrink-0">Day {s.delay_days}</span>
                    <span className="flex-1 min-w-0 truncate">
                      {ACTION_LABELS[s.action_type]}{s.action_config?.subject ? `: "${s.action_config.subject}"` : s.action_config?.tag ? `: "${s.action_config.tag}"` : ''}
                    </span>
                    {canAdmin && <IconButton icon={Trash2} aria-label="Remove step" onClick={() => setConfirmDeleteStep(s)} />}
                  </div>
                ))}
              </div>
            )}
            {canAdmin && (
              <div className="border border-hairline rounded-ui p-2.5 flex flex-col gap-2">
                <div className="flex gap-2">
                  <Field label="Delay (days)" className="w-28">
                    <Input type="number" min="0" value={stepForm.delayDays} onChange={(e) => setStepForm({ ...stepForm, delayDays: e.target.value })} />
                  </Field>
                  <Field label="Action" className="flex-1">
                    <Select value={stepForm.actionType} onChange={(e) => setStepForm({ ...stepForm, actionType: e.target.value })}>
                      {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                  </Field>
                </div>
                {stepForm.actionType === 'create_task' ? (
                  <Field label="Task subject"><Input value={stepForm.subject} onChange={(e) => setStepForm({ ...stepForm, subject: e.target.value })} placeholder="Follow up call" /></Field>
                ) : (
                  <Field label="Tag"><Input value={stepForm.tag} onChange={(e) => setStepForm({ ...stepForm, tag: e.target.value })} placeholder="nurture" /></Field>
                )}
                <Button size="sm" variant="primary" icon={Plus} onClick={addStep} disabled={stepAddDisabled}>Add step</Button>
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="eyebrow">Enrollments ({(enrollments || []).length})</div>
              <Button size="sm" icon={UserPlus} onClick={() => setEnrollOpen(true)} disabled={data.steps.length === 0}>Enroll contact</Button>
            </div>
            {!enrollments || enrollments.length === 0 ? <p className="text-xs text-muted">No contacts enrolled yet.</p> : (
              <div className="flex flex-col gap-1.5">
                {enrollments.map((e) => (
                  <div key={e.id} className="flex items-center justify-between gap-2 text-xs bg-canvas rounded-ui px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-ink truncate">{e.contactName}</div>
                      <div className="text-[11px] text-muted">
                        Step {e.current_step + 1} · next {e.next_run_at ? new Date(e.next_run_at).toLocaleDateString() : '—'}
                        {e.last_error && <span className="text-danger"> · {e.last_error}</span>}
                      </div>
                    </div>
                    <Chip tone={ENROLLMENT_STATUS_TONE[e.status]}>{e.status}</Chip>
                    {e.status === 'active' && <IconButton icon={Pause} aria-label="Pause" onClick={() => setEnrollmentStatus(e, 'paused')} />}
                    {e.status === 'paused' && <IconButton icon={Play} aria-label="Resume" onClick={() => setEnrollmentStatus(e, 'active')} />}
                    {['active', 'paused'].includes(e.status) && <IconButton icon={Square} aria-label="Stop" onClick={() => setEnrollmentStatus(e, 'stopped')} />}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <Modal open={enrollOpen} onClose={() => setEnrollOpen(false)} title="Enroll a contact">
        <div className="flex flex-col gap-2">
          <Input placeholder="Search contacts…" value={contactQuery} onChange={(e) => searchContacts(e.target.value)} autoFocus />
          <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
            {contactResults.map((c) => (
              <button key={c.id} onClick={() => enroll(c)} className="text-left text-xs px-2 py-1.5 rounded-ui hover:bg-canvas">
                {c.display_name} {c.email && <span className="text-muted">· {c.email}</span>}
              </button>
            ))}
            {contactQuery.trim().length >= 2 && contactResults.length === 0 && <p className="text-xs text-muted px-2 py-1.5">No matches.</p>}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirmDeleteStep} onCancel={() => setConfirmDeleteStep(null)} onConfirm={() => removeStep(confirmDeleteStep)}
        title="Remove this step?" body="Enrollments already past this step are unaffected." confirmLabel="Remove"
      />
    </Drawer>
  );
}

export default SequencesTab;
