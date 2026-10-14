'use client';

import { useEffect, useState } from 'react';
import { Mail, MessageCircle, Smartphone, Check } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Button, Checkbox, Banner, Panel, Skeleton, EmptyState } from '../ui';

const CHANNEL_META = {
  email: { label: 'Email', icon: Mail },
  whatsapp: { label: 'WhatsApp', icon: MessageCircle },
  sms: { label: 'SMS', icon: Smartphone }
};

/**
 * No-login "manage my preferences" page, reached from an unsubscribe/
 * preference link in a marketing email or WhatsApp message. The token in
 * the URL is the only access control (backend/lib/consent.js,
 * migrations/025_consent_preferences.sql) — same model as any ESP's
 * unsubscribe link. Every save here hits the real backend, which is also
 * the same gate a send has to pass through server-side — this page can
 * never be the only thing standing between a contact and more messages.
 */
export default function PreferenceCenter({ token }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [draft, setDraft] = useState({});
  const [globalOptOut, setGlobalOptOut] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/marketing/preferences/${token}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'This preference link is invalid or has expired.');
        return body;
      })
      .then((data) => {
        if (cancelled) return;
        setState({ loading: false, error: null, data });
        setDraft(Object.fromEntries(Object.entries(data.channels).map(([ch, info]) => [ch, info.status !== 'opted_out'])));
        setGlobalOptOut(!!data.globalOptOutAt);
      })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err.message, data: null }); });
    return () => { cancelled = true; };
  }, [token]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const data = state.data;
      const channelsOnFile = data ? Object.keys(CHANNEL_META).filter((ch) => (ch === 'email' ? !!data.email : !!data.phone)) : [];
      const channels = Object.fromEntries(
        Object.keys(draft)
          .filter((ch) => channelsOnFile.includes(ch))
          .map((ch) => [ch, draft[ch] ? 'opted_in' : 'opted_out'])
      );
      const res = await fetch(`${API_BASE}/marketing/preferences/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels, globalOptOut })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not save your preferences.');
      setState((s) => ({ ...s, data: body }));
      setSaved(true);
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }));
    } finally {
      setSaving(false);
    }
  };

  if (state.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-page">
        <div className="w-full max-w-md flex flex-col gap-3">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (state.error && !state.data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-page">
        <div className="w-full max-w-md">
          <Panel>
            <EmptyState title="Link not found" description={state.error} />
          </Panel>
        </div>
      </div>
    );
  }

  const { data } = state;
  const availableChannels = Object.keys(CHANNEL_META).filter((ch) => (ch === 'email' ? !!data.email : !!data.phone));

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-page">
      <div className="w-full max-w-md flex flex-col gap-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">Communication preferences</h1>
          <p className="text-xs text-muted mt-1">
            {data.displayName ? `For ${data.displayName}. ` : ''}Choose how we can reach you. Changes apply immediately.
          </p>
        </div>

        <Panel className="p-5 flex flex-col gap-4">
          {saved && (
            <Banner tone="success" icon={Check}>Your preferences have been saved.</Banner>
          )}
          {state.error && <Banner tone="danger">{state.error}</Banner>}

          <fieldset className="flex flex-col gap-3" disabled={globalOptOut}>
            <legend className="text-xs font-medium text-muted mb-1">Channels</legend>
            {availableChannels.map((channel) => {
              const meta = CHANNEL_META[channel];
              const Icon = meta.icon;
              return (
                <label key={channel} className="flex items-center gap-3 cursor-pointer select-none">
                  <Checkbox
                    checked={!!draft[channel]}
                    onChange={(e) => setDraft((d) => ({ ...d, [channel]: e.target.checked }))}
                    aria-label={`Receive marketing messages via ${meta.label}`}
                  />
                  <Icon size={16} className="text-muted" aria-hidden="true" />
                  <span className="text-sm text-ink">{meta.label}</span>
                </label>
              );
            })}
            {availableChannels.length === 0 && (
              <p className="text-xs text-muted">No contactable channel on file.</p>
            )}
          </fieldset>

          <div className="pt-3 border-t border-hairline">
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <Checkbox
                checked={globalOptOut}
                onChange={(e) => setGlobalOptOut(e.target.checked)}
                aria-label="Unsubscribe from all marketing communications"
              />
              <span className="text-sm text-ink">Unsubscribe me from everything</span>
            </label>
            <p className="text-xs text-muted mt-1 ml-7">Overrides every channel above, even if left checked.</p>
          </div>

          <Button variant="primary" onClick={handleSave} loading={saving} full>
            Save preferences
          </Button>
        </Panel>
      </div>
    </div>
  );
}
