"use client";

import { useState, useRef, useEffect } from "react";
import { Languages, Check } from "lucide-react";
import { UI_LANGUAGES } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * Global UI language switcher. Shown on every page so a user never has to
 * dig through Settings to change what language the interface itself is in
 * (separate from the assistant's reply language, which stays configurable
 * per-conversation in the dashboard header).
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = UI_LANGUAGES.find((l) => l.code === lang) ?? UI_LANGUAGES[0];

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Change language"
        aria-expanded={open}
        className="flex h-10 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Languages className="h-4 w-4 text-muted-foreground" />
        <span>{current.native}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 max-h-80 w-48 overflow-y-auto rounded-md border bg-card p-1 shadow-lg"
        >
          {UI_LANGUAGES.map((l) => (
            <button
              key={l.code}
              role="menuitem"
              onClick={() => { setLang(l.code); setOpen(false); }}
              className={cn(
                "flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-secondary",
                l.code === lang && "bg-accent font-medium"
              )}
            >
              <span>{l.native}</span>
              {l.code === lang && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
