'use client';

import React, { useEffect, useState } from 'react';
import {
  RefreshCw, ThumbsUp, MessageCircle, Share2, TrendingUp, TrendingDown,
  ExternalLink, Info, LineChart as LineChartIcon, ChevronDown, ChevronUp
} from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, Cell, LabelList } from 'recharts';
import { SOCIAL_API_BASE } from './api';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  IconButton, Panel, PanelHeader, StatStrip, Stat, EmptyState, Banner,
  Skeleton, Input, cx
} from '../ui';
import { ChannelTile, channelColor, channelLabel } from '../ui/channel';
import RevenueAttribution from './RevenueAttribution';

// "Brand health" — one card per connected account plus an engagement
// comparison, reading GET /social/analytics/summary (aggregate, per
// account) and, lazily, GET /social/accounts/:id/posts (per-post detail).
// backend/social/pollers.js's sweepAnalytics() is what keeps the numbers
// current, every 6 hours; this page just renders them.
//
// A metric this platform's adapter can't report (null) reads as a muted
// em dash with a hover explanation, never a fabricated 0 — the rule the
// redesign kept verbatim.

const TOOLTIP_STYLE = {
  background: 'var(--color-card)',
  border: '1px solid var(--color-hairline)',
  borderRadius: 8,
  fontSize: 11,
  color: 'var(--color-ink)',
  boxShadow: 'var(--shadow-flyout)'
};

const fmt = (v) => (v === null || v === undefined ? null : v.toLocaleString());

function Metric({ value, label }) {
  const display = fmt(value);
  return (
    <div className="min-w-0">
      <div className="eyebrow truncate">{label}</div>
      <div
        className={cx('text-[15px] font-semibold tabular-nums mt-0.5', display === null ? 'text-subtle' : 'text-ink')}
        title={display === null ? 'Not reported by this platform / permission level yet' : undefined}
      >
        {display === null ? '—' : display}
      </div>
    </div>
  );
}

