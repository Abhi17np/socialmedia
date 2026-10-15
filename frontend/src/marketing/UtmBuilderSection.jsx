'use client';

import { useState } from 'react';
import { Link2, Copy, Check } from 'lucide-react';
import { Panel, PanelHeader, Field, Input, Button } from '../ui';

/**
 * Phase 10: a pure client-side UTM link builder — closes the "UTM
 * builder" item in Module H's workspace list. No backend needed: the
 * campaigns/forms this links to already capture whatever UTM params
 * show up on the resulting URL (routes/leadForms.js stores
 * utm_source/medium/campaign/term/content on every submission; the same
 * params on any link into this app's own pages are read the same way).
 * This tool only generates the tagged URL a tenant pastes into an ad,
 * social post, or email — it never needs to call the API.
 */
export default function UtmBuilderSection() {
  const [fields, setFields] = useState({ url: '', source: '', medium: '', campaign: '', term: '', content: '' });
  const [copied, setCopied] = useState(false);

  const set = (key) => (e) => { setFields((f) => ({ ...f, [key]: e.target.value })); setCopied(false); };

  let generated = '';
  let urlError = null;
  if (fields.url.trim()) {
    try {
      const u = new URL(fields.url.trim());
      if (fields.source.trim()) u.searchParams.set('utm_source', fields.source.trim());
      if (fields.medium.trim()) u.searchParams.set('utm_medium', fields.medium.trim());
      if (fields.campaign.trim()) u.searchParams.set('utm_campaign', fields.campaign.trim());
      if (fields.term.trim()) u.searchParams.set('utm_term', fields.term.trim());
      if (fields.content.trim()) u.searchParams.set('utm_content', fields.content.trim());
      generated = u.toString();
    } catch {
      urlError = 'Enter a full URL, including https://';
    }
  }

  const copy = () => {
    navigator.clipboard.writeText(generated).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="UTM builder" meta="Tag a link so its traffic shows up by source/medium/campaign" />
      <div className="p-4 flex flex-col gap-3 max-w-xl">
        <Field label="Destination URL"><Input placeholder="https://example.com/pricing" value={fields.url} onChange={set('url')} /></Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Source" hint="e.g. newsletter, linkedin, google"><Input value={fields.source} onChange={set('source')} /></Field>
          <Field label="Medium" hint="e.g. email, social, cpc"><Input value={fields.medium} onChange={set('medium')} /></Field>
          <Field label="Campaign" hint="e.g. autumn_sale"><Input value={fields.campaign} onChange={set('campaign')} /></Field>
          <Field label="Term (optional)" hint="paid search keyword"><Input value={fields.term} onChange={set('term')} /></Field>
        </div>
        <Field label="Content (optional)" hint="distinguishes two links to the same place, e.g. header_cta vs. footer_cta"><Input value={fields.content} onChange={set('content')} /></Field>

        {urlError && <p className="text-xs text-danger">{urlError}</p>}
        {generated && (
          <div className="pt-2 border-t border-hairline">
            <div className="eyebrow mb-1.5">Tagged link</div>
            <div className="flex items-start gap-2">
              <code className="flex-1 text-[11px] bg-canvas border border-hairline rounded-ui px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-all">{generated}</code>
              <Button size="sm" icon={copied ? Check : Copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
          </div>
        )}
        {!fields.url.trim() && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Link2 size={14} /> Enter a destination URL to start building a tagged link.
          </div>
        )}
      </div>
    </Panel>
  );
}
