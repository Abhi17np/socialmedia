import React, { useEffect, useState } from 'react';
import { RefreshCw, Users, Send, Eye, Heart, Inbox as InboxIcon, CalendarClock, ArrowUpRight, AlertTriangle } from 'lucide-react';
import { SOCIAL_API_BASE, PLATFORM_LABELS, PLATFORM_COLORS } from './api';

// Social's own "30-second glance" — same role Overview plays for the
// assessment-tool side of this app: aggregate KPIs rolled up from the
// per-account summary (GET /social/analytics/summary) plus a snapshot of
// the Inbox and Calendar, so nothing here is a number invented for this
// page — it's the same data those pages already show, just totalled.

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString();
}

function KpiTile({ icon: Icon, color, label, value, sub }) {
  return (
    <div className="kpi-card">
      <div className="kpi-card-icon" style={{ background: color }}><Icon size={17} /></div>
      <div className="kpi-card-label">{label}</div>
      <div className="kpi-card-value">{value}</div>
      {sub && <div className="kpi-card-footer"><span className="kpi-card-sub">{sub}</span></div>}
    </div>
  );
}

function BarRow({ label, value, max, color }) {
  const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 56px', alignItems: 'center', gap: '0.75rem', marginBottom: '0.6rem' }}>
      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ height: 8, borderRadius: 999, background: 'var(--bg-surface-hover)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: color }} />
      </div>
      <span style={{ fontSize: '0.8rem', fontWeight: 700, textAlign: 'right' }}>{fmt(value)}</span>
    </div>
  );
}

