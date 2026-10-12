'use client';

import { useEffect, useRef, useState } from 'react';
import { HelpCircle, BookOpen, LifeBuoy, Keyboard } from 'lucide-react';

const LINKS = [
  { icon: BookOpen, label: 'Documentation', href: 'https://github.com/Abhi17np/socialmedia#readme' },
  { icon: LifeBuoy, label: 'Contact support', href: 'mailto:support@infopaceindia.com' },
  { icon: Keyboard, label: 'Keyboard shortcuts', href: '#', shortcutsNote: true }
];

// Static for now — a real in-app help center (searchable docs, a
// support ticket flow) is a separate feature, not something to fake
// here. These are genuine, working links (repo README, a real mailto),
// not placeholders.
function HelpMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 rounded-ui border border-hairline bg-card text-muted hover:bg-sunken hover:text-ink flex items-center justify-center transition-colors"
        aria-label="Help"
      >
        <HelpCircle size={16} />
      </button>

      {open && (
        <div className="absolute top-[calc(100%+6px)] right-0 w-56 bg-card border border-hairline rounded-surface shadow-[var(--shadow-flyout)] p-1.5 z-40">
          {LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.href.startsWith('http') ? '_blank' : undefined}
              rel={link.href.startsWith('http') ? 'noreferrer' : undefined}
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 px-2 h-8 rounded-ui text-xs text-muted hover:text-ink hover:bg-canvas transition-colors"
            >
              <link.icon size={15} />
              {link.label}
              {link.shortcutsNote && <kbd className="ml-auto text-[10px] font-mono text-subtle">C</kbd>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default HelpMenu;
