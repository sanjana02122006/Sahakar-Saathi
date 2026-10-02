"use client";

import type { AvatarVariant, AvatarState } from "@/lib/avatar-context";
import { SproutAvatar } from "./sprout";
import { RobotAvatar } from "./robot";
import { HumanAvatar } from "./human";
import { LotusAvatar } from "./lotus";
import { MicahAvatar } from "./micah";

export type { AvatarVariant, AvatarState };

/**
 * Single entry point for all four guide avatar variants.
 *
 * Purely presentational: takes a variant + state and renders. It never
 * starts, stops, or otherwise touches audio — if every file in this
 * directory were deleted, voice output in app/dashboard/page.tsx would
 * behave exactly as it does today. Only attach listeners elsewhere that
 * set/clear the `deliveringId` state this component's `state` prop derives
 * from; never call speak()/speakWithBrowser() or touch audioRef from here.
 *
 * aria-hidden is applied on every variant's root node (decorative only —
 * the reply text next to it stays in normal reading order for screen
 * readers, unchanged). Animation is CSS transform/opacity only, and every
 * variant's own stylesheet includes a `prefers-reduced-motion: reduce`
 * override that turns all animation off — see each variant file.
 */
export function GuideAvatar({
  variant,
  state,
  size = 40,
}: {
  variant: AvatarVariant;
  state: AvatarState;
  size?: number;
}) {
  const avatar = (() => {
    switch (variant) {
      case "robot": return <RobotAvatar state={state} size={size} />;
      case "human": return <HumanAvatar state={state} size={size} />;
      case "lotus": return <LotusAvatar state={state} size={size} />;
      case "sprout": return <SproutAvatar state={state} size={size} />;
      case "micah":
      default: return <MicahAvatar state={state} size={size} />;
    }
  })();

  // Shared "listening" affordance: a pulsing ring around whichever variant
  // is active, so the attentive cue is consistent across all four designs
  // rather than reimplemented per-variant.
  return (
    <span
      className={`guide-avatar-ring guide-avatar-ring-${state}`}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
      }}
    >
      {avatar}
      {state === "listening" && (
        <span aria-hidden="true" className="guide-avatar-pulse-ring" />
      )}

      <style>{`
        .guide-avatar-pulse-ring {
          position: absolute;
          inset: -4px;
          border-radius: 9999px;
          border: 2px solid hsl(var(--primary));
          animation: guide-avatar-pulse 1.4s ease-out infinite;
          pointer-events: none;
        }
        @keyframes guide-avatar-pulse {
          0% { transform: scale(0.92); opacity: 0.7; }
          100% { transform: scale(1.25); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .guide-avatar-pulse-ring { animation: none !important; opacity: 0 !important; }
        }
      `}</style>
    </span>
  );
}
