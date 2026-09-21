"use client";

import type { AvatarState } from "@/lib/avatar-context";

/**
 * "Sahakar Mitra" — custom inline SVG, no third-party asset or license.
 * A rounded seedling with a warm permanent smile; two leaves act as arms.
 * Derived from the `Sprout` lucide mark already used as the app logo
 * (app/login/page.tsx, dashboard header) so mascot and brand read as one.
 *
 * Presentational only — animates purely via CSS transform/opacity driven
 * by the `state` prop. Produces no audio and starts no timers.
 */
export function SproutAvatar({ state, size }: { state: AvatarState; size: number }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      className={`guide-avatar-sprout guide-avatar-state-${state}`}
    >
      {/* Body */}
      <circle cx="32" cy="38" r="18" fill="hsl(var(--primary))" />

      {/* Leaves (arms) — animate on delivering via .sprout-leaf-left/right */}
      <path
        className="sprout-leaf sprout-leaf-left"
        d="M14 34c-6-2-10-8-9-15 7 0 13 4 15 10 1 3-1 6-6 5z"
        fill="hsl(var(--accent))"
      />
      <path
        className="sprout-leaf sprout-leaf-right"
        d="M50 34c6-2 10-8 9-15-7 0-13 4-15 10-1 3 1 6 6 5z"
        fill="hsl(var(--accent))"
      />

      {/* Sprout tip on top of the head */}
      <path
        d="M32 20c-1-6-6-9-10-9 0 5 3 9 8 10 .7 5 2 9 2 9s1.3-4 2-9c5-1 8-5 8-10-4 0-9 3-10 9z"
        fill="hsl(var(--accent))"
      />

      {/* Face — always happy: permanent gentle smile, never neutral/sad/angry */}
      <circle cx="26" cy="38" r="2.2" fill="hsl(var(--primary-foreground))" />
      <circle cx="38" cy="38" r="2.2" fill="hsl(var(--primary-foreground))" />
      <path
        d="M25 44c2.5 3 11.5 3 14 0"
        stroke="hsl(var(--primary-foreground))"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />

      {/* Cheeks — a touch of warmth, visible in "delivering" via CSS opacity */}
      <circle className="sprout-cheek" cx="21" cy="42" r="2" fill="hsl(var(--primary-foreground))" opacity="0.35" />
      <circle className="sprout-cheek" cx="43" cy="42" r="2" fill="hsl(var(--primary-foreground))" opacity="0.35" />

      <style>{`
        .guide-avatar-sprout { transform-origin: 32px 56px; }

        /* idle: gentle breathing / float */
        .guide-avatar-state-idle { animation: sprout-breathe 3.2s ease-in-out infinite; }

        /* listening: attentive — slight lift, handled by the pulsing ring wrapper in index.tsx */
        .guide-avatar-state-listening { animation: sprout-breathe 1.4s ease-in-out infinite; }

        /* thinking: cheerful concentration, small sway — never a frown */
        .guide-avatar-state-thinking { animation: sprout-sway 1.1s ease-in-out infinite; }

        /* delivering: subtle bob + leaf-wave beside the reply */
        .guide-avatar-state-delivering { animation: sprout-bob 0.9s ease-in-out infinite; }
        .guide-avatar-state-delivering .sprout-leaf-left { animation: sprout-wave-left 0.9s ease-in-out infinite; }
        .guide-avatar-state-delivering .sprout-leaf-right { animation: sprout-wave-right 0.9s ease-in-out infinite; }

        .sprout-leaf { transform-origin: 32px 30px; }

        @keyframes sprout-breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }
        @keyframes sprout-sway {
          0%, 100% { transform: rotate(-3deg); }
          50% { transform: rotate(3deg); }
        }
        @keyframes sprout-bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        @keyframes sprout-wave-left {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(-18deg); }
        }
        @keyframes sprout-wave-right {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(18deg); }
        }

        @media (prefers-reduced-motion: reduce) {
          .guide-avatar-sprout, .guide-avatar-sprout * { animation: none !important; }
        }
      `}</style>
    </svg>
  );
}
