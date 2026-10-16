'use client';

import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button, Modal, Select, Banner, Chip } from '../ui';
import { errorMessage } from './format';

const COMPANY_FIELDS = [
  { key: 'name', label: 'Name' }, { key: 'domain', label: 'Domain' }, { key: 'industry', label: 'Industry' },
  { key: 'size', label: 'Size' }, { key: 'phone', label: 'Phone' }, { key: 'address', label: 'Address' }, { key: 'notes', label: 'Notes' }
];
const CONTACT_FIELDS = [
  { key: 'display_name', label: 'Name', bodyKey: 'displayName' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
  { key: 'job_title', label: 'Job title', bodyKey: 'jobTitle' }, { key: 'lead_status', label: 'Lead status', bodyKey: 'leadStatus' }
];

/**
 * Safe duplicate merging: the survivor keeps every field by default,
 * only the fields the user explicitly flips to "use other" get sent
 * as mergedFields overrides. The actual reassignment of deals/
 * activities/deal_contacts/sequence enrollments happens atomically in
 * a single Postgres function (merge_contacts/merge_companies,
 * migration 022) — this UI only decides survivor/loser and field
 * values, never touches relationships directly.
 */
function MergeRecordsModal({ entityType, records, authFetch, SALES_API_BASE, onClose, onMerged }) {
  const fields = entityType === 'companies' ? COMPANY_FIELDS : CONTACT_FIELDS;
  const nameKey = entityType === 'companies' ? 'name' : 'display_name';
  const [survivorId, setSurvivorId] = useState(records[0].id);
  const [loserId, setLoserId] = useState(records.find((r) => r.id !== records[0].id)?.id);
  const [overrides, setOverrides] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const survivor = records.find((r) => r.id === survivorId);
  const loser = records.find((r) => r.id === loserId);
  const otherRecords = records.filter((r) => r.id !== survivorId);

  const pickSurvivor = (id) => {
    setSurvivorId(id);
    setOverrides({});
    if (id === loserId) setLoserId(records.find((r) => r.id !== id)?.id);
  };

  const merge = async () => {
    if (!survivor || !loser) return;
    setBusy(true);
    setError(null);
    try {
      const mergedFields = {};
      for (const f of fields) {
        if (overrides[f.key]) mergedFields[f.bodyKey || f.key] = loser[f.key];
      }
      const res = await authFetch(`${SALES_API_BASE}/${entityType}/merge`, {
        method: 'POST', body: JSON.stringify({ survivorId, loserId, mergedFields })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data, 'Could not merge records.'));
      onMerged();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open title="Merge duplicate records" onClose={onClose}
      subtitle="The survivor keeps all its deals, contacts and activity history — the other record is merged into it and removed."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={merge} disabled={busy || !survivor || !loser}>Merge</Button></>}
    >
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}

        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted">Keep:</span>
          <Select className="h-8 flex-1" value={survivorId} onChange={(e) => pickSurvivor(e.target.value)}>
            {records.map((r) => <option key={r.id} value={r.id}>{r[nameKey]}</option>)}
          </Select>
          <span className="text-muted">Merge away:</span>
          <Select className="h-8 flex-1" value={loserId || ''} onChange={(e) => { setLoserId(e.target.value); setOverrides({}); }}>
            {otherRecords.map((r) => <option key={r.id} value={r.id}>{r[nameKey]}</option>)}
          </Select>
        </div>

        {survivor && loser && (
          <div className="border border-hairline rounded-ui divide-y divide-hairline">
            {fields.map((f) => {
              const survivorVal = survivor[f.key] || '—';
              const loserVal = loser[f.key] || '—';
              const differs = (survivor[f.key] || '') !== (loser[f.key] || '') && !!(loser[f.key]);
              if (!differs) return null;
              const useOther = !!overrides[f.key];
              return (
                <div key={f.key} className="px-3 py-2 flex items-center gap-2 text-xs">
                  <span className="w-20 shrink-0 text-muted">{f.label}</span>
                  <button
                    onClick={() => setOverrides((prev) => ({ ...prev, [f.key]: false }))}
                    className={`flex-1 text-left px-2 py-1 rounded-ui border truncate ${!useOther ? 'border-brand bg-brand-subtle text-brand font-medium' : 'border-hairline text-muted'}`}
                  >
                    {survivorVal}
                  </button>
                  <ArrowRight size={12} className="text-subtle shrink-0" />
                  <button
                    onClick={() => setOverrides((prev) => ({ ...prev, [f.key]: true }))}
                    className={`flex-1 text-left px-2 py-1 rounded-ui border truncate ${useOther ? 'border-brand bg-brand-subtle text-brand font-medium' : 'border-hairline text-muted'}`}
                  >
                    {loserVal}
                  </button>
                </div>
              );
            })}
            {fields.every((f) => (survivor[f.key] || '') === (loser[f.key] || '') || !loser[f.key]) && (
              <p className="px-3 py-2 text-xs text-muted">No conflicting fields — the kept record's values will be used as-is.</p>
            )}
          </div>
        )}

        {survivor && loser && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <Chip tone="neutral">Deals, activities and relationships linked to &quot;{loser[nameKey]}&quot; will move to &quot;{survivor[nameKey]}&quot;</Chip>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default MergeRecordsModal;
