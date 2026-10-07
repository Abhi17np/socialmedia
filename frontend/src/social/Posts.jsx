import React, { useEffect, useState } from 'react';
import { RefreshCw, X, Calendar as CalendarIcon, ChevronDown, ChevronUp, PenSquare, Search } from 'lucide-react';
import { SOCIAL_API_BASE, PLATFORM_LABELS, PLATFORM_COLORS, AVAILABLE_PLATFORMS } from './api';
import { PlatformIcon, PlatformFilterTabs } from './PlatformIcon';

// Renamed from "Calendar" — Zoho/HubSpot both call this section "Posts"
// with Scheduled/Published as its two sub-views (Zoho's Posts nav has
// Published Posts, Scheduled Posts, Approvals, Unpublished, Drafts;
// this app's data model only distinguishes pending/publishing (still
// queued) from published/failed (already attempted), so those become the
// two sub-tabs rather than a 1:1 copy of Zoho's five). List view, not a
// grid calendar — this repo has no calendar/date-grid library installed,
// and the build spec explicitly allows "calendar/list view" here.
// Post cards carry the same platform-badge/status-pill visual language as
// Inbox (social/Inbox.jsx) rather than plain colored text.
const STATUS_STYLE = {
  pending: { color: 'var(--text-secondary)', bg: 'var(--bg-surface-hover)', label: 'Pending' },
  publishing: { color: 'var(--accent-warning)', bg: 'rgba(184,105,10,0.12)', label: 'Publishing' },
  published: { color: 'var(--accent-success)', bg: 'rgba(12,163,12,0.1)', label: 'Published' },
  failed: { color: 'var(--accent-danger)', bg: 'rgba(208,59,59,0.1)', label: 'Failed' }
};

const SUB_TABS = [
  { key: 'scheduled', label: 'Scheduled', statuses: ['pending', 'publishing'] },
  { key: 'published', label: 'Published', statuses: ['published', 'failed'] }
];

function groupByDate(posts) {
  const groups = {};
  posts.forEach(p => {
    const key = new Date(p.scheduled_at).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    (groups[key] = groups[key] || []).push(p);
  });
  return groups;
}

function PostErrors({ results }) {
  const [expanded, setExpanded] = useState(false);
  const entries = Object.entries(results || {});
  if (entries.length === 0) return null;

  const anyFailed = entries.some(([, r]) => r.status === 'failed');
  const visible = expanded ? entries : entries.filter(([, r]) => r.status === 'failed').slice(0, 1);
  if (!expanded && visible.length === 0) return null;

  return (
    <div className="post-error-box">
      {visible.map(([key, result]) => (
        <div key={key} className={`post-error-row ${result.status === 'failed' ? 'failed' : ''}`}>
          <span className="platform-name">{PLATFORM_LABELS[key] || key}</span>
          {': '}
          {result.status === 'failed' ? (
            <span className="error-text">{result.error || 'failed'}</span>
          ) : (
            <span style={{ color: 'var(--text-secondary)' }}>{result.status}{result.url ? ` — ${result.url}` : ''}</span>
          )}
        </div>
      ))}
      {entries.length > visible.length && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--accent-primary)', fontSize: '0.75rem', cursor: 'pointer', padding: 0 }}
        >
          Show all {entries.length} platform results
        </button>
      )}
      {expanded && anyFailed && entries.length > 1 && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.75rem', cursor: 'pointer', padding: 0 }}
        >
          Show less
        </button>
      )}
    </div>
  );
}

