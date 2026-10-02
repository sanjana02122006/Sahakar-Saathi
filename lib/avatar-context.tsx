"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

/**
 * Guide avatar variant selection — TEST-ONLY scaffolding for comparing the
 * avatar designs on the deployed site (see AVATAR-PLAN.md). Persists to
 * localStorage only; deliberately does NOT touch profiles.preferred_lang
 * or any other server-side state, since this whole feature is meant to be
 * `git reset --hard`-able back to the pre-avatar checkpoint commit.
 *
 * "micah" (DiceBear Micah, by Micah Lanier) is CC BY 4.0 — UNLIKE every
 * other variant here, its license requires visible attribution. See the
 * credit line rendered next to it in switcher.tsx; don't drop that credit.
 */
export type AvatarVariant = "sprout" | "robot" | "human" | "lotus" | "micah";
export type AvatarState = "idle" | "listening" | "thinking" | "delivering";

const STORAGE_KEY = "sahakar-sathi-guide-avatar";
const DEFAULT_VARIANT: AvatarVariant = "micah";

function isAvatarVariant(v: unknown): v is AvatarVariant {
  return v === "sprout" || v === "robot" || v === "human" || v === "lotus" || v === "micah";
}

type Ctx = {
  variant: AvatarVariant;
  setVariant: (v: AvatarVariant) => void;
};

const AvatarContext = createContext<Ctx | null>(null);

export function AvatarProvider({ children }: { children: React.ReactNode }) {
  const [variant, setVariantState] = useState<AvatarVariant>(DEFAULT_VARIANT);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isAvatarVariant(stored)) setVariantState(stored);
    } catch {
      // localStorage unavailable (private browsing, blocked storage) — stay on default.
    }
  }, []);

  const setVariant = useCallback((next: AvatarVariant) => {
    setVariantState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* non-fatal */ }
  }, []);

  return <AvatarContext.Provider value={{ variant, setVariant }}>{children}</AvatarContext.Provider>;
}

export function useAvatarVariant() {
  const ctx = useContext(AvatarContext);
  if (!ctx) throw new Error("useAvatarVariant must be used within AvatarProvider");
  return ctx;
}
