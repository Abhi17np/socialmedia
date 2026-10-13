'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Users, Upload, Download, Copy, Search } from 'lucide-react';
import {
  Button, Panel, PanelHeader, Table, Th, Td, Input, Select, Field,
  Banner, Modal, EmptyState, Skeleton, Chip, Checkbox, Drawer, Avatar, Pagination
} from '../ui';
import { useTeamMembers } from './useTeamMembers';
import { downloadViaAuthFetch } from './format';
import ContactDetailDrawer from './ContactDetailDrawer';
import { useSavedViews, SavedViewsBar, ColumnsMenu } from './SavedViews';
import MergeRecordsModal from './MergeRecordsModal';

const LEAD_STATUS_TONE = { new: 'neutral', contacted: 'info', qualified: 'brand', unqualified: 'danger', customer: 'success' };
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'customer'];
const COLUMNS = [
  { key: 'name', label: 'Name', required: true },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'owner', label: 'Owner' },
  { key: 'score', label: 'Score' },
  { key: 'status', label: 'Status' }
];
const SORT_OPTIONS = [
  { value: '', label: 'Newest first' },
  { value: 'display_name_asc', label: 'Name (A–Z)' },
  { value: 'display_name_desc', label: 'Name (Z–A)' },
  { value: 'lead_score_desc', label: 'Highest score' },
  { value: 'lead_score_asc', label: 'Lowest score' }
];

