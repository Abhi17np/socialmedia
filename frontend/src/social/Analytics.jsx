import React, { useEffect, useState } from 'react';
import {
  RefreshCw, Users, Send, Eye, ThumbsUp, MessageCircle, Share2,
  TrendingUp, TrendingDown, ExternalLink, X, Info
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, Cell, LabelList
} from 'recharts';
import { SOCIAL_API_BASE, PLATFORM_LABELS, PLATFORM_COLORS } from './api';
import { PlatformIcon } from './PlatformIcon';

// "Brand Health" — redesigned as a channel-card grid (one card per
// connected account) instead of a plain table, plus an engagement
// comparison chart and a dedicated recent-posts panel, so it reads like
// the analytics view in Zoho Social / HubSpot rather than a spreadsheet.
// social/pollers.js's sweepAnalytics() (backend) is what actually keeps
// the underlying numbers current, every 6 hours; this page just reads
// GET /social/analytics/summary (aggregate, per account) and, lazily,
// GET /social/accounts/:id/posts (per-post detail) and renders them.
const CHART_TOOLTIP_STYLE = { background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' };

function fmt(value) {
  if (value === null || value === undefined) return null;
  return value.toLocaleString();
}

function formatPostDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// A metric this platform's adapter can't report (null) reads as a plain
// muted dash with a hover explanation, never a fabricated 0.
function Metric({ value, label }) {
  const display = fmt(value);
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '1.05rem', fontWeight: 700, color: display === null ? 'var(--text-muted)' : 'var(--text-primary)' }} title={display === null ? 'Not reported by this platform / permission level yet' : undefined}>
        {display === null ? '—' : display}
      </div>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em', marginTop: '0.15rem' }}>{label}</div>
    </div>
  );
}

function ChannelCard({ row, expanded, onToggle }) {
  const color = PLATFORM_COLORS[row.platform] || 'var(--text-muted)';
  const followers = fmt(row.followers);
  return (
    <div className="panel" style={{ marginBottom: 0, border: expanded ? `1px solid ${color}` : undefined }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '1rem' }}>
        <div style={{ width: 38, height: 38, borderRadius: 'var(--radius-sm)', background: color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <PlatformIcon platform={row.platform} size={18} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.accountLabel || row.accountId}</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{PLATFORM_LABELS[row.platform] || row.platform}</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', marginBottom: '1rem' }}>
        <div style={{ fontSize: '2rem', fontWeight: 800, color: followers === null ? 'var(--text-muted)' : 'var(--text-primary)' }}>
          {followers === null ? '—' : followers}
        </div>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>followers</div>
        {row.newFollowers !== null && row.newFollowers !== 0 && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.8rem', fontWeight: 700, color: row.newFollowers > 0 ? 'var(--accent-success)' : 'var(--accent-danger)' }}>
            {row.newFollowers > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
            {row.newFollowers > 0 ? `+${row.newFollowers}` : row.newFollowers}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '0.85rem', borderTop: '1px solid var(--border-color)', marginBottom: '1rem' }}>
        <Metric value={row.posts} label="Posts" />
        <Metric value={row.reach} label="Reach" />
        <Metric value={row.engagement} label="Engagement" />
      </div>

      <button className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={() => onToggle(row)}>
        {expanded ? 'Hide Recent Posts' : 'View Recent Posts'}
      </button>
    </div>
  );
}

