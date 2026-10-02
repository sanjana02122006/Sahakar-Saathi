// Client helper for the verify-document Edge Function (see
// BLOCKCHAIN-PLAN.md's "Anchored vs. Verified" section). This is the ONLY
// way the frontend ever learns whether an anchored citation's document
// still matches its on-chain record RIGHT NOW — `chat`'s `citations[]`
// only carries the cheap `anchored` boolean (a tx hash exists), never a
// live result.
"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

export type VerifyStatus = "pending" | "verified" | "failed";

export interface VerifyResult {
  status: "not_anchored" | "storage_mismatch" | "chain_mismatch" | "verified";
  document_id: string;
  chain_tx_hash?: string | null;
  chain_network?: string | null;
  explorer_url?: string | null;
}

/** Maps the Edge Function's four-state result onto the three UI badge states. */
export function toBadgeStatus(result: VerifyResult | null): VerifyStatus {
  if (!result) return "pending";
  if (result.status === "verified") return "verified";
  if (result.status === "storage_mismatch" || result.status === "chain_mismatch") return "failed";
  return "pending"; // not_anchored shouldn't reach the badge at all (anchored === false hides it)
}

/**
 * Calls verify-document for a single document_id and returns the live
 * result once it resolves. Starts in "pending" (the neutral "Anchored"
 * look) exactly as the spec requires — never a stray green checkmark
 * before the real check has run, and never silently falling back to the
 * neutral look on a failed check either.
 */
export function useVerifyDocument(documentId: string | null | undefined) {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const askedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!documentId || askedFor.current === documentId) return;
    askedFor.current = documentId;
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        const res = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/verify-document`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ document_id: documentId }),
          },
        );
        const data = await res.json().catch(() => null);
        if (!cancelled && res.ok && data) setResult(data as VerifyResult);
      } catch {
        // Network failure — badge just stays in "pending"/neutral state,
        // never flips to a false "verified".
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [documentId]);

  return { result, status: toBadgeStatus(result), loading };
}
