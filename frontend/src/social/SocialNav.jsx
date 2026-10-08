'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, PenSquare, Layers, Inbox as InboxIcon, LineChart, Link2, Users, CreditCard } from 'lucide-react';

const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
const atLeast = (role, min) => (ROLE_RANK[role] ?? 0) >= ROLE_RANK[min];

// Sidebar sub-section for the Social module. Every item declares the
// minimum role that can see it at all — this isn't decoration: every one
// of these maps to a backend route gated the same way (requireRole in
// middleware/tenant.js), so a viewer who typed the URL directly would
// still get a 403 from the API. The UI gate exists so a viewer isn't
// shown a link that always fails, not as the actual security boundary.
function SocialNav({ role }) {
  const pathname = usePathname();
  const items = [
    { href: '/dashboard', icon: LayoutGrid, label: 'Dashboard', minRole: 'viewer' },
    { href: '/compose', icon: PenSquare, label: 'Compose', minRole: 'member' },
    { href: '/posts', icon: Layers, label: 'Posts', minRole: 'viewer' },
    { href: '/inbox', icon: InboxIcon, label: 'Inbox', minRole: 'viewer' },
    { href: '/analytics', icon: LineChart, label: 'Analytics', minRole: 'viewer' },
    { href: '/connect-accounts', icon: Link2, label: 'Connect Accounts', minRole: 'admin' },
    { href: '/team', icon: Users, label: 'Team', minRole: 'admin' },
    { href: '/billing', icon: CreditCard, label: 'Billing', minRole: 'owner' }
  ];

  return (
    <div className="menu-section">
      <div className="menu-title">Social</div>
      <ul className="menu-list">
        {items.filter(i => atLeast(role, i.minRole)).map(({ href, icon: Icon, label }) => (
          <li className="menu-item" key={href}>
            <Link href={href} className={`menu-link ${pathname === href ? 'active' : ''}`}>
              <Icon size={18} /> {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default SocialNav;