function Analytics({ authFetch }) {
  const [summary, setSummary] = useState(null);
  const [brand, setBrand] = useState('infopace');
  const [windowDays, setWindowDays] = useState(30);
  const [error, setError] = useState(null);
  // accountId -> { posts } | { loading: true } | { error }, filled in lazily
  // when a card's "View Recent Posts" is clicked — /social/analytics/summary's
  // aggregate numbers don't include per-post likes/comments, so this is a
  // separate fetch.
  const [expandedAccount, setExpandedAccount] = useState(null);
  const [postsByAccount, setPostsByAccount] = useState({});

  const load = async () => {
    try {
      const params = new URLSearchParams();
      if (brand) params.set('brand', brand);
      const res = await authFetch(`${SOCIAL_API_BASE}/analytics/summary?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load analytics.');
      setSummary(data.summary || []);
      setWindowDays(data.windowDays || 30);
    } catch (err) {
      setError(err.message);
      setSummary([]);
    }
  };

  useEffect(() => { load(); }, [brand]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePosts = async (row) => {
    if (expandedAccount === row.accountId) {
      setExpandedAccount(null);
      return;
    }
    setExpandedAccount(row.accountId);
    if (postsByAccount[row.accountId]) return; // already fetched — expand from cache

    setPostsByAccount(prev => ({ ...prev, [row.accountId]: { loading: true } }));
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/accounts/${row.accountId}/posts`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load posts.');
      setPostsByAccount(prev => ({ ...prev, [row.accountId]: { posts: data.posts || [] } }));
    } catch (err) {
      setPostsByAccount(prev => ({ ...prev, [row.accountId]: { error: err.message } }));
    }
  };

  const loading = summary === null;
  const rows = summary || [];
  // A metric only totals up if at least one account actually reports it —
  // summing null-as-0 across accounts that all lack the permission would
  // print a real-looking "0" for a number that's actually unknown.
  const sumMetric = (key) => {
    const known = rows.filter(r => r[key] !== null && r[key] !== undefined);
    if (known.length === 0) return null;
    return known.reduce((sum, r) => sum + r[key], 0);
  };
  const totals = {
    followers: sumMetric('followers'),
    posts: rows.reduce((sum, r) => sum + (r.posts || 0), 0),
    reach: sumMetric('reach'),
    engagement: sumMetric('engagement')
  };

  const engagementChartData = rows
    .filter(r => r.engagement !== null && r.engagement !== undefined)
    .map(r => ({ name: r.accountLabel || r.accountId, value: r.engagement, fill: PLATFORM_COLORS[r.platform] || '#2a78d6' }))
    .sort((a, b) => b.value - a.value);

  const expandedRow = rows.find(r => r.accountId === expandedAccount);
  const expandedPosts = expandedAccount ? postsByAccount[expandedAccount] : null;

  return (
    <div>
      <div className="header-container">
        <div className="title-area">
          <h1>Analytics</h1>
          <p>Channel overview for the past {windowDays} days.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <input type="text" className="form-control" style={{ width: 160 }} placeholder="Brand" value={brand} onChange={(e) => setBrand(e.target.value)} />
          <button className="btn btn-secondary btn-sm" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {error && <p style={{ color: 'var(--accent-danger)', marginBottom: '1rem' }}>{error}</p>}

      {!loading && rows.length === 0 ? (
        <div className="panel">
          <p style={{ color: 'var(--text-secondary)' }}>No connected accounts for this brand yet — connect one in Connect Accounts.</p>
        </div>
      ) : (
        <>
          <div className="kpi-grid" style={{ marginBottom: '1.5rem' }}>
            <div className="kpi-card">
              <div className="kpi-card-icon" style={{ background: '#2a78d6' }}><Users size={17} /></div>
              <div className="kpi-card-label">Total Followers</div>
              <div className="kpi-card-value">{loading || totals.followers === null ? '—' : totals.followers.toLocaleString()}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-card-icon" style={{ background: '#0d8f73' }}><Send size={17} /></div>
              <div className="kpi-card-label">Posts Published</div>
              <div className="kpi-card-value">{loading ? '—' : totals.posts.toLocaleString()}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-card-icon" style={{ background: '#b8690a' }}><Eye size={17} /></div>
              <div className="kpi-card-label">Total Reach</div>
              <div className="kpi-card-value">{loading || totals.reach === null ? '—' : totals.reach.toLocaleString()}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-card-icon" style={{ background: '#4a3aa7' }}><ThumbsUp size={17} /></div>
              <div className="kpi-card-label">Total Engagement</div>
              <div className="kpi-card-value">{loading || totals.engagement === null ? '—' : totals.engagement.toLocaleString()}</div>
            </div>
          </div>

          {engagementChartData.length > 0 && (
            <div className="panel">
              <div className="panel-header"><h2>Engagement by Channel</h2></div>
              <ResponsiveContainer width="100%" height={Math.max(engagementChartData.length * 38, 120)}>
                <BarChart data={engagementChartData} layout="vertical" margin={{ top: 0, right: 28, left: 0, bottom: 0 }}>
                  <XAxis type="number" allowDecimals={false} hide />
                  <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} axisLine={false} tickLine={false} />
                  <RTooltip formatter={(value) => [value.toLocaleString(), 'Engagement']} contentStyle={CHART_TOOLTIP_STYLE} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={16}>
                    {engagementChartData.map(d => <Cell key={d.name} fill={d.fill} />)}
                    <LabelList dataKey="value" position="right" style={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="panel-header" style={{ marginBottom: '0.75rem' }}>
            <h2 style={{ fontSize: '1rem' }}>Channels</h2>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <Info size={12} /> "—" means this platform/permission level doesn't report that metric yet
            </span>
          </div>

          {loading ? (
            <div className="trend-chart-empty">Loading…</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
              {rows.map(row => (
                <ChannelCard key={row.accountId} row={row} expanded={expandedAccount === row.accountId} onToggle={togglePosts} />
              ))}
            </div>
          )}

          {expandedRow && (
            <div className="panel">
              <div className="panel-header">
                <h2>Recent Posts — {expandedRow.accountLabel || expandedRow.accountId} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({PLATFORM_LABELS[expandedRow.platform] || expandedRow.platform})</span></h2>
                <button className="close-btn" onClick={() => setExpandedAccount(null)}><X size={18} /></button>
              </div>

              {!expandedPosts || expandedPosts.loading ? (
                <div className="trend-chart-empty">Loading recent posts…</div>
              ) : expandedPosts.error ? (
                <p style={{ color: 'var(--accent-danger)' }}>{expandedPosts.error}</p>
              ) : expandedPosts.posts.length === 0 ? (
                <div className="trend-chart-empty">No posts found.</div>
              ) : (
                <div>
                  {expandedPosts.posts.some(p => p.likes === null || p.comments === null) && (
                    <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                      Engagement counts (likes/comments) aren't available for this account yet — it needs Advanced Access to Facebook's pages_read_engagement permission. Post content still shows below.
                    </p>
                  )}
                  {expandedPosts.posts.map(post => (
                    <div key={post.externalPostId} className="post-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                          {post.message || '(no text)'}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
                          {formatPostDate(post.createdTime)}
                          {post.permalinkUrl && (
                            <a href={post.permalinkUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)', display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                              <ExternalLink size={11} /> View
                            </a>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '1rem', flexShrink: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><ThumbsUp size={14} /> {post.likes === null ? '—' : post.likes}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><MessageCircle size={14} /> {post.comments === null ? '—' : post.comments}</span>
                        {post.shares !== null && post.shares !== undefined && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Share2 size={14} /> {post.shares}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default Analytics;
