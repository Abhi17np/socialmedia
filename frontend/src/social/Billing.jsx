'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { API_BASE } from '../apiBase';

function UsageBar({ label, used, limit }) {
  const unlimited = limit === null || limit === undefined || !Number.isFinite(limit);
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const nearLimit = !unlimited && pct >= 80;
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.35rem' }}>
        <span>{label}</span>
        <span style={{ color: nearLimit ? 'var(--accent-warning)' : 'var(--text-secondary)' }}>
          {used} {unlimited ? '' : `/ ${limit}`}
        </span>
      </div>
      {!unlimited && (
        <div style={{ height: 6, background: 'var(--bg-surface)', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: nearLimit ? 'var(--accent-warning)' : 'var(--accent-primary)', borderRadius: 999 }} />
        </div>
      )}
    </div>
  );
}

// Owner-only (see SocialNav's minRole) — what this tenant is actually
// using against their plan, and the upgrade path when they're close to a
// limit. Reads GET /billing/usage, which lib/entitlements.js's
// assertWithinLimit() is the enforcement side of — this page is purely
// visibility, same split as the rest of the app's admin/enforcement.
function Billing({ authFetch }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [upgrading, setUpgrading] = useState(null);

  const load = () => {
    authFetch(`${API_BASE}/billing/usage`)
      .then(res => res.json())
      .then(setData)
      .catch(err => setError(err.message));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const upgrade = async (plan) => {
    setUpgrading(plan);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/billing/checkout`, { method: 'POST', body: JSON.stringify({ plan }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not start checkout.');
      if (body.shortUrl) window.location.href = body.shortUrl;
    } catch (err) {
      setError(err.message);
    } finally {
      setUpgrading(null);
    }
  };

  return (
    <div>
      <div className="header-container">
        <div className="title-area">
          <h1>Billing & Usage</h1>
          <p>Your plan, and what you're using against it this month.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}><RefreshCw size={14} /> Refresh</button>
      </div>

      {error && <p style={{ color: 'var(--accent-danger)', marginBottom: '1rem' }}>{error}</p>}

      {!data ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading…</div>
      ) : (
        <div className="table-section" style={{ padding: '1.5rem', maxWidth: 480 }}>
          <div style={{ marginBottom: '1.5rem' }}>
            <span className="pill-select" style={{ textTransform: 'capitalize', background: 'rgba(91,95,239,0.1)', color: 'var(--accent-primary)', border: 'none' }}>
              {data.plan} plan
            </span>
          </div>

          <UsageBar label="Connected accounts" used={data.usage.socialAccounts.used} limit={data.usage.socialAccounts.limit} />
          <UsageBar label="Posts this month" used={data.usage.postsPerMonth.used} limit={data.usage.postsPerMonth.limit} />
          <UsageBar label="WhatsApp messages this month" used={data.usage.whatsappMessagesPerMonth.used} limit={data.usage.whatsappMessagesPerMonth.limit} />

          {data.plan !== 'pro' && data.plan !== 'enterprise' && (
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
              {data.plan === 'free' && (
                <button className="btn btn-primary btn-sm" disabled={upgrading} onClick={() => upgrade('starter')}>
                  {upgrading === 'starter' ? 'Redirecting…' : 'Upgrade to Starter'}
                </button>
              )}
              <button className="btn btn-primary btn-sm" disabled={upgrading} onClick={() => upgrade('pro')}>
                {upgrading === 'pro' ? 'Redirecting…' : 'Upgrade to Pro'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Billing;
