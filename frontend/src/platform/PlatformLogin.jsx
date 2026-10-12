'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Button, Input, Field, Banner } from '../ui';

// Infopace's own internal ops login — visually and structurally separate
// from the tenant-facing app (different token key in localStorage,
// different backend gate: requirePlatformAdmin, not requireAuth — see
// backend/middleware/platform.js), reachable at /platform so a tenant
// user can never stumble into it and a platform admin's token is never
// confused for a tenant's.
//
// It deliberately stays on the slate chrome rather than the indigo app
// shell, so it never reads as the customer-facing product.
export default function PlatformLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/platform/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed.');
      localStorage.setItem('platform_token', data.token);
      router.push('/platform');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6 bg-[#0b0c14]">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center gap-2.5 mb-8">
          <span className="w-7 h-7 rounded bg-[#2f3042] text-white flex items-center justify-center">
            <Shield size={15} />
          </span>
          <div>
            <div className="text-sm font-semibold text-white tracking-tight">Platform admin</div>
            <div className="text-[11px] text-white/45">Infopace internal — not a customer login</div>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="bg-card border border-hairline rounded-card p-5 flex flex-col gap-4"
        >
          {error && <Banner tone="danger">{error}</Banner>}
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Button type="submit" variant="primary" size="lg" full loading={loading}>
            Log in
          </Button>
        </form>
      </div>
    </div>
  );
}
