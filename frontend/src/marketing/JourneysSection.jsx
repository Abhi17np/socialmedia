'use client';

import { useEffect, useState } from 'react';
import {
  RefreshCw, Plus, Workflow, Play, Pause, Copy, Trash2, Clock, Tag, Tags,
  ListChecks, PencilLine, Mail, ArrowUp, ArrowDown, GitBranch
} from 'lucide-react';
import { API_BASE } from '../apiBase';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Textarea, Select, Field, Checkbox,
  Banner, Modal, Drawer, EmptyState, Skeleton, Chip, StatStrip, Stat, Pagination, ConfirmDialog
} from '../ui';

const MKT_API_BASE = `${API_BASE}/marketing`;

const TRIGGER_LABELS = {
  contact_created: 'A contact is created',
  contact_tag_added: 'A tag is added to a contact',
  deal_stage_changed: 'A deal changes stage',
  deal_won: 'A deal is won',
  deal_lost: 'A deal is lost',
  email_opened: 'An email is opened',
  email_clicked: 'A link in an email is clicked'
};

// The step-editor below only authors LINEAR journeys (trigger, then an
// ordered list of delay/action steps) — the same conscious scope call as
// Phase 2's two-level AND/OR segment builder and Phase 3's structured
// block editor: a real, constrained, fully-working surface for the vast
// majority of journeys (every one of the 7 prebuilt templates is exactly
// this shape) rather than a half-built arbitrary graph canvas. The engine
// (lib/journeyGraph.js/journeyEngine.js) fully supports branching
// condition/split nodes — a journey authored via the API with those stays
// perfectly runnable, this editor just can't construct or edit one, and
// says so rather than silently flattening it. See
// docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 4 entry.
const ACTION_TYPES = {
  add_tag: { label: 'Add a tag', icon: Tag },
  remove_tag: { label: 'Remove a tag', icon: Tags },
  create_task: { label: 'Create a follow-up task', icon: ListChecks },
  update_field: { label: 'Update a field', icon: PencilLine },
  send_email: { label: 'Send an email', icon: Mail }
};

const STATUS_TONE = { active: 'success', completed: 'neutral', exited: 'neutral', goal_met: 'success', failed: 'danger' };

function emptyForm() {
  return {
    id: null, version: undefined, name: '', description: '', triggerType: 'contact_tag_added', triggerTag: '',
    reentryAllowed: false, steps: [{ localId: 'step-0', kind: 'action', actionType: 'add_tag', tag: '', amount: 1, unit: 'days', subject: '', notes: '', field: 'lead_status', value: '', templateId: '' }]
  };
}

let stepCounter = 1;
function newStep(kind) {
  return { localId: `step-${stepCounter++}`, kind, actionType: 'add_tag', tag: '', amount: 1, unit: 'days', subject: '', notes: '', field: 'lead_status', value: '', templateId: '' };
}

/** Builds a real { nodes, edges } graph (lib/journeyGraph.js's shape) from the editor's linear step list — the exact same chain shape lib/journeyTemplates.js's chain() helper produces. */
function graphFromForm(form) {
  const nodes = [{ id: 't', type: 'trigger' }];
  const edges = [];
  let prev = 't';
  form.steps.forEach((step, i) => {
    const id = `n${i}`;
    if (step.kind === 'delay') {
      nodes.push({ id, type: 'delay', config: { amount: Number(step.amount) || 1, unit: step.unit } });
    } else {
      const config =
        step.actionType === 'add_tag' || step.actionType === 'remove_tag' ? { tag: step.tag } :
        step.actionType === 'create_task' ? { subject: step.subject, notes: step.notes || undefined } :
        step.actionType === 'update_field' ? { field: step.field, value: step.value } :
        step.actionType === 'send_email' ? { templateId: step.templateId } : {};
      nodes.push({ id, type: 'action', actionType: step.actionType, config });
    }
    edges.push({ id: `e${i}`, source: prev, target: id });
    prev = id;
  });
  return { nodes, edges };
}

