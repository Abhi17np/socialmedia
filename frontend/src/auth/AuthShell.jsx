'use client';

import React from 'react';
import { Hexagon } from 'lucide-react';

/*
 * Shared split-screen frame for Log in and Create workspace.
 *
 * The brand half is a single flat near-black field — the Calm Precision
 * correction to the indigo gradient the first pass produced. Hierarchy
 * comes from one large tight headline and plenty of space, not from a
 * card, an icon list or a glow.
 */
export default function AuthShell({ headline, sub, points, children }) {
  return (
    <div className="min-h-full flex bg-canvas">
      <div className="hidden lg:flex w-[46%] max-w-[620px] flex-col justify-between p-10 bg-[#111118] text-white">
        <div className="flex items-center gap-2.5">
          <span className="w-6 h-6 rounded bg-brand flex items-center justify-center">
            <Hexagon size={14} />
          </span>
          <span className="font-semibold text-sm tracking-tight">Social Hub</span>
        </div>

        <div className="max-w-[420px]">
          <h2 className="text-[36px] leading-[1.15] font-semibold tracking-[-0.02em]">{headline}</h2>
          <p className="mt-4 text-[13px] leading-relaxed text-white/60">{sub}</p>
          <div className="mt-8 flex flex-col gap-3">
            {points.map((p) => (
              <p key={p} className="text-[13px] text-white/70 leading-relaxed">
                {p}
              </p>
            ))}
          </div>
        </div>

        <p className="text-[11px] text-white/35">© {new Date().getFullYear()} Social Hub</p>
      </div>

      <div className="flex-1 flex items-center justify-center p-6 bg-card">
        <div className="w-full max-w-[360px]">
          <div className="lg:hidden flex items-center gap-2.5 mb-8">
            <span className="w-6 h-6 rounded bg-brand text-white flex items-center justify-center">
              <Hexagon size={14} />
            </span>
            <span className="font-semibold text-sm tracking-tight text-ink">Social Hub</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
