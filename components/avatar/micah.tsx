"use client";

import type { AvatarState } from "@/lib/avatar-context";

/**
 * "Radha" — DiceBear Micah (by Micah Lanier), CC BY 4.0. UNLIKE the other
 * four variants, this license REQUIRES visible attribution — see the
 * credit line rendered next to this option in switcher.tsx. Do not remove
 * that credit or reuse this asset elsewhere without carrying it along.
 *
 * ONE fixed hand-picked illustration, generated offline and committed as
 * a static SVG at public/guide-micah.svg — never generated per-user, same
 * rule as every other variant (see AVATAR-PLAN.md: an ambassador must be
 * one identical character for every citizen, not a seeded/random face).
 *
 * Served from /public so it works as a plain static asset under
 * next.config.mjs's `output: "export"` — no runtime generation needed.
 */
export function MicahAvatar({ state, size }: { state: AvatarState; size: number }) {
  return (
    <span
      aria-hidden="true"
      className={`guide-avatar-micah guide-avatar-state-${state}`}
      style={{ display: "inline-block", width: size, height: size, lineHeight: 0 }}
    >
      <img src="/guide-micah.svg" width={size} height={size} alt="" draggable={false} />

      <style>{`
        .guide-avatar-micah { transform-origin: center bottom; }
        .guide-avatar-micah img { width: 100%; height: 100%; display: block; }

        .guide-avatar-state-idle { animation: micah-breathe 3.2s ease-in-out infinite; }
        .guide-avatar-state-listening { animation: micah-breathe 1.4s ease-in-out infinite; }
        .guide-avatar-state-thinking { animation: micah-sway 1.1s ease-in-out infinite; }
        .guide-avatar-state-delivering { animation: micah-bob 0.9s ease-in-out infinite; }

        @keyframes micah-breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }
        @keyframes micah-sway {
          0%, 100% { transform: rotate(-2deg); }
          50% { transform: rotate(2deg); }
        }
        @keyframes micah-bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }

        @media (prefers-reduced-motion: reduce) {
          .guide-avatar-micah { animation: none !important; }
        }
      `}</style>
    </span>
  );
}