function Dashboard({ authFetch, setCurrentView }) {
  const [summary, setSummary] = useState(null);
  const [interactions, setInteractions] = useState(null);
  const [posts, setPosts] = useState(null);
  const [error, setError] = useState(null);

  const load = async () => {
    setError(null);
    try {
      const [summaryRes, interactionsRes, postsRes] = await Promise.all([
        authFetch(`${SOCIAL_API_BASE}/analytics/summary`),
        authFetch(`${SOCIAL_API_BASE}/interactions`),
        authFetch(`${SOCIAL_API_BASE}/posts`)
      ]);
      const summaryData = await summaryRes.json();
      if (!summaryRes.ok) throw new Error(summaryData.error || 'Could not load analytics.');
      setSummary(summaryData.summary || []);

      const interactionsData = await interactionsRes.json();
      setInteractions(interactionsRes.ok ? (interactionsData.interactions || []) : []);

      const postsData = await postsRes.json();
      setPosts(postsRes.ok ? (postsData.posts || []) : []);
    } catch (err) {
      setError(err.message);
      setSummary([]);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loading = summary === null;
  const accounts = summary || [];
  const totals = accounts.reduce((acc, a) => ({
    followers: acc.followers + (a.followers || 0),
    newFollowers: acc.newFollowers + (a.newFollowers || 0),
    posts: acc.posts + (a.posts || 0),
    reach: acc.reach + (a.reach || 0),
    engagement: acc.engagement + (a.engagement || 0)
  }), { followers: 0, newFollowers: 0, posts: 0, reach: 0, engagement: 0 });

  const maxFollowers = Math.max(1, ...accounts.map(a => a.followers || 0));
  const maxEngagement = Math.max(1, ...accounts.map(a => a.engagement || 0));

  const openInteractions = (interactions || []).filter(i => i.interactionStatus === 'open');
  const needsAttention = openInteractions
    .filter(i => i.priority === 'high')
    .concat(openInteractions.filter(i => i.priority !== 'high'))
    .slice(0, 5);

  const upcomingPosts = (posts || [])
    .filter(p => p.status === 'pending')
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))
    .slice(0, 5);

  return (
    <div>
      <div className="header-container">
        <div className="title-area">
          <h1>Social Dashboard</h1>
          <p>Everything connected, at a glance — followers, reach, engagement, and what needs a reply.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && <p style={{ color: 'var(--accent-danger)', marginBottom: '1rem' }}>{error}</p>}

      {!loading && accounts.length === 0 ? (
        <div className="panel">
          <p style={{ color: 'var(--text-secondary)' }}>
            No connected accounts yet — head to Connect Accounts to link a channel, then this page fills in automatically.
          </p>
          <button className="btn btn-primary btn-sm" style={{ marginTop: '0.75rem' }} onClick={() => setCurrentView('social-accounts')}>
            Connect Accounts
          </button>
        </div>
      ) : (
        <>
          <div className="kpi-grid" style={{ marginBottom: '1.5rem' }}>
            <KpiTile icon={Users} color="#2a78d6" label="Connected Accounts" value={loading ? '—' : accounts.length} />
            <KpiTile icon={Heart} color="#e1306c" label="Total Followers" value={loading ? '—' : fmt(totals.followers)} sub={!loading && totals.newFollowers !== 0 ? `${totals.newFollowers > 0 ? '+' : ''}${totals.newFollowers} this window` : undefined} />
            <KpiTile icon={Send} color="#0d8f73" label="Posts Published" value={loading ? '—' : fmt(totals.posts)} sub="in current window" />
            <KpiTile icon={Eye} color="#b8690a" label="Total Reach" value={loading ? '—' : fmt(totals.reach)} />
            <KpiTile icon={ArrowUpRight} color="#4a3aa7" label="Total Engagement" value={loading ? '—' : fmt(totals.engagement)} />
            <KpiTile icon={InboxIcon} color="#d03b3b" label="Open Interactions" value={interactions === null ? '—' : openInteractions.length} sub="needs a reply" />
          </div>

          <div className="split-grid">
            <div className="panel">
              <div className="panel-header"><h2>Followers by Account</h2></div>
              {accounts.length === 0 ? (
                <div className="trend-chart-empty">No data yet.</div>
              ) : (
                accounts.map(a => (
                  <BarRow
                    key={a.accountId}
                    label={a.accountLabel || PLATFORM_LABELS[a.platform] || a.platform}
                    value={a.followers || 0}
                    max={maxFollowers}
                    color={PLATFORM_COLORS[a.platform] || 'var(--accent-primary)'}
                  />
                ))
              )}
            </div>
            <div className="panel">
              <div className="panel-header"><h2>Engagement by Account</h2></div>
              {accounts.length === 0 ? (
                <div className="trend-chart-empty">No data yet.</div>
              ) : (
                accounts.map(a => (
                  <BarRow
                    key={a.accountId}
                    label={a.accountLabel || PLATFORM_LABELS[a.platform] || a.platform}
                    value={a.engagement || 0}
                    max={maxEngagement}
                    color={PLATFORM_COLORS[a.platform] || 'var(--accent-secondary)'}
                  />
                ))
              )}
            </div>
          </div>

          <div className="split-grid">
            <div className="panel">
              <div className="panel-header">
                <h2>Needs Attention</h2>
                <span className="tag" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => setCurrentView('social-inbox')}>Open Inbox →</span>
              </div>
              {interactions === null ? (
                <div className="trend-chart-empty">Loading…</div>
              ) : needsAttention.length === 0 ? (
                <div className="trend-chart-empty">Inbox is clear — nothing open right now.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
                  {needsAttention.map(item => (
                    <div key={`${item.source}-${item.id}`} className="alert-row">
                      <span className="alert-row-icon" style={{ background: item.priority === 'high' ? 'var(--accent-danger)' : 'var(--accent-warning)' }}>
                        <AlertTriangle size={13} />
                      </span>
                      <div className="alert-row-body">
                        <strong>{item.author || 'Unknown'} · {PLATFORM_LABELS[item.platform] || item.platform}</strong>
                        <span>{item.text}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel-header">
                <h2>Upcoming Posts</h2>
                <span className="tag" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => setCurrentView('social-posts')}>Open Posts →</span>
              </div>
              {posts === null ? (
                <div className="trend-chart-empty">Loading…</div>
              ) : upcomingPosts.length === 0 ? (
                <div className="trend-chart-empty">Nothing scheduled — write one in Compose.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
                  {upcomingPosts.map(post => (
                    <div key={post.id} className="alert-row">
                      <span className="alert-row-icon" style={{ background: 'var(--accent-secondary)' }}>
                        <CalendarClock size={13} />
                      </span>
                      <div className="alert-row-body">
                        <strong>{new Date(post.scheduled_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong>
                        <span>{post.content ? (post.content.length > 90 ? `${post.content.slice(0, 90)}…` : post.content) : '(no text content)'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default Dashboard;
