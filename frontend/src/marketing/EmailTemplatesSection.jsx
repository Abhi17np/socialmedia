'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Plus, FileText, Send } from 'lucide-react';
import { API_BASE } from '../apiBase';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Field,
  Banner, Modal, EmptyState, Skeleton, Chip, ConfirmDialog
} from '../ui';
import EmailBlockEditor from './EmailBlockEditor';
import AiGenerateButton from './AiGenerateButton';

const MKT_API_BASE = `${API_BASE}/marketing`;

function emptyTemplate() {
  return { name: '', subject: '', preheader: '', blocks: [{ type: 'heading', text: 'Hello {{firstName|there}}' }, { type: 'text', text: 'Write your message here.' }] };
}

export default function EmailTemplatesSection({ authFetch, canManage, canAdmin }) {
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // the template object being created/edited, or null
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const load = () => {
    authFetch(`${MKT_API_BASE}/email/templates`).then((r) => r.json()).then((d) => setTemplates(d.templates || [])).catch((e) => setError(e.message));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openNew = () => { setEditing(emptyTemplate()); setPreview(null); setTestResult(null); };
  const openExisting = (t) => { setEditing({ ...t }); setPreview(null); setTestResult(null); loadPreviewFor(t.id); };

  const loadPreviewFor = async (id) => {
    if (!id) return;
    setPreviewLoading(true);
    try {
      const res = await authFetch(`${MKT_API_BASE}/email/templates/${id}/preview`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) setPreview(data);
    } catch {
      /* preview is a convenience */
    } finally {
      setPreviewLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { name: editing.name, subject: editing.subject, preheader: editing.preheader, blocks: editing.blocks, brand: editing.brand || {} };
      const isNew = !editing.id;
      const res = await authFetch(`${MKT_API_BASE}/email/templates${isNew ? '' : `/${editing.id}`}`, { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(isNew ? body : { ...body, version: editing.version }) });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'VERSION_CONFLICT') throw new Error('This template was changed elsewhere — reopen it to see the latest version.');
        throw new Error(data.error || 'Could not save template.');
      }
      setTemplates((prev) => (isNew ? [data.template, ...(prev || [])] : (prev || []).map((t) => (t.id === data.template.id ? data.template : t))));
      setEditing(data.template);
      loadPreviewFor(data.template.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      const res = await authFetch(`${MKT_API_BASE}/email/templates/${pendingDelete.id}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Could not delete template.'); }
      setTemplates((prev) => (prev || []).filter((t) => t.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const sendTest = async () => {
    if (!editing?.id || !testTo.trim()) return;
    setTestSending(true);
    setTestResult(null);
    try {
      const res = await authFetch(`${MKT_API_BASE}/email/templates/${editing.id}/send-test`, { method: 'POST', body: JSON.stringify({ to: testTo.trim() }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Test send failed.');
      setTestResult({ ok: true, message: `Sent via ${data.provider}.` });
    } catch (err) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setTestSending(false);
    }
  };

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Email templates"
          meta="Block-based, with tracking built in"
          action={<div className="flex items-center gap-2"><IconButton icon={RefreshCw} label="Refresh" onClick={load} />{canManage && <Button size="sm" variant="primary" icon={Plus} onClick={openNew}>New template</Button>}</div>}
        />
        {templates === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : templates.length === 0 ? (
          <EmptyState icon={FileText} title="No templates yet" description="Build a block-based email template, then use it in a campaign." />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Subject</Th><Th>Blocks</Th>{canAdmin && <Th align="right"> </Th>}</tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="hover:bg-canvas transition-colors cursor-pointer" onClick={() => openExisting(t)}>
                  <Td><span className="font-medium">{t.name}</span></Td>
                  <Td className="text-xs text-muted">{t.subject}</Td>
                  <Td><Chip tone="neutral">{(t.blocks || []).length}</Chip></Td>
                  {canAdmin && <Td align="right"><Button size="sm" onClick={(e) => { e.stopPropagation(); setPendingDelete(t); }}>Delete</Button></Td>}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit template' : 'New template'}
        width={920}
        footer={<><Button onClick={() => setEditing(null)} disabled={saving}>Close</Button><Button variant="primary" onClick={save} loading={saving} disabled={!editing?.name?.trim()}>Save</Button></>}
      >
        {editing && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex flex-col gap-3">
              <Field label="Name"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus /></Field>
              <AiGenerateButton
                authFetch={authFetch}
                endpoint="email-copy"
                label="Draft subject & copy with AI"
                placeholder="e.g. Announce our autumn sale, 20% off, ends Friday"
                buildBody={(brief) => ({ brief })}
                onResult={({ subject, body }) => setEditing((prev) => ({
                  ...prev,
                  subject: subject || prev.subject,
                  blocks: body ? [{ type: 'text', text: body }] : prev.blocks
                }))}
              />
              <Field label="Subject" hint="Merge tags like {{firstName|there}} work here too"><Input value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} /></Field>
              <Field label="Preheader (optional)"><Input value={editing.preheader || ''} onChange={(e) => setEditing({ ...editing, preheader: e.target.value })} /></Field>
              <div>
                <div className="eyebrow mb-1.5">Content blocks</div>
                <EmailBlockEditor blocks={editing.blocks} onChange={(blocks) => setEditing({ ...editing, blocks })} />
              </div>
              {editing.id && (
                <div className="pt-2 border-t border-hairline">
                  <div className="eyebrow mb-1.5 flex items-center gap-1.5"><Send size={12} /> Send a test</div>
                  {testResult && <Banner tone={testResult.ok ? 'success' : 'danger'} className="mb-2">{testResult.message}</Banner>}
                  <div className="flex gap-1.5">
                    <Input className="h-8 flex-1" placeholder="you@company.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Send test to" />
                    <Button size="sm" onClick={sendTest} loading={testSending} disabled={!testTo.trim()}>Send test</Button>
                  </div>
                </div>
              )}
            </div>
            <div>
              <div className="eyebrow mb-1.5">Live preview</div>
              {editing.id ? (
                previewLoading || !preview ? <Skeleton className="h-64" /> : (
                  <div className="border border-hairline rounded-ui overflow-hidden">
                    <div className="px-3 py-2 border-b border-hairline text-xs"><span className="text-muted">Subject: </span>{preview.subject}</div>
                    <iframe title="Email preview" srcDoc={preview.html} className="w-full h-[480px] bg-white" sandbox="" />
                  </div>
                )
              ) : (
                <p className="text-xs text-muted">Save the template once to see a live preview.</p>
              )}
              {editing.id && <Button size="sm" className="mt-2" onClick={() => loadPreviewFor(editing.id)}>Refresh preview</Button>}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this template?"
        body={pendingDelete ? `"${pendingDelete.name}" will be removed. Campaigns already sent from it keep their own records.` : ''}
        confirmLabel="Delete"
        onConfirm={remove}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
