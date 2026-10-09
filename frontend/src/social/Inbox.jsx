'use client';

import React, { useEffect, useState } from 'react';
import { RefreshCw, AtSign, MessageSquare, ExternalLink, UserCircle2, Reply, MessageSquareText } from 'lucide-react';
import { SOCIAL_API_BASE, PLATFORM_LABELS, PLATFORM_COLORS, AVAILABLE_PLATFORMS } from './api';
import { PlatformFilterTabs } from './PlatformIcon';
import ContactTimeline from './ContactTimeline';
import SavedReplies from './SavedReplies';

const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
const atLeast = (role, min) => (ROLE_RANK[role] ?? 0) >= ROLE_RANK[min];

// Unified "all queries and leads in one place" view — mentions (comments,
// reviews) and inbox_messages (DMs) merged server-side into one list by
// GET /social/interactions, so this page never branches on which table a
// row came from beyond the "MENTION"/"MESSAGE" badge. Laid out as a
// Zoho-Social-style interaction list (avatar + platform badge, colored
// pill selects) rather than a plain data table, but reads the exact same
// fields/endpoints the table version did.
const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'closed', label: 'Closed' }
];
const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
];
const STATUS_COLOR = { open: 'var(--accent-warning)', under_review: 'var(--accent-primary)', closed: 'var(--accent-success)' };
const PRIORITY_COLOR = { high: 'var(--accent-danger)', medium: 'var(--accent-warning)', low: 'var(--text-secondary)' };

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.slice(0, 2).map(p => p[0]).join('').toUpperCase();
}

