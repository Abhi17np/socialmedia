'use client';

import { useEffect, useState } from 'react';
import { Plus, Trash2, SlidersHorizontal, Target, ScrollText, Zap, Layers, Mail } from 'lucide-react';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Select, Field,
  Banner, Modal, Drawer, ConfirmDialog, EmptyState, Skeleton, Chip, FilterPill, Checkbox
} from '../ui';
import { money, errorMessage } from './format';
import { useTeamMembers } from './useTeamMembers';

const SECTIONS = [
  { key: 'customFields', label: 'Custom fields', icon: Layers },
  { key: 'leadScoring', label: 'Lead scoring', icon: SlidersHorizontal },
  { key: 'targets', label: 'Targets', icon: Target },
  { key: 'automation', label: 'Automation', icon: Zap },
  { key: 'email', label: 'Email & calendar', icon: Mail },
  { key: 'auditLog', label: 'Audit log', icon: ScrollText }
];

/**
 * Sales Hub admin settings — every panel here is real CRUD over Stage 1's
 * backend additions (migrations 016/017, routes/sales.js), not a mockup.
 * Only reachable by admin+ (SalesHub.jsx gates the tab itself).
 */
function SettingsTab({ authFetch, SALES_API_BASE }) {
  const [section, setSection] = useState('customFields');

  return (
    <>
      <div className="flex items-center gap-1.5 flex-wrap">
        {SECTIONS.map((s) => (
          <FilterPill key={s.key} active={section === s.key} onClick={() => setSection(s.key)}>
            <s.icon size={12} />{s.label}
          </FilterPill>
        ))}
      </div>

      {section === 'customFields' && <CustomFieldsPanel authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} />}
      {section === 'leadScoring' && <LeadScoringPanel authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} />}
      {section === 'targets' && <TargetsPanel authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} />}
      {section === 'automation' && <AutomationPanel authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} />}
      {section === 'email' && <EmailCalendarPanel authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} />}
      {section === 'auditLog' && <AuditLogPanel authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} />}
    </>
  );
}

// ---------------------------------------------------------- Custom fields

const ENTITY_TYPES = ['contact', 'company', 'deal'];
const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select'];

