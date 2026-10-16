'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Calculator, Trash2, Sparkles } from 'lucide-react';
import { SOCIAL_API_BASE } from './api';
import { API_BASE } from '../apiBase';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, Field, Input, Select, Chip,
  Banner, EmptyState, Skeleton, ConfirmDialog
} from '../ui';
import { channelLabel } from '../ui/channel';
import { atLeast } from '../roleRank';

/*
 * Marketing Decision Simulator (migration 042) — projects the effect of
 * ONE real, owned lever: "what if I post N× as often on this connected
 * account?" Every number comes from this app's own historical data for
 * that account (backend/lib/decisionSimulator.js); nothing is a
 * fabricated baseline. Deliberately scoped to posting frequency, not a
 * general ad-budget allocator — this app tracks no ad spend at all.
 */

const CONFIDENCE_TONE = { normal: 'success', low: 'warning' };
const PCT = (rate) => (rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(2)}%`);
const NUM1 = (n) => (n === null || n === undefined ? '—' : n.toFixed(1));

function NewScenarioForm({ accounts, onCreated, authFetch }) {
  const [accountId, setAccountId] = useState('');
  const [multiplier, setMultiplier] = useState('1.5');
  const [lookbackWeeks, setLookbackWeeks] = useState('8');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const run = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/decision-simulator/scenarios`, {
        method: 'POST',
        body: JSON.stringify({ socialAccountId: accountId, frequencyMultiplier: Number(multiplier), lookbackWeeks: Number(lookbackWeeks) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not run this simulation.');
      onCreated(data.scenario);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel className="p-3.5">
      {error && <Banner tone="danger" className="mb-2">{error}</Banner>}
      <div className="grid grid-cols-3 gap-3">
        <Field label="Connected account">
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Select an account…</option>
            {(accounts || []).filter((a) => a.status === 'active').map((a) => (
              <option key={a.id} value={a.id}>{a.account_label || a.id} ({channelLabel(a.platform)})</option>
            ))}
          </Select>
        </Field>
        <Field label="Posting frequency ×" hint="e.g. 1.5 = post 50% more often">
          <Input type="number" min={0.1} max={20} step={0.1} value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
        </Field>
        <Field label="Lookback window (weeks)" hint="how much history to base this on">
          <Input type="number" min={2} max={26} value={lookbackWeeks} onChange={(e) => setLookbackWeeks(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="primary" icon={Calculator} loading={saving} onClick={run} disabled={!accountId || !multiplier}>
          Run simulation
        </Button>
      </div>
    </Panel>
  );
}

function ExplainPanel({ scenarioId, authFetch }) {
  const [explanation, setExplanation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const explain = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/ai/decision-simulator/scenarios/${scenarioId}/explain`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not explain this scenario.');
      setExplanation(data.explanation);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2.5 pt-2.5 border-t border-hairline">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted">Plain-English explanation</span>
        <Button size="sm" variant="ghost" icon={Sparkles} loading={loading} onClick={explain}>
          {explanation ? 'Re-explain' : 'Explain'}
        </Button>
      </div>
      {error && <p className="text-[11px] text-danger mt-1">{error}</p>}
      {explanation && <p className="text-[11px] text-subtle mt-1.5">{explanation}</p>}
    </div>
  );
}

function ScenarioCard({ scenario, canDelete, onDelete, authFetch }) {
  const { baseline, projection } = scenario;
  return (
    <Panel className="p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-ink">Posting frequency × {scenario.frequency_multiplier}</span>
            {projection.wasClamped && <Chip tone="warning">clamped to × {projection.appliedMultiplier}</Chip>}
            <Chip tone={CONFIDENCE_TONE[projection.confidence] || 'neutral'}>{projection.confidence} confidence</Chip>
          </div>
          <p className="text-[11px] text-subtle mt-0.5">
            Based on the last {scenario.lookback_weeks} weeks · {new Date(scenario.created_at).toLocaleString()}
          </p>
        </div>
        {canDelete && <IconButton icon={Trash2} label="Delete scenario" onClick={() => onDelete(scenario)} />}
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded-ui border border-hairline bg-sunken/40 p-2">
          <div className="font-semibold text-ink mb-1">Current (observed)</div>
          <div className="flex justify-between text-muted"><span>Posts/week</span><span className="tabular-nums text-ink">{NUM1(baseline.postsPerWeek)}</span></div>
          <div className="flex justify-between text-muted"><span>Engagement rate</span><span className="tabular-nums text-ink">{PCT(baseline.engagementRate)}</span></div>
          <div className="flex justify-between text-muted">
            <span>Follower growth/week</span>
            <span className="tabular-nums text-ink">{baseline.followerMetricAvailable ? NUM1(baseline.followerGrowthPerWeek.mean) : '—'}</span>
          </div>
        </div>
        <div className="rounded-ui border border-brand/30 bg-brand-subtle/20 p-2">
          <div className="font-semibold text-ink mb-1">Projected</div>
          <div className="flex justify-between text-muted"><span>Posts/week</span><span className="tabular-nums text-ink">{NUM1(projection.postsPerWeek)}</span></div>
          <div className="flex justify-between text-muted"><span>Engagement rate</span><span className="tabular-nums text-ink">{PCT(projection.engagementRate)} (unchanged)</span></div>
          <div className="flex justify-between text-muted">
            <span>Follower growth/week</span>
            <span className="tabular-nums text-ink">
              {baseline.followerMetricAvailable
                ? `${NUM1(projection.followerGrowthPerWeek.mean)} (${NUM1(projection.followerGrowthPerWeek.low)}–${NUM1(projection.followerGrowthPerWeek.high)})`
                : '—'}
            </span>
          </div>
        </div>
      </div>

      {!baseline.followerMetricAvailable && (
        <p className="text-[11px] text-subtle mt-2">No follower-count metric is collected for this platform — only posting frequency is projected.</p>
      )}
      <ul className="mt-2 text-[11px] text-subtle list-disc pl-4 space-y-0.5">
        {projection.assumptions.map((a, i) => <li key={i}>{a}</li>)}
      </ul>

      <ExplainPanel scenarioId={scenario.id} authFetch={authFetch} />
    </Panel>
  );
}

function DecisionSimulator({ authFetch, role }) {
  const canManage = atLeast(role, 'member');
  const canDelete = atLeast(role, 'admin');
  const [scenarios, setScenarios] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const [scenariosRes, accountsRes] = await Promise.all([
        authFetch(`${SOCIAL_API_BASE}/decision-simulator/scenarios`),
        authFetch(`${SOCIAL_API_BASE}/accounts`)
      ]);
      const scenariosData = await scenariosRes.json();
      if (!scenariosRes.ok) throw new Error(scenariosData.error || 'Could not load scenarios.');
      setScenarios(scenariosData.scenarios || []);

      const accountsData = await accountsRes.json();
      if (accountsRes.ok) setAccounts(accountsData.accounts || []);
      setError(null);
    } catch (err) {
      setError(err.message);
      setScenarios([]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (scenario) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/decision-simulator/scenarios/${scenario.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not delete this scenario.');
      setScenarios((prev) => prev.filter((s) => s.id !== scenario.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <Page>
      <PageBar
        title="Decision Simulator"
        count={scenarios === null ? undefined : `${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`}
        actions={<IconButton icon={RefreshCw} label="Refresh" onClick={load} className={refreshing ? 'animate-[spin_1s_linear_infinite]' : undefined} />}
      />

      <PageBody width="narrow">
        {error && <Banner tone="danger">{error}</Banner>}

        <Banner tone="info" className="mb-0">
          Projects posting frequency changes from your own historical data only — never a fabricated baseline. This model
          assumes engagement rate stays the same and growth scales proportionally with posting activity; both are stated
          simplifying assumptions, not proven effects for your account.
        </Banner>

        {canManage && <NewScenarioForm accounts={accounts} authFetch={authFetch} onCreated={(s) => setScenarios((prev) => [s, ...(prev || [])])} />}

        {scenarios === null ? (
          <Panel className="p-4 space-y-3">
            <Skeleton className="h-16" />
          </Panel>
        ) : scenarios.length === 0 ? (
          <Panel>
            <EmptyState
              icon={Calculator}
              title="No scenarios yet"
              description="Run a simulation above to project what changing your posting frequency would mean for growth and engagement, based on your own real history."
            />
          </Panel>
        ) : (
          <div className="flex flex-col gap-3">
            {scenarios.map((s) => (
              <ScenarioCard key={s.id} scenario={s} canDelete={canDelete} onDelete={setConfirmDelete} authFetch={authFetch} />
            ))}
          </div>
        )}
      </PageBody>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete this scenario?"
        body="This can't be undone."
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => remove(confirmDelete)}
      />
    </Page>
  );
}

export default DecisionSimulator;
