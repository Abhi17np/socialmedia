import React from 'react';
import { LayoutGrid, PenSquare, Layers, Inbox as InboxIcon, LineChart, Link2 } from 'lucide-react';

// Sidebar sub-section for the Social module — same menu-section/menu-list/
// menu-link markup as every other sidebar section in App.jsx (see
// "Main Dashboard" just above this in the sidebar), so it reads as one
// more section of the same shell, not a bolted-on second nav. Phase 3
// added Inbox — one unified view over mentions + inbox_messages (see
// social/Inbox.jsx). Phase 4 adds Analytics — the "Brand Health"
// followers/reach/engagement summary (see social/Analytics.jsx). Phase 5
// adds Dashboard — the rolled-up KPI landing page (see social/Dashboard.jsx).
// "Calendar" was renamed "Posts" (social/Posts.jsx) — matches Zoho/HubSpot's
// own naming, with Scheduled/Published as in-page sub-tabs.
function SocialNav({ currentView, setCurrentView }) {
  const items = [
    { view: 'social-dashboard', icon: LayoutGrid, label: 'Dashboard' },
    { view: 'social-compose', icon: PenSquare, label: 'Compose' },
    { view: 'social-posts', icon: Layers, label: 'Posts' },
    { view: 'social-inbox', icon: InboxIcon, label: 'Inbox' },
    { view: 'social-analytics', icon: LineChart, label: 'Analytics' },
    { view: 'social-accounts', icon: Link2, label: 'Connect Accounts' }
  ];

  return (
    <div className="menu-section">
      <div className="menu-title">Social</div>
      <ul className="menu-list">
        {items.map(({ view, icon: Icon, label }) => (
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
