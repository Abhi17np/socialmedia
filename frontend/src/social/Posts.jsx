'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, X, ChevronDown, ChevronRight, PenSquare, CalendarDays, List as ListIcon,
  CalendarClock, Check, Repeat
} from 'lucide-react';
import { SOCIAL_API_BASE, AVAILABLE_PLATFORMS } from './api';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, Chip, Input, EmptyState, Banner, Skeleton,
  ConfirmDialog, cx
} from '../ui';
import { ChannelFilterTabs, ChannelDot, channelLabel } from '../ui/channel';
import { atLeast } from '../roleRank';

/*
 * Scheduled and published posts. The data model distinguishes
 * pending/publishing (still queued) from published/failed (already
 * attempted), so those are the two sub-tabs.
 *
 * The redesign adds a month calendar next to the list — the thing a
 * social manager actually plans in — built from the same `posts` array,
 * with no date library: a plain 6×7 grid of the month's cells.
 */

const STATUS = {
  pending: { tone: 'neutral', label: 'Pending' },
  publishing: { tone: 'warning', label: 'Publishing' },
  published: { tone: 'success', label: 'Published' },
  failed: { tone: 'danger', label: 'Failed' },
  pending_review: { tone: 'warning', label: 'Needs review' },
  rejected: { tone: 'danger', label: 'Rejected' }
};

const SUB_TABS = [
  { key: 'review', label: 'Needs review', statuses: ['pending_review', 'rejected'] },
  { key: 'scheduled', label: 'Scheduled', statuses: ['pending', 'publishing'] },
  { key: 'published', label: 'Published', statuses: ['published', 'failed'] }
];

const dayKey = (d) => new Date(d).toDateString();

function PostErrors({ results }) {
  const [expanded, setExpanded] = useState(false);
  const entries = Object.entries(results || {});
  if (entries.length === 0) return null;
  const failed = entries.filter(([, r]) => r.status === 'failed');
  if (failed.length === 0 && !expanded) return null;
  const visible = expanded ? entries : failed.slice(0, 1);

  return (
    <div className="mt-2 rounded-ui border border-danger-border bg-danger-subtle/60 px-2.5 py-2 flex flex-col gap-1">
      {visible.map(([key, result]) => (
        <div key={key} className="text-[11px] leading-tight">
          <span className="font-medium text-ink">{channelLabel(key)}</span>
          {': '}
          {result.status === 'failed' ? (
            <span className="text-danger">{result.error || 'failed'}</span>
          ) : (
            <span className="text-muted">{result.status}</span>
          )}
        </div>
      ))}
      {entries.length > visible.length && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start text-[11px] text-brand hover:underline"
        >
          Show all {entries.length} channel results
        </button>
      )}
    </div>
  );
}

