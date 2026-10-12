'use client';

import React, { useEffect, useState } from 'react';
import {
  RefreshCw, PenSquare, CalendarClock, ArrowRight, Share2, Inbox as InboxIcon
} from 'lucide-react';
import { SOCIAL_API_BASE } from './api';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, PanelHeader, StatStrip, Stat, EmptyState, Banner,
  Skeleton, Avatar, Chip
} from '../ui';
import { ChannelTile, ChannelDot, channelColor, channelLabel } from '../ui/channel';

// Social's "30-second glance" — aggregate KPIs rolled up from the
// per-account summary (GET /social/analytics/summary) plus a snapshot of
// the Inbox and the schedule, so nothing here is a number invented for
// this page: it's the same data those pages show, totalled.
//
// Under the Calm Precision system the figures sit on one flat divided
// strip rather than six separate cards with colored icon chips.

const fmt = (n) => (n === null || n === undefined ? '—' : n.toLocaleString());

function ChannelRow({ row, max }) {
  const value = row.followers || 0;
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="px-4 py-2.5 flex items-center gap-3 border-b border-hairline last:border-0">
      <ChannelTile platform={row.platform} size={28} />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-ink truncate">
          {row.accountLabel || channelLabel(row.platform)}
        </div>
        <div className="mt-1.5 h-1 rounded-full bg-sunken overflow-hidden">
          <div
            className="h-full rounded-full"
            style={{ width: `${pct}%`, background: channelColor(row.platform) }}
          />
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-xs font-semibold tabular-nums text-ink">{fmt(row.followers)}</div>
        <div className="text-[11px] text-subtle">followers</div>
      </div>
    </div>
  );
}

