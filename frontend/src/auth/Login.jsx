'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Share2, Mail, Lock, AlertCircle, RefreshCw, Check } from 'lucide-react';
import { API_BASE } from '../apiBase';

const FEATURES = [
  'One inbox for WhatsApp, Instagram and Facebook',
  'Every conversation tied to a real customer record',
  'Schedule once, publish to every connected channel'
];

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed.');
      localStorage.setItem('token', data.token);
      router.push('/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-split">
      <div className="auth-brand-panel">
        <div className="auth-brand-mark">
          <span className="auth-brand-mark-icon"><Share2 size={16} /></span>
          Social Hub
        </div>

        <div className="auth-brand-copy">
          <h2>Every channel, one inbox. One customer, one history.</h2>
          <p>The messaging and scheduling layer other tools treat as an afterthought — built as the whole point.</p>
          <div className="auth-brand-feature-list">
            {FEATURES.map(f => (
              <div className="auth-brand-feature" key={f}>
                <span className="auth-brand-feature-icon"><Check size={12} /></span>
                {f}
              </div>
            ))}
          </div>
        </div>

        <div className="auth-brand-footer">&copy; {new Date().getFullYear()} Social Hub</div>
      </div>

      <div className="auth-form-panel">
        <div className="auth-form-inner">
          <div className="auth-header">
            <div className="auth-logo"><Share2 size={22} /></div>
            <h1 className="auth-title">Welcome back</h1>
            <p className="auth-subtitle">Log in to your workspace</p>
          </div>

          <div className="auth-body">
            {error && (
              <div className="alert-auth">
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label">Email address</label>
                <div className="form-control-wrap">
                  <Mail size={16} className="form-control-icon" />
                  <input
                    type="email"
                    className="form-control"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Password</label>
                <div className="form-control-wrap">
                  <Lock size={16} className="form-control-icon" />
                  <input
                    type="password"
                    className="form-control"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
              </div>

              <button type="submit" className="btn btn-primary auth-btn" disabled={loading}>
                {loading ? <RefreshCw size={18} style={{ animation: 'spin 1s linear infinite' }} /> : 'Log in'}
              </button>
            </form>

            <div className="auth-footer">
              <span>
                No account yet?{' '}
                <Link href="/signup" className="auth-toggle-link">Create a workspace</Link>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