function CustomFieldsPanel({ authFetch, SALES_API_BASE }) {
  const [fields, setFields] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [form, setForm] = useState({ entityType: 'contact', fieldKey: '', label: '', fieldType: 'text', options: '', isRequired: false });

  const load = () => { authFetch(`${SALES_API_BASE}/custom-fields`).then((r) => r.json()).then((d) => setFields(d.fields || [])).catch((e) => setError(e.message)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const body = {
        entityType: form.entityType, fieldKey: form.fieldKey.trim(), label: form.label.trim(), fieldType: form.fieldType,
        isRequired: form.isRequired,
        options: form.fieldType === 'select' ? form.options.split(',').map((o) => o.trim()).filter(Boolean) : undefined
      };
      const res = await authFetch(`${SALES_API_BASE}/custom-fields`, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not create field.'));
      setFields((prev) => [...(prev || []), data.field]);
      setOpen(false);
      setForm({ entityType: 'contact', fieldKey: '', label: '', fieldType: 'text', options: '', isRequired: false });
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (field) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/custom-fields/${field.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not delete field.'));
      setFields((prev) => prev.filter((f) => f.id !== field.id));
      setConfirmDelete(null);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Custom fields" meta="Extra fields rendered on Contact/Company/Deal records" action={<Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New field</Button>} />
      {error && <div className="px-4 pt-3"><Banner tone="danger">{error}</Banner></div>}
      {fields === null ? (
        <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
      ) : fields.length === 0 ? (
        <EmptyState icon={Layers} title="No custom fields yet" description="Add fields your team needs beyond the built-in ones." />
      ) : (
        <Table>
          <thead><tr><Th>Label</Th><Th>Entity</Th><Th>Key</Th><Th>Type</Th><Th>Required</Th><Th align="right"> </Th></tr></thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.id} className="hover:bg-canvas transition-colors">
                <Td><span className="font-medium">{f.label}</span></Td>
                <Td><Chip tone="neutral">{f.entity_type}</Chip></Td>
                <Td><code className="text-[11px]">{f.field_key}</code></Td>
                <Td>{f.field_type}</Td>
                <Td>{f.is_required ? 'Yes' : 'No'}</Td>
                <Td align="right"><IconButton icon={Trash2} label="Delete" size={14} onClick={() => setConfirmDelete(f)} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={open} onClose={() => setOpen(false)} title="New custom field"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.fieldKey.trim() || !form.label.trim()}>Create</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Applies to">
            <Select value={form.entityType} onChange={(e) => setForm({ ...form, entityType: e.target.value })}>
              {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Label"><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Industry segment" autoFocus /></Field>
          <Field label="Key" hint="lowercase_with_underscores — used in the record's custom_fields data">
            <Input value={form.fieldKey} onChange={(e) => setForm({ ...form, fieldKey: e.target.value })} placeholder="industry_segment" />
          </Field>
          <Field label="Field type">
            <Select value={form.fieldType} onChange={(e) => setForm({ ...form, fieldType: e.target.value })}>
              {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          {form.fieldType === 'select' && (
            <Field label="Options" hint="Comma-separated"><Input value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} placeholder="small, medium, large" /></Field>
          )}
          <label className="flex items-center gap-2 text-xs"><Checkbox checked={form.isRequired} onChange={(e) => setForm({ ...form, isRequired: e.target.checked })} />Required</label>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete} onCancel={() => setConfirmDelete(null)} onConfirm={() => remove(confirmDelete)}
        title="Delete this custom field?" body={`"${confirmDelete?.label}" will no longer appear on ${confirmDelete?.entity_type} records. Existing values are kept in the record's data but won't be editable here anymore.`}
        confirmLabel="Delete"
      />
    </Panel>
  );
}

// ---------------------------------------------------------- Lead scoring

const CONDITION_TYPES = [
  'has_email', 'has_phone', 'has_company', 'tag_equals', 'lead_status_equals',
  'email_opened_any', 'email_clicked_any', 'form_submitted_any', 'journey_completed_any'
];
const CONDITION_LABELS = {
  has_email: 'Has an email address', has_phone: 'Has a phone number', has_company: 'Belongs to a company',
  tag_equals: 'Has tag', lead_status_equals: 'Lead status is',
  // Marketing engagement (Phase 6) — folded into the same scoring model,
  // computed live from real Marketing Hub events (lib/leadScoring.js).
  email_opened_any: 'Opened a marketing email', email_clicked_any: 'Clicked a link in a marketing email',
  form_submitted_any: 'Submitted a lead form', journey_completed_any: 'Completed a journey'
};
const CONDITION_NEEDS_VALUE = ['tag_equals', 'lead_status_equals'];

function LeadScoringPanel({ authFetch, SALES_API_BASE }) {
  const [rules, setRules] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', conditionType: 'has_email', conditionValue: '', points: 10 });

  const load = () => { authFetch(`${SALES_API_BASE}/lead-scoring-rules`).then((r) => r.json()).then((d) => setRules(d.rules || [])).catch((e) => setError(e.message)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/lead-scoring-rules`, {
        method: 'POST',
        body: JSON.stringify({ name: form.name, conditionType: form.conditionType, conditionValue: form.conditionValue || undefined, points: Number(form.points) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not create rule.'));
      setRules((prev) => [...(prev || []), data.rule]);
      setOpen(false);
      setForm({ name: '', conditionType: 'has_email', conditionValue: '', points: 10 });
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleActive = async (rule) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/lead-scoring-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !rule.is_active }) });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not update rule.'));
      setRules((prev) => prev.map((r) => (r.id === rule.id ? data.rule : r)));
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (rule) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/lead-scoring-rules/${rule.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not delete rule.'));
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Lead scoring rules" meta="Each active rule's points are summed into a contact's lead score" action={<Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New rule</Button>} />
      {error && <div className="px-4 pt-3"><Banner tone="danger">{error}</Banner></div>}
      {rules === null ? (
        <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
      ) : rules.length === 0 ? (
        <EmptyState icon={SlidersHorizontal} title="No scoring rules yet" description="E.g. award points for having an email, or deduct points for being unqualified." />
      ) : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Condition</Th><Th align="right">Points</Th><Th>Active</Th><Th align="right"> </Th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="hover:bg-canvas transition-colors">
                <Td><span className="font-medium">{r.name}</span></Td>
                <Td>{CONDITION_LABELS[r.condition_type]}{r.condition_value ? ` "${r.condition_value}"` : ''}</Td>
                <Td align="right"><span className={r.points >= 0 ? 'text-success' : 'text-danger'}>{r.points >= 0 ? '+' : ''}{r.points}</span></Td>
                <Td><button onClick={() => toggleActive(r)}><Chip tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'active' : 'paused'}</Chip></button></Td>
                <Td align="right"><IconButton icon={Trash2} label="Delete" size={14} onClick={() => remove(r)} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={open} onClose={() => setOpen(false)} title="New lead scoring rule"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.name.trim() || (CONDITION_NEEDS_VALUE.includes(form.conditionType) && !form.conditionValue.trim())}>Create</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Has email" autoFocus /></Field>
          <Field label="Condition">
            <Select value={form.conditionType} onChange={(e) => setForm({ ...form, conditionType: e.target.value })}>
              <optgroup label="Contact attributes">
                {CONDITION_TYPES.slice(0, 5).map((t) => <option key={t} value={t}>{CONDITION_LABELS[t]}</option>)}
              </optgroup>
              <optgroup label="Marketing engagement">
                {CONDITION_TYPES.slice(5).map((t) => <option key={t} value={t}>{CONDITION_LABELS[t]}</option>)}
              </optgroup>
            </Select>
          </Field>
          {CONDITION_NEEDS_VALUE.includes(form.conditionType) && (
            <Field label={form.conditionType === 'tag_equals' ? 'Tag' : 'Lead status'}>
              <Input value={form.conditionValue} onChange={(e) => setForm({ ...form, conditionValue: e.target.value })} placeholder={form.conditionType === 'tag_equals' ? 'vip' : 'unqualified'} />
            </Field>
          )}
          <Field label="Points" hint="Negative to dock a score"><Input type="number" value={form.points} onChange={(e) => setForm({ ...form, points: e.target.value })} /></Field>
        </div>
      </Modal>
    </Panel>
  );
}

// -------------------------------------------------------------- Targets

function TargetsPanel({ authFetch, SALES_API_BASE }) {
  const [targets, setTargets] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ownerId: '', periodStart: '', periodEnd: '', targetAmount: '', currency: 'INR' });
  const members = useTeamMembers(authFetch);
  const memberEmail = (id) => members.find((m) => m.id === id)?.email || '—';

  const load = () => { authFetch(`${SALES_API_BASE}/targets`).then((r) => r.json()).then((d) => setTargets(d.targets || [])).catch((e) => setError(e.message)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/targets`, {
        method: 'POST',
        body: JSON.stringify({ ownerId: form.ownerId || undefined, periodStart: form.periodStart, periodEnd: form.periodEnd, targetAmount: Number(form.targetAmount), currency: form.currency })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not create target.'));
      setTargets((prev) => [data.target, ...(prev || [])]);
      setOpen(false);
      setForm({ ownerId: '', periodStart: '', periodEnd: '', targetAmount: '', currency: 'INR' });
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (target) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/targets/${target.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not delete target.'));
      setTargets((prev) => prev.filter((t) => t.id !== target.id));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Sales targets" meta="Shown on the Dashboard tab as attainment vs. actual revenue" action={<Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New target</Button>} />
      {error && <div className="px-4 pt-3"><Banner tone="danger">{error}</Banner></div>}
      {targets === null ? (
        <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
      ) : targets.length === 0 ? (
        <EmptyState icon={Target} title="No targets set" description="Set a team-wide or per-rep revenue target for a period." />
      ) : (
        <Table>
          <thead><tr><Th>Scope</Th><Th>Period</Th><Th align="right">Target</Th><Th align="right"> </Th></tr></thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.id} className="hover:bg-canvas transition-colors">
                <Td>{t.owner_id ? memberEmail(t.owner_id) : <span className="font-medium">Team-wide</span>}</Td>
                <Td>{t.period_start} → {t.period_end}</Td>
                <Td align="right">{money(t.target_amount)}</Td>
                <Td align="right"><IconButton icon={Trash2} label="Delete" size={14} onClick={() => remove(t)} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={open} onClose={() => setOpen(false)} title="New sales target"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.periodStart || !form.periodEnd || !form.targetAmount}>Create</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Scope">
            <Select value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
              <option value="">Team-wide</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
            </Select>
          </Field>
          <div className="flex gap-3">
            <Field label="Period start" className="flex-1"><Input type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} /></Field>
            <Field label="Period end" className="flex-1"><Input type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} /></Field>
          </div>
          <Field label="Target amount"><Input type="number" value={form.targetAmount} onChange={(e) => setForm({ ...form, targetAmount: e.target.value })} placeholder="300000" /></Field>
        </div>
      </Modal>
    </Panel>
  );
}

// ------------------------------------------------------------ Automation

const TRIGGER_LABELS = {
  contact_created: 'A contact is created', contact_tag_added: 'A tag is added to a contact',
  deal_stage_changed: 'A deal changes stage', deal_won: 'A deal is won', deal_lost: 'A deal is lost'
};
const ACTION_LABELS = { add_tag: 'Add a tag', remove_tag: 'Remove a tag', create_task: 'Create a follow-up task', assign_owner: 'Assign an owner' };

function AutomationPanel({ authFetch, SALES_API_BASE }) {
  const [rules, setRules] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [runsFor, setRunsFor] = useState(null);
  const [runs, setRuns] = useState(null);
  const [form, setForm] = useState({ name: '', triggerType: 'contact_created', actionType: 'add_tag', tag: '', taskSubject: '', ownerId: '' });
  const members = useTeamMembers(authFetch);

  const load = () => { authFetch(`${SALES_API_BASE}/automation-rules`).then((r) => r.json()).then((d) => setRules(d.rules || [])).catch((e) => setError(e.message)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const actionConfig = form.actionType === 'create_task' ? { subject: form.taskSubject }
        : form.actionType === 'assign_owner' ? { ownerId: form.ownerId }
        : { tag: form.tag };
      const res = await authFetch(`${SALES_API_BASE}/automation-rules`, {
        method: 'POST',
        body: JSON.stringify({ name: form.name, triggerType: form.triggerType, actionType: form.actionType, actionConfig })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not create rule.'));
      setRules((prev) => [data.rule, ...(prev || [])]);
      setOpen(false);
      setForm({ name: '', triggerType: 'contact_created', actionType: 'add_tag', tag: '', taskSubject: '', ownerId: '' });
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleActive = async (rule) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/automation-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !rule.is_active }) });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not update rule.'));
      setRules((prev) => prev.map((r) => (r.id === rule.id ? data.rule : r)));
    } catch (err) {
      setError(err.message);
    }
  };

  const viewRuns = async (rule) => {
    setRunsFor(rule);
    const res = await authFetch(`${SALES_API_BASE}/automation-rules/${rule.id}/runs`);
    const data = await res.json();
    setRuns(data.runs || []);
  };

  const actionDisabled = !form.name.trim()
    || (form.actionType === 'create_task' && !form.taskSubject.trim())
    || (form.actionType === 'assign_owner' && !form.ownerId)
    || (!['create_task', 'assign_owner'].includes(form.actionType) && !form.tag.trim());

  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Automation rules" meta="Fires from real Sales Hub events — contact and deal changes" action={<Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New rule</Button>} />
      {error && <div className="px-4 pt-3"><Banner tone="danger">{error}</Banner></div>}
      {rules === null ? (
        <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
      ) : rules.length === 0 ? (
        <EmptyState icon={Zap} title="No automation rules yet" description="E.g. assign a new lead to a rep, or tag a contact when a deal is won." />
      ) : (
        <Table>
          <thead><tr><Th>Name</Th><Th>When</Th><Th>Then</Th><Th>Active</Th><Th align="right"> </Th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="hover:bg-canvas transition-colors">
                <Td><span className="font-medium">{r.name}</span></Td>
                <Td>{TRIGGER_LABELS[r.trigger_type]}</Td>
                <Td>{ACTION_LABELS[r.action_type]}{r.action_config?.tag ? ` "${r.action_config.tag}"` : ''}</Td>
                <Td><button onClick={() => toggleActive(r)}><Chip tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'active' : 'paused'}</Chip></button></Td>
                <Td align="right"><Button size="sm" onClick={() => viewRuns(r)}>Runs</Button></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={open} onClose={() => setOpen(false)} title="New automation rule"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={actionDisabled}>Create</Button></>}
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
          {form.actionType === 'create_task' && (
            <Field label="Task subject"><Input value={form.taskSubject} onChange={(e) => setForm({ ...form, taskSubject: e.target.value })} placeholder="Follow up with contact" /></Field>
          )}
          {form.actionType === 'assign_owner' && (
            <Field label="Owner">
              <Select value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
                <option value="">Select a rep…</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
              </Select>
            </Field>
          )}
          {['add_tag', 'remove_tag'].includes(form.actionType) && (
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
    </Panel>
  );
}

// ------------------------------------------------------- Email & calendar

const PROVIDER_LABELS = { gmail: 'Gmail', microsoft365: 'Microsoft 365' };

/**
 * Real connection status for each provider — nothing here is mocked.
 * `configured: false` (the case in every environment without real OAuth
 * credentials — see SALES_HUB_IMPLEMENTATION.md's "Blocked: Email &
 * Calendar") disables Connect outright with an explanation, rather than
 * pretending a connect flow exists. `configured: true, connected: false`
 * is a real "Connect" button that redirects to the provider's actual
 * consent screen (backend/routes/salesEmail.js).
 */
function EmailCalendarPanel({ authFetch, SALES_API_BASE }) {
  const [providers, setProviders] = useState(null);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);
  const [connectingProvider, setConnectingProvider] = useState(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(null);

  const load = () => { authFetch(`${SALES_API_BASE}/email/status`).then((r) => r.json()).then((d) => setProviders(d.providers || [])).catch((e) => setError(e.message)); };

  // The OAuth callback redirects the browser back to ?tab=email&email_connected=<provider>
  // or &email_error=<message> — surface it once, then strip just those
  // two params so a refresh doesn't reshow it and ?tab=email is kept.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('email_connected');
    const connectError = params.get('email_error');
    if (connected) setBanner({ tone: 'success', text: `${PROVIDER_LABELS[connected] || connected} connected.` });
    if (connectError) setBanner({ tone: 'danger', text: connectError });
    if (connected || connectError) {
      params.delete('email_connected');
      params.delete('email_error');
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (provider) => {
    setConnectingProvider(provider);
    try {
      const res = await authFetch(`${SALES_API_BASE}/email/connect/${provider}`);
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not start the connect flow.'));
      window.location.href = data.url; // leaves the app for the provider's real OAuth consent screen
    } catch (err) {
      setBanner({ tone: 'danger', text: err.message });
      setConnectingProvider(null);
    }
  };

  const disconnect = async (provider) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/email/${provider}/disconnect`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not disconnect.'));
      setConfirmDisconnect(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Email & calendar" meta="Connect your own inbox to log sent emails and sync meetings against deals and contacts" />
      {banner && <div className="px-4 pt-3"><Banner tone={banner.tone}>{banner.text}</Banner></div>}
      {error && <div className="px-4 pt-3"><Banner tone="danger">{error}</Banner></div>}

      {providers === null ? (
        <div className="p-4 space-y-3"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
      ) : (
        <div className="divide-y divide-hairline">
          {providers.map((p) => (
            <div key={p.provider} className="px-4 py-3.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink flex items-center gap-2">
                  {PROVIDER_LABELS[p.provider] || p.provider}
                  {p.connected && <Chip tone="success">Connected</Chip>}
                  {!p.configured && <Chip tone="neutral">Not configured</Chip>}
                </div>
                {p.connected ? (
                  <div className="text-xs text-muted mt-0.5">{p.emailAddress}</div>
                ) : !p.configured ? (
                  <div className="text-xs text-muted mt-0.5">
                    Needs an administrator to set up OAuth credentials for this provider — see SALES_HUB_IMPLEMENTATION.md&rsquo;s &ldquo;Blocked: Email &amp; Calendar&rdquo; section for the exact environment variables.
                  </div>
                ) : (
                  <div className="text-xs text-muted mt-0.5">Not connected yet.</div>
                )}
              </div>
              {p.connected ? (
                <Button size="sm" onClick={() => setConfirmDisconnect(p.provider)}>Disconnect</Button>
              ) : (
                <Button
                  size="sm" variant="primary" disabled={!p.configured || connectingProvider === p.provider}
                  onClick={() => connect(p.provider)}
                >
                  {connectingProvider === p.provider ? 'Redirecting…' : 'Connect'}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDisconnect} title={`Disconnect ${PROVIDER_LABELS[confirmDisconnect] || confirmDisconnect}?`}
        body="Deals and contacts keep any activity already logged from this account, but no further emails or calendar events will sync until you reconnect."
        confirmLabel="Disconnect"
        onConfirm={() => disconnect(confirmDisconnect)} onCancel={() => setConfirmDisconnect(null)}
      />
    </Panel>
  );
}

// ------------------------------------------------------------- Audit log

function AuditLogPanel({ authFetch, SALES_API_BASE }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);

  const load = () => { authFetch(`${SALES_API_BASE}/audit-log`).then((r) => r.json()).then((d) => setEntries(d.entries || [])).catch((e) => setError(e.message)); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Audit log" meta="Who did what, across companies, contacts, deals, pipelines and rules" />
      {error && <div className="px-4 pt-3"><Banner tone="danger">{error}</Banner></div>}
      {entries === null ? (
        <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
      ) : entries.length === 0 ? (
        <EmptyState icon={ScrollText} title="No activity recorded yet" description="Every create/update/delete in the Sales Hub is logged here." />
      ) : (
        <Table>
          <thead><tr><Th>When</Th><Th>Action</Th><Th>Target</Th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="hover:bg-canvas transition-colors">
                <Td>{new Date(e.created_at).toLocaleString()}</Td>
                <Td><code className="text-[11px]">{e.action}</code></Td>
                <Td>{e.target_type ? `${e.target_type}${e.target_id ? ` · ${e.target_id.slice(0, 8)}` : ''}` : '—'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

export default SettingsTab;
