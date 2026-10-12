'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Mail, AlertTriangle, Check } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, Panel, PanelHeader, Input, Field, Banner, ConfirmDialog, Chip
} from '../ui';

// Minimal account-management page — change password, resend
// verification, delete my own account. Not the full "Settings area"
// grouping (Team/Workspace under a gear icon) the redesign direction
// describes; this is the functional piece the audit flagged as missing
// (no self-serve password change/account deletion anywhere), built as
// its own page rather than folded into Team or Workspace.
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
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      setConfirmDelete(false);
    }
  };

  const unverified = me?.user && !me.user.email_verified_at;

  return (
    <Page>
      <PageBar title="Account" count={me?.user?.email} />

      <PageBody width="narrow">
        <Panel>
          <PanelHeader title="Change password" meta="your own login, not the workspace" />
          <form onSubmit={changePassword} className="p-4 flex flex-col gap-4">
            {pwResult && (
              <Banner tone={pwResult.type === 'success' ? 'success' : 'danger'}>{pwResult.text}</Banner>
            )}
            <Field label="Current password">
              <Input
                type="password"
                icon={Lock}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              <Input
                type="password"
                icon={Lock}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={8}
                required
              />
            </Field>
            <div>
              <Button type="submit" variant="primary" loading={pwSaving}>
                Change password
              </Button>
            </div>
          </form>
        </Panel>

        {unverified && (
          <Panel>
            <PanelHeader
              title="Verify your email"
              action={<Chip tone="warning">Unverified</Chip>}
            />
            <div className="p-4 flex flex-col gap-3">
              <p className="text-xs text-muted">
                <span className="text-ink font-medium">{me.user.email}</span> isn’t verified yet.
              </p>
              {verifyResult && (
                <Banner tone={verifyResult.type === 'success' ? 'success' : 'danger'} icon={Check}>
                  {verifyResult.text}
                </Banner>
              )}
              <div>
                <Button icon={Mail} onClick={sendVerification} loading={verifySending}>
                  Send verification email
                </Button>
              </div>
            </div>
          </Panel>
        )}

        <Panel className="border-danger-border">
          <PanelHeader title="Danger zone" />
          <div className="p-4 flex flex-col gap-3">
            <p className="text-xs text-muted leading-relaxed">
              Deletes your own login only — not the whole workspace. Blocked if you’re the only owner.
            </p>
            {deleteError && <Banner tone="danger">{deleteError}</Banner>}
            <div>
              <Button variant="danger" icon={AlertTriangle} onClick={() => setConfirmDelete(true)}>
                Delete my account
              </Button>
            </div>
          </div>
        </Panel>
      </PageBody>

      <ConfirmDialog
        open={confirmDelete}
        pending={deleting}
        title="Delete your account?"
        body="Your login is removed from this workspace immediately and you'll be signed out. This can't be undone."
        confirmLabel="Delete my account"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={deleteAccount}
      />
    </Page>
  );
}

export default Account;
