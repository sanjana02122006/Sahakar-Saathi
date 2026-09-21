"use client";

import { createAvatar } from "@dicebear/core";
import { bottts } from "@dicebear/collection";
import type { AvatarState } from "@/lib/avatar-context";

/**
 * "Seva" — DiceBear Bottts, pinned to ONE hardcoded seed and a locked teal
 * palette so every user sees the identical robot, never a per-user
 * generated face. Generated ONCE at module scope (not per render, not from
 * any user id) and reused as a static data URI — no runtime network call,
 * required by next.config.mjs's `output: "export"`.
 *
 * LICENSE CAVEAT (see AVATAR-PLAN.md): Bottts ships under the artist's own
 * terms (free for personal + commercial use), not a standard OSI/CC
 * license. Fine for this throwaway comparison deploy — if this variant
 * wins, get the terms reviewed before any real government launch.
 */
const SEVA_URI = createAvatar(bottts, {
  seed: "seva-fixed-guide-v1",
  baseColor: ["20796f"], // hsl(var(--primary)) resolved to hex — locked, not randomized
  mouth: ["smile02"], // wide curved-arc mouth — "always happy" rule
  eyes: ["happy"],
  top: ["antenna"],
  radius: 0,
}).toDataUriSync();

export function RobotAvatar({ state, size }: { state: AvatarState; size: number }) {
  return (
    <span
      aria-hidden="true"
      className={`guide-avatar-robot guide-avatar-state-${state}`}
      style={{ display: "inline-block", width: size, height: size, lineHeight: 0 }}
    >
      <img src={SEVA_URI} width={size} height={size} alt="" draggable={false} />

      <style>{`
        .guide-avatar-robot { transform-origin: center bottom; }
        .guide-avatar-robot img { width: 100%; height: 100%; display: block; }

        .guide-avatar-state-idle { animation: robot-breathe 3.2s ease-in-out infinite; }
        .guide-avatar-state-listening { animation: robot-breathe 1.4s ease-in-out infinite; }
        /* thinking: antenna bobs — cheerful concentration, never a frown */
        .guide-avatar-state-thinking { animation: robot-antenna-bob 0.9s ease-in-out infinite; }
        .guide-avatar-state-delivering { animation: robot-bob 0.9s ease-in-out infinite; }

        @keyframes robot-breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }
        @keyframes robot-antenna-bob {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          50% { transform: translateY(-2px) rotate(-4deg); }
        }
        @keyframes robot-bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }

        @media (prefers-reduced-motion: reduce) {
          .guide-avatar-robot { animation: none !important; }
        }
      `}</style>
    </span>
  );
}
