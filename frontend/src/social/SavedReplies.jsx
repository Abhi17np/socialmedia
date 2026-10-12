'use client';

import React, { useState } from 'react';
import { Plus, Pencil, Trash2, MessageSquareText } from 'lucide-react';
import { SOCIAL_API_BASE } from './api';
import { Drawer, Button, Field, Input, Textarea, Banner, EmptyState, ConfirmDialog } from '../ui';

// The curation side of canned responses — the picker that inserts one
// into a reply lives in Inbox.jsx; this is where a team builds the list
// it picks from. Same drawer pattern as ContactTimeline so it reads as
// part of the app rather than a bolted-on modal.
function SavedReplies({ savedReplies, onChange, authFetch, canManage, onClose }) {
  const [editingId, setEditingId] = useState(null); // null = not editing, 'new' = creating
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const startNew = () => {
    setEditingId('new');
    setTitle('');
    setBody('');
    setError(null);
  };
  const startEdit = (reply) => {
    setEditingId(reply.id);
    setTitle(reply.title);
    setBody(reply.body);
    setError(null);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const isNew = editingId === 'new';
      const res = await authFetch(`${SOCIAL_API_BASE}/saved-replies${isNew ? '' : `/${editingId}`}`, {
        method: isNew ? 'POST' : 'PATCH',
        body: JSON.stringify({ title, body })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save this reply.');
      if (isNew) {
        onChange([...savedReplies, data.savedReply].sort((a, b) => a.title.localeCompare(b.title)));
      } else {
        onChange(savedReplies.map((r) => (r.id === editingId ? data.savedReply : r)));
      }
      setEditingId(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (reply) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/saved-replies/${reply.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not delete this reply.');
      }
      onChange(savedReplies.filter((r) => r.id !== reply.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        title="Canned responses"
        subtitle="Shared across your whole team — saved once, usable from any reply box."
        width={460}
        footer={
          canManage && !editingId ? (
            <Button variant="primary" icon={Plus} full onClick={startNew}>
              New canned response
            </Button>
          ) : null
        }
      >
        {error && (
          <div className="p-4 pb-0">
            <Banner tone="danger">{error}</Banner>
          </div>
        )}

        {canManage && editingId && (
          <div className="p-4 border-b border-hairline flex flex-col gap-3 bg-sunken/50">
            <Field label="Title">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Order delay apology"
                maxLength={100}
                autoFocus
              />
            </Field>
            <Field label="Reply text" hint={`${body.length}/2000`}>
              <Textarea
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="The message that gets inserted…"
                maxLength={2000}
              />
            </Field>
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" onClick={cancelEdit} disabled={saving}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={save}
                loading={saving}
                disabled={!title.trim() || !body.trim()}
              >
                Save
              </Button>
            </div>
          </div>
        )}

        {savedReplies.length === 0 && !editingId ? (
          <EmptyState
            icon={MessageSquareText}
            title="No canned responses yet"
            description={
              canManage
                ? 'Save the replies your team types most often, then insert them from any conversation in one click.'
                : 'Nobody on your team has saved one yet. Ask an admin to add the replies you use most.'
            }
          />
        ) : (
          <div>
            {savedReplies.map((reply) => (
              <div
                key={reply.id}
                className="px-4 py-3 border-b border-hairline flex items-start justify-between gap-3 hover:bg-canvas transition-colors group"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-ink">{reply.title}</div>
                  <p className="text-[11px] text-muted leading-relaxed mt-0.5 line-clamp-3">
                    {reply.body}
                  </p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => startEdit(reply)}
                      title="Edit"
                      className="w-7 h-7 rounded-ui border border-hairline bg-card text-muted hover:text-ink flex items-center justify-center"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => setConfirmDelete(reply)}
                      title="Delete"
                      className="w-7 h-7 rounded-ui border border-hairline bg-card text-muted hover:text-danger hover:border-danger-border flex items-center justify-center"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete this canned response?"
        body={`"${confirmDelete?.title}" will be removed for everyone on your team. This can't be undone.`}
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => remove(confirmDelete)}
      />
    </>
  );
}

export default SavedReplies;