// Deterministic avatar tint from the author's name, so the same person
// always gets the same color across a session without a real avatar image.
const AVATAR_PALETTE = ['#2a78d6', '#0d8f73', '#b8690a', '#4a3aa7', '#e34948', '#1baf7a', '#e87ba4'];
function avatarColor(name) {
  if (!name) return AVATAR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function Inbox({ authFetch, role }) {
  const [interactions, setInteractions] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({ platform: '', type: '', priority: '', status: '', assignedTo: '' });
  const [savingId, setSavingId] = useState(null);
  const [timelineContactId, setTimelineContactId] = useState(null);
  const [savedReplies, setSavedReplies] = useState([]);
  const [managingReplies, setManagingReplies] = useState(false);
  const [replyingKey, setReplyingKey] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);

  const load = async () => {
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
      const res = await authFetch(`${SOCIAL_API_BASE}/interactions?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load interactions.');
      setInteractions(data.interactions || []);
    } catch (err) {
      setError(err.message);
      setInteractions([]);
    }
  };

  useEffect(() => {
    authFetch(`${SOCIAL_API_BASE}/team`)
      .then(res => res.json())
      .then(data => setUsers(data.users || []))
      .catch(() => {});
    authFetch(`${SOCIAL_API_BASE}/saved-replies`)
      .then(res => res.json())
      .then(data => setSavedReplies(data.savedReplies || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const openReply = (item) => {
    setReplyingKey(`${item.source}-${item.id}`);
    setReplyText('');
  };
  const cancelReply = () => { setReplyingKey(null); setReplyText(''); };

  const sendReply = async (item) => {
    if (!replyText.trim()) return;
    setSendingReply(true);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/inbox/${item.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ message: replyText.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send this reply.');
      cancelReply();
    } catch (err) {
      setError(err.message);
    } finally {
      setSendingReply(false);
    }
  };

  const patch = async (item, body) => {
    setSavingId(item.id);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/interactions/${item.source}/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update this interaction.');
      setInteractions(prev => prev.map(i => (i.id === item.id && i.source === item.source ? { ...i, ...body } : i)));
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingId(null);
    }
  };

  const setFilter = (key, value) => setFilters(prev => ({ ...prev, [key]: value }));

  return (
    <div>
      <div className="header-container">
        <div className="title-area">
          <h1>Inbox</h1>
          <p>Every comment, review, and message from every connected account, in one place.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setManagingReplies(true)}>
            <MessageSquareText size={14} /> Canned responses
          </button>
          <button className="btn btn-secondary btn-sm" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {error && <p style={{ color: 'var(--accent-danger)', marginBottom: '1rem' }}>{error}</p>}

      <div className="platform-tabs">
        <PlatformFilterTabs platforms={AVAILABLE_PLATFORMS} value={filters.platform} onChange={(p) => setFilter('platform', p)} />
      </div>

      <div className="table-section">
        <div className="table-header">
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <select className="tool-select" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
              <option value="">All types</option>
              <option value="mention">Mentions</option>
              <option value="message">Messages</option>
            </select>
            <select className="tool-select" value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)}>
              <option value="">All priorities</option>
              {PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="tool-select" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="tool-select" value={filters.assignedTo} onChange={(e) => setFilter('assignedTo', e.target.value)}>
              <option value="">Anyone assigned</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}
            </select>
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {interactions === null ? 'Loading…' : `${interactions.length} interaction${interactions.length === 1 ? '' : 's'}`}
          </div>
        </div>

        {interactions === null ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading…</div>
        ) : interactions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Nothing here yet — connected accounts are synced every 10 minutes.</div>
        ) : (
          <div className="inbox-list">
            <div className="inbox-list-header inbox-grid-cols">
              <span></span>
              <span>Interaction</span>
              <span>Platform</span>
              <span>Priority</span>
              <span>Status</span>
              <span>Assignee</span>
            </div>
            {interactions.map(item => {
              const key = `${item.source}-${item.id}`;
              return (
              <React.Fragment key={key}>
              <div className="inbox-row inbox-grid-cols">
                <div className="inbox-avatar-wrap">
                  <div className="inbox-avatar" style={{ background: avatarColor(item.author) }}>
                    {initials(item.author)}
                  </div>
                  <div className="inbox-platform-badge" style={{ background: PLATFORM_COLORS[item.platform] || 'var(--text-muted)' }}>
                    {item.source === 'mention' ? <AtSign size={9} /> : <MessageSquare size={9} />}
                  </div>
                </div>

                <div
                  className="inbox-body"
                  onClick={() => item.contactId && setTimelineContactId(item.contactId)}
                  style={item.contactId ? { cursor: 'pointer' } : undefined}
                  title={item.contactId ? 'View this contact’s full history across every channel' : 'Not yet linked to a contact'}
                >
                  <div className="inbox-body-top">
                    <span className="inbox-author">{item.author || 'Unknown'}</span>
                    {item.contactId && (
                      <span className="inbox-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: 'var(--accent-primary)' }}>
                        <UserCircle2 size={12} /> Full history
                      </span>
                    )}
                  </div>
                  <p className="inbox-text">{item.text}</p>
                  <div className="inbox-footer">
                    <span>{new Date(item.date).toLocaleDateString()} · {new Date(item.date).toLocaleTimeString()}</span>
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: 'var(--accent-primary)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <ExternalLink size={12} /> View
                      </a>
                    )}
                    {item.source === 'message' && (
                      <button
                        className="inbox-reply-trigger"
                        onClick={(e) => { e.stopPropagation(); replyingKey === key ? cancelReply() : openReply(item); }}
                      >
                        <Reply size={12} /> {replyingKey === key ? 'Cancel' : 'Reply'}
                      </button>
                    )}
                  </div>
                </div>

                <div className="inbox-col-platform">
                  <div className="inbox-platform-icon" style={{ background: PLATFORM_COLORS[item.platform] || 'var(--text-muted)' }}>
                    {item.source === 'mention' ? <AtSign size={13} /> : <MessageSquare size={13} />}
                  </div>
                  <div>
                    <div className="inbox-platform-name">{PLATFORM_LABELS[item.platform] || item.platform}</div>
                    <div className="inbox-platform-type">{item.source === 'mention' ? 'Mention' : 'Message'}</div>
                  </div>
                </div>

                <select
                  className="pill-select"
                  value={item.priority}
                  disabled={savingId === item.id}
                  style={{ color: PRIORITY_COLOR[item.priority], background: `${PRIORITY_COLOR[item.priority]}18`, borderColor: 'transparent' }}
                  onChange={(e) => patch(item, { priority: e.target.value })}
                >
                  {PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <select
                  className="pill-select"
                  value={item.interactionStatus}
                  disabled={savingId === item.id}
                  style={{ color: STATUS_COLOR[item.interactionStatus], background: `${STATUS_COLOR[item.interactionStatus]}18`, borderColor: 'transparent' }}
                  onChange={(e) => patch(item, { interactionStatus: e.target.value })}
                >
                  {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <select
                  className="inbox-assignee-select"
                  value={item.assignedTo || ''}
                  disabled={savingId === item.id}
                  onChange={(e) => patch(item, { assignedTo: e.target.value })}
                >
                  <option value="">Unassigned</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}
                </select>
              </div>

              {replyingKey === key && (
                <div className="inbox-reply-box">
                  {savedReplies.length > 0 && (
                    <select
                      className="tool-select"
                      value=""
                      onChange={(e) => {
                        const picked = savedReplies.find(r => r.id === e.target.value);
                        if (picked) setReplyText(picked.body);
                      }}
                    >
                      <option value="">Insert a canned response…</option>
                      {savedReplies.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
                    </select>
                  )}
                  <textarea
                    className="form-control"
                    rows={3}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder={`Reply to ${item.author || 'this contact'} on ${PLATFORM_LABELS[item.platform] || item.platform}…`}
                    autoFocus
                  />
                  <div className="inbox-reply-actions">
                    <button className="btn btn-secondary btn-sm" onClick={cancelReply} disabled={sendingReply}>Cancel</button>
                    <button className="btn btn-primary btn-sm" onClick={() => sendReply(item)} disabled={sendingReply || !replyText.trim()}>
                      {sendingReply ? 'Sending…' : 'Send reply'}
                    </button>
                  </div>
                </div>
              )}
              </React.Fragment>
              );
            })}
          </div>
        )}
      </div>

      <ContactTimeline contactId={timelineContactId} authFetch={authFetch} onClose={() => setTimelineContactId(null)} />
      {managingReplies && (
        <SavedReplies
          savedReplies={savedReplies}
          onChange={setSavedReplies}
          authFetch={authFetch}
          canManage={atLeast(role, 'member')}
          onClose={() => setManagingReplies(false)}
        />
      )}
    </div>
  );
}

export default Inbox;
