'use client';

import { useEffect, useState } from 'react';
import {
  RefreshCw, Plus, Workflow, Play, Pause, Copy, Trash2, Clock, Tag, Tags,
  ListChecks, PencilLine, Mail, MessageSquare, ArrowUp, ArrowDown, GitBranch
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

// The step-editor authors LINEAR journeys plus one level (or more,
// nested) of IF/ELSE branching via a 'condition' step — a real,
// constrained surface rather than a half-built arbitrary graph canvas
// (same conscious scope call as Phase 2's two-level AND/OR segment
// builder). A condition step is always the LAST step in whatever list
// it's in: anything that should happen after it goes INSIDE its "if
// yes"/"if no" branches instead, which keeps compiling/parsing the
// graph a clean, symmetric recursion with no shared-node graph surgery.
// A split node (percentage A/B routing, not a data condition) still has
// no editor UI — a journey authored via the API with one stays
// perfectly runnable, just read-only here. See
// docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 4 and Phase 10 entries.
const ACTION_TYPES = {
  add_tag: { label: 'Add a tag', icon: Tag },
  remove_tag: { label: 'Remove a tag', icon: Tags },
  create_task: { label: 'Create a follow-up task', icon: ListChecks },
  update_field: { label: 'Update a field', icon: PencilLine },
  send_email: { label: 'Send an email', icon: Mail },
  send_sms: { label: 'Send an SMS', icon: MessageSquare }
};

const CONDITION_FIELDS = {
  lead_score: { label: 'Lead score', valueType: 'number', operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] },
  lead_status: { label: 'Lead status', valueType: 'text', operators: ['eq', 'neq'] },
  lifecycle_stage: { label: 'Lifecycle stage', valueType: 'text', operators: ['eq', 'neq'] },
  tags: { label: 'Has tag', valueType: 'text', operators: ['contains', 'not_contains'] },
  has_email: { label: 'Has an email address', valueType: 'boolean', operators: ['eq'] },
  has_phone: { label: 'Has a phone number', valueType: 'boolean', operators: ['eq'] },
  // Resolved live at evaluation time from the real recipient row of this
  // journey's most recent send_email/send_whatsapp/send_sms action — see
  // backend/lib/journeyEngine.js's resolveLastMessageStatus(). Null (never
  // matches) if no send has happened yet earlier in this journey.
  last_message_status: { label: "Last message's delivery status", valueType: 'select', options: ['sent', 'delivered', 'read', 'opened', 'clicked', 'bounced', 'failed'], operators: ['eq', 'neq'] }
};
const OPERATOR_LABELS = { eq: 'is', neq: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains', not_contains: 'does not contain' };

const STATUS_TONE = { active: 'success', completed: 'neutral', exited: 'neutral', goal_met: 'success', failed: 'danger' };

let stepCounter = 1;
function newStep(kind) {
  return {
    localId: `step-${stepCounter++}`, kind, actionType: 'add_tag', tag: '', amount: 1, unit: 'days', subject: '', notes: '',
    field: kind === 'condition' ? 'lead_score' : 'lead_status', operator: 'eq', value: '', templateId: '', smsBody: '',
    thenSteps: [], elseSteps: []
  };
}

function emptyForm() {
  return {
    id: null, version: undefined, name: '', description: '', triggerType: 'contact_tag_added', triggerTag: '',
    reentryAllowed: false, steps: [newStep('action')]
  };
}

function parseConditionValue(step) {
  const field = CONDITION_FIELDS[step.field];
  if (field.valueType === 'number') return Number(step.value) || 0;
  if (field.valueType === 'boolean') return step.value === 'true' || step.value === true;
  return step.value;
}

/** Recursively compiles one step list into lib/journeyGraph.js's { nodes, edges } shape, returning the entry node id for THIS list (or null if empty) — the caller wires its own preceding node's outgoing edge to that id. A condition step's two branches are compiled independently; an empty branch gets a real `noop` action node (lib/journeyActions.js) since validateGraph() requires every condition to have both a yes and a no edge. */
function compileSteps(steps, nodes, edges, idGen) {
  if (!steps || steps.length === 0) return null;
  const [step, ...rest] = steps;
  const id = idGen();

  if (step.kind === 'condition') {
    nodes.push({ id, type: 'condition', config: { field: step.field, operator: step.operator, value: parseConditionValue(step) } });
    let thenEntry = compileSteps(step.thenSteps, nodes, edges, idGen);
    let elseEntry = compileSteps(step.elseSteps, nodes, edges, idGen);
    if (!thenEntry) { thenEntry = idGen(); nodes.push({ id: thenEntry, type: 'action', actionType: 'noop', config: {} }); }
    if (!elseEntry) { elseEntry = idGen(); nodes.push({ id: elseEntry, type: 'action', actionType: 'noop', config: {} }); }
    edges.push({ id: idGen(), source: id, target: thenEntry, branch: 'yes' });
    edges.push({ id: idGen(), source: id, target: elseEntry, branch: 'no' });
    return id; // `rest` is always empty by editor convention (a condition is always the last step in its list)
  }

  if (step.kind === 'delay') {
    nodes.push({ id, type: 'delay', config: { amount: Number(step.amount) || 1, unit: step.unit } });
  } else {
    const config =
      step.actionType === 'add_tag' || step.actionType === 'remove_tag' ? { tag: step.tag } :
      step.actionType === 'create_task' ? { subject: step.subject, notes: step.notes || undefined } :
      step.actionType === 'update_field' ? { field: step.field, value: step.value } :
      step.actionType === 'send_email' ? { templateId: step.templateId } :
      step.actionType === 'send_sms' ? { body: step.smsBody } : {};
    nodes.push({ id, type: 'action', actionType: step.actionType, config });
  }
  const nextId = compileSteps(rest, nodes, edges, idGen);
  if (nextId) edges.push({ id: idGen(), source: id, target: nextId });
  return id;
}

/** Builds a real { nodes, edges } graph (lib/journeyGraph.js's shape) from the editor's step tree. */
function graphFromForm(form) {
  const nodes = [{ id: 't', type: 'trigger' }];
  const edges = [];
  let n = 0;
  const idGen = () => `n${n++}`;
  const entryId = compileSteps(form.steps, nodes, edges, idGen);
  if (entryId) edges.push({ id: 'e-t', source: 't', target: entryId });
  return { nodes, edges };
}

/** The inverse of compileSteps() — recursively walks a chain starting at nodeId, returning its step list, or null if this node (or anything reachable from it) isn't something this editor could have produced (a split node, more than one outgoing edge off a delay/action, a cycle, or a condition missing a clean yes/no pair). A journey authored via the API with any of those falls back to a read-only view rather than being silently flattened or misrepresented. */
function parseChain(graph, nodeId, visited) {
  if (!nodeId) return [];
  if (visited.has(nodeId)) return null; // cycle
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const outgoing = graph.edges.filter((e) => e.source === nodeId);
  const nextVisited = new Set(visited).add(nodeId);

  if (node.type === 'action' && node.actionType === 'noop' && outgoing.length === 0) return [];

  if (node.type === 'condition') {
    const yesEdge = outgoing.find((e) => e.branch === 'yes');
    const noEdge = outgoing.find((e) => e.branch === 'no');
    if (!yesEdge || !noEdge || outgoing.length !== 2) return null;
    const fieldDef = CONDITION_FIELDS[node.config?.field];
    if (!fieldDef) return null; // an unknown/legacy field this editor doesn't offer — read-only rather than misrepresenting it
    const thenSteps = parseChain(graph, yesEdge.target, nextVisited);
    const elseSteps = parseChain(graph, noEdge.target, nextVisited);
    if (thenSteps === null || elseSteps === null) return null;
    const value = fieldDef.valueType === 'boolean' ? String(!!node.config.value) : String(node.config.value ?? '');
    return [{ localId: `step-${stepCounter++}`, kind: 'condition', field: node.config.field, operator: node.config.operator, value, thenSteps, elseSteps }];
  }

  if (outgoing.length > 1) return null; // a split, or a hand-authored fan-out — not editable here
  const rest = parseChain(graph, outgoing[0]?.target, nextVisited);
  if (rest === null) return null;

  if (node.type === 'delay') {
    return [{ localId: `step-${stepCounter++}`, kind: 'delay', amount: node.config?.amount ?? 1, unit: node.config?.unit ?? 'days' }, ...rest];
  }
  if (node.type === 'action') {
    return [{
      localId: `step-${stepCounter++}`, kind: 'action', actionType: node.actionType,
      tag: node.config?.tag || '', subject: node.config?.subject || '', notes: node.config?.notes || '',
      field: node.config?.field || 'lead_status', value: node.config?.value || '', templateId: node.config?.templateId || '', smsBody: node.config?.body || ''
    }, ...rest];
  }
  return null;
}

function formFromJourney(journey) {
  const graph = journey.graph_json;
  const base = { id: journey.id, version: journey.version, name: journey.name, description: journey.description || '', triggerType: journey.trigger_type, triggerTag: journey.trigger_config?.tag || '', reentryAllowed: !!journey.reentry_allowed };
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  if (!trigger) return null;
  const outgoing = graph.edges.filter((e) => e.source === trigger.id);
  if (outgoing.length > 1) return null;
  const steps = parseChain(graph, outgoing[0]?.target, new Set([trigger.id]));
  if (steps === null) return null;
  return { ...base, steps };
}

/** Renders and edits one step list — recurses into its own component for a condition step's two branches, so authoring a nested if/else is the same UI at any depth. Capped at 3 levels deep (plenty for any real journey) purely to keep the modal from getting unreasonably tall, not a limit the compiler itself has. */
function StepEditor({ steps, onChange, emailTemplates, depth = 0 }) {
  const update = (localId, patch) => onChange(steps.map((s) => (s.localId === localId ? { ...s, ...patch } : s)));
  const remove = (localId) => onChange(steps.filter((s) => s.localId !== localId));
  const move = (index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= steps.length) return;
    // A condition step must stay last (graphFromForm compiles anything
    // after it into oblivion) — never swap it out of that position.
    if (steps[index].kind === 'condition' || steps[target].kind === 'condition') return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const add = (kind) => onChange([...steps, newStep(kind)]);
  // A condition step is always the last in its list (see graphFromForm's
  // header comment) — once one's added, "add step" is hidden rather than
  // letting the author create dead-end steps the compiler would ignore.
  const locked = steps.length > 0 && steps[steps.length - 1].kind === 'condition';

  return (
    <div className="flex flex-col gap-2">
      {steps.map((step, i) => {
        const StepIcon = step.kind === 'delay' ? Clock : step.kind === 'condition' ? GitBranch : ACTION_TYPES[step.actionType]?.icon || ListChecks;
        const fieldDef = step.kind === 'condition' ? CONDITION_FIELDS[step.field] : null;
        return (
          <div key={step.localId} className="p-2.5 rounded-ui border border-hairline flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted"><StepIcon size={14} /> Step {i + 1}</div>
              <div className="flex gap-1">
                <IconButton icon={ArrowUp} label="Move up" size={14} onClick={() => move(i, -1)} disabled={i === 0 || step.kind === 'condition' || steps[i - 1]?.kind === 'condition'} />
                <IconButton icon={ArrowDown} label="Move down" size={14} onClick={() => move(i, 1)} disabled={i === steps.length - 1 || step.kind === 'condition' || steps[i + 1]?.kind === 'condition'} />
                <IconButton icon={Trash2} label="Remove step" size={14} onClick={() => remove(step.localId)} />
              </div>
            </div>
            <Select className="h-8" value={step.kind === 'delay' ? 'delay' : step.kind === 'condition' ? 'condition' : step.actionType} onChange={(e) => {
              const v = e.target.value;
              update(step.localId, v === 'delay' ? { kind: 'delay' } : v === 'condition' ? { ...newStep('condition'), localId: step.localId } : { kind: 'action', actionType: v });
            }}>
              <option value="delay">Wait…</option>
              {depth < 3 && i === steps.length - 1 && <option value="condition">If / else…</option>}
              {Object.entries(ACTION_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>

            {step.kind === 'delay' && (
              <div className="flex gap-2">
                <Input type="number" min={1} className="h-8 w-24" value={step.amount} onChange={(e) => update(step.localId, { amount: e.target.value })} />
                <Select className="h-8" value={step.unit} onChange={(e) => update(step.localId, { unit: e.target.value })}>
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                </Select>
              </div>
            )}
            {step.kind === 'action' && (step.actionType === 'add_tag' || step.actionType === 'remove_tag') && (
              <Input className="h-8" placeholder="Tag" value={step.tag} onChange={(e) => update(step.localId, { tag: e.target.value })} />
            )}
            {step.kind === 'action' && step.actionType === 'create_task' && (
              <>
                <Input className="h-8" placeholder="Task subject" value={step.subject} onChange={(e) => update(step.localId, { subject: e.target.value })} />
                <Input className="h-8" placeholder="Notes (optional)" value={step.notes} onChange={(e) => update(step.localId, { notes: e.target.value })} />
              </>
            )}
            {step.kind === 'action' && step.actionType === 'update_field' && (
              <div className="flex gap-2">
                <Select className="h-8" value={step.field} onChange={(e) => update(step.localId, { field: e.target.value })}>
                  <option value="lead_status">Lead status</option>
                  <option value="lifecycle_stage">Lifecycle stage</option>
                </Select>
                <Input className="h-8 flex-1" placeholder="New value" value={step.value} onChange={(e) => update(step.localId, { value: e.target.value })} />
              </div>
            )}
            {step.kind === 'action' && step.actionType === 'send_email' && (
              <Select className="h-8" value={step.templateId} onChange={(e) => update(step.localId, { templateId: e.target.value })}>
                <option value="">Select an email template…</option>
                {emailTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            )}
            {step.kind === 'action' && step.actionType === 'send_sms' && (
              <Textarea rows={2} className="text-xs" placeholder="Hi {{firstName|there}}, …" value={step.smsBody} onChange={(e) => update(step.localId, { smsBody: e.target.value })} />
            )}

            {step.kind === 'condition' && (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Select className="h-8 flex-1" value={step.field} onChange={(e) => {
                    const next = CONDITION_FIELDS[e.target.value];
                    update(step.localId, { field: e.target.value, operator: next.operators[0], value: next.valueType === 'boolean' ? 'true' : next.valueType === 'select' ? next.options[0] : '' });
                  }}>
                    {Object.entries(CONDITION_FIELDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </Select>
                  <Select className="h-8 w-28" value={step.operator} onChange={(e) => update(step.localId, { operator: e.target.value })}>
                    {fieldDef.operators.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
                  </Select>
                </div>
                {fieldDef.valueType === 'boolean' ? (
                  <Select className="h-8" value={step.value} onChange={(e) => update(step.localId, { value: e.target.value })}>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Select>
                ) : fieldDef.valueType === 'select' ? (
                  <Select className="h-8" value={step.value} onChange={(e) => update(step.localId, { value: e.target.value })}>
                    {fieldDef.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                ) : (
                  <Input className="h-8" type={fieldDef.valueType === 'number' ? 'number' : 'text'} placeholder="Value" value={step.value} onChange={(e) => update(step.localId, { value: e.target.value })} />
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                  <div className="p-2 rounded-ui bg-canvas border border-hairline">
                    <div className="eyebrow mb-1.5">If yes</div>
                    <StepEditor steps={step.thenSteps} onChange={(s) => update(step.localId, { thenSteps: s })} emailTemplates={emailTemplates} depth={depth + 1} />
                  </div>
                  <div className="p-2 rounded-ui bg-canvas border border-hairline">
                    <div className="eyebrow mb-1.5">If no</div>
                    <StepEditor steps={step.elseSteps} onChange={(s) => update(step.localId, { elseSteps: s })} emailTemplates={emailTemplates} depth={depth + 1} />
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {!locked && (
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" icon={Clock} onClick={() => add('delay')}>Add wait</Button>
          <Button size="sm" icon={Plus} onClick={() => add('action')}>Add action</Button>
          {depth < 3 && <Button size="sm" icon={GitBranch} onClick={() => add('condition')}>Add condition</Button>}
        </div>
      )}
    </div>
  );
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
              <StepEditor steps={form.steps} onChange={(steps) => setForm({ ...form, steps })} emailTemplates={emailTemplates} />
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