function ChannelCard({ row, expanded, onToggle, detail }) {
  const followers = fmt(row.followers);
  return (
    <Panel>
      <div className="p-4">
        <div className="flex items-start gap-3">
          <ChannelTile platform={row.platform} size={34} />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-ink truncate">
              {row.accountLabel || row.accountId}
            </div>
            <div className="text-[11px] text-subtle">{channelLabel(row.platform)}</div>
          </div>
          {row.newFollowers !== null && row.newFollowers !== 0 && (
            <span
              className={cx(
                'flex items-center gap-1 text-[11px] font-medium tabular-nums shrink-0',
                row.newFollowers > 0 ? 'text-success' : 'text-danger'
              )}
            >
              {row.newFollowers > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              {row.newFollowers > 0 ? `+${row.newFollowers}` : row.newFollowers}
            </span>
          )}
        </div>

        <div className="mt-3 flex items-baseline gap-2">
          <span
            className={cx(
              'text-[26px] leading-7 font-semibold tabular-nums tracking-tight',
              followers === null ? 'text-subtle' : 'text-ink'
            )}
          >
            {followers === null ? '—' : followers}
          </span>
          <span className="text-[11px] text-subtle">followers</span>
        </div>

        <div className="mt-3 pt-3 border-t border-hairline grid grid-cols-3 gap-3">
          <Metric value={row.posts} label="Posts" />
          <Metric value={row.reach} label="Reach" />
          <Metric value={row.engagement} label="Engagement" />
        </div>
      </div>

      <button
        onClick={() => onToggle(row)}
        className="w-full h-9 border-t border-hairline text-[11px] font-medium text-muted hover:text-ink hover:bg-canvas transition-colors flex items-center justify-center gap-1.5"
      >
        {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {expanded ? 'Hide recent posts' : 'View recent posts'}
      </button>

      {expanded && (
        <div className="border-t border-hairline">
          {!detail || detail.loading ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : detail.error ? (
            <p className="p-4 text-[11px] text-danger">{detail.error}</p>
          ) : detail.posts.length === 0 ? (
            <p className="p-4 text-[11px] text-subtle text-center">No posts found.</p>
          ) : (
            <>
              {detail.posts.some((p) => p.likes === null || p.comments === null) && (
                <p className="px-4 pt-3 text-[11px] text-subtle leading-relaxed">
                  Engagement counts aren’t available for this account yet — it needs Advanced Access
                  to Facebook’s pages_read_engagement permission.
                </p>
              )}
              {detail.posts.map((post) => (
                <div
                  key={post.externalPostId}
                  className="px-4 py-2.5 border-b border-hairline last:border-0 flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-[11px] text-ink line-clamp-2 leading-relaxed">
                      {post.message || '(no text)'}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] text-subtle mt-1">
                      {post.createdTime &&
                        new Date(post.createdTime).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric'
                        })}
                      {post.permalinkUrl && (
                        <a
                          href={post.permalinkUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand inline-flex items-center gap-1 hover:underline"
                        >
                          <ExternalLink size={10} /> View
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-[11px] text-muted tabular-nums">
                    <span className="flex items-center gap-1">
                      <ThumbsUp size={12} /> {post.likes === null ? '—' : post.likes}
                    </span>
                    <span className="flex items-center gap-1">
                      <MessageCircle size={12} /> {post.comments === null ? '—' : post.comments}
                    </span>
                    {post.shares !== null && post.shares !== undefined && (
                      <span className="flex items-center gap-1">
                        <Share2 size={12} /> {post.shares}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

function Analytics({ authFetch, role }) {
  const [tab, setTab] = useState('brandHealth'); // 'brandHealth' | 'attribution'
  const [summary, setSummary] = useState(null);
  const [windowDays, setWindowDays] = useState(30);
  const [error, setError] = useState(null);
  const [brand, setBrand] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // accountId -> { posts } | { loading: true } | { error }, filled in lazily
  // when a card is expanded — the summary's aggregate numbers don't
  // include per-post likes/comments, so this is a separate fetch.
  const [expandedAccount, setExpandedAccount] = useState(null);
  const [postsByAccount, setPostsByAccount] = useState({});

  const load = async () => {
    setRefreshing(true);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/analytics/summary`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load analytics.');
      setSummary(data.summary || []);
      setWindowDays(data.windowDays || 30);
      setError(null);
    } catch (err) {
      setError(err.message);
      setSummary([]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePosts = async (row) => {
    if (expandedAccount === row.accountId) {
      setExpandedAccount(null);
      return;
    }
    setExpandedAccount(row.accountId);
    if (postsByAccount[row.accountId]) return; // already fetched — expand from cache

    setPostsByAccount((prev) => ({ ...prev, [row.accountId]: { loading: true } }));
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/accounts/${row.accountId}/posts`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load posts.');
      setPostsByAccount((prev) => ({ ...prev, [row.accountId]: { posts: data.posts || [] } }));
    } catch (err) {
      setPostsByAccount((prev) => ({ ...prev, [row.accountId]: { error: err.message } }));
    }
  };

  const loading = summary === null;
  const allRows = summary || [];
  const rows = brand.trim()
    ? allRows.filter((r) => (r.brand || '').toLowerCase().includes(brand.trim().toLowerCase()))
    : allRows;

  // A metric only totals up if at least one account actually reports it —
  // summing null-as-0 across accounts that all lack the permission would
  // print a real-looking "0" for a number that's actually unknown.
  const sumMetric = (key) => {
    const known = rows.filter((r) => r[key] !== null && r[key] !== undefined);
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
    .filter((r) => r.engagement !== null && r.engagement !== undefined)
    .map((r) => ({
      name: r.accountLabel || r.accountId,
      value: r.engagement,
      fill: channelColor(r.platform)
    }))
    .sort((a, b) => b.value - a.value);

  return (
    <Page>
      <PageBar
        title="Analytics"
        count={loading ? undefined : `past ${windowDays} days`}
        actions={
          <>
            <Input
              className="w-32 hidden sm:block"
              placeholder="Brand"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
            />
            <IconButton
              icon={RefreshCw}
              label="Refresh"
              onClick={load}
              className={refreshing ? 'animate-[spin_1s_linear_infinite]' : undefined}
            />
          </>
        }
      />

      <PageBody>
        <div className="flex items-center gap-1 p-0.5 rounded-ui bg-sunken border border-hairline w-fit">
          {[{ key: 'brandHealth', label: 'Brand health' }, { key: 'attribution', label: 'Revenue attribution' }].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cx(
                'h-6 px-2.5 rounded text-[11px] font-medium transition-colors',
                tab === t.key ? 'bg-card text-ink shadow-[var(--shadow-hover)]' : 'text-muted hover:text-ink'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'attribution' && <RevenueAttribution authFetch={authFetch} role={role} />}

        {tab === 'brandHealth' && error && <Banner tone="danger">{error}</Banner>}

        {tab === 'brandHealth' && (!loading && rows.length === 0 ? (
          <Panel>
            <EmptyState
              icon={LineChartIcon}
              title="No channels to report on"
              description={
                brand.trim()
                  ? 'No connected accounts match this brand.'
                  : 'Connect a channel and its numbers start arriving here — the backend refreshes them every 6 hours.'
              }
            />
          </Panel>
        ) : (
          <>
            <StatStrip className="xl:grid-cols-4">
              <Stat label="Followers" value={loading || totals.followers === null ? '—' : totals.followers.toLocaleString()} />
              <Stat label="Posts published" value={loading ? '—' : totals.posts.toLocaleString()} />
              <Stat label="Reach" value={loading || totals.reach === null ? '—' : totals.reach.toLocaleString()} />
              <Stat label="Engagement" value={loading || totals.engagement === null ? '—' : totals.engagement.toLocaleString()} />
            </StatStrip>

            {engagementChartData.length > 0 && (
              <Panel>
                <PanelHeader title="Engagement by channel" />
                <div className="p-4">
                  <ResponsiveContainer width="100%" height={Math.max(engagementChartData.length * 34, 120)}>
                    <BarChart data={engagementChartData} layout="vertical" margin={{ top: 0, right: 36, left: 0, bottom: 0 }}>
                      <XAxis type="number" allowDecimals={false} hide />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={150}
                        tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <RTooltip
                        cursor={{ fill: 'var(--color-sunken)' }}
                        formatter={(value) => [value.toLocaleString(), 'Engagement']}
                        contentStyle={TOOLTIP_STYLE}
                      />
                      <Bar dataKey="value" radius={[0, 3, 3, 0]} barSize={14}>
                        {engagementChartData.map((d) => (
                          <Cell key={d.name} fill={d.fill} />
                        ))}
                        <LabelList
                          dataKey="value"
                          position="right"
                          style={{ fontSize: 11, fill: 'var(--color-muted)' }}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
            )}

            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[13px] font-semibold text-ink">Channels</h2>
              <span className="text-[11px] text-subtle flex items-center gap-1.5">
                <Info size={12} /> “—” means this channel or permission level doesn’t report that metric
              </span>
            </div>

            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                <Skeleton className="h-44 rounded-card" />
                <Skeleton className="h-44 rounded-card" />
                <Skeleton className="h-44 rounded-card" />
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 items-start">
                {rows.map((row) => (
                  <ChannelCard
                    key={row.accountId}
                    row={row}
                    expanded={expandedAccount === row.accountId}
                    onToggle={togglePosts}
                    detail={postsByAccount[row.accountId]}
                  />
                ))}
              </div>
            )}
          </>
        ))}
      </PageBody>
    </Page>
  );
}

export default Analytics;