function PostCard({ post, onCancel, onApprove, onReject, canReview }) {
  const status = STATUS[post.status] || STATUS.pending;
  return (
    <div className="px-4 py-3 border-b border-hairline last:border-0 flex items-start justify-between gap-4 hover:bg-canvas/60 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-1.5">
          {(post.target_platforms || []).map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 text-[11px] text-muted"
              title={channelLabel(p)}
            >
              <ChannelDot platform={p} size={7} />
            </span>
          ))}
          <span className="text-[11px] text-subtle tabular-nums ml-1">
            {new Date(post.scheduled_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
          {post.brand && <span className="text-[11px] text-subtle">· {post.brand}</span>}
          {post.recurrence_series_id && (
            <span className="inline-flex items-center gap-0.5 text-[11px] text-subtle" title={`Repeats ${post.recurrence?.freq || ''} until ${post.recurrence?.until ? new Date(post.recurrence.until).toLocaleDateString() : '?'}`}>
              <Repeat size={11} />
            </span>
          )}
        </div>
        <p className="text-xs text-ink leading-relaxed line-clamp-2">
          {post.content || <span className="text-subtle">(no text content)</span>}
        </p>
        <PostErrors results={post.platform_results} />
        {post.status === 'rejected' && post.review_note && (
          <p className="text-[11px] text-danger mt-1">Rejected: {post.review_note}</p>
        )}
      </div>
      <div className="flex flex-col items-end gap-2 shrink-0">
        <Chip tone={status.tone}>{status.label}</Chip>
        {post.status === 'pending' && (
          <Button size="sm" variant="ghost" icon={X} onClick={() => onCancel(post)}>
            Cancel
          </Button>
        )}
        {post.status === 'pending_review' && canReview && (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" icon={Check} onClick={() => onApprove(post)}>Approve</Button>
            <Button size="sm" variant="ghost" icon={X} onClick={() => onReject(post)}>Reject</Button>
          </div>
        )}
        {post.status === 'pending_review' && !canReview && (
          <Button size="sm" variant="ghost" icon={X} onClick={() => onCancel(post)}>Withdraw</Button>
        )}
        {post.status === 'rejected' && (
          <Button size="sm" variant="ghost" icon={X} onClick={() => onCancel(post)}>Discard</Button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Calendar */

function MonthCalendar({ posts, month, onMonthChange }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7; // week starts Monday
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d));
  while (cells.length % 7 !== 0) cells.push(null);

  const byDay = {};
  posts.forEach((p) => {
    const k = dayKey(p.scheduled_at);
    (byDay[k] = byDay[k] || []).push(p);
  });

  const today = new Date().toDateString();

  return (
    <Panel className="overflow-hidden">
      <div className="h-11 px-4 flex items-center justify-between border-b border-hairline">
        <h2 className="text-[13px] font-semibold text-ink">
          {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </h2>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          >
            Previous
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onMonthChange(new Date())}>
            Today
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          >
            Next
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-hairline bg-sunken/60">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="eyebrow px-2 py-2 text-center">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {cells.map((date, i) => {
          const items = date ? byDay[date.toDateString()] || [] : [];
          const isToday = date && date.toDateString() === today;
          return (
            <div
              key={i}
              className={cx(
                'min-h-[92px] border-b border-r border-hairline p-1.5 flex flex-col gap-1',
                i % 7 === 6 && 'border-r-0',
                !date && 'bg-sunken/40'
              )}
            >
              {date && (
                <span
                  className={cx(
                    'text-[11px] tabular-nums w-5 h-5 flex items-center justify-center rounded-full shrink-0',
                    isToday ? 'bg-brand text-white font-semibold' : 'text-subtle'
                  )}
                >
                  {date.getDate()}
                </span>
              )}
              {items.slice(0, 3).map((p) => (
                <div
                  key={p.id}
                  title={p.content}
                  className="flex items-center gap-1 px-1 py-0.5 rounded bg-sunken border border-hairline min-w-0"
                >
                  <ChannelDot platform={(p.target_platforms || [])[0]} size={5} />
                  <span className="text-[10px] text-muted truncate">
                    {new Date(p.scheduled_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{' '}
                    {p.content}
                  </span>
                </div>
              ))}
              {items.length > 3 && (
                <span className="text-[10px] text-subtle pl-1">+{items.length - 3} more</span>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/* ================================================================= Posts */

function Posts({ authFetch, role, setCurrentView }) {
  const canReview = atLeast(role, 'admin');
  const [posts, setPosts] = useState(null);
  const [error, setError] = useState(null);
  const [subTab, setSubTab] = useState('scheduled');
  const [platformFilter, setPlatformFilter] = useState('');
  const [brand, setBrand] = useState('');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('list');
  const [month, setMonth] = useState(new Date());
  const [collapsed, setCollapsed] = useState({});
  const [confirmCancel, setConfirmCancel] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (brand.trim()) params.set('brand', brand.trim());
      const res = await authFetch(`${SOCIAL_API_BASE}/posts?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load posts.');
      setPosts((data.posts || []).sort((a, b) => new Date(b.scheduled_at) - new Date(a.scheduled_at)));
      setError(null);
    } catch (err) {
      setError(err.message);
      setPosts([]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, [brand]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = async (post) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/posts/${post.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not cancel post.');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmCancel(null);
    }
  };

  const approve = async (post) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/posts/${post.id}/approve`, { method: 'PATCH' });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not approve post.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const reject = async (post) => {
    const note = window.prompt('Reason for rejecting this post (optional):') || undefined;
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/posts/${post.id}/reject`, { method: 'PATCH', body: JSON.stringify({ note }) });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not reject post.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const activeStatuses = (SUB_TABS.find((t) => t.key === subTab) || SUB_TABS[0]).statuses;
  const searchLower = search.trim().toLowerCase();

  const filtered = useMemo(
    () =>
      (posts || []).filter((p) => {
        if (!activeStatuses.includes(p.status)) return false;
        if (platformFilter && !(p.target_platforms || []).includes(platformFilter)) return false;
        if (searchLower && !(p.content || '').toLowerCase().includes(searchLower)) return false;
        return true;
      }),
    [posts, activeStatuses, platformFilter, searchLower]
  );

  const groups = useMemo(() => {
    const out = {};
    filtered.forEach((p) => {
      const key = new Date(p.scheduled_at).toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      (out[key] = out[key] || []).push(p);
    });
    return out;
  }, [filtered]);

  const countFor = (statuses) => (posts || []).filter((p) => statuses.includes(p.status)).length;

  return (
    <Page>
      <PageBar
        title="Posts & schedule"
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search post content…"
        actions={
          <>
            <IconButton
              icon={RefreshCw}
              label="Refresh"
              onClick={load}
              className={refreshing ? 'animate-[spin_1s_linear_infinite]' : undefined}
            />
            <Button variant="primary" icon={PenSquare} onClick={() => setCurrentView('social-compose')}>
              New post
            </Button>
          </>
        }
      />

      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 p-0.5 rounded-ui bg-sunken border border-hairline">
            {SUB_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setSubTab(t.key)}
                className={cx(
                  'h-6 px-2.5 rounded text-[11px] font-medium transition-colors',
                  subTab === t.key ? 'bg-card text-ink shadow-[var(--shadow-hover)]' : 'text-muted hover:text-ink'
                )}
              >
                {t.label}{' '}
                <span className="tabular-nums opacity-70">{posts ? countFor(t.statuses) : '—'}</span>
              </button>
            ))}
          </div>

          <Input
            className="w-32"
            placeholder="Brand"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
          />

          <div className="flex items-center gap-1 p-0.5 rounded-ui bg-sunken border border-hairline">
            <button
              onClick={() => setMode('list')}
              title="List"
              className={cx(
                'w-7 h-6 rounded flex items-center justify-center transition-colors',
                mode === 'list' ? 'bg-card text-ink' : 'text-muted hover:text-ink'
              )}
            >
              <ListIcon size={14} />
            </button>
            <button
              onClick={() => setMode('calendar')}
              title="Calendar"
              className={cx(
                'w-7 h-6 rounded flex items-center justify-center transition-colors',
                mode === 'calendar' ? 'bg-card text-ink' : 'text-muted hover:text-ink'
              )}
            >
              <CalendarDays size={14} />
            </button>
          </div>
        </div>

        <ChannelFilterTabs
          platforms={AVAILABLE_PLATFORMS}
          value={platformFilter}
          onChange={setPlatformFilter}
        />

        {posts === null ? (
          <Panel className="p-4 space-y-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </Panel>
        ) : mode === 'calendar' ? (
          <MonthCalendar posts={filtered} month={month} onMonthChange={setMonth} />
        ) : filtered.length === 0 ? (
          <Panel>
            <EmptyState
              icon={CalendarClock}
              title={subTab === 'scheduled' ? 'Nothing scheduled' : 'No published posts match'}
              description={
                subTab === 'scheduled'
                  ? 'Write a post in Compose and schedule it — it will appear here and in the calendar.'
                  : 'Try a different channel or clear the search.'
              }
              action={
                subTab === 'scheduled' && (
                  <Button variant="primary" onClick={() => setCurrentView('social-compose')}>
                    Write a post
                  </Button>
                )
              }
            />
          </Panel>
        ) : (
          Object.entries(groups).map(([date, datePosts]) => {
            const isCollapsed = !!collapsed[date];
            return (
              <Panel key={date}>
                <button
                  onClick={() => setCollapsed((prev) => ({ ...prev, [date]: !prev[date] }))}
                  className="w-full h-11 px-4 flex items-center justify-between border-b border-hairline hover:bg-canvas transition-colors"
                >
                  <span className="flex items-center gap-2">
                    {isCollapsed ? (
                      <ChevronRight size={14} className="text-subtle" />
                    ) : (
                      <ChevronDown size={14} className="text-subtle" />
                    )}
                    <span className="text-[13px] font-semibold text-ink">{date}</span>
                  </span>
                  <span className="text-[11px] text-subtle tabular-nums">
                    {datePosts.length} post{datePosts.length === 1 ? '' : 's'}
                  </span>
                </button>
                {!isCollapsed &&
                  datePosts.map((post) => (
                    <PostCard key={post.id} post={post} onCancel={setConfirmCancel} onApprove={approve} onReject={reject} canReview={canReview} />
                  ))}
              </Panel>
            );
          })
        )}
      </PageBody>

      <ConfirmDialog
        open={!!confirmCancel}
        title="Cancel this scheduled post?"
        body="It will be removed from the publish queue and won't go out on any channel. This can't be undone."
        confirmLabel="Cancel post"
        onCancel={() => setConfirmCancel(null)}
        onConfirm={() => cancel(confirmCancel)}
      />
    </Page>
  );
}

export default Posts;
