"use client";

// Admin-only PDF upload + chain-anchoring page (see BLOCKCHAIN-PLAN.md).
// New UI surface -- confirmed via a search of app/ for `role === 'admin'`
// / an "admin" route that no such page already existed before adding
// this one.
//
// Gated the same way as the rest of this project's admin-only surfaces
// (the `ingest` and `anchor-document` Edge Functions): client-side check
// on profile.role === 'admin' for UX (hide the page / show a message),
// with the real security boundary enforced server-side inside those
// functions regardless of what the client sends.
//
// Flow: upload PDF -> ingest (small files inline via pdf_base64, large
// files uploaded directly to the kb-pdfs bucket first, then
// pdf_storage_path) -> anchor-document, shown as three sequential
// stages so the admin can see exactly where the process is and where it
// stopped if something fails (e.g. a scanned PDF, or the chain signer
// wallet not yet funded).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import type { KbCategory, Profile } from "@/lib/types";
import { useI18n } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ArrowLeft, Loader2, UploadCloud, CheckCircle2, ExternalLink, AlertTriangle } from "lucide-react";

const CATEGORIES: KbCategory[] = [
  "cooperative_law", "bylaws", "ministry_scheme",
  "pacs_service", "pmfby", "financial_literacy", "grievance",
];

// Matches the ingest Edge Function's size-threshold rule (BLOCKCHAIN-PLAN.md):
// under ~4MB base64-encoded goes inline; larger files upload to kb-pdfs
// directly first. Base64 inflates size by ~33%, so gate on raw bytes
// accordingly (~3MB raw ≈ 4MB base64).
const INLINE_MAX_BYTES = 3 * 1024 * 1024;

type Stage = "idle" | "uploading" | "ingesting" | "anchoring" | "done" | "error";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip the "data:application/pdf;base64," prefix
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function AdminVerifyPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [booting, setBooting] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<KbCategory>("ministry_scheme");
  const [file, setFile] = useState<File | null>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    document_id: string | null;
    already_ingested?: boolean;
    chain_tx_hash?: string | null;
    explorer_url?: string | null;
    already_anchored?: boolean;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace("/login"); return; }
      const { data: prof } = await supabase
        .from("profiles").select("*").eq("id", session.user.id).single();
      setProfile((prof as Profile) ?? null);
      setBooting(false);
    })();
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !title.trim()) return;

    setError(null);
    setResult(null);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace("/login"); return; }

    const FUNCTIONS_URL = process.env.NEXT_PUBLIC_SUPABASE_URL + "/functions/v1";
    const authHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    };

    try {
      let ingestBody: Record<string, unknown>;

      if (file.size <= INLINE_MAX_BYTES) {
        setStage("ingesting");
        const pdf_base64 = await fileToBase64(file);
        ingestBody = { title: title.trim(), category, pdf_base64 };
      } else {
        // Large file: upload directly to the kb-pdfs bucket first (client
        // -> Supabase Storage, not through ingest at all), then point
        // ingest at the uploaded object via pdf_storage_path.
        setStage("uploading");
        const path = `${crypto.randomUUID()}.pdf`;
        const { error: upErr } = await supabase.storage
          .from("kb-pdfs")
          .upload(path, file, { contentType: "application/pdf" });
        if (upErr) throw new Error(upErr.message);

        setStage("ingesting");
        ingestBody = { title: title.trim(), category, pdf_storage_path: path };
      }

      const ingestRes = await fetch(`${FUNCTIONS_URL}/ingest`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(ingestBody),
      });
      const ingestData = await ingestRes.json().catch(() => ({}));

      if (!ingestRes.ok) {
        if (ingestData.error === "scanned_pdf_needs_ocr") {
          setError(t("admin.scannedPdfError"));
        } else {
          setError(typeof ingestData.error === "string" ? ingestData.error : t("admin.genericError"));
        }
        setStage("error");
        return;
      }

      if (ingestData.already_ingested) {
        setResult({ document_id: ingestData.document_id, already_ingested: true });
        setStage("done");
        return;
      }

      // Second, SEPARATE step — chain write happens only after embeddings
      // succeed (see BLOCKCHAIN-PLAN.md).
      setStage("anchoring");
      const anchorRes = await fetch(`${FUNCTIONS_URL}/anchor-document`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ document_id: ingestData.document_id }),
      });
      const anchorData = await anchorRes.json().catch(() => ({}));

      if (!anchorRes.ok) {
        if (anchorData.error === "chain_signer_not_configured") {
          setError(t("admin.signerNotConfigured"));
        } else {
          setError(typeof anchorData.error === "string" ? anchorData.error : t("admin.genericError"));
        }
        // Document WAS ingested successfully even though anchoring failed —
        // show that partial success rather than a blanket error.
        setResult({ document_id: ingestData.document_id });
        setStage("error");
        return;
      }

      setResult({
        document_id: ingestData.document_id,
        chain_tx_hash: anchorData.chain_tx_hash,
        explorer_url: anchorData.explorer_url,
        already_anchored: anchorData.already_anchored,
      });
      setStage("done");
    } catch (err: any) {
      setError(err?.message ?? t("admin.genericError"));
      setStage("error");
    }
  }

  if (booting) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </main>
    );
  }

  if (profile?.role !== "admin") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <AlertTriangle className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("admin.notAdmin")}</p>
        <Button variant="outline" onClick={() => router.push("/dashboard")}>
          <ArrowLeft className="h-4 w-4" /> {t("common.back")}
        </Button>
      </main>
    );
  }

  const busy = stage === "uploading" || stage === "ingesting" || stage === "anchoring";

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center gap-3 border-b px-4 sm:px-6">
        <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="font-semibold tracking-tight">{t("admin.verifyTitle")}</span>
      </header>

      <main className="mx-auto max-w-xl space-y-6 px-4 py-8 sm:px-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UploadCloud className="h-4 w-4" />
              {t("admin.verifyTitle")}
            </CardTitle>
            <CardDescription>{t("admin.verifySubtitle")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">{t("admin.titleLabel")}</Label>
                <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required disabled={busy} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="category">{t("admin.categoryLabel")}</Label>
                <select
                  id="category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as KbCategory)}
                  disabled={busy}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="pdf">{t("admin.fileLabel")}</Label>
                <input
                  id="pdf"
                  type="file"
                  accept="application/pdf"
                  disabled={busy}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-xs"
                />
              </div>

              {error && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
              )}

              {result && (
                <div className="space-y-1.5 rounded-md bg-accent/40 px-3 py-2.5 text-sm">
                  {result.already_ingested && <p>{t("admin.alreadyIngested")}</p>}
                  {!result.already_ingested && result.chain_tx_hash && (
                    <p className="flex items-center gap-1.5 text-primary">
                      <CheckCircle2 className="h-4 w-4" />
                      {result.already_anchored ? t("admin.alreadyAnchored") : t("admin.anchoredSuccess")}
                    </p>
                  )}
                  {result.explorer_url && (
                    <a
                      href={result.explorer_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                    >
                      {t("admin.viewOnPolygonscan")} <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              )}

              <Button type="submit" disabled={busy || !file || !title.trim()} className="w-full">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {stage === "uploading" && t("admin.uploading")}
                {stage === "ingesting" && t("admin.ingesting")}
                {stage === "anchoring" && t("admin.anchoring")}
                {!busy && t("admin.submit")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