function ContactsTab({ authFetch, SALES_API_BASE, canManage, canDelete, openId }) {
  const [contacts, setContacts] = useState(null);
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
  const [form, setForm] = useState({ displayName: '', phone: '', email: '', ownerId: '' });
  const [selected, setSelected] = useState(new Set());
  const [bulkTag, setBulkTag] = useState('');
  const [bulkOwnerId, setBulkOwnerId] = useState('');
  const [duplicates, setDuplicates] = useState(null);
  const [openContactId, setOpenContactId] = useState(null);
  const [mergeGroup, setMergeGroup] = useState(null);
  const fileInputRef = useRef(null);
  const searchDebounce = useRef(null);
  const members = useTeamMembers(authFetch);
  const memberEmail = (id) => members.find((m) => m.id === id)?.email || '—';

  const load = () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search.trim()) params.set('search', search.trim());
    if (sort) params.set('sort', sort);
    authFetch(`${SALES_API_BASE}/contacts?${params}`).then((r) => r.json())
      .then((d) => { setContacts(d.contacts || []); setTotal(d.total ?? null); })
      .catch((e) => setError(e.message));
  };
  useEffect(load, [page, search, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (openId) setOpenContactId(openId); }, [openId]);

  const onSearchChange = (value) => {
    setSearchInput(value);
    setActiveViewId(null);
    clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => { setPage(1); setSearch(value); }, 300);
  };

  const savedViews = useSavedViews(authFetch, SALES_API_BASE, 'contacts');
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
      const res = await authFetch(`${SALES_API_BASE}/contacts`, { method: 'POST', body: JSON.stringify({ ...form, ownerId: form.ownerId || undefined }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create lead.');
      setOpen(false);
      setForm({ displayName: '', phone: '', email: '', ownerId: '' });
      if (page !== 1) setPage(1); else load();
    } catch (err) {
      setError(err.message);
    }
  };

  const changeStatus = async (contact, leadStatus) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/contacts/${contact.id}`, { method: 'PATCH', body: JSON.stringify({ leadStatus }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update lead.');
      setContacts((prev) => prev.map((c) => (c.id === contact.id ? data.contact : c)));
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleSelect = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // "Select all" only touches the current page's rows — selections made
  // on other pages are preserved, since `selected` persists across pages.
  const toggleSelectAll = () => setSelected((prev) => {
    const pageIds = (contacts || []).map((c) => c.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => prev.has(id));
    const next = new Set(prev);
    pageIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
    return next;
  });

  const bulkAction = async (action, value) => {
    try {
      const res = await authFetch(`${SALES_API_BASE}/contacts/bulk-action`, { method: 'POST', body: JSON.stringify({ ids: [...selected], action, value: value ?? null }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk action failed.');
      setNotice(`${data.updated} lead${data.updated === 1 ? '' : 's'} updated.`);
      setSelected(new Set());
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const exportCsv = async () => {
    try {
      await downloadViaAuthFetch(authFetch, `${SALES_API_BASE}/contacts/export`, 'leads.csv');
    } catch (err) {
      setError(err.message);
    }
  };

  const importCsv = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await authFetch(`${SALES_API_BASE}/contacts/import`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed.');
      setNotice(`Imported ${data.created} lead${data.created === 1 ? '' : 's'}, skipped ${data.skipped} duplicate${data.skipped === 1 ? '' : 's'}${data.errors.length ? `, ${data.errors.length} row error(s)` : ''}.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const loadDuplicates = async () => {
    const res = await authFetch(`${SALES_API_BASE}/contacts/duplicates`);
    const data = await res.json();
    if (res.ok) setDuplicates(data.duplicateGroups);
  };

  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="info">{notice}</Banner>}

      {selected.size > 0 && canManage && (
        <div className="bg-card border border-brand rounded-card px-3 py-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-ink">{selected.size} selected</span>
          <div className="flex-1" />
          <Input placeholder="Tag…" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} className="h-7 w-28" />
          <Button size="sm" disabled={!bulkTag.trim()} onClick={() => bulkAction('add_tag', bulkTag.trim())}>Add tag</Button>
          <Button size="sm" disabled={!bulkTag.trim()} onClick={() => bulkAction('remove_tag', bulkTag.trim())}>Remove tag</Button>
          <Select className="h-7 w-40" value={bulkOwnerId} onChange={(e) => setBulkOwnerId(e.target.value)}>
            <option value="">Assign owner…</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
          </Select>
          <Button size="sm" disabled={!bulkOwnerId} onClick={() => bulkAction('set_owner', bulkOwnerId)}>Apply</Button>
          <Button size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Leads"
          meta={total !== null ? `${total} total` : undefined}
          action={
            <div className="flex items-center gap-1.5">
              <Input icon={Search} placeholder="Search leads…" value={searchInput} onChange={(e) => onSearchChange(e.target.value)} className="h-8 w-48" />
              <Button size="sm" icon={Copy} onClick={loadDuplicates}>Find duplicates</Button>
              <Button size="sm" icon={Download} onClick={exportCsv}>Export</Button>
              {canManage && <Button size="sm" icon={Upload} onClick={() => fileInputRef.current?.click()}>Import</Button>}
              {canManage && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>New lead</Button>}
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
        {contacts === null ? (
          <div className="p-4 space-y-3"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        ) : contacts.length === 0 ? (
          <EmptyState icon={Users} title={search ? 'No leads match your search' : 'No leads yet'} description={search ? 'Try a different name, phone or email.' : 'Leads also appear here automatically from inbound WhatsApp, Instagram and Facebook messages.'} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  {canManage && <Th><Checkbox checked={contacts.length > 0 && contacts.every((c) => selected.has(c.id))} onChange={toggleSelectAll} /></Th>}
                  <Th>Name</Th>
                  {visibleColumns.includes('phone') && <Th>Phone</Th>}
                  {visibleColumns.includes('email') && <Th>Email</Th>}
                  {visibleColumns.includes('owner') && <Th>Owner</Th>}
                  {visibleColumns.includes('score') && <Th align="right">Score</Th>}
                  {visibleColumns.includes('status') && <Th>Status</Th>}
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="hover:bg-canvas transition-colors">
                    {canManage && <Td onClick={(e) => e.stopPropagation()}><Checkbox checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} /></Td>}
                    <Td className="cursor-pointer" onClick={() => setOpenContactId(c.id)}><span className="flex items-center gap-2"><Avatar name={c.display_name} size={24} />{c.display_name}</span></Td>
                    {visibleColumns.includes('phone') && <Td className="cursor-pointer" onClick={() => setOpenContactId(c.id)}>{c.phone || '—'}</Td>}
                    {visibleColumns.includes('email') && <Td className="cursor-pointer" onClick={() => setOpenContactId(c.id)}>{c.email || '—'}</Td>}
                    {visibleColumns.includes('owner') && <Td className="cursor-pointer" onClick={() => setOpenContactId(c.id)}>{c.owner_id ? memberEmail(c.owner_id) : '—'}</Td>}
                    {visibleColumns.includes('score') && <Td align="right"><span className={c.lead_score > 0 ? 'text-success font-medium' : c.lead_score < 0 ? 'text-danger font-medium' : 'text-muted'}>{c.lead_score}</span></Td>}
                    {visibleColumns.includes('status') && (
                      <Td onClick={(e) => e.stopPropagation()}>
                        {canManage ? (
                          <Select className="h-7" value={c.lead_status} onChange={(e) => changeStatus(c, e.target.value)}>
                            {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                          </Select>
                        ) : (
                          <Chip tone={LEAD_STATUS_TONE[c.lead_status]}>{c.lead_status}</Chip>
                        )}
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
          </>
        )}
      </Panel>

      <Modal open={open} onClose={() => setOpen(false)} title="New lead" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create} disabled={!form.displayName.trim()}>Create</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Name"><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} autoFocus /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Owner">
            <Select value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
            </Select>
          </Field>
        </div>
      </Modal>

      <Drawer open={!!duplicates} onClose={() => setDuplicates(null)} title="Possible duplicates" subtitle="Leads sharing a phone number or email">
        <div className="p-4 flex flex-col gap-4">
          {duplicates && duplicates.length === 0 ? (
            <p className="text-xs text-muted">No duplicates found.</p>
          ) : (
            (duplicates || []).map((g, i) => (
              <div key={i} className="border border-hairline rounded-ui p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-[11px] text-muted">Matched on {g.matchType}: <span className="font-medium text-ink">{g.matchValue}</span></div>
                  {canDelete && <Button size="sm" onClick={() => setMergeGroup(g.contacts)}>Merge</Button>}
                </div>
                {g.contacts.map((c) => <div key={c.id} className="text-xs py-0.5">{c.display_name}</div>)}
              </div>
            ))
          )}
        </div>
      </Drawer>

      {mergeGroup && (
        <MergeRecordsModal
          entityType="contacts" records={mergeGroup}
          authFetch={authFetch} SALES_API_BASE={SALES_API_BASE}
          onClose={() => setMergeGroup(null)}
          onMerged={() => { load(); loadDuplicates(); }}
        />
      )}

      {openContactId && (
        <ContactDetailDrawer
          contactId={openContactId} onClose={() => setOpenContactId(null)}
          authFetch={authFetch} SALES_API_BASE={SALES_API_BASE} canManage={canManage}
          onChanged={load}
        />
      )}
    </>
  );
}

export default ContactsTab;