/** The inverse — only succeeds for a graph this editor itself could have produced (or an equally simple hand-authored chain): a single trigger, every other node with exactly one incoming and at most one outgoing edge, no condition/split nodes. Anything else (branching, authored via the API) is NOT flattened silently — the caller falls back to a read-only view. */
function formFromJourney(journey) {
  const graph = journey.graph_json;
  const base = { id: journey.id, version: journey.version, name: journey.name, description: journey.description || '', triggerType: journey.trigger_type, triggerTag: journey.trigger_config?.tag || '', reentryAllowed: !!journey.reentry_allowed };
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  if (!trigger) return null;

  const steps = [];
  let currentId = trigger.id;
  const visited = new Set([trigger.id]);
  for (let i = 0; i < graph.nodes.length; i++) {
    const outgoing = graph.edges.filter((e) => e.source === currentId);
    if (outgoing.length === 0) break;
    if (outgoing.length > 1) return null; // a split/branch — not editable here
    const node = graph.nodes.find((n) => n.id === outgoing[0].target);
    if (!node || visited.has(node.id)) return null;
    visited.add(node.id);
    if (node.type === 'delay') {
      steps.push({ localId: `step-${stepCounter++}`, kind: 'delay', amount: node.config?.amount ?? 1, unit: node.config?.unit ?? 'days' });
    } else if (node.type === 'action') {
      steps.push({
        localId: `step-${stepCounter++}`, kind: 'action', actionType: node.actionType,
        tag: node.config?.tag || '', subject: node.config?.subject || '', notes: node.config?.notes || '',
        field: node.config?.field || 'lead_status', value: node.config?.value || '', templateId: node.config?.templateId || ''
      });
    } else {
      return null; // condition/split
    }
    currentId = node.id;
  }
  if (visited.size !== graph.nodes.length) return null; // unreached nodes — not a simple chain
  return { ...base, steps };
}

/**
 * Journeys: the Phase 4 upgrade over the flat Automation tab — real
 * multi-step, delay-aware workflows (lib/journeyEngine.js) a tenant can
 * author, activate, and watch run against real enrollments. Deliberately
 * a separate tab from "Automation" (AutomationTab in MarketingHub.jsx):
 * that one stays the simple single-action rule list it always was; this
 * is the new, more expressive surface — see routes/journeys.js's header
 * comment for why they're not merged.
 */
