import React, { useState, useCallback } from 'react';
import { Shield, LogOut, RefreshCw, Search } from 'lucide-react';

const API_BASE = (import.meta.env.VITE_API_BASE || 'http://localhost:5000/api/v1');

// Infopace's own internal ops console — visually and structurally
// separate from the tenant-facing app (different token, different
// backend gate: requirePlatformAdmin, not requireAuth — see
// backend/middleware/platform.js), reachable at /platform so a tenant
// user can never stumble into it and a platform admin's token is never
// confused for a tenant's. This is the "I'm giving my product to a
// client, I need to see what they're doing" view: every tenant, their
// plan, and their usage against it, in one list.
function PlatformLogin({ onLoggedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/platform/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed.');
      onLoggedIn(data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container" style={{ background: '#0b0c14' }}>
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo" style={{ background: '#16161f' }}><Shield size={22} /></div>
          <h1 className="auth-title">Platform Admin</h1>
          <p className="auth-subtitle">Infopace internal — not a customer login</p>
        </div>
        <div className="auth-body">
          {error && <div className="alert-auth"><span>{error}</span></div>}
          <form onSubmit={submit}>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-control" style={{ paddingLeft: '0.85rem' }} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input className="form-control" style={{ paddingLeft: '0.85rem' }} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <button type="submit" className="btn btn-primary auth-btn" disabled={loading}>
              {loading ? <RefreshCw size={18} style={{ animation: 'spin 1s linear infinite' }} /> : 'Log in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

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

function PlatformDashboard({ token, onLogout }) {
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

  React.useEffect(load, [load]);

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
          <button className="btn btn-secondary btn-sm" onClick={onLogout} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
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

export default function PlatformApp() {
  const [token, setToken] = useState(() => localStorage.getItem('platform_token'));

  const handleLoggedIn = (t) => { localStorage.setItem('platform_token', t); setToken(t); };
  const handleLogout = () => { localStorage.removeItem('platform_token'); setToken(null); };

  if (!token) return <PlatformLogin onLoggedIn={handleLoggedIn} />;
  return <PlatformDashboard token={token} onLogout={handleLogout} />;
}
