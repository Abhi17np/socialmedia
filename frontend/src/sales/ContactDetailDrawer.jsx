'use client';

import { useEffect, useState } from 'react';
import { Building2, Phone, Mail, Calendar, StickyNote, CheckSquare, X } from 'lucide-react';
import { Input, Select, Field, Banner, Drawer, Skeleton, Chip, Avatar } from '../ui';
import { money } from './format';
import { useTeamMembers } from './useTeamMembers';

const ACTIVITY_ICON = { call: Phone, email: Mail, meeting: Calendar, note: StickyNote, task: CheckSquare };
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'customer'];

/**
 * The lead detail view ContactsTab never had — every contact was only
 * ever a table row with an inline status <select>. Opens from a row
 * click; editable fields persist via PATCH /sales/contacts/:id (which
 * already recomputes lead_score on save), with the company, linked
 * deals (primary or secondary — see routes/sales.js's deal_contacts
 * join) and activity timeline alongside.
 */
function ContactDetailDrawer({ contactId, onClose, authFetch, SALES_API_BASE, canManage, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const members = useTeamMembers(authFetch);

  const load = () => {
    authFetch(`${SALES_API_BASE}/contacts/${contactId}`).then((r) => r.json()).then((d) => {
      if (d.error) throw new Error(d.error);
      setData(d);
      setEditForm({
        displayName: d.contact.display_name, phone: d.contact.phone || '', email: d.contact.email || '',
        jobTitle: d.contact.job_title || '', leadStatus: d.contact.lead_status, ownerId: d.contact.owner_id || '',
        tags: (d.contact.tags || []).join(', ')
      });
    }).catch((e) => setError(e.message));
  };

  useEffect(() => { if (contactId) load(); }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveField = async (patch) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/contacts/${contactId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not save.');
      setData((prev) => ({ ...prev, contact: result.contact }));
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Drawer open={!!contactId} onClose={onClose} title={data?.contact?.display_name || 'Lead'} subtitle={data?.company?.name} width={520}>
      {error && <div className="px-4 pt-3"><Banner tone="danger" action={<button onClick={() => setError(null)}><X size={14} /></button>}>{error}</Banner></div>}
      {!data ? (
        <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-24" /></div>
      ) : (
        <div className="p-4 flex flex-col gap-5">
          <div className="flex items-center gap-2">
            <Avatar name={data.contact.display_name} size={32} />
            <div className={`text-lg font-semibold tabular-nums ${data.contact.lead_score > 0 ? 'text-success' : data.contact.lead_score < 0 ? 'text-danger' : 'text-muted'}`}>
              {data.contact.lead_score}
            </div>
            <span className="text-[11px] text-muted">lead score</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input value={editForm.displayName} disabled={!canManage}
                onChange={(e) => setEditForm({ ...editForm, displayName: e.target.value })}
                onBlur={(e) => e.target.value.trim() && e.target.value !== data.contact.display_name && saveField({ displayName: e.target.value.trim() })} />
            </Field>
            <Field label="Job title">
              <Input value={editForm.jobTitle} disabled={!canManage}
                onChange={(e) => setEditForm({ ...editForm, jobTitle: e.target.value })}
                onBlur={(e) => e.target.value !== (data.contact.job_title || '') && saveField({ jobTitle: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={editForm.phone} disabled={!canManage}
                onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                onBlur={(e) => e.target.value !== (data.contact.phone || '') && saveField({ phone: e.target.value })} />
            </Field>
            <Field label="Email">
              <Input type="email" value={editForm.email} disabled={!canManage}
                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                onBlur={(e) => e.target.value !== (data.contact.email || '') && saveField({ email: e.target.value })} />
            </Field>
            <Field label="Lead status">
              <Select value={editForm.leadStatus} disabled={!canManage}
                onChange={(e) => { setEditForm({ ...editForm, leadStatus: e.target.value }); saveField({ leadStatus: e.target.value }); }}>
                {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="Owner">
              <Select value={editForm.ownerId} disabled={!canManage}
                onChange={(e) => { setEditForm({ ...editForm, ownerId: e.target.value }); saveField({ ownerId: e.target.value || null }); }}>
                <option value="">Unassigned</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
              </Select>
            </Field>
            <Field label="Tags" className="col-span-2" hint="Comma-separated">
              <Input value={editForm.tags} disabled={!canManage}
                onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
                onBlur={(e) => saveField({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} />
            </Field>
          </div>

          {data.company && (
            <div className="flex items-center gap-2 text-xs">
              <Building2 size={14} className="text-subtle" />
              <span className="font-medium text-ink">{data.company.name}</span>
              {data.company.industry && <span className="text-muted">· {data.company.industry}</span>}
            </div>
          )}

          <div>
            <div className="eyebrow mb-1.5">Deals ({data.deals.length})</div>
            {data.deals.length === 0 ? <p className="text-xs text-muted">No deals yet.</p> : (
              <div className="flex flex-col gap-1.5">
                {data.deals.map((d) => (
                  <div key={d.id} className="flex items-center justify-between text-xs bg-canvas rounded-ui px-2 py-1.5">
                    <span className="truncate">{d.name}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {d.status !== 'open' && <Chip tone={d.status === 'won' ? 'success' : 'danger'}>{d.status}</Chip>}
                      <span className="tabular-nums text-muted">{money(d.amount)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="eyebrow mb-1.5">Activity timeline ({data.activities.length})</div>
            {data.activities.length === 0 ? <p className="text-xs text-muted">No calls, emails or notes logged yet.</p> : (
              <div className="flex flex-col gap-1.5">
                {data.activities.map((a) => {
                  const Icon = ACTIVITY_ICON[a.type] || StickyNote;
                  return (
                    <div key={a.id} className="flex items-start gap-2 text-xs">
                      <span className="w-6 h-6 rounded-ui bg-canvas border border-hairline flex items-center justify-center shrink-0 text-muted mt-0.5"><Icon size={12} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-ink">{a.subject}</div>
                        {a.notes && <p className="text-[11px] text-muted mt-0.5">{a.notes}</p>}
                      </div>
                      <Chip tone={a.status === 'completed' ? 'success' : 'neutral'}>{a.status}</Chip>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

export default ContactDetailDrawer;
