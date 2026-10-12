'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, Inbox as InboxIcon, Clock } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { cx } from '../ui';

// Real counts, not placeholder badges: open Inbox conversations (the
// same count the Inbox nav item already shows) and, when Sales Hub is
// enabled, open sales activities whose due date has passed. Nothing
// here is a notification *feed* (no read/unread state, no history) —
// it's a live summary of "what's waiting", which is what these two
// numbers already mean elsewhere in the app.
function NotificationsMenu({ authFetch, openCount, hubsEnabled }) {
  const [open, setOpen] = useState(false);
  const [overdueActivities, setOverdueActivities] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (!open || !hubsEnabled?.sales) return;
    authFetch(`${API_BASE}/sales/activities?status=open`)
      .then((r) => r.json())
      .then((d) => {
        const now = Date.now();
        const overdue = (d.activities || []).filter((a) => a.due_at && new Date(a.due_at).getTime() < now);
        setOverdueActivities(overdue);
      })
      .catch(() => setOverdueActivities([]));
  }, [open, hubsEnabled, authFetch]);

  const total = openCount + (overdueActivities?.length || 0);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative w-8 h-8 rounded-ui border border-hairline bg-card text-muted hover:bg-sunken hover:text-ink flex items-center justify-center transition-colors"
        aria-label="Notifications"
      >
        <Bell size={16} />
        {total > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-danger text-white text-[10px] font-semibold flex items-center justify-center">
            {total > 9 ? '9+' : total}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-[calc(100%+6px)] right-0 w-80 bg-card border border-hairline rounded-surface shadow-[var(--shadow-flyout)] p-1.5 z-40">
          <div className="eyebrow px-2 pt-1 pb-1.5">Notifications</div>

          <Link href="/inbox" onClick={() => setOpen(false)} className="flex items-center gap-2.5 px-2 py-2 rounded-ui hover:bg-canvas transition-colors">
            <span className="w-8 h-8 rounded-ui bg-canvas border border-hairline flex items-center justify-center shrink-0 text-muted"><InboxIcon size={15} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-ink">Inbox</span>
              <span className="block text-[11px] text-muted">{openCount} open conversation{openCount === 1 ? '' : 's'}</span>
            </span>
          </Link>

          {hubsEnabled?.sales && (
            <Link href="/sales?tab=activities" onClick={() => setOpen(false)} className="flex items-center gap-2.5 px-2 py-2 rounded-ui hover:bg-canvas transition-colors">
              <span className={cx('w-8 h-8 rounded-ui border flex items-center justify-center shrink-0', (overdueActivities?.length || 0) > 0 ? 'bg-danger-subtle border-danger-border text-danger' : 'bg-canvas border-hairline text-muted')}>
                <Clock size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-ink">Sales activities</span>
                <span className="block text-[11px] text-muted">
                  {overdueActivities === null ? 'Loading…' : `${overdueActivities.length} overdue`}
                </span>
              </span>
            </Link>
          )}

          {total === 0 && overdueActivities !== null && (
            <div className="px-2 py-3 text-xs text-muted">You&apos;re all caught up.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationsMenu;
