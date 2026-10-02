"use client";

/**
 * TEST-ONLY SCAFFOLDING — this variant picker exists purely so the four
 * guide avatar designs can be compared live on the deployed test site
 * (cglachatbot1.netlify.app). Remove this component and its mount point
 * in the dashboard header once a variant is chosen; it should never ship
 * to a real government deployment. See AVATAR-PLAN.md.
 */
import { useState, useRef, useEffect } from "react";
import { Check, Sparkles } from "lucide-react";
import { useAvatarVariant, type AvatarVariant } from "@/lib/avatar-context";
import { useI18n } from "@/lib/i18n/provider";
import { GuideAvatar } from "./index";
import { cn } from "@/lib/utils";

// credit: only "micah" requires attribution (CC BY 4.0) — every other
// variant is CC0 or a custom asset and carries no credit line.
const VARIANTS: { code: AvatarVariant; nameKey: string; credit?: string }[] = [
  { code: "micah", nameKey: "avatar.name.micah", credit: "Illustration by Micah Lanier, CC BY 4.0" },
  { code: "sprout", nameKey: "avatar.name.sprout" },
  { code: "robot", nameKey: "avatar.name.robot" },
  { code: "human", nameKey: "avatar.name.human" },
  { code: "lotus", nameKey: "avatar.name.lotus" },
];

export function AvatarSwitcher({ className }: { className?: string }) {
  const { t } = useI18n();
  const { variant, setVariant } = useAvatarVariant();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
        aria-label={t("avatar.chooseGuide")}
        aria-expanded={open}
        title={t("avatar.chooseGuide")}
        className="flex h-10 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <span className="hidden sm:inline">{t(`avatar.name.${variant}`)}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-56 rounded-md border bg-card p-1 shadow-lg"
        >
          <p className="px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("avatar.chooseGuide")}
          </p>
          {VARIANTS.map((v) => (
            <button
              key={v.code}
              role="menuitem"
              onClick={() => { setVariant(v.code); setOpen(false); }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left text-sm transition-colors hover:bg-secondary",
                v.code === variant && "bg-accent font-medium"
              )}
            >
              <GuideAvatar variant={v.code} state="idle" size={28} />
              <span className="flex-1">
                <span className="block">{t(v.nameKey)}</span>
                {v.credit && (
                  <span className="block text-[10px] font-normal leading-tight text-muted-foreground">
                    {v.credit}
                  </span>
                )}
              </span>
              {v.code === variant && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
