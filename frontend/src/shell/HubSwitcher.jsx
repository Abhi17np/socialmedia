'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Check, LayoutGrid, KanbanSquare, Rocket } from 'lucide-react';
import { cx } from '../ui';

// The three hubs this switcher knows about. Social Hub is always
// listed — it's the base product every tenant has. Sales/Marketing
// only appear once tenants.hubs_enabled says so (same gate
// middleware/hubs.js enforces server-side), exactly the invisible-
// until-enabled rule the commercial gate already established —
// promoted here from the sidebar into a HubSpot-style switcher, not
// loosened. Platform Admin is deliberately not one of these entries:
// it's a different login, different audience (Infopace staff, every
// tenant), different trust boundary — mixing it into a tenant-facing
// switcher would blur that boundary for no real benefit.
const HUBS = [
  { key: 'social', label: 'Social Hub', description: 'Scheduling, inbox, WhatsApp, analytics', icon: LayoutGrid, href: '/dashboard' },
  { key: 'sales', label: 'Sales Hub', description: 'Companies, leads, deal pipeline', icon: KanbanSquare, href: '/sales', requiresHub: 'sales' },
  { key: 'marketing', label: 'Marketing Hub', description: 'Campaigns and automation', icon: Rocket, href: '/marketing', requiresHub: 'marketing' }
];

export function hubForPathname(pathname) {
  if (pathname.startsWith('/sales')) return 'sales';
  if (pathname.startsWith('/marketing')) return 'marketing';
  return 'social';
}

function HubSwitcher({ activeHub, hubsEnabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const available = HUBS.filter((h) => !h.requiresHub || (hubsEnabled && hubsEnabled[h.requiresHub]));
  const current = HUBS.find((h) => h.key === activeHub) || HUBS[0];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="h-8 pl-2 pr-2.5 rounded-ui flex items-center gap-1.5 text-ink hover:bg-canvas border border-transparent hover:border-hairline transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <current.icon size={16} className="text-brand shrink-0" />
        <span className="text-xs font-semibold truncate max-w-[140px]">{current.label}</span>
        <ChevronDown size={14} className="text-subtle shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-[calc(100%+6px)] left-0 w-72 bg-card border border-hairline rounded-surface shadow-[var(--shadow-flyout)] p-1.5 z-40"
        >
          <div className="eyebrow px-2 pt-1 pb-1.5">Switch hub</div>
          {available.map((hub) => {
            const active = hub.key === activeHub;
            return (
              <Link
                key={hub.key}
                href={hub.href}
                onClick={() => setOpen(false)}
                className={cx(
                  'flex items-center gap-2.5 px-2 py-2 rounded-ui transition-colors',
                  active ? 'bg-brand-subtle' : 'hover:bg-canvas'
                )}
              >
                <span className={cx('w-8 h-8 rounded-ui flex items-center justify-center shrink-0', active ? 'bg-brand text-white' : 'bg-canvas border border-hairline text-muted')}>
                  <hub.icon size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-ink">{hub.label}</span>
                  <span className="block text-[11px] text-muted truncate">{hub.description}</span>
                </span>
                {active && <Check size={15} className="text-brand shrink-0" />}
              </Link>
            );
          })}
          {available.length < HUBS.length && (
            <div className="px-2 pt-1.5 pb-0.5 text-[11px] text-subtle">
              More hubs become available once your workspace is upgraded by Infopace.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default HubSwitcher;
