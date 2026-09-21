"use client";

import type { AvatarState } from "@/lib/avatar-context";

/**
 * "Mitra Didi" — Open Peeps (Pablo Stanley), CC0 / public domain, no
 * attribution required. ONE hand-picked head + smiling-face + hair
 * combination (face: smileBig, head: medium1), generated once offline
 * and committed as a static SVG at public/guide-human.svg — never
 * generated per-user. See AVATAR-PLAN.md for the gender/ethnicity
 * consideration this variant deliberately carries.
 *
 * Served from /public so it works as a plain static asset under
 * next.config.mjs's `output: "export"` — no runtime generation, no
 * bundler SVG loader required.
 */
export function HumanAvatar({ state, size }: { state: AvatarState; size: number }) {
  return (
    <span
      aria-hidden="true"
      className={`guide-avatar-human guide-avatar-state-${state}`}
      style={{ display: "inline-block", width: size, height: size, lineHeight: 0 }}
    >
      <img src="/guide-human.svg" width={size} height={size} alt="" draggable={false} />

      <style>{`
        .guide-avatar-human { transform-origin: center bottom; }
        .guide-avatar-human img { width: 100%; height: 100%; display: block; }

        .guide-avatar-state-idle { animation: human-breathe 3.2s ease-in-out infinite; }
        .guide-avatar-state-listening { animation: human-breathe 1.4s ease-in-out infinite; }
        .guide-avatar-state-thinking { animation: human-sway 1.1s ease-in-out infinite; }
        .guide-avatar-state-delivering { animation: human-bob 0.9s ease-in-out infinite; }

        @keyframes human-breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }
        @keyframes human-sway {
          0%, 100% { transform: rotate(-2deg); }
          50% { transform: rotate(2deg); }
        }
        @keyframes human-bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }

        @media (prefers-reduced-motion: reduce) {
          .guide-avatar-human { animation: none !important; }
        }
      `}</style>
    </span>
  );
}
