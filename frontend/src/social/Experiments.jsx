'use client';

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, FlaskConical, Plus, Ban } from 'lucide-react';
import { SOCIAL_API_BASE } from './api';
import { API_BASE } from '../apiBase';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, Chip, Input, Select, Field,
  Banner, Modal, EmptyState, Skeleton, ConfirmDialog
} from '../ui';
import { channelLabel } from '../ui/channel';
import { atLeast } from '../roleRank';

/*
 * AI Content Experiment Engine — every experiment groups two posts the
 * tenant already created (through the normal Composer flow) as its
 * variants; this page never drafts or schedules a post itself. Decisions
 * are made server-side by a real two-proportion z-test
 * (backend/lib/experimentStats.js) on a timer — this page just displays
 * whatever's been decided, plus a live preview for one still running.
 */

const VARIABLES = [
  { value: 'hook', label: 'Hook (opening line)' },
  { value: 'caption', label: 'Caption' },
  { value: 'cta', label: 'Call to action' },
  { value: 'format', label: 'Format' }
];

const STATUS_TONE = {
  running: 'neutral',
  decided: 'success',
  not_significant: 'warning',
  insufficient_data: 'warning',
  cancelled: 'danger'
};

const STATUS_LABEL = {
  running: 'Running',
  decided: 'Decided',
  not_significant: 'Not significant',
  insufficient_data: 'Insufficient data',
  cancelled: 'Cancelled'
};

