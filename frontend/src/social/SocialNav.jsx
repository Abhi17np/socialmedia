'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid,
  CalendarDays,
  Inbox as InboxIcon,
  LineChart,
  Megaphone,
  FlaskConical,
  Swords,
  Siren
} from 'lucide-react';
import { atLeast } from '../roleRank';

// Sidebar for the Social module — just Social Hub's own sections now.
// Sales Hub / Marketing Hub links moved into the top bar's HubSwitcher
// (src/shell/HubSwitcher.jsx), and Channels/Team/Workspace/Account
// moved into the top bar's Settings gear (src/shell/TopBar.jsx) so
// they're reachable from any hub, not just this one — matching the
// HubSpot pattern where a hub's own sidebar holds only that hub's
// sections, and settings lives behind one global gear icon.
//
// Every item still declares the minimum role that can see it at all —
// this isn't decoration: every one of these maps to a backend route
// gated the same way (requireRole in middleware/tenant.js), so a
// viewer who typed the URL directly would still get a 403 from the
// API. The UI gate exists so a viewer isn't shown a link that always
// fails, not as the actual security boundary.
const ITEMS = [
  { href: '/dashboard', icon: LayoutGrid, label: 'Dashboard', minRole: 'viewer' },
  { href: '/posts', icon: CalendarDays, label: 'Posts & schedule', minRole: 'viewer' },
  { href: '/inbox', icon: InboxIcon, label: 'Inbox', minRole: 'viewer', badge: 'inbox' },
  { href: '/analytics', icon: LineChart, label: 'Analytics', minRole: 'viewer' },
  { href: '/experiments', icon: FlaskConical, label: 'Experiments', minRole: 'viewer' },
  { href: '/competitors', icon: Swords, label: 'Competitors', minRole: 'viewer' },
  { href: '/crisis-alerts', icon: Siren, label: 'Crisis Alerts', minRole: 'viewer' },
  { href: '/whatsapp', icon: Megaphone, label: 'WhatsApp Broadcast', minRole: 'viewer' }
];

function SocialNav({ role, openCount }) {
  const pathname = usePathname();
  const items = ITEMS.filter((i) => atLeast(role, i.minRole));

  return (
    <nav className="px-2 py-1 flex flex-col gap-0.5">
      <div className="eyebrow px-2 pt-3 pb-1">Social Hub</div>
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
    </nav>
  );
}

export default SocialNav;
