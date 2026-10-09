'use client';

import React, { useState } from 'react';
import { X, Plus, Pencil, Trash2 } from 'lucide-react';
import { SOCIAL_API_BASE } from './api';

// The curation side of canned responses — the picker that inserts one
// into a reply lives in Inbox.jsx; this is where a team builds the list
// it picks from. Same slide-over pattern as ContactTimeline so it reads
// as part of the app, not a bolted-on modal.
function SavedReplies({ savedReplies, onChange, authFetch, canManage, onClose }) {
  const [editingId, setEditingId] = useState(null); // null = not editing, 'new' = creating
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const startNew = () => { setEditingId('new'); setTitle(''); setBody(''); setError(null); };
  const startEdit = (reply) => { setEditingId(reply.id); setTitle(reply.title); setBody(reply.body); setError(null); };
  const cancelEdit = () => { setEditingId(null); setError(null); };

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
        onChange(savedReplies.map(r => (r.id === editingId ? data.savedReply : r)));
      }
      setEditingId(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/saved-replies/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not delete this reply.');
      }
      onChange(savedReplies.filter(r => r.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="timeline-overlay" onClick={onClose}>
      <div className="timeline-panel" onClick={(e) => e.stopPropagation()}>
        <div className="timeline-panel-header">
          <div>
            <h2>Canned responses</h2>
            <p className="timeline-panel-sub">Shared across your whole team — saved here once, usable from any reply box.</p>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose}><X size={16} /></button>
        </div>

        {error && <p style={{ color: 'var(--accent-danger)', padding: '0 1.25rem', marginTop: '1rem' }}>{error}</p>}

        <div className="timeline-list">
          {canManage && (editingId === 'new' || editingId) ? (
            <div className="saved-reply-form">
              <div className="form-group">
                <label>Title</label>
                <input className="form-control" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Order delay apology" maxLength={100} />
              </div>
              <div className="form-group">
                <label>Reply text</label>
                <textarea className="form-control" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="The message that gets inserted…" maxLength={2000} />
              </div>
              <div className="saved-reply-form-actions">
                <button className="btn btn-secondary btn-sm" onClick={cancelEdit} disabled={saving}>Cancel</button>
                <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !title.trim() || !body.trim()}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : canManage ? (
            <button className="btn btn-secondary btn-sm" onClick={startNew} style={{ alignSelf: 'flex-start' }}>
              <Plus size={14} /> New canned response
            </button>
          ) : null}

          {savedReplies.length === 0 && editingId === null && (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>No canned responses yet.</div>
          )}

          {savedReplies.map(reply => (
            <div className="saved-reply-item" key={reply.id}>
              <div className="saved-reply-item-body">
                <div className="saved-reply-item-title">{reply.title}</div>
                <p className="saved-reply-item-text">{reply.body}</p>
              </div>
              {canManage && (
                <div className="saved-reply-item-actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => startEdit(reply)} title="Edit"><Pencil size={13} /></button>
                  <button className="btn btn-secondary btn-sm" onClick={() => remove(reply.id)} title="Delete"><Trash2 size={13} /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default SavedReplies;
