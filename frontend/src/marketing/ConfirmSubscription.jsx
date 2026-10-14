'use client';

import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Panel, Skeleton } from '../ui';

/**
 * The double opt-in landing page a lead-form confirmation email's link
 * points at (backend/routes/leadForms.js's GET /public/forms/confirm/:token).
 * No login — the token itself is the access control, same model as
 * PreferenceCenter.jsx's unsubscribe link.
 */
export default function ConfirmSubscription({ token }) {
  const [state, setState] = useState({ loading: true, error: null, alreadyConfirmed: false });

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/public/forms/confirm/${token}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'This confirmation link is invalid or has already been used.');
        return body;
      })
      .then((body) => { if (!cancelled) setState({ loading: false, error: null, alreadyConfirmed: !!body.alreadyConfirmed }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err.message, alreadyConfirmed: false }); });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-page">
      <div className="w-full max-w-md">
        <Panel className="p-6 flex flex-col items-center text-center gap-3">
          {state.loading ? (
            <Skeleton className="h-24 w-full" />
          ) : state.error ? (
            <>
              <X size={32} className="text-danger" />
              <p className="text-sm text-ink">{state.error}</p>
            </>
          ) : (
            <>
              <Check size={32} className="text-success" />
              <p className="text-sm text-ink">{state.alreadyConfirmed ? 'Your subscription was already confirmed.' : 'Your subscription is confirmed — thanks!'}</p>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
