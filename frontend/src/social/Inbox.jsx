'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, AtSign, MessageSquare, ExternalLink, MessageSquareText, Sparkles,
  Inbox as InboxIcon, UserMinus, UserCheck, CheckCircle2, Hourglass, Paperclip,
  Smile, History, ChevronLeft, Filter, Star, Send
} from 'lucide-react';
import { SOCIAL_API_BASE, AVAILABLE_PLATFORMS } from './api';
import { API_BASE } from '../apiBase';
import ContactTimeline from './ContactTimeline';
import SavedReplies from './SavedReplies';
import { Page, PageBar } from '../ui/page';
import {
  Button, IconButton, Chip, PillSelect, EmptyState, Banner, SkeletonRows,
  Avatar, Textarea, cx
} from '../ui';
import { ChannelDot, ChannelBadge, channelColor, channelLabel } from '../ui/channel';
import { atLeast } from '../roleRank';

/*
 * Unified inbox — mentions (comments, reviews) and inbox_messages (DMs)
 * merged server-side into one list by GET /social/interactions, so this
 * page never branches on which table a row came from beyond the badge on
 * the avatar.
 *
 * Laid out as the three-pane triage workstation the design calls for:
 *   views + channels (240) | conversation queue (360) | conversation stage
 * The whole interaction list is fetched once and narrowed in the browser,
 * which is what makes every view and channel count exact and switching
 * between them instant; Refresh re-reads it.
 *
 * The stage is a real thread, not a single row: selecting an interaction
 * that resolved to a contact loads GET /social/contacts/:id/timeline and
 * renders that person's whole cross-channel history as the conversation.
 * That is the same unification the drawer shows, in the place an agent
 * actually works.
 */

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'under_review', label: 'Under review' },
  { value: 'closed', label: 'Closed' }
];
const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
];

const PRIORITY_DOT = { high: '#dc2626', medium: '#d97706', low: '#9a9aa8' };
const STATUS_TONE = { open: 'success', under_review: 'warning', closed: 'neutral' };

const VIEWS = [
  { key: 'all', label: 'All', icon: InboxIcon, match: () => true },
  { key: 'unassigned', label: 'Unassigned', icon: UserMinus, match: (i) => !i.assignedTo && i.interactionStatus !== 'closed' },
  { key: 'mine', label: 'Assigned to me', icon: UserCheck, match: (i, me) => me && i.assignedTo === me },
  { key: 'mentions', label: 'Mentions', icon: AtSign, match: (i) => i.source === 'mention' },
  { key: 'messages', label: 'Messages', icon: MessageSquare, match: (i) => i.source === 'message' },
  { key: 'high', label: 'High priority', icon: null, dot: '#d97706', match: (i) => i.priority === 'high' && i.interactionStatus !== 'closed' },
  { key: 'review', label: 'Under review', icon: Hourglass, match: (i) => i.interactionStatus === 'under_review' },
  { key: 'closed', label: 'Closed', icon: CheckCircle2, match: (i) => i.interactionStatus === 'closed' }
];

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const keyOf = (item) => `${item.source}-${item.id}`;

/* ------------------------------------------------------------- Pane one */

function RailButton({ active, icon: Icon, dot, label, count, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'w-full h-7 px-2 rounded-ui flex items-center justify-between gap-2 text-xs transition-colors',
        active ? 'bg-canvas text-ink font-medium' : 'text-muted hover:bg-canvas hover:text-ink'
      )}
    >
      <span className="flex items-center gap-2 min-w-0">
        {Icon ? (
          <Icon size={15} className={active ? 'text-muted' : 'text-subtle'} />
        ) : dot ? (
          <span className="w-1.5 h-1.5 rounded-full mx-[4.5px] shrink-0" style={{ background: dot }} />
        ) : null}
        <span className="truncate">{label}</span>
      </span>
      <span className={cx('text-[11px] tabular-nums shrink-0', active ? 'text-muted' : 'text-subtle')}>
        {count}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------ Pane three */

