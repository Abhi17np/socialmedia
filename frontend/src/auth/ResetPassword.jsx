'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Share2, Lock, AlertCircle, RefreshCw, Check } from 'lucide-react';
import { API_BASE } from '../apiBase';

export default function ResetPassword() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not reset password.');
      setDone(true);
      setTimeout(() => router.push('/login'), 2000);
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
        </div>
        <div className="auth-brand-footer">&copy; {new Date().getFullYear()} Social Hub</div>
      </div>

      <div className="auth-form-panel">
        <div className="auth-form-inner">
          <div className="auth-header">
            <div className="auth-logo"><Share2 size={22} /></div>
            <h1 className="auth-title">Set a new password</h1>
          </div>

          <div className="auth-body">
            {!token && (
              <div className="alert-auth">
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>This reset link is missing its token — open the link from your email again.</span>
              </div>
            )}
            {error && (
              <div className="alert-auth">
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>{error}</span>
              </div>
            )}
            {done && (
              <div className="alert-auth" style={{ borderColor: 'var(--accent-success)', color: 'var(--accent-success)' }}>
                <Check size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>Password reset — redirecting to log in…</span>
              </div>
            )}

            {token && !done && (
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label className="form-label">New password</label>
                  <div className="form-control-wrap">
                    <Lock size={16} className="form-control-icon" />
                    <input
                      type="password"
                      className="form-control"
                      placeholder="At least 8 characters"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoFocus
                      required
                      minLength={8}
                    />
                  </div>
                </div>

                <button type="submit" className="btn btn-primary auth-btn" disabled={loading}>
                  {loading ? <RefreshCw size={18} style={{ animation: 'spin 1s linear infinite' }} /> : 'Reset password'}
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
