'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { MessageSquare, AtSign, Star, History, Merge, MessageCircle } from 'lucide-react';
import { SOCIAL_API_BASE } from './api';
import { Drawer, Button, EmptyState, Avatar, Skeleton, cx } from '../ui';
import { ChannelDot, ChannelStamp, channelColor, channelLabel } from '../ui/channel';

/*
 * The selling feature, made visible: one scrollable history of every
 * message and mention from this one person, across every connected
 * platform — reading GET /social/contacts/:id/timeline, which resolves
 * contact_id the same way the WhatsApp webhook and the inbound pollers do
 * (see backend/lib/contacts.js). Without this panel, that unification
 * only existed in the database; nobody could actually see it.
 *
 * Promoted by the redesign from a text link inside a table row to a
 * first-class drawer: the channels this person has been seen on, a facts
 * strip, and the stream grouped by month with a channel filter — so the
 * cross-channel part reads at a glance rather than having to be inferred
 * from the platform label on each line.
 */

const monthOf = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

function Fact({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow truncate">{label}</div>
      <div className="text-xs text-ink mt-0.5 truncate">{value}</div>
    </div>
  );
}

function ContactTimeline({ contactId, authFetch, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [channel, setChannel] = useState('');

  useEffect(() => {
    if (!contactId) return;
    setData(null);
    setError(null);
    setChannel('');
    authFetch(`${SOCIAL_API_BASE}/contacts/${contactId}/timeline`)
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || 'Could not load this contact.');
        setData(body);
      })
      .catch((err) => setError(err.message));
  }, [contactId, authFetch]);

  const timeline = useMemo(() => data?.timeline || [], [data]);

  const channels = useMemo(() => {
    const seen = [];
    timeline.forEach((e) => {
      if (!seen.includes(e.platform)) seen.push(e.platform);
    });
    return seen;
  }, [timeline]);

  const counts = useMemo(() => {
    const out = {};
    timeline.forEach((e) => {
      out[e.platform] = (out[e.platform] || 0) + 1;
    });
    return out;
  }, [timeline]);

  const visible = channel ? timeline.filter((e) => e.platform === channel) : timeline;

  const contact = data?.contact;
  const name = contact?.display_name || 'Unnamed contact';
  const first = timeline.length ? timeline[0].at : null;
  const last = timeline.length ? timeline[timeline.length - 1].at : null;

  return (
    <Drawer
      open={!!contactId}
      onClose={onClose}
      width={480}
      header={
        <div className="flex items-start gap-3 min-w-0">
          <Avatar name={data ? name : ''} size={38} />
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink truncate">
              {data ? name : 'Loading…'}
            </h2>
            {contact && (contact.phone || contact.email) && (
              <p className="text-xs text-muted truncate mt-0.5">
                {[contact.phone, contact.email].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
        </div>
      }
      footer={
        <div className="flex items-center gap-2">
          <Button variant="primary" icon={MessageCircle} full onClick={onClose}>
            Open active conversation
          </Button>
          <Button icon={Merge} title="Not available yet — contact merging is a backend feature" disabled>
            Merge
          </Button>
        </div>
      }
    >
      {error && <p className="text-xs text-danger px-4 py-3">{error}</p>}

      {!data && !error && (
        <div className="p-4 space-y-3">
          <Skeleton className="h-20 rounded-card" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      )}

      {data && (
        <>
          {/* Channels this one person has been seen on */}
          <div className="px-4 py-3 border-b border-hairline flex items-center gap-2 flex-wrap">
            <span className="eyebrow mr-1">Connected channels ({channels.length})</span>
            {channels.map((p) => (
              <ChannelStamp key={p} platform={p} />
            ))}
            {channels.length === 0 && <span className="text-xs text-subtle">None yet</span>}
          </div>

          {/* Facts */}
          <div className="px-4 py-3 border-b border-hairline grid grid-cols-2 gap-x-4 gap-y-3">
            <Fact label="First seen" value={first ? new Date(first).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'} />
            <Fact label="Last seen" value={last ? new Date(last).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'} />
            <Fact
              label="Total interactions"
              value={`${timeline.length} across ${channels.length} channel${channels.length === 1 ? '' : 's'}`}
            />
            <Fact label="Contact id" value={<span className="font-mono text-[11px]">{contact.id?.slice(0, 8)}…</span>} />
          </div>

          {/* Stream */}
          <div className="px-4 py-3 flex items-center justify-between gap-2">
            <span className="eyebrow">History timeline</span>
            <span className="text-[11px] text-subtle tabular-nums">{timeline.length} events</span>
          </div>

          {channels.length > 1 && (
            <div className="px-4 pb-3 flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setChannel('')}
                className={cx(
                  'h-6 px-2.5 rounded-full border text-[11px] transition-colors',
                  channel === ''
                    ? 'bg-brand text-white border-transparent font-medium'
                    : 'bg-card border-hairline text-muted hover:text-ink'
                )}
              >
                All ({timeline.length})
              </button>
              {channels.map((p) => (
                <button
                  key={p}
                  onClick={() => setChannel(channel === p ? '' : p)}
                  className={cx(
                    'h-6 pl-1.5 pr-2.5 rounded-full border text-[11px] flex items-center gap-1.5 transition-colors',
                    channel === p
                      ? 'bg-canvas border-hairline text-ink font-medium'
                      : 'bg-card border-hairline text-muted hover:text-ink'
                  )}
                >
                  <ChannelDot platform={p} size={6} />
                  {channelLabel(p)} ({counts[p]})
                </button>
              ))}
            </div>
          )}

          {visible.length === 0 ? (
            <EmptyState
              icon={History}
              title="No history yet"
              description="Nothing has come in from this contact on any connected channel."
            />
          ) : (
            <div className="px-4 pb-4">
              {visible.map((entry, i) => {
                const month = monthOf(entry.at);
                const prevMonth = i > 0 ? monthOf(visible[i - 1].at) : null;
                const outbound = entry.direction === 'outbound';
                return (
                  <React.Fragment key={i}>
                    {month !== prevMonth && (
                      <div className="eyebrow pt-3 pb-2 sticky top-0 bg-card">{month}</div>
                    )}
                    <div className="flex gap-3 pb-3 relative">
                      {/* rail */}
                      <div className="flex flex-col items-center shrink-0">
                        <span
                          className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-white shrink-0 mt-1"
                          style={{ background: channelColor(entry.platform) }}
                          title={channelLabel(entry.platform)}
                        >
                          {entry.kind === 'mention' ? (
                            entry.platform === 'google_business' ? <Star size={10} /> : <AtSign size={10} />
                          ) : (
                            <MessageSquare size={10} />
                          )}
                        </span>
                        {i < visible.length - 1 && <span className="w-px flex-1 bg-hairline mt-1" />}
                      </div>

                      <div className="flex-1 min-w-0 bg-sunken border border-hairline rounded-ui px-3 py-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-xs font-medium text-ink truncate">
                            {channelLabel(entry.platform)}{' '}
                            <span className="text-subtle font-normal">
                              {entry.kind === 'mention' ? 'mention' : outbound ? 'reply' : 'message'}
                            </span>
                          </span>
                          <span className="text-[11px] text-subtle shrink-0 tabular-nums">
                            {new Date(entry.at).toLocaleString(undefined, {
                              day: 'numeric',
                              month: 'short',
                              hour: 'numeric',
                              minute: '2-digit'
                            })}
                          </span>
                        </div>
                        <p className="text-xs text-muted leading-relaxed mt-1">
                          {outbound && <strong className="text-ink font-medium">You: </strong>}
                          {entry.text}
                        </p>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

export default ContactTimeline;
