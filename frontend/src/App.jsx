import React, { useState, useCallback, useEffect } from 'react';
import { Share2, LogOut } from 'lucide-react';
import Login from './auth/Login';
import Signup from './auth/Signup';
import SocialNav from './social/SocialNav';
import Dashboard from './social/Dashboard';
import Composer from './social/Composer';
import Posts from './social/Posts';
import Inbox from './social/Inbox';
import Analytics from './social/Analytics';
import ConnectAccounts from './social/ConnectAccounts';
import { SOCIAL_API_BASE } from './social/api';

const API_BASE = SOCIAL_API_BASE.replace(/\/social$/, '');

// Keys must match SocialNav.jsx's own `view` identifiers exactly — it
// owns the canonical list (what shows in the sidebar, in what order);
// this just maps each one to the component that renders it.
const VIEWS = {
  'social-dashboard': Dashboard,
  'social-compose': Composer,
  'social-posts': Posts,
  'social-inbox': Inbox,
  'social-analytics': Analytics,
  'social-accounts': ConnectAccounts
};

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [authScreen, setAuthScreen] = useState('login'); // 'login' | 'signup'
  const [currentView, setCurrentView] = useState('social-dashboard');
  const [me, setMe] = useState(null);

  const handleLoggedIn = (newToken) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setMe(null);
  };

  // Every component below calls the API through this, never a bare
  // fetch — it attaches the Bearer token and logs out on a 401 instead
  // of each component having to handle an expired/invalid token itself.
  const authFetch = useCallback(async (url, options = {}) => {
    const headers = { ...options.headers, Authorization: `Bearer ${token}` };
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) handleLogout();
    return res;
  }, [token]);

  useEffect(() => {
    if (!token) return;
    authFetch(`${API_BASE}/auth/me`).then(res => res.json()).then(data => { if (data.user) setMe(data); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!token) {
    return authScreen === 'login'
      ? <Login onLoggedIn={handleLoggedIn} onSwitchToSignup={() => setAuthScreen('signup')} />
      : <Signup onLoggedIn={handleLoggedIn} onSwitchToLogin={() => setAuthScreen('login')} />;
  }

  const CurrentViewComponent = VIEWS[currentView] || Dashboard;
  const email = me?.user?.email;

  return (
    <div className="dashboard-container">
      <aside className="sidebar">
        <div className="logo-container">
          <div className="logo-icon">
            <Share2 size={18} />
          </div>
          <span className="logo-text">Social Hub</span>
        </div>

        <SocialNav currentView={currentView} setCurrentView={setCurrentView} />

        <div className="sidebar-user-profile">
          <div className="user-profile-details">
            <div className="user-profile-avatar">{email ? email[0].toUpperCase() : '…'}</div>
            <div>
              <div className="user-profile-email" title={email}>{email || 'Loading…'}</div>
              {me?.tenant && <div style={{ fontSize: '0.75rem', color: 'var(--sidebar-text-muted)' }}>{me.tenant.name} · {me.tenant.plan}</div>}
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={handleLogout} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <LogOut size={14} /> Log out
          </button>
        </div>
      </aside>
      <main className="main-content">
        <CurrentViewComponent authFetch={authFetch} setCurrentView={setCurrentView} />
      </main>
    </div>
  );
}
