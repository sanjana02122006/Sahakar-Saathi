"use client";

import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { DICTS, UI_LANGUAGES, type UiLangCode } from "./index";

const STORAGE_KEY = "sahakar-sathi-ui-lang";

type Ctx = {
  lang: UiLangCode;
  setLang: (lang: UiLangCode) => void;
  t: (path: string, vars?: Record<string, string>) => string;
};

const I18nContext = createContext<Ctx | null>(null);

function getByPath(obj: any, path: string): unknown {
  return path.split(".").reduce((o, key) => (o == null ? undefined : o[key]), obj);
}

function interpolate(str: string, vars?: Record<string, string>) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

// Single language selection for the whole app: UI chrome, assistant
// replies, and STT/TTS all follow this one value. It is mirrored to
// localStorage (STORAGE_KEY) so it's available instantly on next load
// before any network round-trip, but once a logged-in session exists,
// profiles.preferred_lang is the source of truth -- it is read once on
// mount (overriding whatever localStorage had) and written on every
// setLang() call, so the selection survives a refresh AND follows the
// account across devices/browsers, not just the one browser's storage.
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<UiLangCode>("en");
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as UiLangCode | null;
      if (stored && UI_LANGUAGES.some((l) => l.code === stored)) setLangState(stored);
    } catch {
      // localStorage unavailable (private browsing, blocked storage) — stay on English.
    }

    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      userIdRef.current = session.user.id;

      const { data: prof } = await supabase
        .from("profiles").select("preferred_lang").eq("id", session.user.id).single();
      const dbLang = prof?.preferred_lang as UiLangCode | undefined;
      if (dbLang && UI_LANGUAGES.some((l) => l.code === dbLang)) {
        setLangState(dbLang);
        try { localStorage.setItem(STORAGE_KEY, dbLang); } catch { /* non-fatal */ }
      }
    })();
  }, []);

  const setLang = useCallback((next: UiLangCode) => {
    setLangState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* non-fatal */ }
    if (userIdRef.current) {
      supabase.from("profiles").update({ preferred_lang: next }).eq("id", userIdRef.current)
        .then(({ error }) => { if (error) console.error("[i18n] failed to save preferred_lang:", error); });
    }
  }, []);

  const t = useCallback(
    (path: string, vars?: Record<string, string>) => {
      const dict = DICTS[lang] ?? DICTS.en;
      const value = getByPath(dict, path) ?? getByPath(DICTS.en, path);
      return typeof value === "string" ? interpolate(value, vars) : path;
    },
    [lang]
  );

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
