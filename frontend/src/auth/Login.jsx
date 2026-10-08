import React, { useState } from 'react';
import { Share2, Mail, Lock, AlertCircle, RefreshCw } from 'lucide-react';
import { SOCIAL_API_BASE } from '../social/api';

const API_BASE = SOCIAL_API_BASE.replace(/\/social$/, '');

export default function Login({ onLoggedIn, onSwitchToSignup }) {
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
      onLoggedIn(data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo"><Share2 size={22} /></div>
          <h1 className="auth-title">Welcome back</h1>
          <p className="auth-subtitle">Log in to your Social Hub workspace</p>
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
              <span className="auth-toggle-link" onClick={onSwitchToSignup}>Create a workspace</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
