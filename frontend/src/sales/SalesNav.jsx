'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { LayoutDashboard, Inbox, KanbanSquare, Building2, Users, ListChecks, Workflow, Settings } from 'lucide-react';
import { atLeast } from '../roleRank';

// Sales Hub's own sidebar — these used to be a horizontal tab row
// inside SalesHub.jsx itself; promoted to real sidebar nav items (the
// HubSpot pattern: Contacts/Companies/Deals are sidebar items, not
// in-page tabs) driven by a ?tab= query param so each section stays
// linkable/bookmarkable. SalesHub.jsx reads the same param.
// Exported so the mobile bottom tab bar (app/(app)/layout.jsx) can
// show the same items — the ones that don't fit in the bottom row
// go in its "More" sheet, filtered by the same minRole and built from
// the same `/sales?tab=` hrefs, instead of a second hardcoded list
// that would drift from this one.
export const ITEMS = [
  { tab: 'dashboard', icon: LayoutDashboard, label: 'Dashboard', minRole: 'viewer' },
  { tab: 'workspace', icon: Inbox, label: 'Workspace', minRole: 'viewer' },
  { tab: 'pipeline', icon: KanbanSquare, label: 'Pipeline', minRole: 'viewer' },
  { tab: 'companies', icon: Building2, label: 'Companies', minRole: 'viewer' },
  { tab: 'contacts', icon: Users, label: 'Leads', minRole: 'viewer' },
  { tab: 'activities', icon: ListChecks, label: 'Activities', minRole: 'viewer' },
  { tab: 'sequences', icon: Workflow, label: 'Sequences', minRole: 'member' },
  { tab: 'settings', icon: Settings, label: 'Settings', minRole: 'admin' }
];

function SalesNav({ role }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab = searchParams.get('tab') || 'dashboard';

  return (
    <nav className="px-2 py-1 flex flex-col gap-0.5">
      <div className="eyebrow px-2 pt-3 pb-1">Sales Hub</div>
      {ITEMS.filter((i) => atLeast(role, i.minRole)).map(({ tab, icon: Icon, label }) => {
        const active = pathname === '/sales' && activeTab === tab;
        return (
          <Link
            key={tab}
            href={`/sales?tab=${tab}`}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'h-8 px-2.5 rounded-ui flex items-center gap-2.5 bg-canvas text-brand font-medium border border-hairline'
                : 'h-8 px-2.5 rounded-ui flex items-center gap-2.5 text-muted border border-transparent hover:text-ink hover:bg-canvas transition-colors'
            }
          >
            <Icon size={17} className="shrink-0" />
            <span className="truncate text-xs">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export default SalesNav;
