'use client';

import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { API_BASE } from '../apiBase';
import { Button, Input } from '../ui';

const MKT_API_BASE = `${API_BASE}/marketing`;

/**
 * Phase 9: one small "Generate with AI" affordance shared by every AI
 * Assist surface (email copy, SMS copy, NL segment builder, overview
 * insights) instead of four near-duplicate inline forms. Every result is
 * handed to the caller via onResult for the human to review/edit before
 * anything saves or sends — this component never submits on its own.
 */
export default function AiGenerateButton({ endpoint, authFetch, buildBody, onResult, label = 'Generate with AI', placeholder = 'Describe what you want…' }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${MKT_API_BASE}/ai/${endpoint}`, { method: 'POST', body: JSON.stringify(buildBody(input)) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI Assist failed.');
      onResult(data);
      setOpen(false);
      setInput('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" icon={Sparkles} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 p-2 border border-hairline rounded-ui bg-canvas">
      <div className="flex items-center gap-1.5">
        <Input
          className="h-8 flex-1 text-xs"
          autoFocus
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && input.trim() && run()}
        />
        <Button type="button" size="sm" disabled={!input.trim() || loading} loading={loading} onClick={run}>Generate</Button>
        <button type="button" className="text-muted shrink-0" onClick={() => { setOpen(false); setError(null); }} aria-label="Cancel">
          <X size={14} />
        </button>
      </div>
      {error && <div className="text-[11px] text-danger">{error}</div>}
    </div>
  );
}
