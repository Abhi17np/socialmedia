'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid,
  CalendarDays,
  Inbox as InboxIcon,
  LineChart,
  Share2,
  Users,
  SlidersHorizontal,
  UserCircle,
  Megaphone,
  KanbanSquare,
  Rocket
} from 'lucide-react';
import { atLeast } from '../roleRank';

// Sidebar for the Social module, grouped Overview / Settings the way the
// Calm Precision design lays it out. Every item declares the minimum role
// that can see it at all — this isn't decoration: every one of these maps
// to a backend route gated the same way (requireRole in
// middleware/tenant.js), so a viewer who typed the URL directly would
// still get a 403 from the API. The UI gate exists so a viewer isn't shown
// a link that always fails, not as the actual security boundary.
//
// Labels follow the design (Channels, Workspace, Posts & schedule) while
// the hrefs stay on the existing routes, so no link or bookmark breaks.
const GROUPS = [
  {
    label: 'Overview',
    items: [
      { href: '/dashboard', icon: LayoutGrid, label: 'Dashboard', minRole: 'viewer' },
      { href: '/posts', icon: CalendarDays, label: 'Posts & schedule', minRole: 'viewer' },
      { href: '/inbox', icon: InboxIcon, label: 'Inbox', minRole: 'viewer', badge: 'inbox' },
      { href: '/analytics', icon: LineChart, label: 'Analytics', minRole: 'viewer' },
      { href: '/whatsapp', icon: Megaphone, label: 'WhatsApp Broadcast', minRole: 'viewer' }
    ]
  },
  {
    // Sales/Marketing Hub items only render once hubsEnabled says so
    // (tenants.hubs_enabled, flipped only by a platform admin — see
    // middleware/hubs.js) — this is the UI reflection of the same
    // commercial gate the backend enforces on every route underneath.
    label: 'Growth',
    items: [
      { href: '/sales', icon: KanbanSquare, label: 'Sales Hub', minRole: 'viewer', requiresHub: 'sales' },
      { href: '/marketing', icon: Rocket, label: 'Marketing Hub', minRole: 'viewer', requiresHub: 'marketing' }
    ]
  },
  {
    label: 'Settings',
    items: [
      { href: '/connect-accounts', icon: Share2, label: 'Channels', minRole: 'admin' },
      { href: '/team', icon: Users, label: 'Team', minRole: 'admin' },
      { href: '/billing', icon: SlidersHorizontal, label: 'Workspace', minRole: 'owner' },
      { href: '/account', icon: UserCircle, label: 'Account', minRole: 'viewer' }
    ]
  }
];

function SocialNav({ role, openCount, hubsEnabled }) {
  const pathname = usePathname();

  return (
    <nav className="px-2 py-1 flex flex-col gap-0.5">
      {GROUPS.map((group) => {
        const items = group.items.filter((i) => atLeast(role, i.minRole) && (!i.requiresHub || (hubsEnabled && hubsEnabled[i.requiresHub])));
        if (items.length === 0) return null;
        return (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div className="eyebrow px-2 pt-3 pb-1">{group.label}</div>
            {items.map(({ href, icon: Icon, label, badge }) => {
              const active = pathname === href;
              const count = badge === 'inbox' ? openCount : undefined;
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={
                    active
                      ? 'h-8 px-2.5 rounded-ui flex items-center justify-between gap-2.5 bg-canvas text-brand font-medium border border-hairline'
                      : 'h-8 px-2.5 rounded-ui flex items-center justify-between gap-2.5 text-muted border border-transparent hover:text-ink hover:bg-canvas transition-colors'
                  }
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Icon size={17} className="shrink-0" />
                    <span className="truncate text-xs">{label}</span>
                  </span>
                  {count > 0 && (
                    <span
                      className={
                        active
                          ? 'text-[11px] tabular-nums font-semibold bg-card border border-hairline px-1.5 rounded-full text-brand'
                          : 'text-[11px] tabular-nums font-medium text-subtle'
                      }
                    >
                      {count}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

export default SocialNav;
