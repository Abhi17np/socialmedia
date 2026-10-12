'use client';

import React from 'react';
import { Search } from 'lucide-react';
import { cx, Stamp } from './index';

/*
 * Page scaffolding. The shell owns the sidebar; each page owns its own
 * 56px top bar so it can put its real primary action and its real search
 * there, rather than the shell guessing through context.
 *
 * <Page> is a non-scrolling flex column: <PageBar> is fixed at the top and
 * <PageBody> scrolls. A pane-based screen (Inbox) skips PageBody and lays
 * its own panes into the remaining height instead.
 */

export function Page({ className, children }) {
  return <div className={cx('h-full flex flex-col min-w-0 overflow-hidden', className)}>{children}</div>;
}

export function PageBar({ title, count, search, onSearch, searchPlaceholder, actions, children }) {
  return (
    <header className="h-14 shrink-0 bg-card border-b border-hairline px-4 flex items-center justify-between gap-3 z-10">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="flex items-center gap-2 shrink-0">
          <h1 className="text-sm font-semibold tracking-tight text-ink">{title}</h1>
          {count !== undefined && count !== null && <Stamp>{count}</Stamp>}
        </div>

        {onSearch && (
          <div className="relative flex-1 max-w-md ml-1 hidden md:block">
            <span className="absolute inset-y-0 left-2.5 flex items-center pointer-events-none text-subtle">
              <Search size={15} />
            </span>
            <input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder={searchPlaceholder || 'Search…'}
              className="w-full h-8 pl-8 pr-3 text-xs bg-canvas hover:bg-sunken focus:bg-card border border-hairline rounded-ui
                         placeholder:text-subtle text-ink outline-none transition-colors focus:border-brand"
            />
          </div>
        )}

        {children}
      </div>

      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}

export function PageBody({ className, children, width = 'wide' }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div
        className={cx(
          'px-6 py-5 flex flex-col gap-5',
          width === 'narrow' ? 'max-w-3xl' : 'max-w-[1280px]',
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
