'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton, Select, Input, PillSelect } from '../ui';

/**
 * A two-level AND/OR segment rule builder: the top level combines groups
 * with one logic (AND/OR), each group combines its own conditions with
 * its own logic — e.g. "(tag is vip) AND (score >= 50 OR stage = customer)".
 * This covers the overwhelming majority of real segmentation needs
 * without a free-form recursive tree editor; the backend
 * (lib/segmentCompiler.js) supports arbitrary nesting for anything built
 * directly against the API.
 *
 * Produces/consumes exactly the v2 filter_json shape
 * routes/whatsapp.js's segment routes validate:
 *   { version: 2, root: { logic, children: [{ logic, children: [...] }, ...] } }
 */

const FIELD_DEFS = [
  { value: 'tags', label: 'Tags', valueType: 'tags', operators: [['contains_any', 'contains any of'], ['contains_all', 'contains all of'], ['not_contains', 'does not contain']] },
  { value: 'lead_status', label: 'Lead status', valueType: 'text', operators: [['eq', 'is'], ['neq', 'is not']] },
  { value: 'lifecycle_stage', label: 'Lifecycle stage', valueType: 'select', options: ['subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist', 'other'], operators: [['eq', 'is'], ['neq', 'is not']] },
  { value: 'lead_score', label: 'Lead score', valueType: 'number', operators: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤']] },
  { value: 'email', label: 'Email address', valueType: 'none', operators: [['is_set', 'is set'], ['not_set', 'is not set']] },
  { value: 'phone', label: 'Phone number', valueType: 'none', operators: [['is_set', 'is set'], ['not_set', 'is not set']] },
  { value: 'display_name', label: 'Name', valueType: 'text', operators: [['contains', 'contains']] },
  { value: 'created_at', label: 'Created', valueType: 'date', operators: [['after', 'after'], ['before', 'before']] },
  { value: 'global_opt_out', label: 'Globally unsubscribed', valueType: 'boolean', operators: [['eq', 'is']] },
  { value: 'channel_identity', label: 'Has channel identity', valueType: 'select', options: ['whatsapp', 'instagram', 'facebook'], operators: [['has', 'has'], ['not_has', 'does not have']] },
  { value: 'consent_status', label: 'Consent status', valueType: 'consent', operators: [['eq', 'is']] },
  { value: 'deal_status', label: 'Deal status', valueType: 'select', options: ['open', 'won', 'lost'], operators: [['eq', 'is']] },
  { value: 'has_open_deal', label: 'Has an open deal', valueType: 'boolean', operators: [['eq', 'is']] },
  { value: 'deal_amount', label: 'Deal amount', valueType: 'number', operators: [['gte', '≥'], ['lte', '≤']] }
];

const fieldDef = (field) => FIELD_DEFS.find((f) => f.value === field) || FIELD_DEFS[0];

function defaultValueFor(def) {
  if (def.valueType === 'tags') return [];
  if (def.valueType === 'boolean') return true;
  if (def.valueType === 'select') return def.options[0];
  if (def.valueType === 'consent') return { channel: 'whatsapp', status: 'opted_out' };
  if (def.valueType === 'none') return undefined;
  return '';
}

function newCondition() {
  const def = FIELD_DEFS[0];
  return { field: def.value, operator: def.operators[0][0], value: defaultValueFor(def) };
}

function ValueEditor({ condition, onChange }) {
  const def = fieldDef(condition.field);
  if (def.valueType === 'none') return null;
  if (def.valueType === 'tags') {
    return (
      <Input
        className="h-8 flex-1 min-w-[140px]"
        placeholder="vip, newsletter"
        value={(condition.value || []).join(', ')}
        onChange={(e) => onChange(e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
        aria-label="Tag values, comma-separated"
      />
    );
  }
  if (def.valueType === 'number') {
    return <Input type="number" className="h-8 w-28" value={condition.value ?? ''} onChange={(e) => onChange(Number(e.target.value))} aria-label={`${def.label} value`} />;
  }
  if (def.valueType === 'date') {
    return <Input type="date" className="h-8" value={condition.value || ''} onChange={(e) => onChange(e.target.value)} aria-label={`${def.label} value`} />;
  }
  if (def.valueType === 'boolean') {
    return (
      <Select className="h-8" value={String(condition.value)} onChange={(e) => onChange(e.target.value === 'true')} aria-label={`${def.label} value`}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }
  if (def.valueType === 'select') {
    return (
      <Select className="h-8" value={condition.value} onChange={(e) => onChange(e.target.value)} aria-label={`${def.label} value`}>
        {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </Select>
    );
  }
  if (def.valueType === 'consent') {
    const v = condition.value || {};
    return (
      <div className="flex items-center gap-1.5">
        <Select className="h-8" value={v.channel} onChange={(e) => onChange({ ...v, channel: e.target.value })} aria-label="Consent channel">
          <option value="email">Email</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="sms">SMS</option>
        </Select>
        <Select className="h-8" value={v.status} onChange={(e) => onChange({ ...v, status: e.target.value })} aria-label="Consent status">
          <option value="opted_in">Opted in</option>
          <option value="opted_out">Opted out</option>
        </Select>
      </div>
    );
  }
  return <Input className="h-8 flex-1 min-w-[120px]" value={condition.value || ''} onChange={(e) => onChange(e.target.value)} aria-label={`${def.label} value`} />;
}

function ConditionRow({ condition, onChange, onRemove }) {
  const def = fieldDef(condition.field);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        className="h-8 w-40"
        value={condition.field}
        onChange={(e) => {
          const nd = fieldDef(e.target.value);
          onChange({ field: nd.value, operator: nd.operators[0][0], value: defaultValueFor(nd) });
        }}
        aria-label="Field"
      >
        {FIELD_DEFS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
      </Select>
      <Select className="h-8 w-36" value={condition.operator} onChange={(e) => onChange({ ...condition, operator: e.target.value })} aria-label="Operator">
        {def.operators.map(([op, label]) => <option key={op} value={op}>{label}</option>)}
      </Select>
      <ValueEditor condition={condition} onChange={(value) => onChange({ ...condition, value })} />
      <IconButton icon={Trash2} label="Remove condition" onClick={onRemove} />
    </div>
  );
}

function GroupEditor({ group, onChange, onRemove, removable }) {
  const setLogic = (logic) => onChange({ ...group, logic });
  const updateChild = (i, child) => onChange({ ...group, children: group.children.map((c, idx) => (idx === i ? child : c)) });
  const removeChild = (i) => onChange({ ...group, children: group.children.filter((_, idx) => idx !== i) });
  const addChild = () => onChange({ ...group, children: [...group.children, newCondition()] });

  return (
    <div className="rounded-ui border border-hairline p-3 flex flex-col gap-2 bg-canvas">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted">
          Match
          <PillSelect value={group.logic} onChange={(e) => setLogic(e.target.value)} aria-label="Group match logic">
            <option value="AND">all</option>
            <option value="OR">any</option>
          </PillSelect>
          of these conditions
        </div>
        {removable && <IconButton icon={Trash2} label="Remove group" onClick={onRemove} />}
      </div>
      <div className="flex flex-col gap-2">
        {group.children.map((child, i) => (
          <ConditionRow key={i} condition={child} onChange={(c) => updateChild(i, c)} onRemove={() => removeChild(i)} />
        ))}
      </div>
      <Button size="sm" icon={Plus} onClick={addChild} className="self-start">Add condition</Button>
    </div>
  );
}

function emptyRoot() {
  return { logic: 'AND', children: [{ logic: 'AND', children: [newCondition()] }] };
}

/** `value`/`onChange` manage the v2 root tree directly (always a two-level group-of-groups shape) — the parent owns persistence. */
export default function SegmentRuleBuilder({ value, onChange }) {
  const root = value || emptyRoot();
  const groups = root.children;

  const setTopLogic = (logic) => onChange({ ...root, logic });
  const updateGroup = (i, group) => onChange({ ...root, children: groups.map((g, idx) => (idx === i ? group : g)) });
  const removeGroup = (i) => onChange({ ...root, children: groups.filter((_, idx) => idx !== i) });
  const addGroup = () => onChange({ ...root, children: [...groups, { logic: 'AND', children: [newCondition()] }] });

  return (
    <div className="flex flex-col gap-2">
      {groups.length > 1 && (
        <div className="flex items-center gap-1.5 text-xs text-muted">
          Match
          <PillSelect value={root.logic} onChange={(e) => setTopLogic(e.target.value)} aria-label="Overall match logic">
            <option value="AND">all</option>
            <option value="OR">any</option>
          </PillSelect>
          of these groups
        </div>
      )}
      {groups.map((group, i) => (
        <GroupEditor key={i} group={group} onChange={(g) => updateGroup(i, g)} onRemove={() => removeGroup(i)} removable={groups.length > 1} />
      ))}
      <Button size="sm" icon={Plus} onClick={addGroup} className="self-start">Add group</Button>
    </div>
  );
}

export { emptyRoot as emptySegmentRoot };
