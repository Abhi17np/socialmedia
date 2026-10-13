'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Hexagon, Settings,
  Share2, Users, SlidersHorizontal, UserCircle, Lock
} from 'lucide-react';
import { atLeast } from '../roleRank';
import { PRICING_PLANS_ENABLED } from '../featureFlags';
import HubSwitcher, { hubForPathname } from './HubSwitcher';
import GlobalSearch from './GlobalSearch';
import NotificationsMenu from './NotificationsMenu';
import HelpMenu from './HelpMenu';

const SETTINGS_LINKS = [
  { href: '/connect-accounts', icon: Share2, label: 'Channels', minRole: 'admin' },
  { href: '/team', icon: Users, label: 'Team', minRole: 'admin' },
  { href: '/billing', icon: SlidersHorizontal, label: 'Workspace', minRole: 'owner' },
  { href: '/account', icon: UserCircle, label: 'Account', minRole: 'viewer' }
];

function SettingsMenu({ role }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const links = SETTINGS_LINKS.filter((l) => atLeast(role, l.minRole));

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 rounded-ui border border-hairline bg-card text-muted hover:bg-sunken hover:text-ink flex items-center justify-center transition-colors"
        aria-label="Settings"
      >
        <Settings size={16} />
      </button>
      {open && (
        <div className="absolute top-[calc(100%+6px)] right-0 w-52 bg-card border border-hairline rounded-surface shadow-[var(--shadow-flyout)] p-1.5 z-40">
          {links.map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="flex items-center gap-2.5 px-2 h-8 rounded-ui text-xs text-muted hover:text-ink hover:bg-canvas transition-colors">
              <l.icon size={15} />
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The unified HubSpot-style top bar — logo + hub switcher on the left,
 * global search in the middle, notifications/help/settings/pricing on
 * the right. Spans the full width, above the per-hub sidebar; every
 * page's own PageBar (its title/search/actions row) still renders
 * beneath this, unchanged. The profile menu itself lives in the
 * sidebar footer (app/(app)/layout.jsx), not here — see that file's
 * comment for why.
 */
function TopBar({ authFetch, pathname, me, role, openCount }) {
  const hubsEnabled = me?.tenant?.hubs_enabled;
  const activeHub = hubForPathname(pathname);

  return (
    <header className="h-14 shrink-0 bg-card border-b border-hairline px-3 flex items-center gap-3 z-30">
      <Link href="/dashboard" className="flex items-center gap-2 shrink-0 pr-1">
        <span className="w-6 h-6 rounded bg-brand text-white flex items-center justify-center shrink-0">
          <Hexagon size={14} />
        </span>
        <span className="font-semibold text-sm tracking-tight text-ink hidden md:inline">Infopace</span>
      </Link>

      <div className="w-px h-6 bg-hairline shrink-0 hidden md:block" />

      <HubSwitcher activeHub={activeHub} hubsEnabled={hubsEnabled} />

      <div className="flex-1 flex justify-center px-2 hidden md:flex">
        <GlobalSearch authFetch={authFetch} hubsEnabled={hubsEnabled} />
      </div>

      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
        <NotificationsMenu authFetch={authFetch} openCount={openCount} hubsEnabled={hubsEnabled} />
        <HelpMenu />
        <SettingsMenu role={role} />

        {/* Visible placeholder, not a mockup button that pretends to work:
            disabled and inert while PRICING_PLANS_ENABLED is false — see
            src/featureFlags.js. Distinct from the Workspace settings page
            (src/social/Billing.jsx), which already does real billing. */}
        <button
          type="button"
          disabled={!PRICING_PLANS_ENABLED}
          title="Pricing & Plans — coming soon"
          className="h-8 px-2.5 rounded-ui border border-hairline bg-card text-subtle text-xs font-medium flex items-center gap-1.5 opacity-60 cursor-not-allowed hidden lg:flex"
        >
          <Lock size={12} />
          Pricing
        </button>
      </div>
    </header>
  );
}

export default TopBar;
