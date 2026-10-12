'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Building2, Mail, Lock } from 'lucide-react';
import { API_BASE } from '../apiBase';
import AuthShell from './AuthShell';
import { Button, Input, Field, Banner, cx } from '../ui';

const POINTS = [
  'Free plan: two connected channels, no card required.',
  'Invite your team and assign conversations from day one.',
  'Upgrade only when you outgrow a limit.'
];

const STEPS = ['Create workspace', 'Connect a channel', 'Publish your first post'];

export default function Signup() {
  const router = useRouter();
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
      localStorage.setItem('token', data.token);
      router.push('/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Plain length check, matching the backend's own minimum — enough to
  // tell someone why the form will reject them before they submit.
  const strength = password.length === 0 ? null : password.length < 8 ? 'weak' : password.length < 12 ? 'ok' : 'strong';

  return (
    <AuthShell
      headline="Set up your workspace in under a minute."
      sub="Connect a channel, invite your team, and start working every conversation from one place."
      points={POINTS}
    >
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">Create your workspace</h1>
      <p className="text-xs text-muted mt-1">You’ll be its owner</p>

      <form onSubmit={handleSubmit} className="mt-7 flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}

        <Field label="Workspace name">
          <Input
            icon={Building2}
            placeholder="Acme Co."
            value={tenantName}
            onChange={(e) => setTenantName(e.target.value)}
            autoFocus
            required
          />
        </Field>

        <Field label="Email address">
          <Input
            type="email"
            icon={Mail}
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>

        <Field label="Password" hint="At least 8 characters.">
          <Input
            type="password"
            icon={Lock}
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          {strength && (
            <div className="flex items-center gap-1.5 mt-1.5">
              {['weak', 'ok', 'strong'].map((level, i) => (
                <span
                  key={level}
                  className={cx(
                    'h-0.5 flex-1 rounded-full transition-colors',
                    (strength === 'weak' && i === 0) ||
                      (strength === 'ok' && i <= 1) ||
                      strength === 'strong'
                      ? strength === 'weak'
                        ? 'bg-danger'
                        : strength === 'ok'
                        ? 'bg-warning'
                        : 'bg-success'
                      : 'bg-hairline'
                  )}
                />
              ))}
            </div>
          )}
        </Field>

        <Button type="submit" variant="primary" size="lg" full loading={loading}>
          Create workspace
        </Button>
      </form>

      <div className="mt-6 flex items-center gap-2">
        {STEPS.map((step, i) => (
          <div key={step} className="flex items-center gap-2 min-w-0">
            <span
              className={cx(
                'text-[10px] tabular-nums w-4 h-4 rounded-full flex items-center justify-center shrink-0',
                i === 0 ? 'bg-brand text-white font-medium' : 'bg-sunken text-subtle border border-hairline'
              )}
            >
              {i + 1}
            </span>
            <span className={cx('text-[10px] truncate', i === 0 ? 'text-ink font-medium' : 'text-subtle')}>
              {step}
            </span>
            {i < STEPS.length - 1 && <span className="w-3 h-px bg-hairline shrink-0" />}
          </div>
        ))}
      </div>

      <p className="text-xs text-muted mt-6">
        Already have an account?{' '}
        <Link href="/login" className="text-brand font-medium hover:underline">
          Log in
        </Link>
      </p>
    </AuthShell>
  );
}