function NewExperimentModal({ open, onClose, onCreated, authFetch, posts }) {
  const [name, setName] = useState('');
  const [variable, setVariable] = useState('hook');
  const [confidenceLevel, setConfidenceLevel] = useState('0.95');
  const [minSampleSize, setMinSampleSize] = useState('100');
  const [minObservationHours, setMinObservationHours] = useState('24');
  const [variantAId, setVariantAId] = useState('');
  const [variantBId, setVariantBId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Only posts that can genuinely be compared — exactly one target
  // account each, so "same audience" is unambiguous (see
  // backend/routes/experiments.js's own validation, which is the real
  // enforcement; this is just steering the picker toward valid choices).
  const eligible = useMemo(() => (posts || []).filter((p) => (p.target_account_ids || []).length === 1), [posts]);

  const reset = () => {
    setName(''); setVariable('hook'); setConfidenceLevel('0.95'); setMinSampleSize('100'); setMinObservationHours('24');
    setVariantAId(''); setVariantBId(''); setError(null);
  };

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/experiments`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          variable,
          confidenceLevel: Number(confidenceLevel),
          minSampleSize: Number(minSampleSize),
          minObservationHours: Number(minObservationHours),
          variants: [{ key: 'A', scheduledPostId: variantAId }, { key: 'B', scheduledPostId: variantBId }]
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create this experiment.');
      onCreated(data.experiment);
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
      title="New content experiment"
      subtitle="Compare two already-scheduled posts on the same connected account — a real two-proportion significance test decides a winner once both have had time to run."
      footer={
        <>
          <Button onClick={() => { reset(); onClose(); }} disabled={saving}>Cancel</Button>
          <Button
            variant="primary"
            onClick={create}
            loading={saving}
            disabled={!name.trim() || !variantAId || !variantBId || variantAId === variantBId}
          >
            Create experiment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Name">
          <Input autoFocus placeholder="e.g. Question hook vs. statement hook" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="What's being varied?">
          <Select value={variable} onChange={(e) => setVariable(e.target.value)}>
            {VARIABLES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Variant A">
            <Select value={variantAId} onChange={(e) => setVariantAId(e.target.value)}>
              <option value="">Select a post…</option>
              {eligible.map((p) => (
                <option key={p.id} value={p.id} disabled={p.id === variantBId}>
                  {(p.content || '(no text)').slice(0, 60)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Variant B">
            <Select value={variantBId} onChange={(e) => setVariantBId(e.target.value)}>
              <option value="">Select a post…</option>
              {eligible.map((p) => (
                <option key={p.id} value={p.id} disabled={p.id === variantAId}>
                  {(p.content || '(no text)').slice(0, 60)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {eligible.length === 0 && (
          <p className="text-[11px] text-muted">
            No eligible posts yet — an experiment needs two posts that each target exactly one connected account.
          </p>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Confidence level">
            <Select value={confidenceLevel} onChange={(e) => setConfidenceLevel(e.target.value)}>
              <option value="0.90">90%</option>
              <option value="0.95">95%</option>
              <option value="0.99">99%</option>
            </Select>
          </Field>
          <Field label="Min. audience/variant" hint="Refuses to decide below this">
            <Input type="number" min={10} value={minSampleSize} onChange={(e) => setMinSampleSize(e.target.value)} />
          </Field>
          <Field label="Min. hours to run" hint="Per variant, from its own publish">
            <Input type="number" min={1} value={minObservationHours} onChange={(e) => setMinObservationHours(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function ExperimentCard({ experiment, variants, preview, canCancel, onCancel }) {
  const winner = (variants || []).find((v) => v.id === experiment.winner_variant_id);
  const displayNote = experiment.status === 'running' ? preview?.note : experiment.decision_note;
  const displayPValue = experiment.status === 'running' ? preview?.pValue : experiment.p_value;

  return (
    <Panel className="p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-ink">{experiment.name}</span>
            <Chip tone={STATUS_TONE[experiment.status] || 'neutral'}>{STATUS_LABEL[experiment.status] || experiment.status}</Chip>
          </div>
          <p className="text-[11px] text-subtle mt-0.5">
            Testing: {VARIABLES.find((v) => v.value === experiment.variable)?.label || experiment.variable} ·{' '}
            {Math.round(experiment.confidence_level * 100)}% confidence · min {experiment.min_sample_size} audience/variant
          </p>
        </div>
        {canCancel && experiment.status === 'running' && (
          <Button size="sm" variant="ghost" icon={Ban} onClick={() => onCancel(experiment)}>Cancel</Button>
        )}
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        {(variants || []).map((v) => (
          <div
            key={v.id}
            className={`rounded-ui border p-2 text-[11px] ${v.id === experiment.winner_variant_id ? 'border-success-border bg-success-subtle/50' : 'border-hairline bg-sunken/40'}`}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-ink">
                Variant {v.variant_key}{v.id === experiment.winner_variant_id ? ' — winner' : ''}
              </span>
              <span className="text-subtle">{channelLabel(v.social_accounts?.platform)}</span>
            </div>
            <p className="text-muted mt-1 line-clamp-2">{v.scheduled_posts?.content || '(no text)'}</p>
          </div>
        ))}
      </div>

      {displayNote && (
        <p className="text-[11px] text-muted mt-2">
          {displayNote}
          {typeof displayPValue === 'number' && ` (p=${displayPValue.toFixed(4)})`}
          {preview?.isPreview && ' — live preview, not yet final.'}
        </p>
      )}
      {winner && experiment.status === 'decided' && (
        <p className="text-[11px] text-subtle mt-1">
          Assumes both variants were posted to the same account under broadly comparable conditions — see this app's docs for what
          "normalized for audience size" does and doesn't control for.
        </p>
      )}
    </Panel>
  );
}

function Experiments({ authFetch, role }) {
  const canManage = atLeast(role, 'member');
  const canCancel = atLeast(role, 'admin');
  const [experiments, setExperiments] = useState(null);
  const [details, setDetails] = useState({}); // id -> { variants, preview }
  const [posts, setPosts] = useState([]);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const EXPERIMENTS_API_BASE = `${API_BASE}/experiments`;

  const loadDetail = async (id) => {
    try {
      const res = await authFetch(`${EXPERIMENTS_API_BASE}/${id}`);
      const data = await res.json();
      if (res.ok) setDetails((prev) => ({ ...prev, [id]: { variants: data.variants, preview: data.preview } }));
    } catch {
      // a failed detail fetch just leaves that card without variant previews — the list itself still renders
    }
  };

  const load = async () => {
    setRefreshing(true);
    try {
      const [expRes, postsRes] = await Promise.all([
        authFetch(EXPERIMENTS_API_BASE),
        authFetch(`${SOCIAL_API_BASE}/posts`)
      ]);
      const expData = await expRes.json();
      if (!expRes.ok) throw new Error(expData.error || 'Could not load experiments.');
      setExperiments(expData.experiments || []);
      (expData.experiments || []).forEach((exp) => loadDetail(exp.id));

      const postsData = await postsRes.json();
      if (postsRes.ok) setPosts(postsData.posts || []);
      setError(null);
    } catch (err) {
      setError(err.message);
      setExperiments([]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = async (experiment) => {
    try {
      const res = await authFetch(`${EXPERIMENTS_API_BASE}/${experiment.id}/cancel`, { method: 'PATCH' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not cancel this experiment.');
      setExperiments((prev) => prev.map((e) => (e.id === experiment.id ? data.experiment : e)));
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmCancel(null);
    }
  };

  return (
    <Page>
      <PageBar
        title="Experiments"
        count={experiments === null ? undefined : `${experiments.length} experiment${experiments.length === 1 ? '' : 's'}`}
        actions={
          <>
            <IconButton icon={RefreshCw} label="Refresh" onClick={load} className={refreshing ? 'animate-[spin_1s_linear_infinite]' : undefined} />
            {canManage && (
              <Button variant="primary" icon={Plus} onClick={() => setModalOpen(true)}>
                New experiment
              </Button>
            )}
          </>
        }
      />

      <PageBody width="narrow">
        {error && <Banner tone="danger">{error}</Banner>}

        {experiments === null ? (
          <Panel className="p-4 space-y-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </Panel>
        ) : experiments.length === 0 ? (
          <Panel>
            <EmptyState
              icon={FlaskConical}
              title="No experiments yet"
              description="Compare two already-scheduled posts (same hook/caption/CTA/format, different variants) to see which one a real significance test says wins."
              action={
                canManage && (
                  <Button variant="primary" onClick={() => setModalOpen(true)}>
                    New experiment
                  </Button>
                )
              }
            />
          </Panel>
        ) : (
          <div className="flex flex-col gap-3">
            {experiments.map((exp) => (
              <ExperimentCard
                key={exp.id}
                experiment={exp}
                variants={details[exp.id]?.variants}
                preview={details[exp.id]?.preview}
                canCancel={canCancel}
                onCancel={setConfirmCancel}
              />
            ))}
          </div>
        )}
      </PageBody>

      <NewExperimentModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(experiment) => { setExperiments((prev) => [experiment, ...(prev || [])]); loadDetail(experiment.id); }}
        authFetch={authFetch}
        posts={posts}
      />

      <ConfirmDialog
        open={!!confirmCancel}
        title="Cancel this experiment?"
        body="Both posts stay exactly as scheduled — only the experiment's own tracking stops. This can't be undone."
        confirmLabel="Cancel experiment"
        onCancel={() => setConfirmCancel(null)}
        onConfirm={() => cancel(confirmCancel)}
      />
    </Page>
  );
}

export default Experiments;
