'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Share2, Mail, AlertCircle, RefreshCw, Check } from 'lucide-react';
import { API_BASE } from '../apiBase';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not process that request.');
      setSent(true);
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
        </div>
        <div className="auth-brand-footer">&copy; {new Date().getFullYear()} Social Hub</div>
      </div>

      <div className="auth-form-panel">
        <div className="auth-form-inner">
          <div className="auth-header">
            <div className="auth-logo"><Share2 size={22} /></div>
            <h1 className="auth-title">Reset your password</h1>
            <p className="auth-subtitle">We'll email you a link to set a new one.</p>
          </div>

          <div className="auth-body">
            {error && (
              <div className="alert-auth">
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>{error}</span>
              </div>
            )}

            {sent ? (
              <div className="alert-auth" style={{ borderColor: 'var(--accent-success)', color: 'var(--accent-success)' }}>
                <Check size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>If that email has an account, a reset link is on its way.</span>
              </div>
            ) : (
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

                <button type="submit" className="btn btn-primary auth-btn" disabled={loading}>
                  {loading ? <RefreshCw size={18} style={{ animation: 'spin 1s linear infinite' }} /> : 'Send reset link'}
                </button>
              </form>
            )}

            <div className="auth-footer">
              <Link href="/login" className="auth-toggle-link">Back to log in</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
