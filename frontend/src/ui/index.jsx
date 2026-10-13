'use client';

import React from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';

/*
 * The component set DESIGN.md specifies, built once here so no screen
 * invents its own button height or border color. Everything is flat by
 * default: a white surface on the canvas separated by one hairline, with
 * shadow reserved for things that genuinely float (Drawer, Modal, Menu).
 */

export const cx = (...parts) => parts.filter(Boolean).join(' ');

/* ---------------------------------------------------------------- Button */

const BUTTON_VARIANTS = {
  primary: 'bg-brand hover:bg-brand-hover active:bg-brand-active text-white border border-transparent',
  secondary: 'bg-card hover:bg-sunken text-ink border border-hairline',
  ghost: 'bg-transparent hover:bg-sunken text-muted hover:text-ink border border-transparent',
  danger: 'bg-card hover:bg-danger-subtle text-danger border border-danger-border'
};

const BUTTON_SIZES = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-xs gap-1.5',
  lg: 'h-9 px-4 text-[13px] gap-2'
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading = false,
  full = false,
  className,
  children,
  disabled,
  ...rest
}) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center rounded-ui font-medium whitespace-nowrap transition-colors',
        'disabled:opacity-50 disabled:pointer-events-none',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        full && 'w-full',
        className
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <Loader2 size={14} className="animate-[spin_1s_linear_infinite]" />
      ) : (
        Icon && <Icon size={size === 'lg' ? 16 : 15} className="shrink-0" />
      )}
      {children}
      {IconRight && <IconRight size={14} className="shrink-0" />}
    </button>
  );
}

export function IconButton({ icon: Icon, label, size = 18, className, ...rest }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cx(
        'w-8 h-8 rounded-ui border border-hairline bg-card text-muted',
        'hover:bg-sunken hover:text-ink flex items-center justify-center transition-colors shrink-0',
        className
      )}
      {...rest}
    >
      <Icon size={size} />
    </button>
  );
}

/* ----------------------------------------------------------------- Input */

export function Input({ className, icon: Icon, ...rest }) {
  if (Icon) {
    return (
      <div className="relative w-full">
        <span className="absolute inset-y-0 left-2.5 flex items-center pointer-events-none text-subtle">
          <Icon size={15} />
        </span>
        <input
          className={cx(
            'w-full h-8 pl-8 pr-3 text-xs bg-card border border-hairline rounded-ui text-ink',
            'placeholder:text-subtle transition-colors outline-none',
            'focus:border-brand focus:ring-3 focus:ring-brand/15',
            className
          )}
          {...rest}
        />
      </div>
    );
  }
  return (
    <input
      className={cx(
        'w-full h-8 px-2.5 text-xs bg-card border border-hairline rounded-ui text-ink',
        'placeholder:text-subtle transition-colors outline-none',
        'focus:border-brand focus:ring-3 focus:ring-brand/15',
        className
      )}
      {...rest}
    />
  );
}

export function Checkbox({ className, ...rest }) {
  return (
    <input
      type="checkbox"
      className={cx(
        'w-3.5 h-3.5 rounded-[3px] border border-hairline bg-card accent-brand cursor-pointer',
        'focus:ring-3 focus:ring-brand/15 outline-none',
        className
      )}
      {...rest}
    />
  );
}

export function Textarea({ className, ...rest }) {
  return (
    <textarea
      className={cx(
        'w-full px-2.5 py-2 text-xs bg-card border border-hairline rounded-ui text-ink leading-relaxed',
        'placeholder:text-subtle transition-colors outline-none resize-y',
        'focus:border-brand focus:ring-3 focus:ring-brand/15',
        className
      )}
      {...rest}
    />
  );
}

