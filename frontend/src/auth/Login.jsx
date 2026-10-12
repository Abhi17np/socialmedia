'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Mail, Lock } from 'lucide-react';
import { API_BASE } from '../apiBase';
import AuthShell from './AuthShell';
import { Button, Input, Field, Banner } from '../ui';

const POINTS = [
  'One inbox for WhatsApp, Instagram, Facebook, LinkedIn, YouTube and Google Business.',
  'Every conversation tied to one real customer record, across every channel.',
  'Schedule once, publish everywhere, and see what it earned.'
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
    <AuthShell
      headline="Every channel, one inbox. One customer, one history."
      sub="The messaging and scheduling layer other tools treat as an afterthought — built here as the whole point."
      points={POINTS}
    >
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">Welcome back</h1>
      <p className="text-xs text-muted mt-1">Log in to your workspace</p>

      <form onSubmit={handleSubmit} className="mt-7 flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}

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

        <Field label="Password">
          <Input
            type="password"
            icon={Lock}
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>

        <Button type="submit" variant="primary" size="lg" full loading={loading}>
          Log in
        </Button>
      </form>

      <p className="text-xs text-muted mt-6">
        No account yet?{' '}
        <Link href="/signup" className="text-brand font-medium hover:underline">
          Create a workspace
        </Link>
      </p>
    </AuthShell>
  );
}
