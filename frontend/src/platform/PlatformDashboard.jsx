'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, LogOut, RefreshCw, Search } from 'lucide-react';
import { API_BASE } from '../apiBase';

function UsageCell({ used, limit }) {
  const unlimited = limit === null || limit === undefined || !Number.isFinite(limit);
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const warn = !unlimited && pct >= 80;
  return (
    <span style={{ color: warn ? 'var(--accent-warning)' : 'var(--text-secondary)', fontWeight: warn ? 600 : 400 }}>
      {used}{unlimited ? '' : ` / ${limit}`}
    </span>
  );
}

const STATUS_COLOR = { active: 'var(--accent-success)', past_due: 'var(--accent-warning)', canceled: 'var(--accent-danger)' };

// The "I'm giving my product to a client, I need to see what they're
// doing" view: every tenant, their plan, and their usage against it, in
// one list. app/platform/page.jsx owns the auth check (redirects to
// /platform/login if there's no platform_token) before this ever mounts.
export default function PlatformDashboard({ token }) {
  const router = useRouter();
  const [tenants, setTenants] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  const authFetch = useCallback((url) => fetch(url, { headers: { Authorization: `Bearer ${token}` } }), [token]);

  const load = useCallback(() => {
    authFetch(`${API_BASE}/platform/tenants`)
      .then(res => res.json().then(body => ({ ok: res.ok, body })))
      .then(({ ok, body }) => { if (!ok) throw new Error(body.error); setTenants(body.tenants); })
      .catch(err => setError(err.message));
  }, [authFetch]);

  useEffect(load, [load]);

  const handleLogout = () => {
    localStorage.removeItem('platform_token');
    router.push('/platform/login');
  };

  const filtered = (tenants || []).filter(t => t.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="dashboard-container">
      <aside className="sidebar" style={{ background: '#0b0c14' }}>
        <div className="logo-container">
          <div className="logo-icon" style={{ background: '#2f3042' }}><Shield size={18} /></div>
          {/* theme.css's .logo-text override assumes the tenant app's now-light
              sidebar (dark text) — this console keeps the old dark sidebar on
              purpose (a visual signal this isn't the customer-facing app), so
              it needs its own white text here rather than inheriting that rule. */}
          <span className="logo-text" style={{ color: '#ffffff' }}>Platform Admin</span>
        </div>
        <div className="menu-section">
          <div className="menu-title">Infopace Internal</div>
          <ul className="menu-list">
            <li className="menu-item"><div className="menu-link active">All Tenants</div></li>
          </ul>
        </div>
        <div className="sidebar-user-profile">
          <button className="btn btn-secondary btn-sm" onClick={handleLogout} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
            <LogOut size={14} /> Log out
          </button>
        </div>
      </aside>

      <main className="main-content">
        <div className="header-container">
          <div className="title-area">
            <h1>All Tenants</h1>
            <p>Every customer workspace running on Social Hub — plan, seats, and usage against their limit.</p>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={load}><RefreshCw size={14} /> Refresh</button>
        </div>

        {error && <p style={{ color: 'var(--accent-danger)', marginBottom: '1rem' }}>{error}</p>}

        <div className="table-section">
          <div className="table-header">
            <div className="form-control-wrap" style={{ maxWidth: 280 }}>
              <Search size={16} className="form-control-icon" />
              <input className="form-control" placeholder="Search tenants…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              {tenants === null ? 'Loading…' : `${filtered.length} tenant${filtered.length === 1 ? '' : 's'}`}
            </div>
          </div>

          {tenants === null ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>No tenants yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ padding: '0.75rem 1rem' }}>Workspace</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Plan</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Status</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Seats</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Accounts</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Posts (mo.)</th>
                  <th style={{ padding: '0.75rem 1rem' }}>WhatsApp (mo.)</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Created</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => (
                  <tr key={t.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>{t.name}</td>
                    <td style={{ padding: '0.75rem 1rem', textTransform: 'capitalize' }}>{t.plan}</td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <span style={{ color: STATUS_COLOR[t.subscription_status] || 'var(--text-secondary)', fontWeight: 600, fontSize: '0.8rem' }}>
                        {t.subscription_status}
                      </span>
                    </td>
                    <td style={{ padding: '0.75rem 1rem' }}>{t.userCount}</td>
                    <td style={{ padding: '0.75rem 1rem' }}><UsageCell used={t.accountCount} limit={t.accountLimit} /></td>
                    <td style={{ padding: '0.75rem 1rem' }}><UsageCell used={t.postsThisMonth} limit={t.postsLimit} /></td>
                    <td style={{ padding: '0.75rem 1rem' }}><UsageCell used={t.whatsappMessagesThisMonth} limit={t.whatsappLimit} /></td>
                    <td style={{ padding: '0.75rem 1rem', color: 'var(--text-secondary)' }}>{new Date(t.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
