'use client';

import { useEffect, useRef, useState } from 'react';
import { Bookmark, Plus, X, Columns3 } from 'lucide-react';
import { Button, IconButton, Input, Modal, Field, Checkbox } from '../ui';

/**
 * Per-user saved views (filters + sort + visible columns) for the
 * Companies/Leads/Deals lists — CRUD over GET/POST/PATCH/DELETE
 * /sales/saved-views, scoped to the current user (never shared across
 * the team; see routes/sales.js's owner_id scoping).
 */
export function useSavedViews(authFetch, SALES_API_BASE, listType) {
  const [views, setViews] = useState([]);

  const reload = () => {
    authFetch(`${SALES_API_BASE}/saved-views?listType=${listType}`).then((r) => r.json()).then((d) => setViews(d.views || [])).catch(() => {});
  };
  useEffect(reload, [listType]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (name, { filters, sort, visibleColumns }) => {
    const res = await authFetch(`${SALES_API_BASE}/saved-views`, {
      method: 'POST', body: JSON.stringify({ listType, name, filters, sort, visibleColumns })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save view.');
    setViews((prev) => [...prev, data.view]);
    return data.view;
  };

  const remove = async (viewId) => {
    const res = await authFetch(`${SALES_API_BASE}/saved-views/${viewId}`, { method: 'DELETE' });
    if (res.ok) setViews((prev) => prev.filter((v) => v.id !== viewId));
  };

  return { views, reload, create, remove };
}

export function SavedViewsBar({ views, onApply, onSaveCurrent, onDelete, activeViewId }) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);

  const save = async () => {
    if (!name.trim()) return;
    try {
      await onSaveCurrent(name.trim());
      setSaveOpen(false);
      setName('');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {views.map((v) => (
        <div
          key={v.id}
          className={`h-7 pl-2.5 pr-1 rounded-full border text-xs flex items-center gap-1 cursor-pointer transition-colors ${
            activeViewId === v.id ? 'bg-brand-subtle border-brand text-brand font-medium' : 'bg-card border-hairline text-muted hover:text-ink'
          }`}
          onClick={() => onApply(v)}
        >
          <Bookmark size={11} />
          <span className="max-w-[140px] truncate">{v.name}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(v.id); }}
            className="w-4 h-4 rounded-full flex items-center justify-center hover:bg-black/10 shrink-0"
            aria-label={`Delete view "${v.name}"`}
          >
            <X size={10} />
          </button>
        </div>
      ))}
      <Button size="sm" icon={Plus} onClick={() => setSaveOpen(true)}>Save view</Button>

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save current view" footer={<><Button onClick={() => setSaveOpen(false)}>Cancel</Button><Button variant="primary" onClick={save} disabled={!name.trim()}>Save</Button></>}>
        {error && <p className="text-xs text-danger mb-2">{error}</p>}
        <Field label="View name" hint="Saves your current search, sort and visible columns.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My open deals" autoFocus />
        </Field>
      </Modal>
    </div>
  );
}

export function ColumnsMenu({ columns, visible, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const toggle = (key) => {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange([...next]);
  };

  return (
    <div className="relative" ref={ref}>
      <IconButton icon={Columns3} label="Choose columns" onClick={() => setOpen((v) => !v)} />
      {open && (
        <div className="absolute top-[calc(100%+6px)] right-0 w-48 bg-card border border-hairline rounded-surface shadow-[var(--shadow-flyout)] p-2 z-40">
          <div className="eyebrow px-1 pb-1.5">Columns</div>
          {columns.map((c) => (
            <label key={c.key} className="flex items-center gap-2 px-1 py-1 text-xs text-ink hover:bg-canvas rounded-ui cursor-pointer">
              <Checkbox checked={visible.includes(c.key)} onChange={() => toggle(c.key)} disabled={c.required} />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
