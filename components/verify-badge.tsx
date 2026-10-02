"use client";

// Three-state blockchain-integrity badge for an anchored citation — see
// BLOCKCHAIN-PLAN.md's "Citation chip — extend, don't redesign" section.
// Deliberately three states, not one: collapsing "verified" and "anchored"
// into a single green checkmark was the exact bug this feature's first
// draft review caught (a stale "Verified" look surviving a swapped file).
//
// This component ONLY renders — it does not call verify-document itself.
// The caller (app/dashboard/page.tsx) owns the useVerifyDocument() hook
// call so that hook's lifecycle stays tied to the citation chip's own
// key/mount, not duplicated here.

import { ShieldCheck, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/provider";
import type { VerifyStatus } from "@/lib/verify-document";

export function VerifyBadge({
  status,
  explorerUrl,
}: {
  status: VerifyStatus;
  explorerUrl?: string | null;
}) {
  const { t } = useI18n();

  const label = t(`verified.badge.${status}`);
  const tooltip = t(`verified.tooltip.${status}`);

  const classes = cn(
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
    status === "verified" && "bg-emerald-100 text-emerald-900 hover:bg-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400",
    status === "pending" && "bg-muted text-muted-foreground hover:bg-secondary",
    status === "failed" && "bg-destructive/10 text-destructive hover:bg-destructive/20",
  );

  const Icon = status === "failed" ? ShieldAlert : ShieldCheck;

  // Only the verified state is a real link (to Polygonscan) — pending and
  // failed have nothing useful to click through to yet/ever.
  if (status === "verified" && explorerUrl) {
    return (
      <a href={explorerUrl} target="_blank" rel="noopener noreferrer" title={tooltip} className={classes}>
        <Icon className="h-3 w-3" />
        {label}
      </a>
    );
  }

  return (
    <span title={tooltip} className={classes}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
