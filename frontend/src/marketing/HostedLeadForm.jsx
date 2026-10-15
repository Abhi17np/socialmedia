'use client';

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Button, Checkbox, Input, Textarea, Select, Field, Banner, Panel, Skeleton, EmptyState } from '../ui';

/**
 * The hosted, public, no-login lead-capture form (backend/lib/leadForms.js,
 * routes/leadForms.js's publicRouter) — the "public API" this round's
 * lead-capture work actually ships: a tenant embeds this page's URL (or
 * an iframe pointing at it) on their own site, and every real submission
 * becomes a real Sales Hub contact server-side. The honeypot field below
 * is invisible to a human (off-screen, not display:none — some bots
 * skip hidden fields but still fill in off-screen ones, so this uses
 * both: visually hidden AND empty-by-default, never pre-filled).
 */
const VISITOR_ID_KEY = '_mkt_visitor_id';
function getVisitorId() {
  try {
    let id = localStorage.getItem(VISITOR_ID_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(VISITOR_ID_KEY, id); }
    return id;
  } catch {
    return crypto.randomUUID(); // localStorage blocked (private mode) — still track this one beacon, just not persistently
  }
}

export default function HostedLeadForm({ formId }) {
  const [state, setState] = useState({ loading: true, error: null, form: null });
  const [values, setValues] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { message, redirectUrl, consentPending } once submitted
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/public/forms/${formId}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'This form is not available.');
        return body;
      })
      .then((form) => { if (!cancelled) setState({ loading: false, error: null, form }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err.message, form: null }); });
    return () => { cancelled = true; };
  }, [formId]);

  // A page-view-then-submit on this exact hosted form page is tracked
  // and attributed even if the tenant never separately embeds the
  // tracking snippet (routes/tracking.js) — same visitor id, same
  // beacon, just fired here instead of from an external <script> tag.
  useEffect(() => {
    if (!state.form?.tenantId) return;
    const visitorId = getVisitorId();
    const body = JSON.stringify({ tenantId: state.form.tenantId, visitorId, url: window.location.href, referrer: document.referrer });
    if (navigator.sendBeacon) navigator.sendBeacon(`${API_BASE}/track/pageview`, new Blob([body], { type: 'application/json' }));
    else fetch(`${API_BASE}/track/pageview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }, [state.form?.tenantId]);

  useEffect(() => {
    if (state.form && result?.redirectUrl) {
      window.location.href = result.redirectUrl;
    }
  }, [result, state.form]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const params = new URLSearchParams(window.location.search);
      const res = await fetch(`${API_BASE}/public/forms/${formId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: values,
          hp: values._hp || '',
          visitorId: getVisitorId(),
          utmSource: params.get('utm_source') || undefined,
          utmMedium: params.get('utm_medium') || undefined,
          utmCampaign: params.get('utm_campaign') || undefined,
          utmTerm: params.get('utm_term') || undefined,
          utmContent: params.get('utm_content') || undefined
        })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not submit the form.');
      setResult(body);
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (state.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-page">
        <div className="w-full max-w-md flex flex-col gap-3">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-page">
        <div className="w-full max-w-md"><Panel><EmptyState title="Form not found" description={state.error} /></Panel></div>
      </div>
    );
  }

  const { form } = state;

  if (result) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-page">
        <div className="w-full max-w-md">
          <Panel className="p-6 flex flex-col items-center text-center gap-3">
            <Check size={32} className="text-success" />
            <p className="text-sm text-ink">{result.message}</p>
            {result.consentPending && <p className="text-xs text-muted">Check your inbox to confirm your subscription.</p>}
          </Panel>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-page">
      <div className="w-full max-w-md flex flex-col gap-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">{form.name}</h1>
          {form.description && <p className="text-xs text-muted mt-1">{form.description}</p>}
        </div>
        <Panel className="p-5">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {submitError && <Banner tone="danger">{submitError}</Banner>}
            {form.fields.map((field) => (
              <Field key={field.key} label={`${field.label}${field.required ? ' *' : ''}`}>
                {field.type === 'textarea' ? (
                  <Textarea rows={3} required={field.required} value={values[field.key] || ''} onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))} />
                ) : field.type === 'select' ? (
                  <Select required={field.required} value={values[field.key] || ''} onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}>
                    <option value="">Select…</option>
                    {field.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </Select>
                ) : field.type === 'checkbox' ? (
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <Checkbox checked={!!values[field.key]} onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.checked ? 'yes' : '' }))} />
                  </label>
                ) : (
                  <Input
                    type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'}
                    required={field.required}
                    value={values[field.key] || ''}
                    onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}

            {form.consentRequired && (
              <p className="text-[11px] text-muted">{form.consentText}</p>
            )}

            {/* Honeypot — real visitors never see this; a bot filling every field will. */}
            <div className="absolute -left-[9999px] w-px h-px overflow-hidden" aria-hidden="true">
              <label htmlFor="_hp">Leave this field empty</label>
              <input id="_hp" name="_hp" type="text" tabIndex={-1} autoComplete="off" value={values._hp || ''} onChange={(e) => setValues((v) => ({ ...v, _hp: e.target.value }))} />
            </div>

            <Button type="submit" variant="primary" loading={submitting} full>Submit</Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}
