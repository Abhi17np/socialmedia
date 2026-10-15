'use client';

import { useEffect, useState } from 'react';
import { Plus, Play, Pause, Trash2, Zap } from 'lucide-react';
import { API_BASE } from '../apiBase';
import {
  Button, IconButton, Panel, PanelHeader, Table, Th, Td, Input, Select, Field,
  Banner, Modal, ConfirmDialog, EmptyState, Skeleton, Chip
} from '../ui';
import { channelLabel } from '../ui/channel';

const CJ_API_BASE = `${API_BASE}/social/conversion-journeys`;
const PLATFORMS = ['', 'whatsapp', 'instagram', 'facebook'];

/**
 * Social-to-WhatsApp Conversion Journeys — the UI for
 * backend/routes/conversionJourneys.js's focused, ungated authoring
 * surface. Deliberately a fixed "a contact messages us on social, wait,
 * send a WhatsApp template" shape, not a graph editor — a tenant who
 * wants branching builds one in Marketing Hub's full journey builder
 * instead, using this exact same trigger type.
 */
function CreateJourneyModal({ open, onClose, onCreated, authFetch, templates, accounts }) {
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState('');
  const [delayAmount, setDelayAmount] = useState('5');
  const [delayUnit, setDelayUnit] = useState('minutes');
  const [templateId, setTemplateId] = useState('');
  const [socialAccountId, setSocialAccountId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const waAccounts = (accounts || []).filter((a) => a.platform === 'whatsapp');
  const approvedTemplates = (templates || []).filter((t) => t.approval_status === 'approved');

  const reset = () => {
    setName(''); setPlatform(''); setDelayAmount('5'); setDelayUnit('minutes'); setTemplateId(''); setSocialAccountId(''); setError(null);
  };

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(CJ_API_BASE, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(), platform: platform || undefined, delayAmount: Number(delayAmount), delayUnit, templateId, socialAccountId
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create this journey.');
      onCreated(data.journey);
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
      title="New conversion journey"
      subtitle="When a contact messages you on social, wait, then send a WhatsApp template follow-up."
      footer={
        <>
          <Button onClick={() => { reset(); onClose(); }} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={create} loading={saving} disabled={!name.trim() || !templateId || !socialAccountId}>
            Create (starts paused)
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Banner tone="danger">{error}</Banner>}
        {waAccounts.length === 0 && (
          <Banner tone="warning">Connect a WhatsApp account before creating a conversion journey.</Banner>
        )}
        {approvedTemplates.length === 0 && (
          <Banner tone="warning">No approved WhatsApp template yet — submit one for Meta review first.</Banner>
        )}
        <Field label="Name">
          <Input autoFocus placeholder="e.g. DM follow-up" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Fires on messages from" hint="Leave blank to match any social channel's inbound message">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORMS.map((p) => <option key={p} value={p}>{p ? channelLabel(p) : 'Any platform'}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Wait">
            <Input type="number" min={1} value={delayAmount} onChange={(e) => setDelayAmount(e.target.value)} />
          </Field>
          <Field label="Unit">
            <Select value={delayUnit} onChange={(e) => setDelayUnit(e.target.value)}>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </Select>
          </Field>
        </div>
        <Field label="WhatsApp account">
          <Select value={socialAccountId} onChange={(e) => setSocialAccountId(e.target.value)}>
            <option value="">Select…</option>
            {waAccounts.map((a) => <option key={a.id} value={a.id}>{a.account_label || a.id}</option>)}
          </Select>
        </Field>
        <Field label="Template" hint="Only approved templates can send">
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Select…</option>
            {approvedTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function ConversionJourneysTab({ authFetch, templates, accounts, canManage, canActivate }) {
  const [journeys, setJourneys] = useState(null);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = async () => {
    try {
      const res = await authFetch(CJ_API_BASE);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load conversion journeys.');
      setJourneys(data.journeys || []);
      setError(null);
    } catch (err) {
      setError(err.message);
      setJourneys([]);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleActive = async (journey) => {
    try {
      const res = await authFetch(`${CJ_API_BASE}/${journey.id}/${journey.is_active ? 'pause' : 'activate'}`, { method: 'PATCH' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update this journey.');
      setJourneys((prev) => prev.map((j) => (j.id === journey.id ? data.journey : j)));
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (journey) => {
    try {
      const res = await authFetch(`${CJ_API_BASE}/${journey.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete this journey.');
      setJourneys((prev) => prev.filter((j) => j.id !== journey.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="flex justify-end">
        {canManage && (
          <Button variant="primary" icon={Plus} onClick={() => setModalOpen(true)}>
            New conversion journey
          </Button>
        )}
      </div>

      <Panel className="overflow-hidden">
        <PanelHeader title="Conversion journeys" meta="social message in → WhatsApp follow-up out" />
        {journeys === null ? (
          <div className="p-4"><Skeleton className="h-9" /></div>
        ) : journeys.length === 0 ? (
          <EmptyState
            icon={Zap}
            title="No conversion journeys yet"
            description="Automatically follow up on WhatsApp when a contact messages you on any connected social channel."
            action={canManage && <Button variant="primary" onClick={() => setModalOpen(true)}>New conversion journey</Button>}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Trigger</Th>
                <Th>Status</Th>
                <Th align="right"> </Th>
              </tr>
            </thead>
            <tbody>
              {journeys.map((j) => (
                <tr key={j.id} className="hover:bg-canvas transition-colors last:[&>td]:border-0">
                  <Td>{j.name}</Td>
                  <Td>
                    {j.trigger_config?.platform ? `Message on ${channelLabel(j.trigger_config.platform)}` : 'Message on any channel'}
                  </Td>
                  <Td><Chip tone={j.is_active ? 'success' : 'neutral'}>{j.is_active ? 'Active' : 'Paused'}</Chip></Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-1">
                      {canActivate && (
                        <IconButton
                          icon={j.is_active ? Pause : Play}
                          label={j.is_active ? 'Pause' : 'Activate'}
                          onClick={() => toggleActive(j)}
                        />
                      )}
                      {canActivate && <IconButton icon={Trash2} label="Delete" onClick={() => setConfirmDelete(j)} />}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <CreateJourneyModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(journey) => setJourneys((prev) => [journey, ...(prev || [])])}
        authFetch={authFetch}
        templates={templates}
        accounts={accounts}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete this conversion journey?"
        body="Any contact currently waiting in it will stop — this can't be undone."
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => remove(confirmDelete)}
      />
    </div>
  );
}

export default ConversionJourneysTab;
