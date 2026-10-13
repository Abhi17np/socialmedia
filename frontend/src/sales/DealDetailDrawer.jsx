'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Building2, Plus, X, Trash2, Phone, Mail, Calendar, StickyNote, CheckSquare, Clock
} from 'lucide-react';
import {
  Button, IconButton, Input, Select, Field,
  Banner, Modal, Drawer, Skeleton, Chip, Avatar, ConfirmDialog
} from '../ui';
import { useTeamMembers } from './useTeamMembers';

const ACTIVITY_ICON = { call: Phone, email: Mail, meeting: Calendar, note: StickyNote, task: CheckSquare };
const FORECAST_CATEGORIES = ['pipeline', 'best_case', 'commit', 'omitted'];
const FORECAST_LABELS = { pipeline: 'Pipeline', best_case: 'Best case', commit: 'Commit', omitted: 'Omitted' };

/**
 * The deal detail view the frontend never had — GET /sales/deals/:id
 * existed and returned activities+history since Stage 1, but nothing
 * ever called it. Opens from a kanban card or a table row; editable
 * properties persist via PATCH, the contact list persists via the new
 * deal_contacts routes, and the timeline/history are the deal's real
 * sales_activities and deal_stage_history rows.
 */
function DealDetailDrawer({ dealId, onClose, authFetch, SALES_API_BASE, canManage, canDelete, onChanged, pipelineStages }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lostMove, setLostMove] = useState(null);
  const [lostReason, setLostReason] = useState('');
  const members = useTeamMembers(authFetch);
  const searchDebounce = useRef(null);

  const load = () => {
    authFetch(`${SALES_API_BASE}/deals/${dealId}`).then((r) => r.json()).then((d) => {
      if (d.error) throw new Error(d.error);
      setData(d);
      setEditForm({
        name: d.deal.name, amount: d.deal.amount, currency: d.deal.currency,
        expectedCloseDate: d.deal.expected_close_date || '', forecastCategory: d.deal.forecast_category || 'pipeline',
        ownerId: d.deal.owner_id || ''
      });
    }).catch((e) => setError(e.message));
  };

  useEffect(() => { if (dealId) load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveField = async (patch) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/deals/${dealId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not save.');
      setData((prev) => ({ ...prev, deal: result.deal }));
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  };

  const searchContacts = (q) => {
    setContactQuery(q);
    clearTimeout(searchDebounce.current);
    if (q.trim().length < 2) { setContactResults([]); return; }
    searchDebounce.current = setTimeout(() => {
      authFetch(`${SALES_API_BASE}/contacts?search=${encodeURIComponent(q.trim())}&pageSize=8`)
        .then((r) => r.json())
        .then((d) => setContactResults((d.contacts || []).filter((c) => !(data?.contacts || []).some((lc) => lc.contactId === c.id))))
        .catch(() => {});
    }, 300);
  };

  const linkContact = async (contact) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/deals/${dealId}/contacts`, { method: 'POST', body: JSON.stringify({ contactId: contact.id }) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not link contact.');
      setAddContactOpen(false);
      setContactQuery('');
      setContactResults([]);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const unlinkContact = async (contactId) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/deals/${dealId}/contacts/${contactId}`, { method: 'DELETE' });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not remove contact.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const moveToStage = async (stageId, reason) => {
    try {
      const body = reason ? { stageId, lostReason: reason } : { stageId };
      const res = await authFetch(`${SALES_API_BASE}/deals/${dealId}/move`, { method: 'POST', body: JSON.stringify(body) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not move deal.');
      setData((prev) => ({ ...prev, deal: result.deal }));
      onChanged?.();
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleStageChange = (stageId) => {
    const target = (pipelineStages || []).find((s) => s.id === stageId);
    if (target?.is_lost) { setLostMove(stageId); setLostReason(''); return; }
    moveToStage(stageId);
  };

  const confirmLostMove = async () => {
    if (!lostReason.trim()) return;
    await moveToStage(lostMove, lostReason.trim());
    setLostMove(null);
  };

  const deleteDeal = async () => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/deals/${dealId}`, { method: 'DELETE' });
      if (!res.ok) { const result = await res.json(); throw new Error(result.error || 'Could not delete deal.'); }
      setConfirmDelete(false);
      onChanged?.();
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Drawer open={!!dealId} onClose={onClose} title={data?.deal?.name || 'Deal'} subtitle={data?.company?.name} width={520}>
      {error && <div className="px-4 pt-3"><Banner tone="danger" action={<button onClick={() => setError(null)}><X size={14} /></button>}>{error}</Banner></div>}
      {!data ? (
        <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-24" /></div>
      ) : (
        <div className="p-4 flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input value={editForm.name} disabled={!canManage}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                onBlur={(e) => e.target.value.trim() && e.target.value !== data.deal.name && saveField({ name: e.target.value.trim() })} />
            </Field>
            <Field label="Amount">
              <Input type="number" value={editForm.amount} disabled={!canManage}
                onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                onBlur={(e) => Number(e.target.value) !== Number(data.deal.amount) && saveField({ amount: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="Expected close">
              <Input type="date" value={editForm.expectedCloseDate} disabled={!canManage}
                onChange={(e) => { setEditForm({ ...editForm, expectedCloseDate: e.target.value }); saveField({ expectedCloseDate: e.target.value || null }); }} />
            </Field>
            <Field label="Forecast category">
              <Select value={editForm.forecastCategory} disabled={!canManage}
                onChange={(e) => { setEditForm({ ...editForm, forecastCategory: e.target.value }); saveField({ forecastCategory: e.target.value }); }}>
                {FORECAST_CATEGORIES.map((c) => <option key={c} value={c}>{FORECAST_LABELS[c]}</option>)}
              </Select>
            </Field>
            <Field label="Owner">
              <Select value={editForm.ownerId} disabled={!canManage}
                onChange={(e) => { setEditForm({ ...editForm, ownerId: e.target.value }); saveField({ ownerId: e.target.value || null }); }}>
                <option value="">Unassigned</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
              </Select>
            </Field>
            {pipelineStages && (
              <Field label="Stage">
                <Select value={data.deal.stage_id} disabled={!canManage} onChange={(e) => handleStageChange(e.target.value)}>
                  {pipelineStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
            )}
          </div>

          {data.deal.status !== 'open' && (
            <Chip tone={data.deal.status === 'won' ? 'success' : 'danger'}>
              {data.deal.status === 'won' ? 'Won' : `Lost${data.deal.lost_reason ? ` — ${data.deal.lost_reason}` : ''}`}
            </Chip>
          )}

          {data.company && (
            <div className="flex items-center gap-2 text-xs">
              <Building2 size={14} className="text-subtle" />
              <span className="font-medium text-ink">{data.company.name}</span>
              {data.company.industry && <span className="text-muted">· {data.company.industry}</span>}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="eyebrow">Contacts ({data.contacts.length})</div>
              {canManage && <button onClick={() => setAddContactOpen(true)} className="text-[11px] text-brand hover:underline flex items-center gap-1"><Plus size={11} />Add</button>}
            </div>
            {data.contacts.length === 0 ? <p className="text-xs text-muted">No contacts linked.</p> : (
              <div className="flex flex-col gap-1.5">
                {data.contacts.map((c) => (
                  <div key={c.linkId} className="flex items-center gap-2 text-xs bg-canvas rounded-ui px-2 py-1.5">
                    <Avatar name={c.display_name} size={20} />
                    <span className="flex-1 min-w-0 truncate">{c.display_name}</span>
                    {c.isPrimary && <Chip tone="brand">primary</Chip>}
                    {c.role && <span className="text-subtle">{c.role}</span>}
                    {canManage && <IconButton icon={Trash2} label="Remove" size={12} onClick={() => unlinkContact(c.contactId)} />}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="eyebrow mb-1.5">Stage history</div>
            {data.history.length === 0 ? <p className="text-xs text-muted">No stage changes yet.</p> : (
              <div className="flex flex-col gap-1.5">
                {data.history.map((h) => (
                  <div key={h.id} className="flex items-center gap-2 text-[11px] text-muted">
                    <Clock size={11} className="shrink-0" />
                    <span>{h.from_stage_name || 'Created'} → <span className="text-ink font-medium">{h.to_stage_name}</span></span>
                    <span className="ml-auto shrink-0">{new Date(h.changed_at).toLocaleDateString()}</span>
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

          {canDelete && (
            <Button variant="danger" size="sm" icon={Trash2} onClick={() => setConfirmDelete(true)}>Delete deal</Button>
          )}
        </div>
      )}

      <Modal
        open={addContactOpen} onClose={() => setAddContactOpen(false)} title="Link a contact to this deal"
        footer={<Button onClick={() => setAddContactOpen(false)}>Close</Button>}
      >
        <Input value={contactQuery} onChange={(e) => searchContacts(e.target.value)} placeholder="Search leads by name, phone or email…" autoFocus />
        <div className="mt-2 flex flex-col gap-1 max-h-60 overflow-y-auto">
          {contactResults.map((c) => (
            <button key={c.id} onClick={() => linkContact(c)} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-ui hover:bg-canvas text-left">
              <Avatar name={c.display_name} size={20} /><span className="flex-1 truncate">{c.display_name}</span><span className="text-muted">{c.phone || c.email || ''}</span>
            </button>
          ))}
          {contactQuery.trim().length >= 2 && contactResults.length === 0 && <p className="text-xs text-muted px-2 py-1.5">No matching leads.</p>}
        </div>
      </Modal>

      <Modal
        open={!!lostMove} onClose={() => setLostMove(null)} title="Why was this deal lost?"
        footer={<><Button onClick={() => setLostMove(null)}>Cancel</Button><Button variant="primary" onClick={confirmLostMove} disabled={!lostReason.trim()}>Move to Lost</Button></>}
      >
        <Field label="Lost reason" hint="Required — shown on the deal's history.">
          <Input value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="e.g. Budget cut, chose a competitor" autoFocus />
        </Field>
      </Modal>

      <ConfirmDialog
        open={confirmDelete} onCancel={() => setConfirmDelete(false)} onConfirm={deleteDeal}
        title="Delete this deal?" body={`"${data?.deal?.name}" and its activity/stage history will be permanently removed.`} confirmLabel="Delete"
      />
    </Drawer>
  );
}

export default DealDetailDrawer;
