'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Share2, LogOut, WifiOff, Settings } from 'lucide-react';
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
  // Distinct from "no token" (redirect to /login) and from "a specific
  // request errored" (that page's own error state) — this means the
  // browser couldn't even reach API_BASE at all: backend not running,
  // wrong port, no network. Every page that calls authFetch gets a
  // friendly message for this for free (see the catch below) instead of
  // each one needing its own network-vs-HTTP-error branching.
  const [serverUnreachable, setServerUnreachable] = useState(false);

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
    let res;
    try {
      res = await fetch(url, { ...options, headers });
    } catch (err) {
      // fetch() throws a bare TypeError ("Failed to fetch" in
      // Chrome/Edge, "NetworkError..." in Firefox) when it can't even
      // open a connection — refused, wrong port, no backend running.
      // Translate it once, here, so every page's own `catch (err) {
      // setError(err.message) }` shows this instead of that raw string.
      setServerUnreachable(true);
      throw new Error(`Can't reach the Social Hub server at ${API_BASE} — make sure the backend is running.`);
    }
    setServerUnreachable(false);
    if (res.status === 401) handleLogout();
    return res;
  }, [token, handleLogout]);

  useEffect(() => {
    if (checkedStorage && !token) router.replace('/login');
  }, [checkedStorage, token, router]);

  const loadMe = useCallback(() => {
    if (!token) return;
    authFetch(`${API_BASE}/auth/me`).then(res => res.json()).then(data => { if (data.user) setMe(data); }).catch(() => {});
    // authFetch already sets serverUnreachable on a network failure —
    // this catch only needs to stop an unhandled rejection from
    // reaching the console, not report anything a second time.
  }, [token, authFetch]);

  useEffect(() => { loadMe(); }, [loadMe]);

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
            <div className="user-profile-avatar" style={serverUnreachable ? { background: 'var(--accent-danger)' } : undefined}>
              {serverUnreachable ? <WifiOff size={15} /> : (email ? email[0].toUpperCase() : '…')}
            </div>
            <div>
              <div className="user-profile-email" title={email}>
                {serverUnreachable ? 'Can’t reach server' : (email || 'Loading…')}
              </div>
              {me?.tenant && <div style={{ fontSize: '0.75rem', color: 'var(--sidebar-text-muted)' }}>{me.tenant.name} · {me.tenant.plan}</div>}
            </div>
          </div>
          <Link href="/account" className="btn btn-secondary btn-sm" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <Settings size={14} /> Account
          </Link>
          <button className="btn btn-secondary btn-sm" onClick={handleLogout} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <LogOut size={14} /> Log out
          </button>
        </div>
      </aside>
      <main className="main-content">
        {serverUnreachable && (
          <div className="connectivity-banner">
            <WifiOff size={16} />
            <span>Can&rsquo;t reach the Social Hub server at <code>{API_BASE}</code> — make sure the backend is running.</span>
            <button className="btn btn-secondary btn-sm" onClick={loadMe}>Retry</button>
          </div>
        )}
        <AuthContext.Provider value={{ authFetch, role, me, serverUnreachable }}>
          {children}
        </AuthContext.Provider>
      </main>
    </div>
  );
}
