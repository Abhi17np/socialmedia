'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, RefreshCw } from 'lucide-react';
import { API_BASE } from '../apiBase';

// Infopace's own internal ops login — visually and structurally separate
// from the tenant-facing app (different token key in localStorage,
// different backend gate: requirePlatformAdmin, not requireAuth — see
// backend/middleware/platform.js), reachable at /platform so a tenant
// user can never stumble into it and a platform admin's token is never
// confused for a tenant's.
export default function PlatformLogin() {
  const router = useRouter();
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
      localStorage.setItem('platform_token', data.token);
      router.push('/platform');
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