function ThreadBubble({ entry }) {
  const outbound = entry.direction === 'outbound';
  return (
    <div className={cx('flex flex-col gap-1 max-w-lg', outbound && 'self-end items-end')}>
      <div className="flex items-center gap-2 text-[11px] text-subtle">
        {outbound ? (
          <>
            <span>{new Date(entry.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            <span>·</span>
            <span className="font-medium text-ink">You</span>
          </>
        ) : (
          <>
            <span className="font-medium text-ink">{entry.author || 'Them'}</span>
            <span>·</span>
            <span>
              {new Date(entry.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} via{' '}
              {channelLabel(entry.platform)}
            </span>
          </>
        )}
      </div>
      <div
        className={cx(
          'p-3 rounded-ui text-xs leading-relaxed border border-hairline text-ink',
          outbound ? 'bg-card' : 'bg-sunken'
        )}
      >
        {entry.kind === 'mention' && (
          <span className="flex items-center gap-1.5 eyebrow mb-1.5">
            {entry.platform === 'google_business' ? <Star size={11} /> : <AtSign size={11} />}
            {entry.platform === 'google_business' ? 'Review' : 'Public mention'}
          </span>
        )}
        {entry.text}
      </div>
    </div>
  );
}

function DayDivider({ label }) {
  return (
    <div className="flex items-center justify-center my-1">
      <span className="text-[11px] text-subtle px-2 py-0.5 rounded-full bg-canvas border border-hairline">
        {label}
      </span>
    </div>
  );
}

/* ================================================================= Inbox */

function Inbox({ authFetch, role, me }) {
  const myId = me?.user?.id || null;

  const [interactions, setInteractions] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSync, setLastSync] = useState(null);

  const [view, setView] = useState('all');
  const [channel, setChannel] = useState('');
  const [filters, setFilters] = useState({ type: '', priority: '', status: '' });
  const [search, setSearch] = useState('');

  const [selectedKey, setSelectedKey] = useState(null);
  const [thread, setThread] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const [timelineContactId, setTimelineContactId] = useState(null);
  const [savedReplies, setSavedReplies] = useState([]);
  const [managingReplies, setManagingReplies] = useState(false);

  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState(null);
  const [composerTab, setComposerTab] = useState('reply');

  const load = async () => {
    setRefreshing(true);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/interactions`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load interactions.');
      setInteractions(data.interactions || []);
      setLastSync(new Date());
      setError(null);
    } catch (err) {
      setError(err.message);
      setInteractions([]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    authFetch(`${SOCIAL_API_BASE}/team`)
      .then((res) => res.json())
      .then((data) => setUsers(data.users || []))
      .catch(() => {});
    authFetch(`${SOCIAL_API_BASE}/saved-replies`)
      .then((res) => res.json())
      .then((data) => setSavedReplies(data.savedReplies || []))
      .catch(() => {});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- narrowing, all client-side so every count stays exact ----- */

  const viewCounts = useMemo(() => {
    const counts = {};
    VIEWS.forEach((v) => {
      counts[v.key] = (interactions || []).filter((i) => v.match(i, myId)).length;
    });
    return counts;
  }, [interactions, myId]);

  const channelCounts = useMemo(() => {
    const counts = {};
    AVAILABLE_PLATFORMS.forEach((p) => {
      counts[p] = (interactions || []).filter(
        (i) => i.platform === p && i.interactionStatus !== 'closed'
      ).length;
    });
    return counts;
  }, [interactions]);

  const visible = useMemo(() => {
    const activeView = VIEWS.find((v) => v.key === view) || VIEWS[0];
    const q = search.trim().toLowerCase();
    return (interactions || []).filter((i) => {
      if (!activeView.match(i, myId)) return false;
      if (channel && i.platform !== channel) return false;
      if (filters.type && i.source !== filters.type) return false;
      if (filters.priority && i.priority !== filters.priority) return false;
      if (filters.status && i.interactionStatus !== filters.status) return false;
      if (q && !`${i.author || ''} ${i.text || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [interactions, view, channel, filters, search, myId]);

  const selected = useMemo(
    () => (interactions || []).find((i) => keyOf(i) === selectedKey) || null,
    [interactions, selectedKey]
  );

  /* Selecting a row loads that contact's whole cross-channel history as
     the thread; an interaction with no resolved contact shows on its own. */
  useEffect(() => {
    setReplyText('');
    setSuggestError(null);
    setComposerTab('reply');
    if (!selected) {
      setThread(null);
      return;
    }
    if (!selected.contactId) {
      setThread({ entries: null, contact: null });
      return;
    }
    let cancelled = false;
    setThread({ loading: true });
    authFetch(`${SOCIAL_API_BASE}/contacts/${selected.contactId}/timeline`)
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) throw new Error(body.error || 'Could not load this conversation.');
        setThread({ entries: body.timeline || [], contact: body.contact });
      })
      .catch(() => {
        if (!cancelled) setThread({ entries: null, contact: null });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedKey, selected, authFetch]);

  /* ----------------------------------------------------- mutations ----- */

  const patch = async (item, body) => {
    setSavingId(item.id);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/interactions/${item.source}/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update this interaction.');
      setInteractions((prev) =>
        prev.map((i) => (i.id === item.id && i.source === item.source ? { ...i, ...body } : i))
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingId(null);
    }
  };

  // AI Suggest — drafts into the same textarea manual typing uses; the
  // human still reviews/edits and still presses Send reply. See
  // backend/lib/ai.js for why this stays a single drafting call rather
  // than an agent that replies on its own.
  const suggestReply = async (item) => {
    setSuggesting(true);
    setSuggestError(null);
    try {
      const res = await authFetch(`${API_BASE}/ai/inbox/${item.id}/draft-reply`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not generate a suggested reply.');
      setReplyText(data.draft);
    } catch (err) {
      setSuggestError(err.message);
    } finally {
      setSuggesting(false);
    }
  };

  const sendReply = async (item, thenClose = false) => {
    if (!replyText.trim()) return;
    setSendingReply(true);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/inbox/${item.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ message: replyText.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send this reply.');
      setReplyText('');
      // Show it in the thread immediately rather than waiting for the
      // next poller sweep to write it back.
      setThread((prev) =>
        prev && prev.entries
          ? {
              ...prev,
              entries: [
                ...prev.entries,
                {
                  kind: 'message',
                  direction: 'outbound',
                  platform: item.platform,
                  text: replyText.trim(),
                  at: new Date().toISOString()
                }
              ]
            }
          : prev
      );
      if (thenClose) await patch(item, { interactionStatus: 'closed' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSendingReply(false);
    }
  };

  const setFilter = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));
  const assigneeEmail = (id) => users.find((u) => u.id === id)?.email;

  /* --------------------------------------------------------- render ---- */

  const loading = interactions === null;
  const threadEntries = thread?.entries;

  return (
    <Page>
      <PageBar
        title="Inbox"
        count={loading ? undefined : `${viewCounts.all - viewCounts.closed} open`}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search contacts, text, tags…"
        actions={
          <>
            <Button icon={MessageSquareText} onClick={() => setManagingReplies(true)} className="hidden sm:inline-flex">
              Canned responses
            </Button>
            <IconButton icon={RefreshCw} label="Refresh" onClick={load} className={refreshing ? 'animate-[spin_1s_linear_infinite]' : undefined} />
          </>
        }
      />

      {error && (
        <div className="px-4 pt-3 shrink-0">
          <Banner tone="danger" action={<Button size="sm" onClick={() => setError(null)}>Dismiss</Button>}>
            {error}
          </Banner>
        </div>
      )}

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* ------------------------------------------- Pane 1: views */}
        <section className="w-[240px] shrink-0 bg-card border-r border-hairline flex-col justify-between overflow-y-auto hidden xl:flex">
          <div className="p-2 space-y-4">
            <div>
              <div className="eyebrow px-2 py-1">Views</div>
              <div className="space-y-0.5 mt-0.5">
                {VIEWS.map((v) => (
                  <RailButton
                    key={v.key}
                    active={view === v.key}
                    icon={v.icon}
                    dot={v.dot}
                    label={v.label}
                    count={loading ? '—' : viewCounts[v.key]}
                    onClick={() => setView(v.key)}
                  />
                ))}
              </div>
            </div>

            <div>
              <div className="eyebrow px-2 py-1">Channels</div>
              <div className="space-y-0.5 mt-0.5">
                {AVAILABLE_PLATFORMS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setChannel(channel === p ? '' : p)}
                    className={cx(
                      'w-full h-7 px-2 rounded-ui flex items-center justify-between gap-2 text-xs transition-colors',
                      channel === p ? 'bg-canvas text-ink font-medium' : 'text-muted hover:bg-canvas hover:text-ink'
                    )}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <ChannelDot platform={p} />
                      <span className="truncate">{channelLabel(p)}</span>
                    </span>
                    <span className="text-[11px] tabular-nums text-subtle">
                      {loading ? '—' : channelCounts[p]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="p-3 border-t border-hairline flex items-center justify-between text-[11px] text-subtle shrink-0">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-success" />
              {AVAILABLE_PLATFORMS.length} streams live
            </span>
            <span className="font-mono">
              {lastSync ? `${relativeTime(lastSync.toISOString())} ago` : '—'}
            </span>
          </div>
        </section>

        {/* -------------------------------------------- Pane 2: queue */}
        <section
          className={cx(
            'w-full lg:w-[360px] shrink-0 bg-card border-r border-hairline flex-col min-h-0',
            selected ? 'hidden lg:flex' : 'flex'
          )}
        >
          <div className="p-2 border-b border-hairline flex items-center gap-1.5 overflow-x-auto shrink-0">
            <span className="xl:hidden">
              <PillSelect value={view} onChange={(e) => setView(e.target.value)}>
                {VIEWS.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label} ({viewCounts[v.key] ?? 0})
                  </option>
                ))}
              </PillSelect>
            </span>
            <PillSelect value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
              <option value="">Type: all</option>
              <option value="mention">Mentions</option>
              <option value="message">Messages</option>
            </PillSelect>
            <PillSelect value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)}>
              <option value="">Priority</option>
              {PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </PillSelect>
            <PillSelect value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">Status</option>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </PillSelect>
            <span className="xl:hidden">
              <PillSelect value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="">Channel</option>
                {AVAILABLE_PLATFORMS.map((p) => (
                  <option key={p} value={p}>{channelLabel(p)}</option>
                ))}
              </PillSelect>
            </span>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0">
            {loading ? (
              <SkeletonRows rows={8} />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={interactions.length === 0 ? InboxIcon : Filter}
                title={interactions.length === 0 ? 'Nothing here yet' : 'No conversations match'}
                description={
                  interactions.length === 0
                    ? 'Connected accounts are synced every 10 minutes — incoming comments, reviews and messages land here.'
                    : 'Try a different view, channel or filter.'
                }
                action={
                  interactions.length > 0 && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setView('all');
                        setChannel('');
                        setFilters({ type: '', priority: '', status: '' });
                        setSearch('');
                      }}
                    >
                      Clear filters
                    </Button>
                  )
                }
              />
            ) : (
              visible.map((item) => {
                const key = keyOf(item);
                const active = key === selectedKey;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedKey(key)}
                    className={cx(
                      'w-full h-11 pl-3 pr-3 flex items-center gap-2.5 text-left border-b border-hairline',
                      'border-l-2 transition-colors',
                      active
                        ? 'bg-brand/[0.04] border-l-brand'
                        : 'border-l-transparent hover:bg-canvas'
                    )}
                  >
                    <Avatar
                      name={item.author}
                      size={28}
                      badge={<ChannelBadge platform={item.platform} size={13} />}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium text-xs text-ink truncate">
                          {item.author || 'Unknown'}
                        </span>
                        <span className="text-[11px] text-subtle shrink-0 tabular-nums">
                          {relativeTime(item.date)}
                        </span>
                      </span>
                      <span className="block text-[11px] text-muted truncate leading-tight">
                        {item.text}
                      </span>
                    </span>
                    {item.priority === 'high' && item.interactionStatus !== 'closed' && (
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: PRIORITY_DOT.high }}
                        title="High priority"
                      />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* -------------------------------------------- Pane 3: stage */}
        <section className={cx('flex-1 min-w-0 flex-col bg-canvas', selected ? 'flex' : 'hidden lg:flex')}>
          {!selected ? (
            <EmptyState
              className="m-auto"
              icon={MessageSquare}
              title="Select a conversation"
              description="Pick anything in the queue to see the full history with that person and reply."
            />
          ) : (
            <>
              {/* Stage header */}
              <div className="shrink-0 bg-card border-b border-hairline px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2.5 min-w-0">
                  <button
                    className="lg:hidden text-muted hover:text-ink -ml-1 p-1"
                    onClick={() => setSelectedKey(null)}
                    aria-label="Back to queue"
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <Avatar
                    name={selected.author}
                    size={30}
                    badge={<ChannelBadge platform={selected.platform} size={14} />}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink truncate">
                        {selected.author || 'Unknown'}
                      </span>
                      <Chip tone={STATUS_TONE[selected.interactionStatus]}>
                        {STATUS_OPTIONS.find((s) => s.value === selected.interactionStatus)?.label}
                      </Chip>
                    </div>
                    <div className="text-[11px] text-muted flex items-center gap-1.5">
                      <span style={{ color: channelColor(selected.platform) }}>●</span>
                      {channelLabel(selected.platform)}
                      {selected.accountLabel && <span className="text-subtle">· {selected.accountLabel}</span>}
                      {selected.url && (
                        <a
                          href={selected.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand inline-flex items-center gap-1 hover:underline"
                        >
                          <ExternalLink size={11} /> View on {channelLabel(selected.platform)}
                        </a>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  <PillSelect
                    className="h-7"
                    value={selected.priority}
                    disabled={savingId === selected.id}
                    onChange={(e) => patch(selected, { priority: e.target.value })}
                  >
                    {PRIORITY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label} priority</option>
                    ))}
                  </PillSelect>
                  <PillSelect
                    className="h-7"
                    value={selected.interactionStatus}
                    disabled={savingId === selected.id}
                    onChange={(e) => patch(selected, { interactionStatus: e.target.value })}
                  >
                    {STATUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </PillSelect>
                  <PillSelect
                    className="h-7"
                    value={selected.assignedTo || ''}
                    disabled={savingId === selected.id}
                    onChange={(e) => patch(selected, { assignedTo: e.target.value })}
                    title={assigneeEmail(selected.assignedTo) || 'Unassigned'}
                  >
                    <option value="">Unassigned</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.email}</option>
                    ))}
                  </PillSelect>
                  <Button
                    size="sm"
                    icon={History}
                    disabled={!selected.contactId}
                    title={
                      selected.contactId
                        ? 'Every message and mention from this person, across every channel'
                        : 'Not yet linked to a contact'
                    }
                    onClick={() => setTimelineContactId(selected.contactId)}
                  >
                    Full history
                  </Button>
                </div>
              </div>

              {/* Thread */}
              <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
                {thread?.loading ? (
                  <div className="space-y-4 max-w-lg w-full">
                    <div className="skeleton h-14 rounded-ui" />
                    <div className="skeleton h-10 rounded-ui ml-auto max-w-sm" />
                    <div className="skeleton h-14 rounded-ui" />
                  </div>
                ) : threadEntries && threadEntries.length > 0 ? (
                  threadEntries.map((entry, i) => {
                    const day = new Date(entry.at).toLocaleDateString(undefined, {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric'
                    });
                    const prevDay =
                      i > 0
                        ? new Date(threadEntries[i - 1].at).toLocaleDateString(undefined, {
                            weekday: 'long',
                            day: 'numeric',
                            month: 'long',
                            year: 'numeric'
                          })
                        : null;
                    return (
                      <React.Fragment key={i}>
                        {day !== prevDay && <DayDivider label={day} />}
                        <ThreadBubble entry={{ ...entry, author: selected.author }} />
                      </React.Fragment>
                    );
                  })
                ) : (
                  <>
                    <DayDivider label={new Date(selected.date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} />
                    <ThreadBubble
                      entry={{
                        kind: selected.source,
                        direction: 'inbound',
                        platform: selected.platform,
                        text: selected.text,
                        at: selected.date,
                        author: selected.author
                      }}
                    />
                    {!selected.contactId && (
                      <p className="text-[11px] text-subtle text-center">
                        This interaction isn’t linked to a contact yet, so there’s no cross-channel
                        history to show.
                      </p>
                    )}
                  </>
                )}
              </div>

              {/* Composer dock */}
              {selected.source === 'message' ? (
                <div className="shrink-0 p-3 border-t border-hairline bg-card flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setComposerTab('reply')}
                        className={cx(
                          'px-2.5 py-1 rounded-ui text-xs font-medium transition-colors',
                          composerTab === 'reply'
                            ? 'bg-canvas text-ink border border-hairline'
                            : 'text-muted hover:text-ink hover:bg-canvas border border-transparent'
                        )}
                      >
                        Reply
                      </button>
                      <button
                        onClick={() => setComposerTab('note')}
                        className={cx(
                          'px-2.5 py-1 rounded-ui text-xs font-medium transition-colors',
                          composerTab === 'note'
                            ? 'bg-canvas text-ink border border-hairline'
                            : 'text-muted hover:text-ink hover:bg-canvas border border-transparent'
                        )}
                      >
                        Internal note
                      </button>
                    </div>

                    {composerTab === 'reply' && (
                      <div className="flex items-center gap-2">
                        {savedReplies.length > 0 && (
                          <PillSelect
                            value=""
                            onChange={(e) => {
                              const picked = savedReplies.find((r) => r.id === e.target.value);
                              if (picked) setReplyText(picked.body);
                            }}
                          >
                            <option value="">Insert a canned response…</option>
                            {savedReplies.map((r) => (
                              <option key={r.id} value={r.id}>{r.title}</option>
                            ))}
                          </PillSelect>
                        )}
                        <Button
                          size="sm"
                          icon={Sparkles}
                          loading={suggesting}
                          onClick={() => suggestReply(selected)}
                        >
                          {suggesting ? 'Thinking…' : 'AI suggest'}
                        </Button>
                      </div>
                    )}
                  </div>

                  {suggestError && (
                    <p className="text-[11px] text-danger">{suggestError}</p>
                  )}

                  {composerTab === 'note' ? (
                    <div className="px-3 py-4 rounded-ui bg-sunken border border-hairline text-[11px] text-muted text-center">
                      Internal notes aren’t stored yet — the backend has no notes table. Use a canned
                      response or reply directly for now.
                    </div>
                  ) : (
                    <>
                      <Textarea
                        rows={3}
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder={`Reply to ${selected.author || 'this contact'} on ${channelLabel(selected.platform)}…`}
                        className="border-0 focus:ring-0 bg-transparent px-1 resize-none"
                      />
                      <div className="flex items-center justify-between gap-3 pt-2 border-t border-hairline">
                        <div className="flex items-center gap-2 text-muted min-w-0">
                          <button className="hover:text-ink" title="Emoji" type="button"><Smile size={16} /></button>
                          <button className="hover:text-ink" title="Attach file" type="button"><Paperclip size={16} /></button>
                          {selected.platform === 'whatsapp' && (
                            <>
                              <span className="h-3 w-px bg-hairline" />
                              <span className="text-[11px] text-muted truncate">
                                Outside WhatsApp’s 24-hour window a reply needs an approved template.
                              </span>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            size="sm"
                            onClick={() => sendReply(selected, true)}
                            disabled={sendingReply || !replyText.trim()}
                          >
                            Send and close
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            icon={Send}
                            loading={sendingReply}
                            onClick={() => sendReply(selected)}
                            disabled={!replyText.trim()}
                          >
                            Send reply
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="shrink-0 p-3 border-t border-hairline bg-card flex items-center justify-between gap-3">
                  <span className="text-[11px] text-muted">
                    This is a public {selected.platform === 'google_business' ? 'review' : 'mention'} —
                    replies go through {channelLabel(selected.platform)} itself.
                  </span>
                  {selected.url && (
                    <Button
                      size="sm"
                      icon={ExternalLink}
                      onClick={() => window.open(selected.url, '_blank', 'noopener')}
                    >
                      Reply on {channelLabel(selected.platform)}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <ContactTimeline
        contactId={timelineContactId}
        authFetch={authFetch}
        onClose={() => setTimelineContactId(null)}
      />
      {managingReplies && (
        <SavedReplies
          savedReplies={savedReplies}
          onChange={setSavedReplies}
          authFetch={authFetch}
          canManage={atLeast(role, 'member')}
          onClose={() => setManagingReplies(false)}
        />
      )}
    </Page>
  );
}

export default Inbox;