function Dashboard({ authFetch, setCurrentView }) {
  const [summary, setSummary] = useState(null);
  const [interactions, setInteractions] = useState(null);
  const [posts, setPosts] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setError(null);
    setRefreshing(true);
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
      setInteractions(interactionsRes.ok ? interactionsData.interactions || [] : []);

      const postsData = await postsRes.json();
      setPosts(postsRes.ok ? postsData.posts || [] : []);
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

  const loading = summary === null;
  const accounts = summary || [];
  const totals = accounts.reduce(
    (acc, a) => ({
      followers: acc.followers + (a.followers || 0),
      newFollowers: acc.newFollowers + (a.newFollowers || 0),
      posts: acc.posts + (a.posts || 0),
      reach: acc.reach + (a.reach || 0),
      engagement: acc.engagement + (a.engagement || 0)
    }),
    { followers: 0, newFollowers: 0, posts: 0, reach: 0, engagement: 0 }
  );

  const maxFollowers = Math.max(1, ...accounts.map((a) => a.followers || 0));
  const openInteractions = (interactions || []).filter((i) => i.interactionStatus === 'open');
  const needsAttention = openInteractions
    .filter((i) => i.priority === 'high')
    .concat(openInteractions.filter((i) => i.priority !== 'high'))
    .slice(0, 5);

  const upcomingPosts = (posts || [])
    .filter((p) => p.status === 'pending')
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))
    .slice(0, 5);

  return (
    <Page>
      <PageBar
        title="Dashboard"
        actions={
          <>
            <IconButton
              icon={RefreshCw}
              label="Refresh"
              onClick={load}
              className={refreshing ? 'animate-[spin_1s_linear_infinite]' : undefined}
            />
            <Button variant="primary" icon={PenSquare} onClick={() => setCurrentView('social-compose')}>
              Create post
            </Button>
          </>
        }
      />

      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}

        {!loading && accounts.length === 0 ? (
          <Panel>
            <EmptyState
              icon={Share2}
              title="No channels connected yet"
              description="Connect WhatsApp, Instagram, Facebook, LinkedIn, YouTube or Google Business and this page fills in automatically — followers, reach, engagement and everything waiting for a reply."
              action={
                <Button variant="primary" onClick={() => setCurrentView('social-accounts')}>
                  Connect a channel
                </Button>
              }
            />
          </Panel>
        ) : (
          <>
            <StatStrip>
              <Stat label="Channels" value={loading ? '—' : accounts.length} />
              <Stat
                label="Followers"
                value={loading ? '—' : fmt(totals.followers)}
                delta={
                  !loading && totals.newFollowers !== 0
                    ? `${totals.newFollowers > 0 ? '+' : ''}${totals.newFollowers}`
                    : undefined
                }
                deltaTone={totals.newFollowers > 0 ? 'up' : totals.newFollowers < 0 ? 'down' : 'neutral'}
              />
              <Stat label="Posts published" value={loading ? '—' : fmt(totals.posts)} />
              <Stat label="Reach" value={loading ? '—' : fmt(totals.reach)} />
              <Stat label="Engagement" value={loading ? '—' : fmt(totals.engagement)} />
              <Stat
                label="Open conversations"
                value={interactions === null ? '—' : openInteractions.length}
                delta={openInteractions.length > 0 ? 'needs a reply' : undefined}
                deltaTone={openInteractions.length > 0 ? 'down' : 'neutral'}
              />
            </StatStrip>

            <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-5 items-start">
              {/* Needs attention — the widest column, because it is the work */}
              <Panel>
                <PanelHeader
                  title="Needs attention"
                  meta={interactions === null ? undefined : `${openInteractions.length} open`}
                  action={
                    <button
                      onClick={() => setCurrentView('social-inbox')}
                      className="text-[11px] text-brand hover:underline flex items-center gap-1"
                    >
                      Open inbox <ArrowRight size={12} />
                    </button>
                  }
                />
                {interactions === null ? (
                  <div className="p-4 space-y-3">
                    <Skeleton className="h-9" />
                    <Skeleton className="h-9" />
                    <Skeleton className="h-9" />
                  </div>
                ) : needsAttention.length === 0 ? (
                  <EmptyState
                    icon={InboxIcon}
                    title="You’re all caught up"
                    description="Nothing open across any connected channel right now."
                  />
                ) : (
                  needsAttention.map((item) => (
                    <button
                      key={`${item.source}-${item.id}`}
                      onClick={() => setCurrentView('social-inbox')}
                      className="w-full px-4 py-2.5 flex items-center gap-3 text-left border-b border-hairline last:border-0 hover:bg-canvas transition-colors"
                    >
                      <Avatar name={item.author} size={28} />
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="text-xs font-medium text-ink truncate">
                            {item.author || 'Unknown'}
                          </span>
                          <ChannelDot platform={item.platform} size={6} />
                          <span className="text-[11px] text-subtle truncate">
                            {channelLabel(item.platform)}
                          </span>
                        </span>
                        <span className="block text-[11px] text-muted truncate mt-0.5">{item.text}</span>
                      </span>
                      {item.priority === 'high' && (
                        <Chip tone="danger" className="shrink-0">
                          High
                        </Chip>
                      )}
                      <span className="text-[11px] text-subtle shrink-0 tabular-nums hidden sm:block">
                        {new Date(item.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                      </span>
                    </button>
                  ))
                )}
              </Panel>

              <div className="flex flex-col gap-5">
                <Panel>
                  <PanelHeader title="Channels" meta={`${accounts.length}`} />
                  {loading ? (
                    <div className="p-4 space-y-3">
                      <Skeleton className="h-8" />
                      <Skeleton className="h-8" />
                    </div>
                  ) : (
                    accounts.map((a) => <ChannelRow key={a.accountId} row={a} max={maxFollowers} />)
                  )}
                </Panel>

                <Panel>
                  <PanelHeader
                    title="Upcoming posts"
                    action={
                      <button
                        onClick={() => setCurrentView('social-posts')}
                        className="text-[11px] text-brand hover:underline flex items-center gap-1"
                      >
                        Open posts <ArrowRight size={12} />
                      </button>
                    }
                  />
                  {posts === null ? (
                    <div className="p-4 space-y-3">
                      <Skeleton className="h-8" />
                      <Skeleton className="h-8" />
                    </div>
                  ) : upcomingPosts.length === 0 ? (
                    <EmptyState
                      icon={CalendarClock}
                      title="Nothing scheduled"
                      description="Write one in Compose and it shows up here."
                      action={
                        <Button size="sm" onClick={() => setCurrentView('social-compose')}>
                          Write a post
                        </Button>
                      }
                    />
                  ) : (
                    upcomingPosts.map((post) => (
                      <div
                        key={post.id}
                        className="px-4 py-2.5 border-b border-hairline last:border-0 flex items-start gap-3"
                      >
                        <span className="flex -space-x-1 shrink-0 pt-0.5">
                          {(post.target_platforms || []).slice(0, 3).map((p) => (
                            <span key={p} className="ring-2 ring-card rounded-full">
                              <ChannelDot platform={p} size={8} />
                            </span>
                          ))}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] font-medium text-ink tabular-nums">
                            {new Date(post.scheduled_at).toLocaleString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit'
                            })}
                          </div>
                          <p className="text-[11px] text-muted truncate mt-0.5">
                            {post.content || '(no text content)'}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </Panel>
              </div>
            </div>
          </>
        )}
      </PageBody>
    </Page>
  );
}

export default Dashboard;
