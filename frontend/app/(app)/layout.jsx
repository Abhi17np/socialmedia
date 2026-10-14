'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  PenSquare,
  LayoutGrid,
  CalendarDays,
  Inbox as InboxIcon,
  LineChart,
  MoreHorizontal,
  ChevronsUpDown,
  Moon,
  Sun,
  LogOut,
  WifiOff,
  X
} from 'lucide-react';
import SocialNav from '../../src/social/SocialNav';
import SalesNav, { ITEMS as SALES_NAV_ITEMS } from '../../src/sales/SalesNav';
import MarketingNav, { ITEMS as MARKETING_NAV_ITEMS } from '../../src/marketing/MarketingNav';
import TopBar from '../../src/shell/TopBar';
import { hubForPathname } from '../../src/shell/HubSwitcher';
import { AuthContext } from '../../src/AuthContext';
import { API_BASE } from '../../src/apiBase';
import { SOCIAL_API_BASE } from '../../src/social/api';
import { Button } from '../../src/ui';
import { atLeast } from '../../src/roleRank';

// Everything under app/(app)/ shares this one shell, one auth check,
// and — since the HubSpot-style redesign — one unified top bar
// (src/shell/TopBar.jsx). The route group parens mean /(app)/dashboard
// serves at /dashboard; the group exists only to give these routes a
// shared layout without it becoming part of the URL.
//
// The left sidebar below the top bar swaps based on which hub the
// current route belongs to (hubForPathname) — Social Hub's own nav,
// Sales Hub's own nav, or Marketing Hub's own nav — the HubSpot pattern
// of "each hub owns its sidebar, settings lives behind one global
// gear icon" (that gear, plus search/notifications/help, live in
// TopBar). The profile/account menu — email, tenant, theme, log out —
// stays anchored at the bottom of the sidebar instead, the same
// workspace-switcher-card spot it had before the redesign: it's
// identity/account chrome, not a hub-switching concern, and keeping it
// in the sidebar (rather than duplicating it into the top bar too)
// means there's exactly one place it lives.
//
// Auth/session is unchanged by any of this: one tenant JWT
// (authFetch/token below) already covers Social, Sales and Marketing
// Hub — there was never a separate login per hub to unify.

