import React, { useEffect, useState } from 'react';
import { RefreshCw, AtSign, MessageSquare, ExternalLink } from 'lucide-react';
import { SOCIAL_API_BASE, PLATFORM_LABELS, PLATFORM_COLORS, AVAILABLE_PLATFORMS } from './api';
import { PlatformFilterTabs } from './PlatformIcon';

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

function Inbox({ authFetch }) {
  const [interactions, setInteractions] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({ platform: '', type: '', priority: '', status: '', assignedTo: '' });
  const [savingId, setSavingId] = useState(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <button className="btn btn-secondary btn-sm" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
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
            {interactions.map(item => (
              <div className="inbox-row inbox-grid-cols" key={`${item.source}-${item.id}`}>
                <div className="inbox-avatar-wrap">
                  <div className="inbox-avatar" style={{ background: avatarColor(item.author) }}>
                    {initials(item.author)}
                  </div>
                  <div className="inbox-platform-badge" style={{ background: PLATFORM_COLORS[item.platform] || 'var(--text-muted)' }}>
                    {item.source === 'mention' ? <AtSign size={9} /> : <MessageSquare size={9} />}
                  </div>
                </div>

                <div className="inbox-body">
                  <div className="inbox-body-top">
                    <span className="inbox-author">{item.author || 'Unknown'}</span>
                    {item.brand && <span className="inbox-meta">{item.brand}</span>}
                  </div>
                  <p className="inbox-text">{item.text}</p>
                  <div className="inbox-footer">
                    <span>{new Date(item.date).toLocaleDateString()} · {new Date(item.date).toLocaleTimeString()}</span>
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <ExternalLink size={12} /> View
                      </a>
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default Inbox;
