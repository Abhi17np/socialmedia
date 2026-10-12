'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Megaphone, Zap } from 'lucide-react';
import { atLeast } from '../roleRank';

// Marketing Hub's own sidebar — see SalesNav.jsx's header comment for
// why this is a sidebar now instead of an in-page tab row.
const ITEMS = [
  { tab: 'campaigns', icon: Megaphone, label: 'Campaigns', minRole: 'viewer' },
  { tab: 'automation', icon: Zap, label: 'Automation', minRole: 'viewer' }
];

function MarketingNav({ role }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab = searchParams.get('tab') || 'campaigns';

  return (
    <nav className="px-2 py-1 flex flex-col gap-0.5">
      <div className="eyebrow px-2 pt-3 pb-1">Marketing Hub</div>
      {ITEMS.filter((i) => atLeast(role, i.minRole)).map(({ tab, icon: Icon, label }) => {
        const active = pathname === '/marketing' && activeTab === tab;
        return (
          <Link
            key={tab}
            href={`/marketing?tab=${tab}`}
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

export default MarketingNav;
