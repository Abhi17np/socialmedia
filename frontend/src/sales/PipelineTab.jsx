'use client';

import { useEffect, useRef, useState } from 'react';
import {
  RefreshCw, Plus, KanbanSquare, Table2, Settings2, Flame, GripVertical,
  Trash2, ArrowUp, ArrowDown, IndianRupee, Building2, User, CalendarClock, Search
} from 'lucide-react';
import {
  Button, IconButton, Select, Input, Field, Checkbox,
  Banner, Modal, Drawer, EmptyState, Skeleton, Chip, Pagination
} from '../ui';
import { money, moneyByCurrency } from './format';
import DealDetailDrawer from './DealDetailDrawer';

// Kanban genuinely needs every open deal in the pipeline at once — stage
// totals/weighted amounts and drag targets would silently be wrong if
// any stage's deals were paginated away. 200 is a generous, documented
// cap (not a silent truncation): if a pipeline ever exceeds it, a
// banner says so explicitly instead of quietly dropping deals.
const KANBAN_PAGE_SIZE = 200;

// ------------------------------------------------------------- Pipeline

function PipelineTab({ authFetch, SALES_API_BASE, canManage, canAdmin, canDelete, openId }) {
  const [pipelines, setPipelines] = useState(null);
  const [activePipelineId, setActivePipelineId] = useState(null);
  const [deals, setDeals] = useState(null);
  const [dealsTotal, setDealsTotal] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('kanban');
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newDealOpen, setNewDealOpen] = useState(null); // stageId or null
  const [pipelineName, setPipelineName] = useState('');
  const [dealForm, setDealForm] = useState({ name: '', amount: '' });
  const [draggingDeal, setDraggingDeal] = useState(null);
  const [stageEditorOpen, setStageEditorOpen] = useState(false);
  const [lostMove, setLostMove] = useState(null); // { deal, stage } | null
  const [lostReason, setLostReason] = useState('');
  const [openDealId, setOpenDealId] = useState(null);

  const loadPipelines = () => {
    authFetch(`${SALES_API_BASE}/pipelines`).then((r) => r.json()).then((d) => {
      setPipelines(d.pipelines || []);
      if (!activePipelineId && d.pipelines && d.pipelines.length > 0) setActivePipelineId(d.pipelines[0].id);
    }).catch((e) => setError(e.message));
  };

  const loadDeals = (pipelineId) => {
    if (!pipelineId) return;
    authFetch(`${SALES_API_BASE}/deals?pipelineId=${pipelineId}&pageSize=${KANBAN_PAGE_SIZE}`).then((r) => r.json())
      .then((d) => { setDeals(d.deals || []); setDealsTotal(d.total ?? null); })
      .catch((e) => setError(e.message));
  };

  useEffect(loadPipelines, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => loadDeals(activePipelineId), [activePipelineId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep-linked from GlobalSearch: switch to the deal's own pipeline first so
  // the detail drawer's stage picker reflects the pipeline the deal is
  // actually in, not whichever one happened to be active.
  useEffect(() => {
    if (!openId) return;
    authFetch(`${SALES_API_BASE}/deals/${openId}`).then((r) => r.json()).then((d) => {
      if (d.deal?.pipeline_id) setActivePipelineId(d.deal.pipeline_id);
      setOpenDealId(openId);
    }).catch(() => {});
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pipeline = (pipelines || []).find((p) => p.id === activePipelineId);

  const createPipeline = async () => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/pipelines`, { method: 'POST', body: JSON.stringify({ name: pipelineName }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create pipeline.');
      setPipelines((prev) => [...(prev || []), data.pipeline]);
      setActivePipelineId(data.pipeline.id);
      setNewPipelineOpen(false);
      setPipelineName('');
    } catch (err) {
      setError(err.message);
    }
  };

  const createDeal = async (stageId) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/deals`, {
        method: 'POST',
        body: JSON.stringify({ name: dealForm.name, pipelineId: activePipelineId, stageId, amount: Number(dealForm.amount) || 0 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create deal.');
      setDeals((prev) => [...(prev || []), data.deal]);
      setNewDealOpen(null);
      setDealForm({ name: '', amount: '' });
    } catch (err) {
      setError(err.message);
    }
  };

  const applyMove = async (deal, stageId, lostReasonValue) => {
    setDeals((prev) => prev.map((d) => (d.id === deal.id ? { ...d, stage_id: stageId } : d))); // optimistic
    try {
      const body = lostReasonValue ? { stageId, lostReason: lostReasonValue } : { stageId };
      const res = await authFetch(`${SALES_API_BASE}/deals/${deal.id}/move`, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not move deal.');
      setDeals((prev) => prev.map((d) => (d.id === deal.id ? data.deal : d)));
    } catch (err) {
      setError(err.message);
      loadDeals(activePipelineId); // revert optimistic update on failure
    }
  };

  const moveDeal = (deal, stageId) => {
    if (deal.stage_id === stageId) return;
    const targetStage = (pipeline?.stages || []).find((s) => s.id === stageId);
    if (targetStage?.is_lost) {
      setLostMove({ deal, stage: targetStage });
      setLostReason('');
      return;
    }
    applyMove(deal, stageId);
  };

  const confirmLostMove = async () => {
    if (!lostMove || !lostReason.trim()) return;
    await applyMove(lostMove.deal, lostMove.stage.id, lostReason.trim());
    setLostMove(null);
    setLostReason('');
  };

  if (pipelines === null) return <Skeleton className="h-64" />;

  if (pipelines.length === 0) {
    return (
      <>
        <EmptyState icon={KanbanSquare} title="No pipeline yet" description="Create a pipeline to start tracking deals." action={canManage && <Button variant="primary" icon={Plus} onClick={() => setNewPipelineOpen(true)}>New pipeline</Button>} />
        <PipelineModal open={newPipelineOpen} name={pipelineName} setName={setPipelineName} onClose={() => setNewPipelineOpen(false)} onCreate={createPipeline} />
      </>
    );
  }

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      {view === 'kanban' && dealsTotal !== null && dealsTotal > KANBAN_PAGE_SIZE && (
        <Banner tone="warning">
          Showing the first {KANBAN_PAGE_SIZE} of {dealsTotal} deals in this pipeline. Switch to Table view to page through the rest.
        </Banner>
      )}
      <div className="flex items-center justify-between">
        <Select value={activePipelineId || ''} onChange={(e) => setActivePipelineId(e.target.value)} className="w-56">
          {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-sunken border border-hairline rounded-ui p-0.5">
            <button onClick={() => setView('kanban')} className={`h-7 w-7 rounded flex items-center justify-center ${view === 'kanban' ? 'bg-card text-ink shadow-sm' : 'text-muted'}`} title="Kanban view"><KanbanSquare size={14} /></button>
            <button onClick={() => setView('table')} className={`h-7 w-7 rounded flex items-center justify-center ${view === 'table' ? 'bg-card text-ink shadow-sm' : 'text-muted'}`} title="Table view"><Table2 size={14} /></button>
          </div>
          <IconButton icon={RefreshCw} label="Refresh" onClick={() => loadDeals(activePipelineId)} />
          {canAdmin && <Button size="sm" icon={Settings2} onClick={() => setStageEditorOpen(true)}>Edit stages</Button>}
          {canManage && <Button size="sm" icon={Plus} onClick={() => setNewPipelineOpen(true)}>New pipeline</Button>}
        </div>
      </div>

      {deals === null || !pipeline ? (
        <Skeleton className="h-64" />
      ) : view === 'kanban' ? (
        <KanbanView
          pipeline={pipeline} deals={deals} canManage={canManage}
          newDealOpen={newDealOpen} setNewDealOpen={setNewDealOpen}
          dealForm={dealForm} setDealForm={setDealForm} createDeal={createDeal}
          draggingDeal={draggingDeal} setDraggingDeal={setDraggingDeal} moveDeal={moveDeal}
          onOpenDeal={setOpenDealId}
        />
      ) : (
        <TableView
          pipeline={pipeline} authFetch={authFetch} SALES_API_BASE={SALES_API_BASE}
          canManage={canManage} onOpenDeal={setOpenDealId}
          onChanged={() => loadDeals(activePipelineId)}
        />
      )}

      {openDealId && (
        <DealDetailDrawer
          dealId={openDealId} onClose={() => setOpenDealId(null)}
          authFetch={authFetch} SALES_API_BASE={SALES_API_BASE}
          canManage={canManage} canDelete={canDelete}
          pipelineStages={pipeline?.stages}
          onChanged={() => loadDeals(activePipelineId)}
        />
      )}

      <PipelineModal open={newPipelineOpen} name={pipelineName} setName={setPipelineName} onClose={() => setNewPipelineOpen(false)} onCreate={createPipeline} />

      <StageEditorDrawer
        open={stageEditorOpen} onClose={() => setStageEditorOpen(false)}
        authFetch={authFetch} SALES_API_BASE={SALES_API_BASE}
        pipeline={pipeline}
        onStagesChanged={(stages) => setPipelines((prev) => prev.map((p) => (p.id === pipeline.id ? { ...p, stages } : p)))}
      />

      <Modal
        open={!!lostMove}
        onClose={() => setLostMove(null)}
        title="Why was this deal lost?"
        subtitle={lostMove?.deal?.name}
        footer={<><Button onClick={() => setLostMove(null)}>Cancel</Button><Button variant="primary" onClick={confirmLostMove} disabled={!lostReason.trim()}>Move to Lost</Button></>}
      >
        <Field label="Lost reason" hint="Required — shown on the deal's history.">
          <Input value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="e.g. Budget cut, chose a competitor" autoFocus />
        </Field>
      </Modal>
    </>
  );
}

function StaleBadge({ isStale }) {
  if (!isStale) return null;
  return <span title="No activity in this stage for longer than its stale threshold"><Chip tone="danger"><Flame size={10} className="inline -mt-0.5 mr-0.5" />Stale</Chip></span>;
}

function DealMeta({ deal }) {
  const hasMeta = deal.companyName || deal.contactName || deal.ownerEmail || deal.nextActivityDueAt;
  if (!hasMeta) return null;
  return (
    <div className="flex flex-col gap-0.5 mt-1.5 text-[11px] text-muted">
      {(deal.companyName || deal.contactName) && (
        <div className="flex items-center gap-1 truncate">
          {deal.companyName && <Building2 size={10} className="shrink-0" />}
          <span className="truncate">{deal.companyName}{deal.companyName && deal.contactName ? ' · ' : ''}{deal.contactName}</span>
        </div>
      )}
      <div className="flex items-center justify-between gap-1">
        {deal.ownerEmail ? <span className="flex items-center gap-1 truncate"><User size={10} className="shrink-0" />{deal.ownerEmail}</span> : <span />}
        {deal.nextActivityDueAt && (
          <span className="flex items-center gap-1 shrink-0" title="Next scheduled activity">
            <CalendarClock size={10} />{new Date(deal.nextActivityDueAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}

function KanbanView({ pipeline, deals, canManage, newDealOpen, setNewDealOpen, dealForm, setDealForm, createDeal, draggingDeal, setDraggingDeal, moveDeal, onOpenDeal }) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {pipeline.stages.map((stage) => {
        const stageDeals = deals.filter((d) => d.stage_id === stage.id);
        // Deals in one stage aren't guaranteed to share a currency —
        // group instead of summing raw numbers across currencies.
        const totalByCurrency = {};
        const weightedByCurrency = {};
        for (const d of stageDeals) {
          const cur = d.currency || 'INR';
          totalByCurrency[cur] = (totalByCurrency[cur] || 0) + Number(d.amount || 0);
          weightedByCurrency[cur] = (weightedByCurrency[cur] || 0) + Number(d.amount || 0) * ((stage.probability || 0) / 100);
        }
        return (
          <div
            key={stage.id}
            className="w-72 shrink-0 bg-sunken border border-hairline rounded-card flex flex-col"
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => draggingDeal && moveDeal(draggingDeal, stage.id)}
          >
            <div className="px-3 py-2.5 border-b border-hairline">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs font-semibold text-ink truncate">{stage.name}</span>
                <span className="text-[11px] text-subtle shrink-0">{stageDeals.length}</span>
              </div>
              <div className="flex items-center justify-between mt-0.5 gap-1.5 min-w-0">
                <span className="text-[11px] tabular-nums text-ink truncate">{moneyByCurrency(totalByCurrency)}</span>
                <span className="text-[10px] tabular-nums text-subtle shrink-0" title="Weighted by this stage's win probability">{moneyByCurrency(weightedByCurrency)} wtd</span>
              </div>
            </div>
            <div className="p-2 flex flex-col gap-2 min-h-[80px]">
              {stageDeals.map((deal) => (
                <div
                  key={deal.id}
                  draggable={canManage}
                  onDragStart={() => setDraggingDeal(deal)}
                  onDragEnd={() => setDraggingDeal(null)}
                  onClick={() => onOpenDeal(deal.id)}
                  className="bg-card border border-hairline rounded-ui p-2.5 cursor-pointer hover:border-brand transition-colors"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="text-xs font-medium text-ink truncate">{deal.name}</div>
                    <StaleBadge isStale={deal.isStale} />
                  </div>
                  <div className="flex items-center gap-1 mt-1 text-[11px] text-muted tabular-nums">
                    <IndianRupee size={10} />{money(deal.amount, deal.currency).replace(/^[^\d]+/, '')}
                  </div>
                  <DealMeta deal={deal} />
                </div>
              ))}
              {canManage && (
                newDealOpen === stage.id ? (
                  <div className="bg-card border border-hairline rounded-ui p-2 flex flex-col gap-1.5">
                    <Input autoFocus placeholder="Deal name" value={dealForm.name} onChange={(e) => setDealForm({ ...dealForm, name: e.target.value })} className="h-7 text-xs" />
                    <Input placeholder="Amount" type="number" value={dealForm.amount} onChange={(e) => setDealForm({ ...dealForm, amount: e.target.value })} className="h-7 text-xs" />
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="primary" disabled={!dealForm.name.trim()} onClick={() => createDeal(stage.id)}>Add</Button>
                      <Button size="sm" onClick={() => setNewDealOpen(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setNewDealOpen(stage.id)} className="text-[11px] text-muted hover:text-ink flex items-center gap-1 px-1.5 py-1">
                    <Plus size={12} /> Add deal
                  </button>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const TABLE_PAGE_SIZE = 50;

// The Pipeline tab's real "Deals list" — independently paginated and
// searchable from the Kanban view, which deliberately loads the whole
// pipeline instead (see KANBAN_PAGE_SIZE above). Moving a deal here
// also tells the parent to refresh its Kanban cache, so stage totals
// are correct next time the user switches views.
function TableView({ pipeline, authFetch, SALES_API_BASE, canManage, onOpenDeal, onChanged }) {
  const [deals, setDeals] = useState(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(null);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [error, setError] = useState(null);
  const [lostMove, setLostMove] = useState(null);
  const [lostReason, setLostReason] = useState('');
  const searchDebounce = useRef(null);
  const stageById = new Map(pipeline.stages.map((s) => [s.id, s]));

  const load = () => {
    const params = new URLSearchParams({ pipelineId: pipeline.id, page: String(page), pageSize: String(TABLE_PAGE_SIZE) });
    if (search.trim()) params.set('search', search.trim());
    authFetch(`${SALES_API_BASE}/deals?${params}`).then((r) => r.json())
      .then((d) => { setDeals(d.deals || []); setTotal(d.total ?? null); })
      .catch((e) => setError(e.message));
  };
  useEffect(load, [pipeline.id, page, search]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSearchChange = (value) => {
    setSearchInput(value);
    clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => { setPage(1); setSearch(value); }, 300);
  };

  const applyMove = async (deal, stageId, lostReasonValue) => {
    setDeals((prev) => prev.map((d) => (d.id === deal.id ? { ...d, stage_id: stageId } : d))); // optimistic
    try {
      const body = lostReasonValue ? { stageId, lostReason: lostReasonValue } : { stageId };
      const res = await authFetch(`${SALES_API_BASE}/deals/${deal.id}/move`, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not move deal.');
      setDeals((prev) => prev.map((d) => (d.id === deal.id ? data.deal : d)));
      onChanged?.();
    } catch (err) {
      setError(err.message);
      load();
    }
  };

  const moveDeal = (deal, stageId) => {
    if (deal.stage_id === stageId) return;
    const targetStage = stageById.get(stageId);
    if (targetStage?.is_lost) {
      setLostMove({ deal, stage: targetStage });
      setLostReason('');
      return;
    }
    applyMove(deal, stageId);
  };

  const confirmLostMove = async () => {
    if (!lostMove || !lostReason.trim()) return;
    await applyMove(lostMove.deal, lostMove.stage.id, lostReason.trim());
    setLostMove(null);
    setLostReason('');
  };

  return (
    <div className="flex flex-col gap-2">
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="flex items-center justify-between">
        <Input icon={Search} placeholder="Search deals…" value={searchInput} onChange={(e) => onSearchChange(e.target.value)} className="h-8 w-56" />
        {total !== null && <span className="text-[11px] text-subtle">{total} total</span>}
      </div>
      <div className="bg-card border border-hairline rounded-card overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-hairline text-left">
              <th className="px-3 py-2 font-medium text-subtle">Deal</th>
              <th className="px-3 py-2 font-medium text-subtle">Company / contact</th>
              <th className="px-3 py-2 font-medium text-subtle">Owner</th>
              <th className="px-3 py-2 font-medium text-subtle">Stage</th>
              <th className="px-3 py-2 font-medium text-subtle text-right">Amount</th>
              <th className="px-3 py-2 font-medium text-subtle">Expected close</th>
              <th className="px-3 py-2 font-medium text-subtle"> </th>
            </tr>
          </thead>
          <tbody>
            {deals === null ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted">Loading…</td></tr>
            ) : deals.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted">{search ? 'No deals match your search.' : 'No deals in this pipeline yet.'}</td></tr>
            ) : deals.map((deal) => {
              const stage = stageById.get(deal.stage_id);
              return (
                <tr key={deal.id} className="border-b border-hairline last:border-b-0 hover:bg-canvas transition-colors">
                  <td className="px-3 py-2 cursor-pointer" onClick={() => onOpenDeal(deal.id)}>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-ink">{deal.name}</span>
                      <StaleBadge isStale={deal.isStale} />
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted truncate max-w-[180px]">
                    {deal.companyName}{deal.companyName && deal.contactName ? ' · ' : ''}{deal.contactName}{!deal.companyName && !deal.contactName && '—'}
                  </td>
                  <td className="px-3 py-2 text-muted truncate max-w-[160px]">{deal.ownerEmail || '—'}</td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    {canManage ? (
                      <Select className="h-7" value={deal.stage_id} onChange={(e) => moveDeal(deal, e.target.value)}>
                        {pipeline.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                    ) : (
                      <Chip tone={stage?.is_won ? 'success' : stage?.is_lost ? 'danger' : 'neutral'}>{stage?.name || '—'}</Chip>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(deal.amount, deal.currency)}</td>
                  <td className="px-3 py-2 text-muted">{deal.expected_close_date || '—'}</td>
                  <td className="px-3 py-2">
                    {deal.status !== 'open' && <Chip tone={deal.status === 'won' ? 'success' : 'danger'}>{deal.status}</Chip>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {deals && deals.length > 0 && <Pagination page={page} pageSize={TABLE_PAGE_SIZE} total={total} onPageChange={setPage} />}
      </div>

      <Modal
        open={!!lostMove}
        onClose={() => setLostMove(null)}
        title="Why was this deal lost?"
        subtitle={lostMove?.deal?.name}
        footer={<><Button onClick={() => setLostMove(null)}>Cancel</Button><Button variant="primary" onClick={confirmLostMove} disabled={!lostReason.trim()}>Move to Lost</Button></>}
      >
        <Field label="Lost reason" hint="Required — shown on the deal's history.">
          <Input value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="e.g. Budget cut, chose a competitor" autoFocus />
        </Field>
      </Modal>
    </div>
  );
}

function PipelineModal({ open, name, setName, onClose, onCreate }) {
  return (
    <Modal open={open} onClose={onClose} title="New pipeline" subtitle="Starts with 5 practical stages — New, Qualified, Proposal, Won, Lost." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={onCreate} disabled={!name.trim()}>Create</Button></>}>
      <Field label="Pipeline name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Enterprise sales" autoFocus /></Field>
    </Modal>
  );
}

// --------------------------------------------------------- Stage editor

function StageEditorDrawer({ open, onClose, authFetch, SALES_API_BASE, pipeline, onStagesChanged }) {
  const [stages, setStages] = useState([]);
  const [newStageName, setNewStageName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (pipeline) setStages([...(pipeline.stages || [])].sort((a, b) => a.position - b.position)); }, [pipeline, open]);

  if (!pipeline) return null;

  const patchStage = async (stageId, patch) => {
    setBusy(true);
    try {
      const res = await authFetch(`${SALES_API_BASE}/stages/${stageId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update stage.');
      const next = stages.map((s) => (s.id === stageId ? data.stage : s));
      setStages(next);
      onStagesChanged(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const addStage = async () => {
    if (!newStageName.trim()) return;
    setBusy(true);
    try {
      const res = await authFetch(`${SALES_API_BASE}/pipelines/${pipeline.id}/stages`, { method: 'POST', body: JSON.stringify({ name: newStageName.trim(), probability: 0 }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create stage.');
      const next = [...stages, data.stage];
      setStages(next);
      onStagesChanged(next);
      setNewStageName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteStage = async (stageId) => {
    setBusy(true);
    try {
      const res = await authFetch(`${SALES_API_BASE}/stages/${stageId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not delete stage.');
      const next = stages.filter((s) => s.id !== stageId);
      setStages(next);
      onStagesChanged(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const reorder = async (fromIndex, toIndex) => {
    if (toIndex < 0 || toIndex >= stages.length) return;
    const reordered = [...stages];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    const body = { stages: reordered.map((s, i) => ({ id: s.id, position: i })) };
    setBusy(true);
    try {
      const res = await authFetch(`${SALES_API_BASE}/pipelines/${pipeline.id}/stages/reorder`, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not reorder stages.');
      const sorted = [...data.stages].sort((a, b) => a.position - b.position);
      setStages(sorted);
      onStagesChanged(sorted);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title="Edit stages" subtitle={pipeline.name} width={440}>
      <div className="p-4 flex flex-col gap-3">
        {error && <Banner tone="danger">{error}</Banner>}
        {stages.map((stage, i) => (
          <div key={stage.id} className="border border-hairline rounded-ui p-3 flex flex-col gap-2 bg-card">
            <div className="flex items-center gap-2">
              <GripVertical size={14} className="text-subtle shrink-0" />
              <Input
                value={stage.name}
                onChange={(e) => setStages((prev) => prev.map((s) => (s.id === stage.id ? { ...s, name: e.target.value } : s)))}
                onBlur={(e) => e.target.value.trim() && e.target.value !== pipeline.stages.find((s) => s.id === stage.id)?.name && patchStage(stage.id, { name: e.target.value.trim() })}
                className="h-7 text-xs flex-1"
              />
              <IconButton icon={ArrowUp} label="Move up" size={13} onClick={() => reorder(i, i - 1)} disabled={busy || i === 0} />
              <IconButton icon={ArrowDown} label="Move down" size={13} onClick={() => reorder(i, i + 1)} disabled={busy || i === stages.length - 1} />
              <IconButton icon={Trash2} label="Delete stage" size={13} onClick={() => deleteStage(stage.id)} disabled={busy} />
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted pl-6">
              <label className="flex items-center gap-1.5">
                Win %
                <Input
                  type="number" min={0} max={100}
                  defaultValue={stage.probability}
                  onBlur={(e) => patchStage(stage.id, { probability: Number(e.target.value) || 0 })}
                  className="h-6 w-14 text-xs"
                />
              </label>
              <label className="flex items-center gap-1.5">
                <Checkbox checked={stage.is_won} onChange={(e) => patchStage(stage.id, { isWon: e.target.checked })} />
                Won stage
              </label>
              <label className="flex items-center gap-1.5">
                <Checkbox checked={stage.is_lost} onChange={(e) => patchStage(stage.id, { isLost: e.target.checked })} />
                Lost stage
              </label>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted pl-6">
              Flag stale after
              <Input
                type="number" min={1}
                defaultValue={stage.stale_after_days ?? ''}
                placeholder="never"
                onBlur={(e) => patchStage(stage.id, { staleAfterDays: e.target.value ? Number(e.target.value) : null })}
                className="h-6 w-16 text-xs"
              />
              days of inactivity
            </div>
          </div>
        ))}

        <div className="flex gap-1.5">
          <Input placeholder="New stage name" value={newStageName} onChange={(e) => setNewStageName(e.target.value)} className="h-8 text-xs" />
          <Button size="sm" variant="primary" icon={Plus} onClick={addStage} disabled={!newStageName.trim() || busy}>Add</Button>
        </div>
      </div>
    </Drawer>
  );
}

export default PipelineTab;