export default function JourneysSection({ authFetch, canManage, canAdmin }) {
  const [journeys, setJourneys] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [emailTemplates, setEmailTemplates] = useState([]);
  const [error, setError] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [readOnlyGraph, setReadOnlyGraph] = useState(null); // set instead of `form` when a journey's graph isn't a simple chain
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [enrollments, setEnrollments] = useState(null);
  const [enrollPage, setEnrollPage] = useState(1);
  const [enrollTotal, setEnrollTotal] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const load = () => {
    authFetch(`${MKT_API_BASE}/journeys`).then((r) => r.json()).then((d) => setJourneys(d.journeys || [])).catch((e) => setError(e.message));
    authFetch(`${MKT_API_BASE}/journeys/templates`).then((r) => r.json()).then((d) => setTemplates(d.templates || [])).catch(() => {});
    authFetch(`${MKT_API_BASE}/email/templates`).then((r) => r.json()).then((d) => setEmailTemplates(d.templates || [])).catch(() => {});
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => { setForm(emptyForm()); setReadOnlyGraph(null); setEditorOpen(true); };

  const openEdit = (journey) => {
    const parsed = formFromJourney(journey);
    if (!parsed) { setReadOnlyGraph(journey); setForm(null); setEditorOpen(true); return; }
    setForm(parsed);
    setReadOnlyGraph(null);
    setEditorOpen(true);
  };

  const addStep = (kind) => setForm((f) => ({ ...f, steps: [...f.steps, newStep(kind)] }));
  const removeStep = (localId) => setForm((f) => ({ ...f, steps: f.steps.filter((s) => s.localId !== localId) }));
  const updateStep = (localId, patch) => setForm((f) => ({ ...f, steps: f.steps.map((s) => (s.localId === localId ? { ...s, ...patch } : s)) }));
  const moveStep = (index, dir) => setForm((f) => {
    const steps = [...f.steps];
    const target = index + dir;
    if (target < 0 || target >= steps.length) return f;
    [steps[index], steps[target]] = [steps[target], steps[index]];
    return { ...f, steps };
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const graph = graphFromForm(form);
      const body = {
        name: form.name, description: form.description || undefined, triggerType: form.triggerType,
        triggerConfig: form.triggerType === 'contact_tag_added' ? { tag: form.triggerTag } : {},
        graph, reentryAllowed: form.reentryAllowed, version: form.version
      };
      const url = form.id ? `${MKT_API_BASE}/journeys/${form.id}` : `${MKT_API_BASE}/journeys`;
      const res = await authFetch(url, { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'VERSION_CONFLICT') throw new Error('This journey was changed elsewhere since you opened it. Close and reopen it to see the latest version.');
        throw new Error(data.error || 'Could not save journey.');
      }
      setJourneys((prev) => form.id ? (prev || []).map((j) => (j.id === data.journey.id ? data.journey : j)) : [data.journey, ...(prev || [])]);
      setEditorOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const cloneTemplate = async (key) => {
    try {
      const res = await authFetch(`${MKT_API_BASE}/journeys/from-template/${key}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not clone template.');
      setJourneys((prev) => [data.journey, ...(prev || [])]);
      setTemplatesOpen(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleActive = async (journey) => {
    try {
      const res = await authFetch(`${MKT_API_BASE}/journeys/${journey.id}/${journey.is_active ? 'pause' : 'activate'}`, { method: 'PATCH' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update journey.');
      setJourneys((prev) => (prev || []).map((j) => (j.id === journey.id ? data.journey : j)));
    } catch (err) {
      setError(err.message);
    }
  };

  const clone = async (journey) => {
    try {
      const res = await authFetch(`${MKT_API_BASE}/journeys/${journey.id}/clone`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not clone journey.');
      setJourneys((prev) => [data.journey, ...(prev || [])]);
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      const res = await authFetch(`${MKT_API_BASE}/journeys/${pendingDelete.id}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Could not delete journey.'); }
      setJourneys((prev) => (prev || []).filter((j) => j.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const openDetail = async (journey) => {
    setDetail(journey);
    setEnrollPage(1);
    setEnrollments(null);
    setAnalytics(null);
    const [enrollRes, analyticsRes] = await Promise.all([
      authFetch(`${MKT_API_BASE}/journeys/${journey.id}/enrollments?page=1&pageSize=25`).then((r) => r.json()),
      authFetch(`${MKT_API_BASE}/journeys/${journey.id}/analytics`).then((r) => r.json())
    ]);
    setEnrollments(enrollRes.enrollments || []);
    setEnrollTotal(enrollRes.total ?? 0);
    setAnalytics(analyticsRes);
  };

  useEffect(() => {
    if (!detail) return;
    authFetch(`${MKT_API_BASE}/journeys/${detail.id}/enrollments?page=${enrollPage}&pageSize=25`).then((r) => r.json()).then((d) => { setEnrollments(d.enrollments || []); setEnrollTotal(d.total ?? 0); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrollPage]);

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Journeys"
          action={
            <div className="flex items-center gap-1.5 sm:gap-2">
              <IconButton icon={RefreshCw} label="Refresh" onClick={load} />
              {canManage && <Button size="sm" icon={Workflow} onClick={() => setTemplatesOpen(true)}><span className="hidden sm:inline">From template</span></Button>}
              {canManage && <Button size="sm" variant="primary" icon={Plus} onClick={openCreate}><span className="hidden sm:inline">New journey</span></Button>}
            </div>
          }
        />
        {journeys === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : journeys.length === 0 ? (
          <EmptyState icon={Workflow} title="No journeys yet" description="Start from a prebuilt template (welcome series, lead nurture, re-engagement…) or build one from scratch." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Trigger</Th><Th>Status</Th><Th align="right"> </Th></tr></thead>
            <tbody>
              {journeys.map((j) => (
                <tr key={j.id} className="hover:bg-canvas transition-colors">
                  <Td><button className="font-medium hover:underline" onClick={() => openDetail(j)}>{j.name}</button></Td>
                  <Td>{TRIGGER_LABELS[j.trigger_type] || j.trigger_type}{j.trigger_config?.tag ? ` "${j.trigger_config.tag}"` : ''}</Td>
                  <Td><Chip tone={j.is_active ? 'success' : 'neutral'}>{j.is_active ? 'active' : 'paused'}</Chip></Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      {canManage && <IconButton icon={PencilLine} label="Edit" onClick={() => openEdit(j)} />}
                      {canAdmin && <IconButton icon={j.is_active ? Pause : Play} label={j.is_active ? 'Pause' : 'Activate'} onClick={() => toggleActive(j)} />}
                      {canManage && <IconButton icon={Copy} label="Clone" onClick={() => clone(j)} />}
                      {canAdmin && <IconButton icon={Trash2} label="Delete" onClick={() => setPendingDelete(j)} />}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      {/* ---------------------------------------------------------- Templates gallery */}
      <Modal open={templatesOpen} onClose={() => setTemplatesOpen(false)} title="Start from a template" width={560}>
        <div className="flex flex-col gap-2">
          {templates.length === 0 ? <Skeleton className="h-9" /> : templates.map((t) => (
            <button key={t.key} onClick={() => cloneTemplate(t.key)} className="text-left p-3 rounded-ui border border-hairline hover:border-brand hover:bg-canvas transition-colors">
              <div className="font-medium text-sm">{t.name}</div>
              <div className="text-xs text-muted mt-0.5">{t.description}</div>
            </button>
          ))}
        </div>
      </Modal>

      {/* ---------------------------------------------------------- Editor */}
      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={readOnlyGraph ? readOnlyGraph.name : form?.id ? 'Edit journey' : 'New journey'}
        width={640}
        footer={readOnlyGraph ? <Button onClick={() => setEditorOpen(false)}>Close</Button> : (
          <><Button onClick={() => setEditorOpen(false)} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!form?.name.trim() || (form?.triggerType === 'contact_tag_added' && !form?.triggerTag.trim()) || form?.steps.length === 0}>Save</Button></>
        )}
      >
        {readOnlyGraph ? (
          <div className="flex flex-col gap-3">
            <Banner tone="info" icon={GitBranch}>
              This journey has a branching graph (a condition or split node) authored outside this editor — the step-by-step
              editor here only builds straight-line journeys, so it&apos;s shown read-only to avoid silently flattening it.
              It keeps running exactly as built; edit its graph via the API if you need to change it.
            </Banner>
            <div className="text-xs text-muted">{readOnlyGraph.graph_json.nodes.length} nodes, {readOnlyGraph.graph_json.edges.length} edges.</div>
          </div>
        ) : form && (
          <div className="flex flex-col gap-3">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
            <Field label="Description (optional)"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <Field label="Starts when">
              <Select value={form.triggerType} onChange={(e) => setForm({ ...form, triggerType: e.target.value })} disabled={!!form.id}>
                {Object.entries(TRIGGER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            {form.triggerType === 'contact_tag_added' && (
              <Field label="Tag"><Input value={form.triggerTag} onChange={(e) => setForm({ ...form, triggerTag: e.target.value })} placeholder="e.g. newsletter" /></Field>
            )}
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
              <Checkbox checked={form.reentryAllowed} onChange={(e) => setForm({ ...form, reentryAllowed: e.target.checked })} />
              Allow a contact to go through this journey more than once
            </label>

            <div className="pt-2 border-t border-hairline">
              <div className="eyebrow mb-2">Steps</div>
              <div className="flex flex-col gap-2">
                {form.steps.map((step, i) => {
                  const StepIcon = step.kind === 'delay' ? Clock : ACTION_TYPES[step.actionType]?.icon || ListChecks;
                  return (
                  <div key={step.localId} className="p-2.5 rounded-ui border border-hairline flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-muted"><StepIcon size={14} /> Step {i + 1}</div>
                      <div className="flex gap-1">
                        <IconButton icon={ArrowUp} label="Move up" size={14} onClick={() => moveStep(i, -1)} />
                        <IconButton icon={ArrowDown} label="Move down" size={14} onClick={() => moveStep(i, 1)} />
                        <IconButton icon={Trash2} label="Remove step" size={14} onClick={() => removeStep(step.localId)} />
                      </div>
                    </div>
                    <Select className="h-8" value={step.kind === 'delay' ? 'delay' : step.actionType} onChange={(e) => {
                      const v = e.target.value;
                      updateStep(step.localId, v === 'delay' ? { kind: 'delay' } : { kind: 'action', actionType: v });
                    }}>
                      <option value="delay">Wait…</option>
                      {Object.entries(ACTION_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </Select>
                    {step.kind === 'delay' && (
                      <div className="flex gap-2">
                        <Input type="number" min={1} className="h-8 w-24" value={step.amount} onChange={(e) => updateStep(step.localId, { amount: e.target.value })} />
                        <Select className="h-8" value={step.unit} onChange={(e) => updateStep(step.localId, { unit: e.target.value })}>
                          <option value="minutes">Minutes</option>
                          <option value="hours">Hours</option>
                          <option value="days">Days</option>
                        </Select>
                      </div>
                    )}
                    {step.kind === 'action' && (step.actionType === 'add_tag' || step.actionType === 'remove_tag') && (
                      <Input className="h-8" placeholder="Tag" value={step.tag} onChange={(e) => updateStep(step.localId, { tag: e.target.value })} />
                    )}
                    {step.kind === 'action' && step.actionType === 'create_task' && (
                      <>
                        <Input className="h-8" placeholder="Task subject" value={step.subject} onChange={(e) => updateStep(step.localId, { subject: e.target.value })} />
                        <Input className="h-8" placeholder="Notes (optional)" value={step.notes} onChange={(e) => updateStep(step.localId, { notes: e.target.value })} />
                      </>
                    )}
                    {step.kind === 'action' && step.actionType === 'update_field' && (
                      <div className="flex gap-2">
                        <Select className="h-8" value={step.field} onChange={(e) => updateStep(step.localId, { field: e.target.value })}>
                          <option value="lead_status">Lead status</option>
                          <option value="lifecycle_stage">Lifecycle stage</option>
                        </Select>
                        <Input className="h-8 flex-1" placeholder="New value" value={step.value} onChange={(e) => updateStep(step.localId, { value: e.target.value })} />
                      </div>
                    )}
                    {step.kind === 'action' && step.actionType === 'send_email' && (
                      <Select className="h-8" value={step.templateId} onChange={(e) => updateStep(step.localId, { templateId: e.target.value })}>
                        <option value="">Select an email template…</option>
                        {emailTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </Select>
                    )}
                  </div>
                  );
                })}
              </div>
              <div className="flex gap-2 mt-2">
                <Button size="sm" icon={Clock} onClick={() => addStep('delay')}>Add wait</Button>
                <Button size="sm" icon={Plus} onClick={() => addStep('action')}>Add action</Button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ---------------------------------------------------------- Detail / analytics drawer */}
      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.name} subtitle={detail?.description} width={580}>
        {detail && (
          <div className="p-4 flex flex-col gap-4">
            {analytics === null ? <Skeleton className="h-9" /> : (
              <>
                <StatStrip>
                  <Stat label="Entered" value={analytics.totals.entered} />
                  <Stat label="Active" value={analytics.totals.active} />
                  <Stat label="Done" value={analytics.totals.completed} hint="Completed" />
                  <Stat label="Won" value={analytics.totals.goal_met} hint="Goal met" />
                  <Stat label="Conv." value={`${analytics.conversionRate}%`} hint="Conversion rate" />
                </StatStrip>
                {analytics.perNode.length > 0 && (
                  <div>
                    <div className="eyebrow mb-1.5">Per-step funnel</div>
                    <div className="flex flex-col gap-1">
                      {analytics.perNode.map((n) => (
                        <div key={n.nodeId} className="flex items-center justify-between text-xs">
                          <span className="font-mono text-muted">{n.nodeId}</span>
                          <span>{n.entered} entered · {n.completed} completed{n.failed ? ` · ${n.failed} failed` : ''}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            <div>
              <div className="eyebrow mb-1.5">Enrollments</div>
              {enrollments === null ? <Skeleton className="h-9" /> : enrollments.length === 0 ? (
                <p className="text-xs text-muted">No one has entered this journey yet.</p>
              ) : (
                <Table>
                  <thead><tr><Th>Contact</Th><Th>Status</Th><Th>Enrolled</Th></tr></thead>
                  <tbody>
                    {enrollments.map((e) => (
                      <tr key={e.id}>
                        <Td className="text-xs">{e.contacts?.display_name || '—'}</Td>
                        <Td><Chip tone={STATUS_TONE[e.status] || 'neutral'}>{e.status}</Chip></Td>
                        <Td className="text-xs text-muted">{new Date(e.enrolled_at).toLocaleString()}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <Pagination page={enrollPage} pageSize={25} total={enrollTotal} onPageChange={setEnrollPage} />
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this journey?"
        body={pendingDelete ? `"${pendingDelete.name}" and its enrollment history will be permanently deleted. This can't be undone.` : ''}
        confirmLabel="Delete"
        onConfirm={remove}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