export function Select({ className, children, ...rest }) {
  return (
    <select
      className={cx(
        'select-ui h-8 pl-2.5 text-xs bg-card border border-hairline rounded-ui text-ink',
        'transition-colors outline-none cursor-pointer',
        'focus:border-brand focus:ring-3 focus:ring-brand/15',
        className
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      {label && <label className="text-xs font-medium text-ink">{label}</label>}
      {children}
      {hint && <p className="text-[11px] text-subtle leading-tight">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------ Pills/chips */

const CHIP_TONES = {
  neutral: 'bg-sunken text-muted border-hairline',
  brand: 'bg-brand-subtle text-brand border-transparent',
  success: 'bg-success-subtle text-success border-transparent',
  warning: 'bg-warning-subtle text-warning border-transparent',
  danger: 'bg-danger-subtle text-danger border-transparent',
  info: 'bg-info-subtle text-info border-transparent'
};

export function Chip({ tone = 'neutral', dot, className, children, ...rest }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full border',
        'text-[11px] font-medium leading-none whitespace-nowrap',
        CHIP_TONES[tone],
        className
      )}
      {...rest}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />}
      {children}
    </span>
  );
}

/* A count or key/value stamp — the "42 open" next to a page title. */
export function Stamp({ className, children }) {
  return (
    <span
      className={cx(
        'text-[11px] tabular-nums font-medium text-muted px-1.5 py-0.5',
        'rounded bg-canvas border border-hairline whitespace-nowrap',
        className
      )}
    >
      {children}
    </span>
  );
}

export function FilterPill({ active, className, children, ...rest }) {
  return (
    <button
      type="button"
      className={cx(
        'h-6 px-2 rounded-full border text-[11px] flex items-center gap-1 shrink-0 transition-colors',
        active
          ? 'bg-canvas border-hairline text-ink font-medium'
          : 'bg-card border-hairline text-muted hover:bg-canvas hover:text-ink',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* A select that reads as a filter pill — keeps native behaviour. */
export function PillSelect({ className, children, ...rest }) {
  return (
    <select
      className={cx(
        'select-ui h-6 pl-2 rounded-full bg-card border border-hairline text-[11px] text-muted',
        'hover:bg-canvas hover:text-ink cursor-pointer outline-none transition-colors',
        'focus:border-brand',
        className
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/* ------------------------------------------------------------- Structure */

/* One flat white region with a hairline — never nested inside another. */
export function Panel({ className, children, ...rest }) {
  return (
    <section
      className={cx('bg-card border border-hairline rounded-card', className)}
      {...rest}
    >
      {children}
    </section>
  );
}

export function PanelHeader({ title, meta, action, className }) {
  return (
    <div
      className={cx(
        'h-11 px-4 flex items-center justify-between gap-3 border-b border-hairline',
        className
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <h2 className="text-[13px] font-semibold text-ink truncate">{title}</h2>
        {meta && <span className="text-[11px] text-subtle shrink-0">{meta}</span>}
      </div>
      {action}
    </div>
  );
}

export function SectionLabel({ className, children }) {
  return <div className={cx('eyebrow', className)}>{children}</div>;
}

/* ----------------------------------------------------------- KPI figures */

/*
 * Numbers are set on a flat strip divided by hairlines, not boxed one per
 * card with a colored icon chip — the single biggest tell of the generic
 * look this redesign replaced.
 */
export function StatStrip({ children, className }) {
  return (
    <div
      className={cx(
        'bg-card border border-hairline rounded-card grid divide-x divide-hairline',
        'grid-cols-2 md:grid-cols-3 xl:grid-cols-6 divide-y xl:divide-y-0 md:divide-y-0',
        className
      )}
    >
      {children}
    </div>
  );
}

export function Stat({ label, value, delta, deltaTone = 'neutral', hint }) {
  const toneClass =
    deltaTone === 'up' ? 'text-success' : deltaTone === 'down' ? 'text-danger' : 'text-subtle';
  return (
    <div className="px-4 py-3.5 min-w-0" title={hint}>
      <div className="eyebrow truncate">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[26px] leading-7 font-semibold tabular-nums text-ink tracking-tight">
          {value}
        </span>
        {delta && <span className={cx('text-[11px] font-medium tabular-nums', toneClass)}>{delta}</span>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- States */

export function Banner({ tone = 'info', icon: Icon, action, className, children }) {
  const tones = {
    info: 'bg-sunken border-hairline text-ink',
    success: 'bg-success-subtle border-transparent text-success',
    warning: 'bg-warning-subtle border-transparent text-warning',
    danger: 'bg-danger-subtle border-danger-border text-danger'
  };
  const DefaultIcon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  const Resolved = Icon || DefaultIcon;
  return (
    <div
      className={cx(
        'flex items-center gap-2.5 px-3 py-2 rounded-ui border text-xs',
        tones[tone],
        className
      )}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      <Resolved size={15} className="shrink-0" />
      <span className="flex-1 min-w-0">{children}</span>
      {action}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center text-center px-6 py-14 gap-3',
        className
      )}
    >
      {Icon && (
        <div className="w-10 h-10 rounded-full bg-sunken border border-hairline flex items-center justify-center text-subtle">
          <Icon size={18} />
        </div>
      )}
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-ink">{title}</p>
        {description && (
          <p className="text-xs text-muted max-w-sm leading-relaxed">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function Skeleton({ className }) {
  return <div className={cx('skeleton rounded-ui', className)} />;
}

export function SkeletonRows({ rows = 5, className }) {
  return (
    <div className={cx('flex flex-col', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-11 px-4 flex items-center gap-3 border-b border-hairline last:border-0">
          <Skeleton className="w-7 h-7 rounded-full" />
          <Skeleton className="h-2.5 flex-1 max-w-[40%]" />
          <Skeleton className="h-2.5 w-16 ml-auto" />
        </div>
      ))}
    </div>
  );
}

export function Spinner({ size = 14, className }) {
  return <Loader2 size={size} className={cx('animate-[spin_1s_linear_infinite]', className)} />;
}

/* ------------------------------------------------------- Floating layers */

export function Drawer({ open, onClose, title, subtitle, header, footer, width = 480, children }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[rgba(14,14,20,0.4)] animate-[fade-in_120ms_ease-out]"
      onClick={onClose}
    >
      <aside
        className="h-full bg-card border-l border-hairline flex flex-col shadow-[var(--shadow-modal)] animate-[drawer-in_160ms_ease-out] w-full"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-4 py-3 border-b border-hairline flex items-start justify-between gap-3 shrink-0">
          {header || (
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-ink truncate">{title}</h2>
              {subtitle && <p className="text-xs text-muted truncate mt-0.5">{subtitle}</p>}
            </div>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-subtle hover:text-ink p-1 -m-1 rounded transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="p-3 border-t border-hairline shrink-0">{footer}</div>}
      </aside>
    </div>
  );
}

export function Modal({ open, onClose, title, subtitle, footer, width = 440, children }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(14,14,20,0.4)] animate-[fade-in_120ms_ease-out]"
      onClick={onClose}
    >
      <div
        className="w-full bg-card border border-hairline rounded-card shadow-[var(--shadow-modal)] flex flex-col max-h-[85vh]"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-4 py-3 border-b border-hairline flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
            {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-subtle hover:text-ink p-1 -m-1 rounded transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto flex-1">{children}</div>
        {footer && (
          <div className="px-4 py-3 border-t border-hairline flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/*
 * Replaces window.confirm() for destructive actions — the system requires
 * every one of them to go through a dialog that names the consequence.
 */
export function ConfirmDialog({ open, onCancel, onConfirm, title, body, confirmLabel = 'Confirm', pending }) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width={400}
      footer={
        <>
          <Button onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-xs text-muted leading-relaxed">{body}</p>
    </Modal>
  );
}

/* ----------------------------------------------------------------- Table */

export function Table({ children, className }) {
  return (
    <table className={cx('w-full border-collapse', className)}>{children}</table>
  );
}

export function Th({ children, align = 'left', className }) {
  return (
    <th
      className={cx(
        'h-9 px-4 eyebrow font-medium border-b border-hairline bg-sunken/60',
        align === 'right' ? 'text-right' : 'text-left',
        className
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, align = 'left', className, ...rest }) {
  return (
    <td
      className={cx(
        'px-4 py-0 h-11 text-xs text-ink border-b border-hairline',
        align === 'right' ? 'text-right tabular-nums' : 'text-left',
        className
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

/* ---------------------------------------------------------------- Avatar */

const AVATAR_TINTS = ['#5b5fef', '#0d9488', '#b8690a', '#4a3aa7', '#c2410c', '#15803d', '#be185d'];

export function avatarTint(name) {
  if (!name) return AVATAR_TINTS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

export function initials(name) {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
}

/* Circles for external people, 8px rounded squares for our own accounts. */
export function Avatar({ name, size = 28, square = false, badge, className, children }) {
  return (
    <div className={cx('relative shrink-0', className)} style={{ width: size, height: size }}>
      <div
        className={cx(
          'w-full h-full flex items-center justify-center font-semibold border border-hairline bg-canvas text-ink',
          square ? 'rounded-[8px]' : 'rounded-full'
        )}
        style={{ fontSize: Math.max(9, Math.round(size * 0.38)) }}
      >
        {initials(name)}
      </div>
      {badge}
      {children}
    </div>
  );
}
