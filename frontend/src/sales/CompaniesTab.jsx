'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Building2, Upload, Download, Copy, Search } from 'lucide-react';
import {
  Button, Panel, PanelHeader, Table, Th, Td, Input, Select, Field,
  Banner, Modal, Drawer, EmptyState, Skeleton, Chip, Checkbox, Pagination
} from '../ui';
import { money, downloadViaAuthFetch } from './format';
import { useTeamMembers } from './useTeamMembers';
import { useSavedViews, SavedViewsBar, ColumnsMenu } from './SavedViews';

const LEAD_STATUS_TONE = { new: 'neutral', contacted: 'info', qualified: 'brand', unqualified: 'danger', customer: 'success' };
const COLUMNS = [
  { key: 'name', label: 'Name', required: true },
  { key: 'industry', label: 'Industry' },
  { key: 'domain', label: 'Domain' },
  { key: 'owner', label: 'Owner' }
];
const SORT_OPTIONS = [
  { value: '', label: 'Newest first' },
  { value: 'name_asc', label: 'Name (A–Z)' },
  { value: 'name_desc', label: 'Name (Z–A)' }
];

function CompaniesTab({ authFetch, SALES_API_BASE, canManage, canDelete, openId }) {
  const [companies, setCompanies] = useState(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(null);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [sort, setSort] = useState('');
  const [visibleColumns, setVisibleColumns] = useState(COLUMNS.map((c) => c.key));
  const [activeViewId, setActiveViewId] = useState(null);
  const PAGE_SIZE = 50;
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailForm, setDetailForm] = useState(null);
  const [form, setForm] = useState({ name: '', domain: '', industry: '', ownerId: '' });
  const [selected, setSelected] = useState(new Set());
  const [bulkOwnerId, setBulkOwnerId] = useState('');
  const [duplicates, setDuplicates] = useState(null);
  const fileInputRef = useRef(null);
  const searchDebounce = useRef(null);
  const members = useTeamMembers(authFetch);
  const memberEmail = (id) => members.find((m) => m.id === id)?.email || '—';

  const load = () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search.trim()) params.set('search', search.trim());
    if (sort) params.set('sort', sort);
    authFetch(`${SALES_API_BASE}/companies?${params}`).then((r) => r.json())
      .then((d) => { setCompanies(d.companies || []); setTotal(d.total ?? null); })
      .catch((e) => setError(e.message));
  };
  useEffect(load, [page, search, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (openId) openDetail({ id: openId }); }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSearchChange = (value) => {
    setSearchInput(value);
    setActiveViewId(null);
    clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => { setPage(1); setSearch(value); }, 300);
  };

  const savedViews = useSavedViews(authFetch, SALES_API_BASE, 'companies');
  const applyView = (view) => {
    setActiveViewId(view.id);
    setSearchInput(view.filters?.search || '');
    setSearch(view.filters?.search || '');
    setSort(view.sort || '');
    setVisibleColumns(view.visible_columns || COLUMNS.map((c) => c.key));
    setPage(1);
  };
  const saveCurrentView = (name) => savedViews.create(name, { filters: { search }, sort, visibleColumns });

  const create = async () => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/companies`, { method: 'POST', body: JSON.stringify({ ...form, ownerId: form.ownerId || undefined }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create company.');
      setOpen(false);
      setForm({ name: '', domain: '', industry: '', ownerId: '' });
      if (page !== 1) setPage(1); else load();
    } catch (err) {
      setError(err.message);
    }
  };

  const openDetail = async (company) => {
    const res = await authFetch(`${SALES_API_BASE}/companies/${company.id}`);
    const data = await res.json();
    if (res.ok) {
      setDetail(data);
      setDetailForm({
        name: data.company.name, domain: data.company.domain || '', industry: data.company.industry || '',
        size: data.company.size || '', phone: data.company.phone || '', address: data.company.address || '',
        notes: data.company.notes || '', ownerId: data.company.owner_id || ''
      });
    }
  };

  // PATCH /sales/companies/:id validates against the full companySchema
  // (name required) rather than a partial-update schema, so every save
  // here resends the whole form, not just the field that changed.
  const saveDetail = async (overrides) => {
    const next = { ...detailForm, ...overrides };
    setDetailForm(next);
    if (!next.name.trim()) return;
    try {
      const res = await authFetch(`${SALES_API_BASE}/companies/${detail.company.id}`, { method: 'PATCH', body: JSON.stringify({ ...next, ownerId: next.ownerId || undefined, size: next.size || undefined }) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not save.');
      setDetail((prev) => ({ ...prev, company: result.company }));
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleSelect = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // Selecting "all" only ever affects the current page's rows — other
  // pages' selections (if any) are preserved, not wiped out, since
  // `selected` persists across page navigation by design.
  const toggleSelectAll = () => setSelected((prev) => {
    const pageIds = (companies || []).map((c) => c.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => prev.has(id));
    const next = new Set(prev);
    pageIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
    return next;
  });

  const bulkAction = async (action, value) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/companies/bulk-action`, { method: 'POST', body: JSON.stringify({ ids: [...selected], action, value: value ?? null }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk action failed.');
      setNotice(`${data.updated} compan${data.updated === 1 ? 'y' : 'ies'} updated.`);
      setSelected(new Set());
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const exportCsv = async () => {
    try {
      await downloadViaAuthFetch(authFetch, `${SALES_API_BASE}/companies/export`, 'companies.csv');
    } catch (err) {
      setError(err.message);
    }
  };

  const importCsv = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await authFetch(`${SALES_API_BASE}/companies/import`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed.');
      setNotice(`Imported ${data.created} compan${data.created === 1 ? 'y' : 'ies'}, skipped ${data.skipped} duplicate${data.skipped === 1 ? '' : 's'}${data.errors.length ? `, ${data.errors.length} row error(s)` : ''}.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const loadDuplicates = async () => {
    const res = await authFetch(`${SALES_API_BASE}/companies/duplicates`);
    const data = await res.json();
    if (res.ok) setDuplicates(data.duplicateGroups);
  };

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="info">{notice}</Banner>}

      {selected.size > 0 && canManage && (
        <div className="bg-card border border-brand rounded-card px-3 py-2 flex items-center gap-2 text-xs">
          <span className="font-medium text-ink">{selected.size} selected</span>
          <div className="flex-1" />
          <Select className="h-7 w-44" value={bulkOwnerId} onChange={(e) => setBulkOwnerId(e.target.value)}>
            <option value="">Assign owner…</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
          </Select>
          <Button size="sm" disabled={!bulkOwnerId} onClick={() => bulkAction('set_owner', bulkOwnerId)}>Apply</Button>
          {canDelete && <Button size="sm" variant="danger" onClick={() => bulkAction('delete')}>Delete selected</Button>}
          <Button size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Companies"
          meta={total !== null ? `${total} total` : undefined}
          action={
            <div className="flex items-center gap-1.5">
              <Input icon={Search} placeholder="Search companies…" value={searchInput} onChange={(e) => onSearchChange(e.target.value)} className="h-8 w-48" />
              <Button size="sm" icon={Copy} onClick={loadDuplicates}>Find duplicates</Button>
              <Button size="sm" icon={Download} onClick={exportCsv}>Export</Button>
              {canManage && <Button size="sm" icon={Upload} onClick={() => fileInputRef.current?.click()}>Import</Button>}
              {canManage && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New company</Button>}
              <input ref={fileInputRef} type="file" accept=".csv" hidden onChange={(e) => e.target.files[0] && importCsv(e.target.files[0])} />
            </div>
          }
        />
        <div className="px-4 py-2 border-b border-hairline flex items-center justify-between gap-2 flex-wrap">
          <SavedViewsBar views={savedViews.views} activeViewId={activeViewId} onApply={applyView} onSaveCurrent={saveCurrentView} onDelete={savedViews.remove} />
          <div className="flex items-center gap-1.5">
            <Select className="h-7 w-36" value={sort} onChange={(e) => { setActiveViewId(null); setSort(e.target.value); }}>
              {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <ColumnsMenu columns={COLUMNS} visible={visibleColumns} onChange={(cols) => { setActiveViewId(null); setVisibleColumns(cols); }} />
          </div>
        </div>
        {companies === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : companies.length === 0 ? (
          <EmptyState icon={Building2} title={search ? 'No companies match your search' : 'No companies yet'} description={search ? 'Try a different name or domain.' : 'Track the organizations your contacts belong to.'} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  {canManage && <Th><Checkbox checked={companies.length > 0 && companies.every((c) => selected.has(c.id))} onChange={toggleSelectAll} /></Th>}
                  <Th>Name</Th>
                  {visibleColumns.includes('industry') && <Th>Industry</Th>}
                  {visibleColumns.includes('domain') && <Th>Domain</Th>}
                  {visibleColumns.includes('owner') && <Th>Owner</Th>}
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={c.id} className="hover:bg-canvas transition-colors">
                    {canManage && <Td onClick={(e) => e.stopPropagation()}><Checkbox checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} /></Td>}
                    <Td className="cursor-pointer" onClick={() => openDetail(c)}><span className="font-medium">{c.name}</span></Td>
                    {visibleColumns.includes('industry') && <Td className="cursor-pointer" onClick={() => openDetail(c)}>{c.industry || '—'}</Td>}
                    {visibleColumns.includes('domain') && <Td className="cursor-pointer" onClick={() => openDetail(c)}>{c.domain || '—'}</Td>}
                    {visibleColumns.includes('owner') && <Td>{c.owner_id ? memberEmail(c.owner_id) : '—'}</Td>}
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
          </>
        )}
      </Panel>

      <Modal open={open} onClose={() => setOpen(false)} title="New company" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.name.trim()}>Create</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <Field label="Industry"><Input value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} /></Field>
          <Field label="Domain"><Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="acme.com" /></Field>
          <Field label="Owner">
            <Select value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
            </Select>
          </Field>
        </div>
      </Modal>

      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.company?.name} subtitle={detail?.company?.industry}>
        {detail && detailForm && (
          <div className="p-4 flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <Input value={detailForm.name} disabled={!canManage} onChange={(e) => setDetailForm({ ...detailForm, name: e.target.value })} onBlur={(e) => saveDetail({ name: e.target.value })} />
              </Field>
              <Field label="Industry">
                <Input value={detailForm.industry} disabled={!canManage} onChange={(e) => setDetailForm({ ...detailForm, industry: e.target.value })} onBlur={(e) => saveDetail({ industry: e.target.value })} />
              </Field>
              <Field label="Domain">
                <Input value={detailForm.domain} disabled={!canManage} onChange={(e) => setDetailForm({ ...detailForm, domain: e.target.value })} onBlur={(e) => saveDetail({ domain: e.target.value })} />
              </Field>
              <Field label="Phone">
                <Input value={detailForm.phone} disabled={!canManage} onChange={(e) => setDetailForm({ ...detailForm, phone: e.target.value })} onBlur={(e) => saveDetail({ phone: e.target.value })} />
              </Field>
              <Field label="Owner" className="col-span-2">
                <Select value={detailForm.ownerId} disabled={!canManage} onChange={(e) => saveDetail({ ownerId: e.target.value })}>
                  <option value="">Unassigned</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
                </Select>
              </Field>
              <Field label="Notes" className="col-span-2">
                <Input value={detailForm.notes} disabled={!canManage} onChange={(e) => setDetailForm({ ...detailForm, notes: e.target.value })} onBlur={(e) => saveDetail({ notes: e.target.value })} />
              </Field>
            </div>
            <div>
              <div className="eyebrow mb-1.5">Contacts ({detail.contacts.length})</div>
              {detail.contacts.length === 0 ? <p className="text-xs text-muted">No contacts linked yet.</p> : (
                <div className="flex flex-col gap-1.5">
                  {detail.contacts.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 text-xs"><span>{c.display_name}</span><Chip tone={LEAD_STATUS_TONE[c.lead_status]}>{c.lead_status}</Chip></div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="eyebrow mb-1.5">Deals ({detail.deals.length})</div>
              {detail.deals.length === 0 ? <p className="text-xs text-muted">No deals yet.</p> : (
                <div className="flex flex-col gap-1.5">
                  {detail.deals.map((d) => (
                    <div key={d.id} className="flex items-center justify-between text-xs"><span>{d.name}</span><span className="tabular-nums text-muted">{money(d.amount)}</span></div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="eyebrow mb-1.5">Activity timeline ({detail.activities?.length || 0})</div>
              {!detail.activities || detail.activities.length === 0 ? <p className="text-xs text-muted">No calls, emails or notes logged yet.</p> : (
                <div className="flex flex-col gap-1.5">
                  {detail.activities.map((a) => (
                    <div key={a.id} className="flex items-center justify-between text-xs"><span>{a.subject}</span><Chip tone={a.status === 'completed' ? 'success' : 'neutral'}>{a.status}</Chip></div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>

      <Drawer open={!!duplicates} onClose={() => setDuplicates(null)} title="Possible duplicates" subtitle="Companies sharing a domain or name">
        <div className="p-4 flex flex-col gap-4">
          {duplicates && duplicates.length === 0 ? (
            <p className="text-xs text-muted">No duplicates found.</p>
          ) : (
            (duplicates || []).map((g, i) => (
              <div key={i} className="border border-hairline rounded-ui p-3">
                <div className="text-[11px] text-muted mb-1.5">Matched on {g.matchType}: <span className="font-medium text-ink">{g.matchValue}</span></div>
                {g.companies.map((c) => <div key={c.id} className="text-xs py-0.5">{c.name}</div>)}
              </div>
            ))
          )}
        </div>
      </Drawer>
    </>
  );
}

export default CompaniesTab;
