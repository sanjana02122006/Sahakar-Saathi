"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
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

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<UiLangCode>("en");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as UiLangCode | null;
      if (stored && UI_LANGUAGES.some((l) => l.code === stored)) setLangState(stored);
    } catch {
      // localStorage unavailable (private browsing, blocked storage) — stay on English.
    }
  }, []);

  const setLang = useCallback((next: UiLangCode) => {
    setLangState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* non-fatal */ }
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
