'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Mail, Check } from 'lucide-react';
import { API_BASE } from '../apiBase';
import AuthShell from './AuthShell';
import { Button, Input, Field, Banner } from '../ui';

const POINTS = [
  'One inbox for WhatsApp, Instagram, Facebook, LinkedIn, YouTube and Google Business.',
  'Every conversation tied to one real customer record, across every channel.',
  'Schedule once, publish everywhere, and see what it earned.'
];

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
    <AuthShell
      headline="Every channel, one inbox. One customer, one history."
      sub="The messaging and scheduling layer other tools treat as an afterthought — built here as the whole point."
      points={POINTS}
    >
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">Reset your password</h1>
      <p className="text-xs text-muted mt-1">We’ll email you a link to set a new one.</p>

      <div className="mt-7 flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}

        {sent ? (
          <Banner tone="success" icon={Check}>
            If that email has an account, a reset link is on its way.
          </Banner>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Field label="Email address">
              <Input
                type="email"
                icon={Mail}
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                required
              />
            </Field>
            <Button type="submit" variant="primary" size="lg" full loading={loading}>
              Send reset link
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
