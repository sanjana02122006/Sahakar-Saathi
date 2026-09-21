"use client";

import type { ReactNode } from "react";
import type { AvatarState } from "@/lib/avatar-context";
import { cn } from "@/lib/utils";

/**
 * The "reply cloud" that sits beside a GuideAvatar — a rounded bubble with
 * a small tail pointing back toward the avatar. Purely presentational:
 * renders whatever children it's given (text, thinking dots, etc.) inside
 * normal reading order, so screen readers see exactly the same content
 * they would without the avatar feature at all.
 */
export function SpeechBubble({
  state,
  children,
  className,
}: {
  state: AvatarState;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative rounded-2xl rounded-tl-sm bg-secondary px-3.5 py-2.5", className)}>
      {/* Tail pointing toward the avatar, left edge */}
      <span
        aria-hidden="true"
        className="absolute -left-1.5 top-3 h-3 w-3 rotate-45 bg-secondary"
      />
      <div className={`guide-speech-bubble-content guide-avatar-state-${state}`}>{children}</div>
    </div>
  );
}

/**
 * Animated "…" dots used for the `thinking` state's cloud content.
 * CSS-only (transform/opacity), respects prefers-reduced-motion.
 */
export function ThinkingDots({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground"
            style={{ animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </span>
      <style>{`
        .thinking-dot { animation: thinking-dot-bounce 1.1s ease-in-out infinite; }
        @keyframes thinking-dot-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-3px); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .thinking-dot { animation: none !important; opacity: 0.7; }
        }
      `}</style>
    </span>
  );
}
