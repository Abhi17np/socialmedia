'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Search, X, Building2, Users, FileText, Megaphone } from 'lucide-react';
import { API_BASE } from '../apiBase';

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;

// Real cross-hub search, not a mockup — every result below comes from
// an existing, already-authenticated route this app already serves;
// nothing here is a second search index. Categories whose Hub isn't
// enabled for this tenant are skipped silently (their endpoint would
// 403) rather than shown as an error, same as the rest of the app
// treats a disabled Hub. Companies/Leads use each route's own
// server-side `search` param; WhatsApp templates and Marketing
// campaigns have no server-side search yet, so those two are fetched
// and filtered client-side — fine at the list sizes a single tenant
// actually has, and still real data, just not server-filtered.
function GlobalSearch({ authFetch, hubsEnabled }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (query.trim().length < MIN_CHARS) {
      setResults(null);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const runSearch = async (q) => {
    setLoading(true);
    const categories = [];

    const tasks = [];
    if (hubsEnabled?.sales) {
      tasks.push(
        authFetch(`${API_BASE}/sales/companies?search=${encodeURIComponent(q)}&pageSize=5`)
          .then((r) => r.json())
          .then((d) => { if (d.companies?.length) categories.push({ key: 'companies', label: 'Companies', icon: Building2, href: '/sales?tab=companies', items: d.companies.map((c) => ({ id: c.id, title: c.name, subtitle: c.industry || c.domain || '' })) }); })
          .catch(() => {})
      );
      tasks.push(
        authFetch(`${API_BASE}/sales/contacts?search=${encodeURIComponent(q)}&pageSize=5`)
          .then((r) => r.json())
          .then((d) => { if (d.contacts?.length) categories.push({ key: 'contacts', label: 'Leads', icon: Users, href: '/sales?tab=contacts', items: d.contacts.map((c) => ({ id: c.id, title: c.display_name, subtitle: c.phone || c.email || '' })) }); })
          .catch(() => {})
      );
    }
    tasks.push(
      authFetch(`${API_BASE}/whatsapp/templates`)
        .then((r) => r.json())
        .then((d) => {
          const matches = (d.templates || []).filter((t) => t.name.toLowerCase().includes(q.toLowerCase())).slice(0, 5);
          if (matches.length) categories.push({ key: 'templates', label: 'WhatsApp templates', icon: FileText, href: '/whatsapp', items: matches.map((t) => ({ id: t.id, title: t.name, subtitle: t.approval_status })) });
        })
        .catch(() => {})
    );
    if (hubsEnabled?.marketing) {
      tasks.push(
        authFetch(`${API_BASE}/marketing/campaigns`)
          .then((r) => r.json())
          .then((d) => {
            const matches = (d.campaigns || []).filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 5);
            if (matches.length) categories.push({ key: 'campaigns', label: 'Marketing campaigns', icon: Megaphone, href: '/marketing?tab=campaigns', items: matches.map((c) => ({ id: c.id, title: c.name, subtitle: c.status })) });
          })
          .catch(() => {})
      );
    }

    await Promise.all(tasks);
    setResults(categories);
    setLoading(false);
  };

  const totalCount = (results || []).reduce((sum, c) => sum + c.items.length, 0);

  return (
    <div className="relative flex-1 max-w-md" ref={ref}>
      <span className="absolute inset-y-0 left-2.5 flex items-center pointer-events-none text-subtle">
        <Search size={15} />
      </span>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder="Search companies, leads, templates, campaigns…"
        className="w-full h-8 pl-8 pr-8 text-xs bg-canvas hover:bg-sunken focus:bg-card border border-hairline rounded-ui
                   placeholder:text-subtle text-ink outline-none transition-colors focus:border-brand"
      />
      {query && (
        <button
          onClick={() => { setQuery(''); setResults(null); }}
          className="absolute inset-y-0 right-2.5 flex items-center text-subtle hover:text-ink"
          aria-label="Clear search"
        >
          <X size={14} />
        </button>
      )}

      {open && query.trim().length >= MIN_CHARS && (
        <div className="absolute top-[calc(100%+6px)] left-0 w-[420px] max-h-[70vh] overflow-y-auto bg-card border border-hairline rounded-surface shadow-[var(--shadow-flyout)] p-1.5 z-40">
          {loading && <div className="px-3 py-4 text-xs text-muted">Searching…</div>}
          {!loading && (results === null || totalCount === 0) && (
            <div className="px-3 py-4 text-xs text-muted">No matches for &quot;{query}&quot;.</div>
          )}
          {!loading && results && results.map((cat) => (
            <div key={cat.key} className="mb-1 last:mb-0">
              <div className="eyebrow px-2 pt-1.5 pb-1">{cat.label}</div>
              {cat.items.map((item) => (
                <Link
                  key={item.id}
                  href={cat.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 px-2 py-1.5 rounded-ui hover:bg-canvas transition-colors"
                >
                  <cat.icon size={14} className="text-subtle shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-xs text-ink">{item.title}</span>
                  {item.subtitle && <span className="text-[11px] text-subtle shrink-0 truncate max-w-[120px]">{item.subtitle}</span>}
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default GlobalSearch;
