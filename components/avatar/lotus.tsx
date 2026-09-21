"use client";

import type { AvatarState } from "@/lib/avatar-context";

/**
 * "Kamal" — custom inline SVG, no third-party asset. Non-figurative: a
 * soft, generic decorative lotus/bloom that pulses, rotates and blooms
 * through states. No face — expression is carried entirely by motion
 * and the reply cloud beside it.
 *
 * HARD CONSTRAINT: must NOT resemble the State Emblem of India (the
 * Sarnath Lion Capital) or any actual state insignia, protected under the
 * State Emblem of India (Prohibition of Improper Use) Act. This is a
 * plain 8-petal bloom — no lions, no wheel rendered as an Ashoka Chakra,
 * no tricolour arrangement. Warmth comes from soft rounded petals and
 * gentle easing, not a smiley (there is no face to be sad, so the "always
 * happy" rule is satisfied by construction).
 */
export function LotusAvatar({ state, size }: { state: AvatarState; size: number }) {
  const petals = Array.from({ length: 8 }, (_, i) => i);

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      className={`guide-avatar-lotus guide-avatar-state-${state}`}
    >
      <g className="lotus-bloom" style={{ transformOrigin: "32px 32px" }}>
        {petals.map((i) => (
          <ellipse
            key={i}
            className="lotus-petal"
            cx="32"
            cy="16"
            rx="6.5"
            ry="15"
            fill={i % 2 === 0 ? "hsl(var(--primary))" : "hsl(var(--accent-foreground))"}
            opacity={i % 2 === 0 ? 0.95 : 0.55}
            style={{ transformOrigin: "32px 32px", transform: `rotate(${i * 45}deg)` }}
          />
        ))}
        <circle cx="32" cy="32" r="6" fill="hsl(var(--primary-foreground))" />
        <circle cx="32" cy="32" r="6" fill="hsl(var(--primary))" opacity="0.25" />
      </g>

      <style>{`
        .guide-avatar-lotus { transform-origin: 32px 32px; }

        .guide-avatar-state-idle .lotus-bloom { animation: lotus-pulse 3.4s ease-in-out infinite; }
        .guide-avatar-state-listening .lotus-bloom { animation: lotus-pulse 1.4s ease-in-out infinite; }
        .guide-avatar-state-thinking .lotus-bloom { animation: lotus-rotate 3s linear infinite; }
        .guide-avatar-state-delivering .lotus-bloom { animation: lotus-bloom-open 0.9s ease-in-out infinite; }

        @keyframes lotus-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        @keyframes lotus-rotate {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes lotus-bloom-open {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.12); }
        }

        @media (prefers-reduced-motion: reduce) {
          .guide-avatar-lotus .lotus-bloom { animation: none !important; }
        }
      `}</style>
    </svg>
  );
}