function Posts({ authFetch, setCurrentView }) {
  const [posts, setPosts] = useState(null);
  const [error, setError] = useState(null);
  const [subTab, setSubTab] = useState('scheduled');
  const [platformFilter, setPlatformFilter] = useState('');
  const [brand, setBrand] = useState('');
  const [search, setSearch] = useState('');
  const [collapsedDates, setCollapsedDates] = useState({});

  const load = async () => {
    try {
      const params = new URLSearchParams();
      if (brand.trim()) params.set('brand', brand.trim());
      const res = await authFetch(`${SOCIAL_API_BASE}/posts?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load posts.');
      setPosts((data.posts || []).sort((a, b) => new Date(b.scheduled_at) - new Date(a.scheduled_at)));
    } catch (err) {
      setError(err.message);
      setPosts([]);
    }
  };

  useEffect(() => { load(); }, [brand]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = async (id) => {
    if (!confirm('Cancel this pending post?')) return;
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/posts/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not cancel post.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleDate = (date) => setCollapsedDates(prev => ({ ...prev, [date]: !prev[date] }));

  const activeStatuses = (SUB_TABS.find(t => t.key === subTab) || SUB_TABS[0]).statuses;
  const searchLower = search.trim().toLowerCase();

  const filteredPosts = (posts || []).filter(p => {
    if (!activeStatuses.includes(p.status)) return false;
    if (platformFilter && !(p.target_platforms || []).includes(platformFilter)) return false;
    if (searchLower && !(p.content || '').toLowerCase().includes(searchLower)) return false;
    return true;
  });
  const groups = posts ? groupByDate(filteredPosts) : {};
  const countFor = (statuses) => (posts || []).filter(p => statuses.includes(p.status)).length;

  return (
    <div>
      <div className="header-container">
        <div className="title-area">
          <h1>Posts</h1>
          <p>Everything scheduled and everything already published, across every connected account.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <button className="btn btn-secondary btn-sm" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setCurrentView('social-compose')}>
            <PenSquare size={14} /> New Post
          </button>
        </div>
      </div>

      {error && <p style={{ color: 'var(--accent-danger)', marginBottom: '1rem' }}>{error}</p>}

      <div className="range-tabs" style={{ marginBottom: '1rem', display: 'inline-flex' }}>
        {SUB_TABS.map(t => (
          <button
            key={t.key}
            className={`range-tab ${subTab === t.key ? 'active' : ''}`}
            onClick={() => setSubTab(t.key)}
          >
            {t.label} <span style={{ opacity: 0.75 }}>({countFor(t.statuses)})</span>
          </button>
        ))}
      </div>

      <div className="platform-tabs">
        <PlatformFilterTabs platforms={AVAILABLE_PLATFORMS} value={platformFilter} onChange={setPlatformFilter} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.75rem' }}>
          <div className="search-bar" style={{ width: 200 }}>
            <Search size={14} style={{ color: 'var(--text-muted)' }} />
            <input placeholder="Search post content…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <input
            type="text"
            className="form-control"
            style={{ width: 140 }}
            placeholder="Brand"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
          />
        </div>
      </div>

      {posts === null ? (
        <div className="trend-chart-empty">Loading posts...</div>
      ) : filteredPosts.length === 0 ? (
        <div className="trend-chart-empty">
          {subTab === 'scheduled' ? 'Nothing scheduled — write one in Compose.' : 'No published posts match these filters yet.'}
        </div>
      ) : (
        Object.entries(groups).map(([date, datePosts]) => {
          const collapsed = !!collapsedDates[date];
          return (
            <div className="panel" key={date} style={{ marginBottom: '1.25rem' }}>
              <div className="panel-header" style={{ cursor: 'pointer' }} onClick={() => toggleDate(date)}>
                <div className="calendar-date-header">
                  <h2><CalendarIcon size={16} />{date}</h2>
                  <span className="calendar-date-count">{datePosts.length} post{datePosts.length === 1 ? '' : 's'}</span>
                </div>
                {collapsed ? <ChevronDown size={16} style={{ color: 'var(--text-muted)' }} /> : <ChevronUp size={16} style={{ color: 'var(--text-muted)' }} />}
              </div>

              {!collapsed && datePosts.map(post => {
                const status = STATUS_STYLE[post.status] || STATUS_STYLE.pending;
                return (
                  <div key={post.id} className="post-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="post-platform-chips">
                          {(post.target_platforms || []).map(p => (
                            <div key={p} className="post-platform-chip" style={{ background: PLATFORM_COLORS[p] || 'var(--text-muted)' }} title={PLATFORM_LABELS[p] || p}>
                              <PlatformIcon platform={p} size={12} />
                            </div>
                          ))}
                        </div>
                        <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
                          {post.content ? (post.content.length > 140 ? `${post.content.slice(0, 140)}…` : post.content) : '(no text content)'}
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                          {new Date(post.scheduled_at).toLocaleTimeString()} · {post.brand}
                        </div>
                        <PostErrors results={post.platform_results} />
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem' }}>
                        <span className="status-pill" style={{ color: status.color, background: status.bg }}>{status.label}</span>
                        {post.status === 'pending' && (
                          <button className="btn btn-secondary btn-sm" onClick={() => cancel(post.id)}>
                            <X size={12} /> Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}

export default Posts;
