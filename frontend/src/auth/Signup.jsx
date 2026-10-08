import React, { useState } from 'react';
import { Share2, Building2, Mail, Lock, AlertCircle, RefreshCw, Check } from 'lucide-react';
import { SOCIAL_API_BASE } from '../social/api';

const API_BASE = SOCIAL_API_BASE.replace(/\/social$/, '');

const FEATURES = [
  'Free plan: 2 connected accounts, no card required',
  'Invite your team and assign conversations',
  'Upgrade only when you outgrow a limit'
];

export default function Signup({ onLoggedIn, onSwitchToLogin }) {
  const [tenantName, setTenantName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantName, email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.issues?.[0]?.message || 'Signup failed.');
      onLoggedIn(data.token);
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
          <h2>Set up your workspace in under a minute.</h2>
          <p>Connect your first channel today; invite the rest of your team once you've seen it work.</p>
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
            <h1 className="auth-title">Create your workspace</h1>
            <p className="auth-subtitle">Connect WhatsApp, Instagram and Facebook in one inbox</p>
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
                <label className="form-label">Workspace name</label>
                <div className="form-control-wrap">
                  <Building2 size={16} className="form-control-icon" />
                  <input
                    type="text"
                    className="form-control"
                    placeholder="Acme Co."
                    value={tenantName}
                    onChange={(e) => setTenantName(e.target.value)}
                    autoFocus
                    required
                  />
                </div>
              </div>

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
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={8}
                    required
                  />
                </div>
              </div>

              <button type="submit" className="btn btn-primary auth-btn" disabled={loading}>
                {loading ? <RefreshCw size={18} style={{ animation: 'spin 1s linear infinite' }} /> : 'Create workspace'}
              </button>
            </form>

            <div className="auth-footer">
              <span>
                Already have an account?{' '}
                <span className="auth-toggle-link" onClick={onSwitchToLogin}>Log in</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
