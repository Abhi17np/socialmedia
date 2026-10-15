'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Plus, FileText, Play, Pause, Trash2, PencilLine, Copy, ArrowUp, ArrowDown, Check } from 'lucide-react';
import { API_BASE } from '../apiBase';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Textarea, Select, Field, Checkbox,
  Banner, Modal, Drawer, EmptyState, Skeleton, Chip, Pagination, ConfirmDialog
} from '../ui';

const MKT_API_BASE = `${API_BASE}/marketing`;

const FIELD_TYPES = { text: 'Text', email: 'Email', phone: 'Phone', textarea: 'Long text', select: 'Dropdown', checkbox: 'Checkbox' };

let fieldCounter = 1;
function newField() {
  return { localId: `field-${fieldCounter++}`, key: '', label: '', type: 'text', required: false, options: '' };
}

function emptyForm() {
  return {
    id: null, version: undefined, name: '', description: '', consentRequired: true,
    consentText: 'I agree to receive marketing communications.', thankYouMessage: 'Thanks — we\'ll be in touch shortly.', redirectUrl: '',
    fields: [{ ...newField(), key: 'name', label: 'Full name', required: true }, { ...newField(), key: 'email', label: 'Email', type: 'email', required: true }]
  };
}

function formFromRecord(form) {
  return {
    id: form.id, version: form.version, name: form.name, description: form.description || '', consentRequired: form.consent_required,
    consentText: form.consent_text, thankYouMessage: form.thank_you_message, redirectUrl: form.redirect_url || '',
    fields: form.fields.map((f) => ({ localId: `field-${fieldCounter++}`, key: f.key, label: f.label, type: f.type, required: !!f.required, options: (f.options || []).join(', ') }))
  };
}

/**
 * Lead capture forms (Phase 5): the authoring/management surface over
 * backend/routes/leadForms.js. A form's public hosted page lives at
 * `${FRONTEND_URL}/forms/:id` — this tab is where a tenant builds the
 * field list, turns a form live, and sees who actually submitted it
 * (each a real Sales Hub contact, not a Marketing-Hub-only shadow
 * record — see lib/leadForms.js's header).
 */
