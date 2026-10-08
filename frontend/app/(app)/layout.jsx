'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Share2, LogOut } from 'lucide-react';
import SocialNav from '../../src/social/SocialNav';
import { AuthContext } from '../../src/AuthContext';
import { API_BASE } from '../../src/apiBase';

// Everything under app/(app)/ — Dashboard, Compose, Posts, Inbox,
// Analytics, Connect Accounts, Team, Billing — shares this one shell and
// one auth check, the direct replacement for the old single-page
// App.jsx's VIEWS-map switch. The route group parens mean /(app)/dashboard
// serves at /dashboard; the group exists only to give these routes a
// shared layout without it becoming part of the URL.
export default function AppShellLayout({ children }) {
  const router = useRouter();
  const [token, setToken] = useState(null);
  const [checkedStorage, setCheckedStorage] = useState(false);
  const [me, setMe] = useState(null);

  // Read localStorage only after mount — reading it during the render
  // Next.js uses to produce the initial HTML would desync from what the
  // browser renders on hydration (localStorage doesn't exist on the
  // server at all), so this intentionally renders "logged out" for one
  // frame before correcting itself.
  useEffect(() => {
    setToken(localStorage.getItem('token'));
    setCheckedStorage(true);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setMe(null);
    router.replace('/login');
  }, [router]);

  const authFetch = useCallback(async (url, options = {}) => {
    const headers = { ...options.headers, Authorization: `Bearer ${token}` };
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) handleLogout();
    return res;
  }, [token, handleLogout]);

  useEffect(() => {
    if (checkedStorage && !token) router.replace('/login');
  }, [checkedStorage, token, router]);

  useEffect(() => {
    if (!token) return;
    authFetch(`${API_BASE}/auth/me`).then(res => res.json()).then(data => { if (data.user) setMe(data); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!checkedStorage || !token) return null; // redirecting to /login, or still reading localStorage

  const role = me?.user?.role || 'viewer';
  const email = me?.user?.email;

  return (
    <div className="dashboard-container">
      <aside className="sidebar">
        <div className="logo-container">
          <div className="logo-icon"><Share2 size={18} /></div>
          <span className="logo-text">Social Hub</span>
        </div>

        <SocialNav role={role} />

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
        <AuthContext.Provider value={{ authFetch, role, me }}>
          {children}
        </AuthContext.Provider>
      </main>
    </div>
  );
}
