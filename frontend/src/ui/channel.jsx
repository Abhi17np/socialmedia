'use client';

import React from 'react';
import { PlatformIcon } from '../social/PlatformIcon';
import { PLATFORM_LABELS, PLATFORM_COLORS } from '../social/api';
import { cx } from './index';

/*
 * Channel identity is operational metadata, not decoration. DESIGN.md
 * restricts these hues to three shapes and nothing else:
 *   ChannelDot      — a 6–8px brand-mark glyph in lists and nav
 *   ChannelBadge    — a 12–14px stamp overlaid on an avatar
 *   ChannelStamp    — a neutral pill carrying the glyph plus a handle
 * A channel color never fills a card, a header or a sidebar.
 */

export const channelColor = (platform) => PLATFORM_COLORS[platform] || '#9a9aa8';
export const channelLabel = (platform) => PLATFORM_LABELS[platform] || platform;

export function ChannelDot({ platform, size = 8, className }) {
  return (
    <span
      className={cx('shrink-0 inline-flex items-center justify-center', className)}
      style={{ width: size, height: size, color: channelColor(platform) }}
      title={channelLabel(platform)}
    >
      <PlatformIcon platform={platform} size={size} />
    </span>
  );
}

/* Sits on the corner of an avatar — the ring keeps it legible on any row tint. */
export function ChannelBadge({ platform, size = 14, ring = 'ring-card', className }) {
  return (
    <span
      className={cx(
        'absolute -bottom-0.5 -right-0.5 rounded-full flex items-center justify-center text-white ring-2',
        ring,
        className
      )}
      style={{ width: size, height: size, background: channelColor(platform) }}
      title={channelLabel(platform)}
    >
      <PlatformIcon platform={platform} size={Math.round(size * 0.58)} />
    </span>
  );
}

/* Neutral pill, channel-colored glyph only. */
export function ChannelStamp({ platform, label, className }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full',
        'bg-sunken border border-hairline text-[11px] font-medium text-ink whitespace-nowrap',
        className
      )}
    >
      <span style={{ color: channelColor(platform) }} className="flex items-center">
        <PlatformIcon platform={platform} size={11} />
      </span>
      {label || channelLabel(platform)}
    </span>
  );
}

/* A square account avatar for our own connected accounts. */
export function ChannelTile({ platform, size = 32, className }) {
  return (
    <span
      className={cx(
        'rounded-[8px] bg-sunken border border-hairline flex items-center justify-center shrink-0',
        className
      )}
      style={{ width: size, height: size, color: channelColor(platform) }}
    >
      <PlatformIcon platform={platform} size={Math.round(size * 0.5)} />
    </span>
  );
}

/*
 * The channel filter row shared by Posts and Inbox. The active channel is
 * marked by the neutral selected state plus its own dot — not by flooding
 * the control with the channel color.
 */
export function ChannelFilterTabs({ platforms, value, onChange, counts, className }) {
  return (
    <div className={cx('flex items-center gap-1.5 overflow-x-auto', className)}>
      <button
        type="button"
        onClick={() => onChange('')}
        className={cx(
          'h-6 px-2.5 rounded-full border text-[11px] shrink-0 transition-colors',
          value === ''
            ? 'bg-canvas border-hairline text-ink font-medium'
            : 'bg-card border-hairline text-muted hover:bg-canvas hover:text-ink'
        )}
      >
        All
      </button>
      {platforms.map((p) => {
        const active = value === p;
        return (
          <button
            key={p}
            type="button"
            onClick={() => onChange(active ? '' : p)}
            title={channelLabel(p)}
            className={cx(
              'h-6 pl-1.5 pr-2.5 rounded-full border text-[11px] shrink-0 transition-colors',
              'flex items-center gap-1.5',
              active
                ? 'bg-canvas border-hairline text-ink font-medium'
                : 'bg-card border-hairline text-muted hover:bg-canvas hover:text-ink'
            )}
          >
            <ChannelDot platform={p} size={6} />
            <span>{channelLabel(p)}</span>
            {counts && counts[p] !== undefined && (
              <span className="tabular-nums text-subtle">{counts[p]}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export { PlatformIcon };
