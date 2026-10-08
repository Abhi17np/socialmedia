import React from 'react';
import { LayoutGrid, PenSquare, Layers, Inbox as InboxIcon, LineChart, Link2, Users, CreditCard } from 'lucide-react';

const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
const atLeast = (role, min) => (ROLE_RANK[role] ?? 0) >= ROLE_RANK[min];

// Sidebar sub-section for the Social module. Every item declares the
// minimum role that can see it at all — this isn't decoration: every one
// of these maps to a backend route gated the same way (requireRole in
// middleware/tenant.js), so a viewer who edited localStorage to force
// the UI open would still get a 403 from the API. The UI gate exists so
// a viewer isn't shown a button that always fails, not as the actual
// security boundary.
function SocialNav({ currentView, setCurrentView, role }) {
  const items = [
    { view: 'social-dashboard', icon: LayoutGrid, label: 'Dashboard', minRole: 'viewer' },
    { view: 'social-compose', icon: PenSquare, label: 'Compose', minRole: 'member' },
    { view: 'social-posts', icon: Layers, label: 'Posts', minRole: 'viewer' },
    { view: 'social-inbox', icon: InboxIcon, label: 'Inbox', minRole: 'viewer' },
    { view: 'social-analytics', icon: LineChart, label: 'Analytics', minRole: 'viewer' },
    { view: 'social-accounts', icon: Link2, label: 'Connect Accounts', minRole: 'admin' },
    { view: 'social-team', icon: Users, label: 'Team', minRole: 'admin' },
    { view: 'social-billing', icon: CreditCard, label: 'Billing', minRole: 'owner' }
  ];

  return (
    <div className="menu-section">
      <div className="menu-title">Social</div>
      <ul className="menu-list">
        {items.filter(i => atLeast(role, i.minRole)).map(({ view, icon: Icon, label }) => (
          <li className="menu-item" key={view}>
            <div
              className={`menu-link ${currentView === view ? 'active' : ''}`}
              onClick={() => setCurrentView(view)}
            >
              <Icon size={18} /> {label}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default SocialNav;
