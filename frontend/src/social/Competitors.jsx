'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, Swords, Plus, Trash2, Sparkles, ExternalLink } from 'lucide-react';
import { SOCIAL_API_BASE } from './api';
import { API_BASE } from '../apiBase';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, Field, Input, Select,
  Banner, Modal, EmptyState, Skeleton, ConfirmDialog
} from '../ui';
import { channelLabel } from '../ui/channel';
import { atLeast } from '../roleRank';

/*
 * Competitor Opportunity Radar (migration 040) — track a competitor's
 * PUBLIC Instagram or YouTube account (the only two platforms with an
 * official, non-scraping way to read one — see
 * backend/social/adapters/instagram.js's/youtube.js's own
 * fetchCompetitor() headers). A daily sweep fills in followers/media
 * count/posting frequency/engagement rate; this page shows that
 * alongside the tenant's own equivalent numbers (computed from data
 * already collected for the tenant's own account, not a second live
 * call) and offers an on-demand AI content-gap analysis, pull-based and
 * metered like every other AI Assist feature.
 */

const PCT = (rate) => (rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(2)}%`);
const NUM = (n) => (n === null || n === undefined ? '—' : n.toLocaleString());

function NewCompetitorModal({ open, onClose, onCreated, authFetch, accounts }) {
  const [platform, setPlatform] = useState('instagram');
  const [handle, setHandle] = useState('');
  const [label, setLabel] = useState('');
  const [viewerAccountId, setViewerAccountId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const eligibleAccounts = (accounts || []).filter((a) => a.platform === platform && a.status === 'active');

  const reset = () => {
    setPlatform('instagram'); setHandle(''); setLabel(''); setViewerAccountId(''); setError(null);
  };

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/competitors`, {
        method: 'POST',
        body: JSON.stringify({ platform, handle: handle.trim(), label: label.trim() || undefined, viewerAccountId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not track this competitor.');
      onCreated(data.competitor);
      reset();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Track a competitor"
      subtitle="Reads only public data, through one of your own connected accounts — no new permissions, nothing posted on your behalf."
      footer={
        <>
          <Button onClick={() => { reset(); onClose(); }} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={create} loading={saving} disabled={!handle.trim() || !viewerAccountId}>
            Track competitor
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Platform">
          <Select value={platform} onChange={(e) => { setPlatform(e.target.value); setViewerAccountId(''); }}>
            <option value="instagram">Instagram</option>
            <option value="youtube">YouTube</option>
          </Select>
        </Field>
        <Field label="Handle" hint={platform === 'instagram' ? 'Username, without the @' : 'Channel handle, e.g. @somechannel'}>
          <Input placeholder={platform === 'instagram' ? 'rivalbrand' : '@rivalbrand'} value={handle} onChange={(e) => setHandle(e.target.value)} />
        </Field>
        <Field label="Label (optional)">
          <Input placeholder="e.g. Main rival" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="View through which of your accounts?" hint="Spends that account's own API quota, once a day">
          <Select value={viewerAccountId} onChange={(e) => setViewerAccountId(e.target.value)}>
            <option value="">Select a connected account…</option>
            {eligibleAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.account_label || a.id}</option>
            ))}
          </Select>
        </Field>
        {eligibleAccounts.length === 0 && (
          <p className="text-[11px] text-muted">
            No connected, active {channelLabel(platform)} account yet — connect one first.
          </p>
        )}
      </div>
    </Modal>
  );
}

