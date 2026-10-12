'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, LogOut, RefreshCw, Search, Building2 } from 'lucide-react';
import { API_BASE } from '../apiBase';
import {
  Panel, Table, Th, Td, Input, Chip, Banner, EmptyState, Skeleton, cx
} from '../ui';

function UsageCell({ used, limit }) {
  const unlimited = limit === null || limit === undefined || !Number.isFinite(limit);
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const warn = !unlimited && pct >= 80;
  return (
    <span className={cx('tabular-nums', warn ? 'text-warning font-medium' : 'text-muted')}>
      {used}
      {unlimited ? '' : ` / ${limit}`}
    </span>
  );
}

const STATUS_TONE = { active: 'success', past_due: 'warning', canceled: 'danger' };

// The "I'm giving my product to a client, I need to see what they're
// doing" view: every tenant, their plan, and their usage against it, in
// one list. app/platform/page.jsx owns the auth check (redirects to
// /platform/login if there's no platform_token) before this ever mounts.
//
// Kept on slate chrome rather than the indigo app shell so it's obvious
// at a glance that this is not the customer-facing product.
export default function PlatformDashboard({ token }) {
  const router = useRouter();
  const [tenants, setTenants] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  const authFetch = useCallback(
    (url) => fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
    [token]
  );

  const load = useCallback(() => {
    authFetch(`${API_BASE}/platform/tenants`)
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error);
        setTenants(body.tenants);
      })
      .catch((err) => setError(err.message));
  }, [authFetch]);

  useEffect(load, [load]);

  const handleLogout = () => {
    localStorage.removeItem('platform_token');
    router.push('/platform/login');
  };

  const filtered = (tenants || []).filter((t) => t.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="h-full flex flex-col bg-canvas">
      <header className="h-14 shrink-0 bg-[#0b0c14] px-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-6 h-6 rounded bg-[#2f3042] text-white flex items-center justify-center shrink-0">
            <Shield size={14} />
          </span>
          <span className="text-sm font-semibold text-white tracking-tight">Social Hub · Internal</span>
          <span className="text-[11px] text-white/40 hidden sm:block">All tenants</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="w-8 h-8 rounded-ui border border-white/10 text-white/60 hover:text-white hover:bg-white/5 flex items-center justify-center transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={handleLogout}
            className="h-8 px-3 rounded-ui border border-white/10 text-white/70 hover:text-white hover:bg-white/5 text-xs font-medium flex items-center gap-1.5 transition-colors"
          >
            <LogOut size={14} /> Log out
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-5 max-w-[1280px] flex flex-col gap-5">
          {error && <Banner tone="danger">{error}</Banner>}

          <Panel className="overflow-hidden">
            <div className="h-11 px-4 flex items-center justify-between gap-3 border-b border-hairline">
              <div className="w-full max-w-[280px]">
                <Input
                  icon={Search}
                  placeholder="Search tenants…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <span className="text-[11px] text-subtle tabular-nums shrink-0">
                {tenants === null ? 'Loading…' : `${filtered.length} tenant${filtered.length === 1 ? '' : 's'}`}
              </span>
            </div>

            {tenants === null ? (
              <div className="p-4 space-y-3">
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={Building2}
                title={query ? 'No tenants match' : 'No tenants yet'}
                description={query ? 'Try a different search.' : 'Workspaces appear here as soon as someone signs up.'}
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Workspace</Th>
                      <Th>Plan</Th>
                      <Th>Status</Th>
                      <Th align="right">Seats</Th>
                      <Th align="right">Channels</Th>
                      <Th align="right">Posts (mo.)</Th>
                      <Th align="right">WhatsApp (mo.)</Th>
                      <Th align="right">AI drafts (mo.)</Th>
                      <Th align="right">Created</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((t) => (
                      <tr key={t.id} className="hover:bg-canvas transition-colors last:[&>td]:border-0">
                        <Td>
                          <span className="font-medium">{t.name}</span>
                        </Td>
                        <Td>
                          <span className="capitalize text-muted">{t.plan}</span>
                        </Td>
                        <Td>
                          <Chip tone={STATUS_TONE[t.subscription_status] || 'neutral'}>
                            {t.subscription_status}
                          </Chip>
                        </Td>
                        <Td align="right">{t.userCount}</Td>
                        <Td align="right">
                          <UsageCell used={t.accountCount} limit={t.accountLimit} />
                        </Td>
                        <Td align="right">
                          <UsageCell used={t.postsThisMonth} limit={t.postsLimit} />
                        </Td>
                        <Td align="right">
                          <UsageCell used={t.whatsappMessagesThisMonth} limit={t.whatsappLimit} />
                        </Td>
                        <Td align="right">
                          <UsageCell used={t.aiGenerationsThisMonth} limit={t.aiGenerationsLimit} />
                        </Td>
                        <Td align="right">
                          <span className="text-muted">
                            {new Date(t.created_at).toLocaleDateString(undefined, {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric'
                            })}
                          </span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
