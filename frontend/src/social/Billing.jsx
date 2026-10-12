'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Check, AlertTriangle } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, PanelHeader, Chip, Banner, Skeleton, cx
} from '../ui';

// Owner-only (see SocialNav's minRole) — what this tenant is actually
// using against their plan, and the upgrade path when they're close to a
// limit. Reads GET /billing/usage, which lib/entitlements.js's
// assertWithinLimit() is the enforcement side of — this page is purely
// visibility, same split as the rest of the app's admin/enforcement.

const PLANS = [
  {
    key: 'free',
    name: 'Free',
    price: '₹0',
    cadence: 'forever',
    features: ['1 connected channel', '30 posts a month', 'Unified inbox', 'Single user']
  },
  {
    key: 'starter',
    name: 'Starter',
    price: '₹1,499',
    cadence: 'per month',
    features: ['5 connected channels', '300 posts a month', 'WhatsApp messaging', 'Up to 3 teammates']
  },
  {
    key: 'pro',
    name: 'Pro',
    price: '₹4,999',
    cadence: 'per month',
    recommended: true,
    features: ['Unlimited channels', 'Unlimited posts', 'AI assist drafting', 'Unlimited teammates']
  }
];

function UsageMeter({ label, used, limit }) {
  const unlimited = limit === null || limit === undefined || !Number.isFinite(limit);
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const atLimit = !unlimited && pct >= 100;
  const near = !unlimited && pct >= 80;
  return (
    <div className="px-4 py-3 border-b border-hairline last:border-0">
      <div className="flex items-center justify-between text-xs mb-2">
        <span className="text-ink">{label}</span>
        <span
          className={cx(
            'tabular-nums',
            atLimit ? 'text-danger font-medium' : near ? 'text-warning font-medium' : 'text-muted'
          )}
        >
          {used}
          {unlimited ? '' : ` / ${limit}`}
          {unlimited && <span className="text-subtle"> · unlimited</span>}
        </span>
      </div>
      {!unlimited && (
        <div className="h-1 rounded-full bg-sunken overflow-hidden">
          <div
            className={cx(
              'h-full rounded-full transition-all',
              atLimit ? 'bg-danger' : near ? 'bg-warning' : 'bg-brand'
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Billing({ authFetch }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [upgrading, setUpgrading] = useState(null);

  const load = () => {
    authFetch(`${API_BASE}/billing/usage`)
      .then((res) => res.json())
      .then(setData)
      .catch((err) => setError(err.message));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const upgrade = async (plan) => {
    setUpgrading(plan);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/billing/checkout`, {
        method: 'POST',
        body: JSON.stringify({ plan })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not start checkout.');
      if (body.shortUrl) window.location.href = body.shortUrl;
    } catch (err) {
      setError(err.message);
    } finally {
      setUpgrading(null);
    }
  };

  const usage = data?.usage;
  const nearAnyLimit =
    usage &&
    Object.values(usage).some(
      (u) => Number.isFinite(u.limit) && u.limit > 0 && u.used / u.limit >= 0.8
    );

  return (
    <Page>
      <PageBar
        title="Workspace"
        count={data ? `${data.plan} plan` : undefined}
        actions={<IconButton icon={RefreshCw} label="Refresh" onClick={load} />}
      />

      <PageBody width="narrow">
        {error && <Banner tone="danger">{error}</Banner>}

        {nearAnyLimit && (
          <Banner tone="warning" icon={AlertTriangle}>
            You’re close to a plan limit — publishing or messaging will start to be blocked once you
            reach it.
          </Banner>
        )}

        {!data ? (
          <Panel className="p-4 space-y-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </Panel>
        ) : (
          <>
            <Panel>
              <PanelHeader
                title="Usage this month"
                action={<Chip tone="brand" className="capitalize">{data.plan} plan</Chip>}
              />
              <UsageMeter
                label="Connected channels"
                used={usage.socialAccounts.used}
                limit={usage.socialAccounts.limit}
              />
              <UsageMeter label="Posts" used={usage.postsPerMonth.used} limit={usage.postsPerMonth.limit} />
              <UsageMeter
                label="WhatsApp messages"
                used={usage.whatsappMessagesPerMonth.used}
                limit={usage.whatsappMessagesPerMonth.limit}
              />
              <UsageMeter
                label="AI assist drafts"
                used={usage.aiGenerationsPerMonth.used}
                limit={usage.aiGenerationsPerMonth.limit}
              />
            </Panel>

            {data.plan !== 'enterprise' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-stretch">
                {PLANS.map((plan) => {
                  const current = plan.key === data.plan;
                  const canUpgrade =
                    !current && plan.key !== 'free' && data.plan !== 'pro' && data.plan !== 'enterprise';
                  return (
                    <Panel
                      key={plan.key}
                      className={cx('flex flex-col', current && 'border-brand/40')}
                    >
                      <div className="p-4 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-xs font-semibold text-ink">{plan.name}</h3>
                          {current ? (
                            <Chip tone="brand">Current</Chip>
                          ) : plan.recommended ? (
                            <Chip tone="neutral">Recommended</Chip>
                          ) : null}
                        </div>
                        <div className="mt-2 flex items-baseline gap-1.5">
                          <span className="text-[22px] font-semibold tracking-tight text-ink tabular-nums">
                            {plan.price}
                          </span>
                          <span className="text-[11px] text-subtle">{plan.cadence}</span>
                        </div>
                        <ul className="mt-3 flex flex-col gap-1.5">
                          {plan.features.map((f) => (
                            <li key={f} className="flex items-start gap-1.5 text-[11px] text-muted">
                              <Check size={12} className="text-success shrink-0 mt-0.5" />
                              {f}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="p-3 border-t border-hairline">
                        <Button
                          full
                          size="sm"
                          variant={plan.recommended && canUpgrade ? 'primary' : 'secondary'}
                          disabled={!canUpgrade}
                          loading={upgrading === plan.key}
                          onClick={() => upgrade(plan.key)}
                        >
                          {current ? 'Current plan' : canUpgrade ? `Upgrade to ${plan.name}` : 'Not available'}
                        </Button>
                      </div>
                    </Panel>
                  );
                })}
              </div>
            )}

            <p className="text-[11px] text-subtle">
              Payments are handled by Razorpay. Plan limits are enforced server-side — this page only
              shows what’s already being counted.
            </p>
          </>
        )}
      </PageBody>
    </Page>
  );
}

export default Billing;