function GapAnalysisPanel({ competitorId, authFetch }) {
  const [gaps, setGaps] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const analyze = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/ai/compose/competitor-gaps`, {
        method: 'POST',
        body: JSON.stringify({ trackedCompetitorId: competitorId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not analyze content gaps.');
      setGaps(data.gaps || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2.5 pt-2.5 border-t border-hairline">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted">Content gap analysis</span>
        <Button size="sm" variant="ghost" icon={Sparkles} loading={loading} onClick={analyze}>
          {gaps ? 'Re-analyze' : 'Analyze'}
        </Button>
      </div>
      {error && <p className="text-[11px] text-danger mt-1">{error}</p>}
      {gaps && gaps.length === 0 && !error && (
        <p className="text-[11px] text-subtle mt-1">No clear gap found — your recent content already covers what they're posting about.</p>
      )}
      {gaps && gaps.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          {gaps.map((g, i) => (
            <div key={i} className="rounded-ui border border-hairline bg-sunken/40 p-2 text-[11px]">
              <div className="font-semibold text-ink">{g.theme}</div>
              {g.suggestion && <p className="text-muted mt-0.5">{g.suggestion}</p>}
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {g.evidence.map((ev, j) => (
                  ev.permalinkUrl ? (
                    <a key={j} href={ev.permalinkUrl} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-brand hover:underline" title={ev.caption}>
                      Evidence {j + 1} <ExternalLink size={10} />
                    </a>
                  ) : (
                    <span key={j} className="text-subtle" title={ev.caption}>Evidence {j + 1}</span>
                  )
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CompetitorCard({ competitor, detail, canDelete, onDelete, authFetch }) {
  const latest = detail?.competitorLatest;
  const own = detail?.own;

  return (
    <Panel className="p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-ink">{competitor.label || `@${competitor.handle}`}</span>
            <span className="text-[11px] text-subtle">{channelLabel(competitor.platform)} · @{competitor.handle}</span>
          </div>
        </div>
        {canDelete && (
          <IconButton icon={Trash2} label="Stop tracking" onClick={() => onDelete(competitor)} />
        )}
      </div>

      {!detail ? (
        <Skeleton className="h-9 mt-2.5" />
      ) : (
        <div className="mt-2.5 grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-ui border border-hairline bg-sunken/40 p-2">
            <div className="font-semibold text-ink mb-1">{competitor.label || `@${competitor.handle}`}</div>
            <div className="flex justify-between text-muted"><span>Followers</span><span className="tabular-nums text-ink">{NUM(latest?.followers)}</span></div>
            <div className="flex justify-between text-muted"><span>Posts (30d)</span><span className="tabular-nums text-ink">{NUM(latest?.postsInWindow)}</span></div>
            <div className="flex justify-between text-muted"><span>Engagement rate</span><span className="tabular-nums text-ink">{PCT(latest?.avgEngagementRate)}</span></div>
          </div>
          <div className="rounded-ui border border-hairline bg-sunken/40 p-2">
            <div className="font-semibold text-ink mb-1">You</div>
            <div className="flex justify-between text-muted"><span>Followers</span><span className="tabular-nums text-ink">{NUM(own?.followers)}</span></div>
            <div className="flex justify-between text-muted"><span>Posts compared</span><span className="tabular-nums text-ink">{NUM(own?.postsCompared)}</span></div>
            <div className="flex justify-between text-muted"><span>Engagement rate</span><span className="tabular-nums text-ink">{PCT(own?.avgEngagementRate)}</span></div>
          </div>
        </div>
      )}

      {!detail?.history?.length && detail && (
        <p className="text-[11px] text-subtle mt-2">
          No snapshot yet — the daily sweep hasn't run for this competitor since it was tracked.
        </p>
      )}

      <GapAnalysisPanel competitorId={competitor.id} authFetch={authFetch} />
    </Panel>
  );
}

function Competitors({ authFetch, role }) {
  const canManage = atLeast(role, 'member');
  const canDelete = atLeast(role, 'admin');
  const [competitors, setCompetitors] = useState(null);
  const [details, setDetails] = useState({}); // id -> detail response
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadDetail = async (id) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/competitors/${id}`);
      const data = await res.json();
      if (res.ok) setDetails((prev) => ({ ...prev, [id]: data }));
    } catch {
      // a failed detail fetch just leaves that card without numbers — the list itself still renders
    }
  };

  const load = async () => {
    setRefreshing(true);
    try {
      const [compRes, accountsRes] = await Promise.all([
        authFetch(`${SOCIAL_API_BASE}/competitors`),
        authFetch(`${SOCIAL_API_BASE}/accounts`)
      ]);
      const compData = await compRes.json();
      if (!compRes.ok) throw new Error(compData.error || 'Could not load tracked competitors.');
      setCompetitors(compData.competitors || []);
      (compData.competitors || []).forEach((c) => loadDetail(c.id));

      const accountsData = await accountsRes.json();
      if (accountsRes.ok) setAccounts(accountsData.accounts || []);
      setError(null);
    } catch (err) {
      setError(err.message);
      setCompetitors([]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (competitor) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/competitors/${competitor.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not stop tracking this competitor.');
      setCompetitors((prev) => prev.filter((c) => c.id !== competitor.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <Page>
      <PageBar
        title="Competitors"
        count={competitors === null ? undefined : `${competitors.length} tracked`}
        actions={
          <>
            <IconButton icon={RefreshCw} label="Refresh" onClick={load} className={refreshing ? 'animate-[spin_1s_linear_infinite]' : undefined} />
            {canManage && (
              <Button variant="primary" icon={Plus} onClick={() => setModalOpen(true)}>
                Track competitor
              </Button>
            )}
          </>
        }
      />

      <PageBody width="narrow">
        {error && <Banner tone="danger">{error}</Banner>}

        <Banner tone="info" className="mb-0">
          Only Instagram and YouTube are supported — the only two platforms with an official, non-scraping way to read a
          public account's data. Facebook, LinkedIn, and Google Business Profile each have a real platform-side reason they
          can't, documented in this app's Social Hub docs.
        </Banner>

        {competitors === null ? (
          <Panel className="p-4 space-y-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </Panel>
        ) : competitors.length === 0 ? (
          <Panel>
            <EmptyState
              icon={Swords}
              title="No competitors tracked yet"
              description="Track a public Instagram or YouTube account to compare followers, posting frequency, and engagement rate against your own — updated once a day."
              action={
                canManage && (
                  <Button variant="primary" onClick={() => setModalOpen(true)}>
                    Track competitor
                  </Button>
                )
              }
            />
          </Panel>
        ) : (
          <div className="flex flex-col gap-3">
            {competitors.map((c) => (
              <CompetitorCard
                key={c.id}
                competitor={c}
                detail={details[c.id]}
                canDelete={canDelete}
                onDelete={setConfirmDelete}
                authFetch={authFetch}
              />
            ))}
          </div>
        )}
      </PageBody>

      <NewCompetitorModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(competitor) => { setCompetitors((prev) => [competitor, ...(prev || [])]); loadDetail(competitor.id); }}
        authFetch={authFetch}
        accounts={accounts}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        title="Stop tracking this competitor?"
        body="Past snapshots are deleted along with it. This can't be undone."
        confirmLabel="Stop tracking"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => remove(confirmDelete)}
      />
    </Page>
  );
}

export default Competitors;