export default function FormsSection({ authFetch, canManage, canAdmin }) {
  const [forms, setForms] = useState(null);
  const [error, setError] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [detail, setDetail] = useState(null);
  const [submissions, setSubmissions] = useState(null);
  const [subPage, setSubPage] = useState(1);
  const [subTotal, setSubTotal] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [snippet, setSnippet] = useState(null);
  const [trackingSummary, setTrackingSummary] = useState(null);
  const [snippetCopied, setSnippetCopied] = useState(false);

  const load = () => {
    authFetch(`${MKT_API_BASE}/forms`).then((r) => r.json()).then((d) => setForms(d.forms || [])).catch((e) => setError(e.message));
    authFetch(`${MKT_API_BASE}/tracking/snippet`).then((r) => r.json()).then((d) => setSnippet(d.snippet)).catch(() => {});
    authFetch(`${MKT_API_BASE}/tracking/summary`).then((r) => r.json()).then(setTrackingSummary).catch(() => {});
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const copySnippet = () => {
    navigator.clipboard.writeText(snippet).then(() => { setSnippetCopied(true); setTimeout(() => setSnippetCopied(false), 1500); });
  };

  const openCreate = () => { setForm(emptyForm()); setEditorOpen(true); };
  const openEdit = (f) => { setForm(formFromRecord(f)); setEditorOpen(true); };

  const addField = () => setForm((f) => ({ ...f, fields: [...f.fields, newField()] }));
  const removeField = (localId) => setForm((f) => ({ ...f, fields: f.fields.filter((x) => x.localId !== localId) }));
  const updateField = (localId, patch) => setForm((f) => ({ ...f, fields: f.fields.map((x) => (x.localId === localId ? { ...x, ...patch } : x)) }));
  const moveField = (index, dir) => setForm((f) => {
    const fields = [...f.fields];
    const target = index + dir;
    if (target < 0 || target >= fields.length) return f;
    [fields[index], fields[target]] = [fields[target], fields[index]];
    return { ...f, fields };
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const fields = form.fields.map((f) => ({
        key: f.key.trim(), label: f.label.trim(), type: f.type, required: f.required,
        options: f.type === 'select' ? f.options.split(',').map((o) => o.trim()).filter(Boolean) : undefined
      }));
      const body = {
        name: form.name, description: form.description || undefined, fields, consentRequired: form.consentRequired,
        consentText: form.consentText || undefined, thankYouMessage: form.thankYouMessage || undefined,
        redirectUrl: form.redirectUrl || undefined, version: form.version
      };
      const url = form.id ? `${MKT_API_BASE}/forms/${form.id}` : `${MKT_API_BASE}/forms`;
      const res = await authFetch(url, { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'VERSION_CONFLICT') throw new Error('This form was changed elsewhere since you opened it. Close and reopen it to see the latest version.');
        throw new Error(data.error || 'Could not save form.');
      }
      setForms((prev) => form.id ? (prev || []).map((f) => (f.id === data.form.id ? data.form : f)) : [data.form, ...(prev || [])]);
      setEditorOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (f) => {
    try {
      const res = await authFetch(`${MKT_API_BASE}/forms/${f.id}/${f.is_active ? 'pause' : 'activate'}`, { method: 'PATCH' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update form.');
      setForms((prev) => (prev || []).map((x) => (x.id === f.id ? data.form : x)));
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      const res = await authFetch(`${MKT_API_BASE}/forms/${pendingDelete.id}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Could not delete form.'); }
      setForms((prev) => (prev || []).filter((f) => f.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const copyLink = (id) => {
    const url = `${window.location.origin}/forms/${id}`;
    navigator.clipboard?.writeText(url).then(() => { setCopiedId(id); setTimeout(() => setCopiedId(null), 1500); }).catch(() => {});
  };

  const openDetail = async (f) => {
    setDetail(f);
    setSubPage(1);
    setSubmissions(null);
    const res = await authFetch(`${MKT_API_BASE}/forms/${f.id}/submissions?page=1&pageSize=25`);
    const data = await res.json();
    setSubmissions(data.submissions || []);
    setSubTotal(data.total ?? 0);
  };

  useEffect(() => {
    if (!detail) return;
    authFetch(`${MKT_API_BASE}/forms/${detail.id}/submissions?page=${subPage}&pageSize=25`).then((r) => r.json()).then((d) => { setSubmissions(d.submissions || []); setSubTotal(d.total ?? 0); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subPage]);

  const fieldsValid = form.fields.length > 0 && form.fields.every((f) => f.key.trim() && f.label.trim() && (f.type !== 'select' || f.options.trim())) && form.fields.some((f) => f.type === 'email' || f.type === 'phone');

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}

      {canAdmin && (
        <Panel className="p-3.5">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-semibold text-ink">Website tracking</span>
            {trackingSummary && (
              <span className="text-[11px] text-muted">
                {trackingSummary.totalVisitors} visitors · {trackingSummary.identifiedVisitors} identified · {trackingSummary.pageviewsLast30d} page views (30d)
              </span>
            )}
          </div>
          <p className="text-xs text-muted mb-2">Paste this once into your site&apos;s <code>&lt;head&gt;</code> — every page view is tracked anonymously, then linked to a real contact the moment that visitor submits a form below.</p>
          <div className="flex items-start gap-2">
            <code className="flex-1 text-[11px] bg-canvas border border-hairline rounded-ui px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-all">{snippet || 'Loading…'}</code>
            <Button size="sm" icon={snippetCopied ? Check : Copy} onClick={copySnippet} disabled={!snippet}>{snippetCopied ? 'Copied' : 'Copy'}</Button>
          </div>
        </Panel>
      )}

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Forms"
          action={
            <div className="flex items-center gap-1.5 sm:gap-2">
              <IconButton icon={RefreshCw} label="Refresh" onClick={load} />
              {canManage && <Button size="sm" variant="primary" icon={Plus} onClick={openCreate}><span className="hidden sm:inline">New form</span></Button>}
            </div>
          }
        />
        {forms === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : forms.length === 0 ? (
          <EmptyState icon={FileText} title="No lead forms yet" description="Build a form, activate it, and embed its link on your site — every real submission becomes a real Sales Hub contact." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Fields</Th><Th>Submissions</Th><Th>Status</Th><Th align="right"> </Th></tr></thead>
            <tbody>
              {forms.map((f) => (
                <tr key={f.id} className="hover:bg-canvas transition-colors">
                  <Td><button className="font-medium hover:underline" onClick={() => openDetail(f)}>{f.name}</button></Td>
                  <Td className="tabular-nums">{f.fields.length}</Td>
                  <Td className="tabular-nums">{f.submit_count}</Td>
                  <Td><Chip tone={f.is_active ? 'success' : 'neutral'}>{f.is_active ? 'active' : 'draft'}</Chip></Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      {f.is_active && <IconButton icon={copiedId === f.id ? Check : Copy} label="Copy public link" onClick={() => copyLink(f.id)} />}
                      {canManage && <IconButton icon={PencilLine} label="Edit" onClick={() => openEdit(f)} />}
                      {canAdmin && <IconButton icon={f.is_active ? Pause : Play} label={f.is_active ? 'Pause' : 'Activate'} onClick={() => toggleActive(f)} />}
                      {canAdmin && <IconButton icon={Trash2} label="Delete" onClick={() => setPendingDelete(f)} />}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      {/* ---------------------------------------------------------- Editor */}
      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={form.id ? 'Edit form' : 'New form'}
        width={640}
        footer={<><Button onClick={() => setEditorOpen(false)} disabled={saving}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} disabled={!form.name.trim() || !fieldsValid}>Save</Button></>}
      >
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <Field label="Description (optional)"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>

          <div className="pt-2 border-t border-hairline">
            <div className="eyebrow mb-2">Fields</div>
            <div className="flex flex-col gap-2">
              {form.fields.map((f, i) => (
                <div key={f.localId} className="p-2.5 rounded-ui border border-hairline flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">Field {i + 1}</span>
                    <div className="flex gap-1">
                      <IconButton icon={ArrowUp} label="Move up" size={14} onClick={() => moveField(i, -1)} />
                      <IconButton icon={ArrowDown} label="Move down" size={14} onClick={() => moveField(i, 1)} />
                      <IconButton icon={Trash2} label="Remove field" size={14} onClick={() => removeField(f.localId)} />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Input className="h-8 flex-1" placeholder="Label (e.g. Full name)" value={f.label} onChange={(e) => updateField(f.localId, { label: e.target.value, key: f.key || e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') })} />
                    <Select className="h-8 w-36" value={f.type} onChange={(e) => updateField(f.localId, { type: e.target.value })}>
                      {Object.entries(FIELD_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                  </div>
                  {f.type === 'select' && (
                    <Input className="h-8" placeholder="Options, comma-separated" value={f.options} onChange={(e) => updateField(f.localId, { options: e.target.value })} />
                  )}
                  <label className="flex items-center gap-2 cursor-pointer select-none text-xs">
                    <Checkbox checked={f.required} onChange={(e) => updateField(f.localId, { required: e.target.checked })} />
                    Required
                  </label>
                </div>
              ))}
            </div>
            <Button size="sm" icon={Plus} onClick={addField} className="mt-2">Add field</Button>
            {!form.fields.some((f) => f.type === 'email' || f.type === 'phone') && (
              <p className="text-[11px] text-danger mt-2">A form needs at least one Email or Phone field so a submission can become a contact.</p>
            )}
          </div>

          <div className="pt-2 border-t border-hairline flex flex-col gap-3">
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
              <Checkbox checked={form.consentRequired} onChange={(e) => setForm({ ...form, consentRequired: e.target.checked })} />
              Require double opt-in before sending this lead any marketing email
            </label>
            {form.consentRequired && (
              <Field label="Consent text shown on the form"><Input value={form.consentText} onChange={(e) => setForm({ ...form, consentText: e.target.value })} /></Field>
            )}
            <Field label="Thank-you message"><Input value={form.thankYouMessage} onChange={(e) => setForm({ ...form, thankYouMessage: e.target.value })} /></Field>
            <Field label="Redirect URL (optional)" hint="Send visitors here instead of showing the thank-you message"><Input value={form.redirectUrl} onChange={(e) => setForm({ ...form, redirectUrl: e.target.value })} placeholder="https://yoursite.com/thanks" /></Field>
          </div>
        </div>
      </Modal>

      {/* ---------------------------------------------------------- Detail / submissions drawer */}
      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.name} subtitle={detail?.description} width={580}>
        {detail && (
          <div className="p-4 flex flex-col gap-4">
            {detail.is_active && (
              <Banner tone="info">
                Public link: <code className="font-mono text-[11px]">{`${typeof window !== 'undefined' ? window.location.origin : ''}/forms/${detail.id}`}</code>
              </Banner>
            )}
            <div>
              <div className="eyebrow mb-1.5">Submissions</div>
              {submissions === null ? <Skeleton className="h-9" /> : submissions.length === 0 ? (
                <p className="text-xs text-muted">No one has submitted this form yet.</p>
              ) : (
                <Table>
                  <thead><tr><Th>Contact</Th><Th>Consent</Th><Th>Submitted</Th></tr></thead>
                  <tbody>
                    {submissions.map((s) => (
                      <tr key={s.id}>
                        <Td className="text-xs">{s.spam_flagged ? <Chip tone="danger">Flagged as spam</Chip> : (s.contacts?.display_name || '—')}</Td>
                        <Td><Chip tone={s.consent_status === 'confirmed' ? 'success' : s.consent_status === 'pending' ? 'warning' : 'neutral'}>{s.consent_status.replace('_', ' ')}</Chip></Td>
                        <Td className="text-xs text-muted">{new Date(s.created_at).toLocaleString()}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <Pagination page={subPage} pageSize={25} total={subTotal} onPageChange={setSubPage} />
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this form?"
        body={pendingDelete ? `"${pendingDelete.name}" and its submission history will be permanently deleted. Its public link will stop working. This can't be undone.` : ''}
        confirmLabel="Delete"
        onConfirm={remove}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
