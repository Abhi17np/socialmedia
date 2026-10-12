'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Lock, Check } from 'lucide-react';
import { API_BASE } from '../apiBase';
import AuthShell from './AuthShell';
import { Button, Input, Field, Banner } from '../ui';

const POINTS = [
  'One inbox for WhatsApp, Instagram, Facebook, LinkedIn, YouTube and Google Business.',
  'Every conversation tied to one real customer record, across every channel.',
  'Schedule once, publish everywhere, and see what it earned.'
];

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
    <AuthShell
      headline="Every channel, one inbox. One customer, one history."
      sub="The messaging and scheduling layer other tools treat as an afterthought — built here as the whole point."
      points={POINTS}
    >
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">Set a new password</h1>
      <p className="text-xs text-muted mt-1">Then you’ll be sent back to log in.</p>

      <div className="mt-7 flex flex-col gap-4">
        {!token && (
          <Banner tone="warning">
            This link is missing its token — open the reset link from your email again.
          </Banner>
        )}
        {error && <Banner tone="danger">{error}</Banner>}

        {done ? (
          <Banner tone="success" icon={Check}>
            Password changed — taking you to the log in page.
          </Banner>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Field label="New password" hint="At least 8 characters.">
              <Input
                type="password"
                icon={Lock}
                placeholder="••••••••"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={8}
                autoFocus
                required
              />
            </Field>
            <Button type="submit" variant="primary" size="lg" full loading={loading} disabled={!token}>
              Set new password
            </Button>
          </form>
        )}
      </div>

      <p className="text-xs mt-6">
        <Link href="/login" className="text-brand font-medium hover:underline">
          Back to log in
        </Link>
      </p>
    </AuthShell>
  );
}
