'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Mail, AlertTriangle } from 'lucide-react';
import { API_BASE } from '../apiBase';

// Minimal account-management page — change password, resend
// verification, delete my own account. Not the full "Settings area"
// grouping (Team/Billing under a gear icon) the redesign direction
// describes; this is the functional piece the audit flagged as
// missing (no self-serve password change/account deletion anywhere),
// built as its own page rather than folded into Team or Billing.
function Account({ authFetch, me }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwResult, setPwResult] = useState(null);
  const [pwSaving, setPwSaving] = useState(false);

  const [verifyResult, setVerifyResult] = useState(null);
  const [verifySending, setVerifySending] = useState(false);

  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const changePassword = async (e) => {
    e.preventDefault();
    setPwSaving(true);
    setPwResult(null);
    try {
      const res = await authFetch(`${API_BASE}/auth/change-password`, {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not change password.');
      setPwResult({ type: 'success', text: 'Password changed.' });
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setPwResult({ type: 'error', text: err.message });
    } finally {
      setPwSaving(false);
    }
  };

  const sendVerification = async () => {
    setVerifySending(true);
    setVerifyResult(null);
    try {
      const res = await authFetch(`${API_BASE}/auth/send-verification-email`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send verification email.');
      setVerifyResult({ type: 'success', text: 'Verification email sent — check your inbox.' });
    } catch (err) {
      setVerifyResult({ type: 'error', text: err.message });
    } finally {
      setVerifySending(false);
    }
  };

  const deleteAccount = async () => {
    if (!confirm('Delete your account? This cannot be undone.')) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await authFetch(`${API_BASE}/auth/me`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not delete account.');
      localStorage.removeItem('token');
      router.push('/login');
    } catch (err) {
      setDeleteError(err.message);
      setDeleting(false);
    }
  };

  return (
    <div>
      <div className="header-container">
        <div className="title-area">
          <h1>Account</h1>
          <p>Your own login — password and account, separate from workspace-wide Team settings.</p>
        </div>
      </div>

      <div className="table-section" style={{ padding: '1.5rem', maxWidth: 480, marginBottom: '1.5rem' }}>
        <div className="panel-header" style={{ padding: 0, marginBottom: '1rem' }}><h2 style={{ fontSize: '1rem' }}>Change password</h2></div>
        {pwResult && <p style={{ color: pwResult.type === 'success' ? 'var(--accent-success)' : 'var(--accent-danger)', fontSize: '0.85rem', marginBottom: '1rem' }}>{pwResult.text}</p>}
        <form onSubmit={changePassword}>
          <div className="form-group">
            <label>Current password</label>
            <div className="form-control-wrap">
              <Lock size={16} className="form-control-icon" />
              <input type="password" className="form-control" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
            </div>
          </div>
          <div className="form-group">
            <label>New password</label>
            <div className="form-control-wrap">
              <Lock size={16} className="form-control-icon" />
              <input type="password" className="form-control" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required />
            </div>
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={pwSaving}>{pwSaving ? 'Saving…' : 'Change password'}</button>
        </form>
      </div>

      {me?.user && !me.user.email_verified_at && (
        <div className="table-section" style={{ padding: '1.5rem', maxWidth: 480, marginBottom: '1.5rem' }}>
          <div className="panel-header" style={{ padding: 0, marginBottom: '1rem' }}><h2 style={{ fontSize: '1rem' }}>Verify your email</h2></div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{me.user.email} is not verified yet.</p>
          {verifyResult && <p style={{ color: verifyResult.type === 'success' ? 'var(--accent-success)' : 'var(--accent-danger)', fontSize: '0.85rem', marginBottom: '1rem' }}>{verifyResult.text}</p>}
          <button className="btn btn-secondary btn-sm" onClick={sendVerification} disabled={verifySending}>
            <Mail size={14} /> {verifySending ? 'Sending…' : 'Send verification email'}
          </button>
        </div>
      )}

      <div className="table-section" style={{ padding: '1.5rem', maxWidth: 480, borderColor: 'var(--accent-danger)' }}>
        <div className="panel-header" style={{ padding: 0, marginBottom: '1rem' }}><h2 style={{ fontSize: '1rem', color: 'var(--accent-danger)' }}>Danger zone</h2></div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Deletes your own login only — not the whole workspace. Blocked if you're the only owner.
        </p>
        {deleteError && <p style={{ color: 'var(--accent-danger)', fontSize: '0.85rem', marginBottom: '1rem' }}>{deleteError}</p>}
        <button className="btn btn-secondary btn-sm" style={{ color: 'var(--accent-danger)', borderColor: 'var(--accent-danger)' }} onClick={deleteAccount} disabled={deleting}>
          <AlertTriangle size={14} /> {deleting ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
    </div>
  );
}

export default Account;