function useTheme() {
  const [theme, setTheme] = useState('light');

  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      try {
        localStorage.setItem('theme', next);
      } catch {
        /* private mode — the class still applies for this session */
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}

const SOCIAL_MOBILE_TABS = [
  { href: '/dashboard', icon: LayoutGrid, label: 'Home' },
  { href: '/compose', icon: PenSquare, label: 'Compose' },
  { href: '/inbox', icon: InboxIcon, label: 'Inbox' },
  { href: '/analytics', icon: LineChart, label: 'Analytics' },
  { href: '/posts', icon: CalendarDays, label: 'Posts' }
];

// Sales/Marketing Hub mobile bottom tabs are derived from each hub's own
// sidebar ITEMS (SalesNav.jsx/MarketingNav.jsx) rather than a second
// hardcoded list, so they can't drift. Only the first few fit the bottom
// row; anything past that (plus account actions) surfaces in the "More"
// sheet below instead of being unreachable on mobile.
const SALES_MOBILE_TAB_COUNT = 4;

export default function AppShellLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [token, setToken] = useState(null);
  const [checkedStorage, setCheckedStorage] = useState(false);
  const [me, setMe] = useState(null);
  const [openCount, setOpenCount] = useState(0);
  const [theme, toggleTheme] = useTheme();
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef(null);

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

  const authFetch = useCallback(
    async (url, options = {}) => {
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
        throw new Error(
          `Can't reach the Social Hub server at ${API_BASE} — make sure the backend is running.`
        );
      }
      setServerUnreachable(false);
      if (res.status === 401) handleLogout();
      return res;
    },
    [token, handleLogout]
  );

  useEffect(() => {
    if (checkedStorage && !token) router.replace('/login');
  }, [checkedStorage, token, router]);

  const loadMe = useCallback(() => {
    if (!token) return;
    authFetch(`${API_BASE}/auth/me`)
      .then((res) => res.json())
      .then((data) => {
        if (data.user) setMe(data);
      })
      .catch(() => {});
    // authFetch already sets serverUnreachable on a network failure —
    // this catch only needs to stop an unhandled rejection from
    // reaching the console, not report anything a second time.
  }, [token, authFetch]);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  // Drives the Inbox count in the rail. Re-read on navigation so closing
  // a conversation is reflected without a reload.
  useEffect(() => {
    if (!token) return;
    authFetch(`${SOCIAL_API_BASE}/interactions?status=open`)
      .then((res) => res.json())
      .then((data) => setOpenCount((data.interactions || []).length))
      .catch(() => {});
  }, [token, authFetch, pathname]);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const onClick = (e) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target)) setProfileMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [profileMenuOpen]);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const onClick = (e) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target)) setMoreMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [moreMenuOpen]);

  // Close the "More" sheet on navigation so it doesn't linger over the next page.
  useEffect(() => {
    setMoreMenuOpen(false);
  }, [pathname]);

  if (!checkedStorage || !token) return null; // redirecting to /login, or still reading localStorage

  const role = me?.user?.role || 'viewer';
  const email = me?.user?.email;
  const activeHub = hubForPathname(pathname);

  const salesActiveTab = searchParams.get('tab') || 'dashboard';
  const marketingActiveTab = searchParams.get('tab') || 'campaigns';
  const visibleSalesItems = SALES_NAV_ITEMS.filter((i) => atLeast(role, i.minRole));
  const visibleMarketingItems = MARKETING_NAV_ITEMS.filter((i) => atLeast(role, i.minRole));

  // Each hub drives its own bottom-tab row from its own sidebar ITEMS;
  // whatever doesn't fit the row goes in the "More" sheet (see nav below).
  const hubBottomTabs =
    activeHub === 'sales'
      ? visibleSalesItems.slice(0, SALES_MOBILE_TAB_COUNT).map((i) => ({
          href: `/sales?tab=${i.tab}`,
          icon: i.icon,
          label: i.label,
          active: pathname === '/sales' && salesActiveTab === i.tab
        }))
      : activeHub === 'marketing'
      ? visibleMarketingItems.map((i) => ({
          href: `/marketing?tab=${i.tab}`,
          icon: i.icon,
          label: i.label,
          active: pathname === '/marketing' && marketingActiveTab === i.tab
        }))
      : SOCIAL_MOBILE_TABS.map((t) => ({ ...t, active: pathname === t.href }));

  const moreSheetHubItems =
    activeHub === 'sales'
      ? visibleSalesItems.slice(SALES_MOBILE_TAB_COUNT).map((i) => ({
          href: `/sales?tab=${i.tab}`,
          icon: i.icon,
          label: i.label
        }))
      : [];

  return (
    <div className="h-full flex flex-col bg-canvas text-ink">
      <TopBar authFetch={authFetch} pathname={pathname} me={me} role={role} openCount={openCount} />

      <div className="flex-1 flex min-h-0">
        {/* ---------------------------------------------- Navigation rail */}
        <aside className="w-[248px] shrink-0 h-full bg-card border-r border-hairline flex-col justify-between z-20 hidden lg:flex">
          <div className="flex flex-col min-h-0">
            {activeHub === 'social' && (
              <div className="p-3 pb-1 shrink-0">
                <Link
                  href="/compose"
                  className="w-full h-8 px-3 rounded-ui bg-canvas hover:bg-sunken border border-hairline
                             text-ink font-medium text-xs flex items-center justify-between transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <PenSquare size={15} className="text-muted" />
                    New post
                  </span>
                  <kbd className="text-[10px] font-mono text-subtle">C</kbd>
                </Link>
              </div>
            )}

            <div className="overflow-y-auto min-h-0">
              {activeHub === 'sales' && <SalesNav role={role} />}
              {activeHub === 'marketing' && <MarketingNav role={role} />}
              {activeHub === 'social' && <SocialNav role={role} openCount={openCount} />}
            </div>
          </div>

          {/* Profile/account menu — shared across every hub's sidebar,
              not hub-specific, so it renders here rather than inside
              SocialNav/SalesNav/MarketingNav. */}
          <div className="p-3 border-t border-hairline shrink-0 relative" ref={profileMenuRef}>
            {profileMenuOpen && (
              <div
                className="absolute bottom-[calc(100%-4px)] left-3 right-3 bg-card border border-hairline rounded-surface
                           shadow-[var(--shadow-flyout)] p-1 z-30"
              >
                <button
                  onClick={toggleTheme}
                  className="w-full h-8 px-2 rounded-ui flex items-center gap-2 text-xs text-muted hover:text-ink hover:bg-canvas transition-colors"
                >
                  {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
                  {theme === 'dark' ? 'Light theme' : 'Dark theme'}
                </button>
                <button
                  onClick={handleLogout}
                  className="w-full h-8 px-2 rounded-ui flex items-center gap-2 text-xs text-muted hover:text-ink hover:bg-canvas transition-colors"
                >
                  <LogOut size={15} />
                  Log out
                </button>
              </div>
            )}

            <button
              onClick={() => setProfileMenuOpen((v) => !v)}
              className="w-full p-2 rounded-ui bg-canvas border border-hairline flex items-center justify-between gap-2 hover:bg-sunken transition-colors text-left"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className={`w-7 h-7 rounded font-semibold text-[11px] flex items-center justify-center shrink-0 ${
                    serverUnreachable ? 'bg-danger-subtle text-danger' : 'bg-brand/10 text-brand'
                  }`}
                >
                  {serverUnreachable ? <WifiOff size={14} /> : email ? email[0].toUpperCase() : '·'}
                </span>
                <span className="flex flex-col min-w-0 leading-tight">
                  <span className="font-medium text-xs text-ink truncate" title={email}>
                    {serverUnreachable ? 'Can’t reach server' : email || 'Loading…'}
                  </span>
                  {me?.tenant && (
                    <span className="text-[11px] text-muted truncate">
                      {me.tenant.name} · {role}{me.tenant.plan && ` · ${me.tenant.plan}`}
                    </span>
                  )}
                </span>
              </span>
              <ChevronsUpDown size={15} className="text-subtle shrink-0" />
            </button>
          </div>
        </aside>

        {/* ------------------------------------------------- Work surface */}
        <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden pb-14 lg:pb-0">
          {serverUnreachable && (
            <div className="shrink-0 px-4 py-2 bg-warning-subtle border-b border-hairline flex items-center gap-2.5 text-xs text-warning">
              <span className="flex-1 min-w-0">
                Can’t reach the Social Hub server at <code className="font-mono">{API_BASE}</code> — make
                sure the backend is running.
              </span>
              <Button size="sm" onClick={loadMe}>
                Retry
              </Button>
            </div>
          )}

          <AuthContext.Provider value={{ authFetch, role, me, serverUnreachable }}>
            {children}
          </AuthContext.Provider>
        </div>
      </div>

      {/* ------------------------------------------- Mobile tab bar */}
      {/* Hub-aware: swaps the same way the desktop sidebar does, driven
          by each hub's own ITEMS (SalesNav/MarketingNav/SOCIAL_MOBILE_TABS)
          instead of a single hardcoded Social-only list. Whatever doesn't
          fit the row (remaining Sales items, plus account actions for
          every hub) lives in the "More" sheet instead of being silently
          unreachable on mobile. */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 h-14 bg-card border-t border-hairline flex items-stretch z-30">
        {hubBottomTabs.map(({ href, icon: Icon, label, active }) => (
          <Link
            key={href}
            href={href}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
              active ? 'text-brand' : 'text-subtle'
            }`}
          >
            <Icon size={18} />
            {label}
          </Link>
        ))}
        <div className="flex-1 relative" ref={moreMenuRef}>
          {moreMenuOpen && (
            <div
              className="absolute bottom-[calc(100%+4px)] right-2 w-56 bg-card border border-hairline rounded-surface
                         shadow-[var(--shadow-flyout)] p-1 z-50"
            >
              {moreSheetHubItems.length > 0 && (
                <>
                  {moreSheetHubItems.map(({ href, icon: Icon, label }) => (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setMoreMenuOpen(false)}
                      className="w-full h-8 px-2 rounded-ui flex items-center gap-2 text-xs text-muted hover:text-ink hover:bg-canvas transition-colors"
                    >
                      <Icon size={15} />
                      {label}
                    </Link>
                  ))}
                  <div className="my-1 border-t border-hairline" />
                </>
              )}
              <button
                onClick={toggleTheme}
                className="w-full h-8 px-2 rounded-ui flex items-center gap-2 text-xs text-muted hover:text-ink hover:bg-canvas transition-colors"
              >
                {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
                {theme === 'dark' ? 'Light theme' : 'Dark theme'}
              </button>
              <button
                onClick={handleLogout}
                className="w-full h-8 px-2 rounded-ui flex items-center gap-2 text-xs text-muted hover:text-ink hover:bg-canvas transition-colors"
              >
                <LogOut size={15} />
                Log out
              </button>
            </div>
          )}
          <button
            onClick={() => setMoreMenuOpen((v) => !v)}
            className={`w-full h-full flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
              moreMenuOpen ? 'text-brand' : 'text-subtle'
            }`}
          >
            {moreMenuOpen ? <X size={18} /> : <MoreHorizontal size={18} />}
            More
          </button>
        </div>
      </nav>
    </div>
  );
}
