"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import type { Grievance, GrievanceStatus, KbCategory } from "@/lib/types";
import { useI18n } from "@/lib/i18n/provider";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ArrowLeft, Plus, Loader2, MessageSquareWarning } from "lucide-react";

const STATUS_VARIANT: Record<GrievanceStatus, "warning" | "secondary" | "destructive" | "success" | "outline"> = {
  open: "warning",
  in_review: "secondary",
  escalated: "destructive",
  resolved: "success",
  closed: "outline",
};

const STATUS_KEY: Record<GrievanceStatus, string> = {
  open: "statusOpen",
  in_review: "statusInReview",
  escalated: "statusEscalated",
  resolved: "statusResolved",
  closed: "statusClosed",
};

const CATEGORY_OPTIONS: { value: KbCategory; key: string }[] = [
  { value: "grievance", key: "categoryGeneral" },
  { value: "cooperative_law", key: "categoryLaw" },
  { value: "pacs_service", key: "categoryPacs" },
  { value: "ministry_scheme", key: "categoryScheme" },
  { value: "pmfby", key: "categoryPmfby" },
  { value: "financial_literacy", key: "categoryFinance" },
];

export default function GrievancesPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [booting, setBooting] = useState(true);
  const [grievances, setGrievances] = useState<Grievance[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<KbCategory>("grievance");

  async function load() {
    const { data, error } = await supabase
      .from("grievances")
      .select("id, ticket_no, subject, description, status, created_at")
      .order("created_at", { ascending: false });
    if (!error && data) setGrievances(data as Grievance[]);
  }

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace("/login"); return; }
      await load();
      setBooting(false);
    })();
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!subject.trim() || !description.trim()) return;
    setSubmitting(true);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace("/login"); return; }

    const { error } = await supabase.from("grievances").insert({
      user_id: session.user.id,
      subject: subject.trim(),
      description: description.trim(),
      category,
    });

    if (error) {
      setError(error.message);
    } else {
      setSubject("");
      setDescription("");
      setCategory("grievance");
      setShowForm(false);
      await load();
    }
    setSubmitting(false);
  }

  if (booting) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </main>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center gap-3 border-b px-4 sm:px-6">
        <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="font-semibold tracking-tight">{t("grievances.title")}</span>
        <LanguageSwitcher className="ml-auto" />
      </header>

      <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t("grievances.yourGrievances")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("grievances.subtitle")}</p>
          </div>
          <Button size="sm" onClick={() => setShowForm((s) => !s)}>
            <Plus className="h-4 w-4" /> {t("common.new")}
          </Button>
        </div>

        {showForm && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-base">{t("grievances.fileNew")}</CardTitle>
              <CardDescription>{t("grievances.formHint")}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="category">{t("grievances.category")}</Label>
                  <select
                    id="category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value as KbCategory)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {CATEGORY_OPTIONS.map((c) => (
                      <option key={c.value} value={c.value}>{t(`grievances.${c.key}`)}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="subject">{t("grievances.subject")}</Label>
                  <Input
                    id="subject" value={subject} onChange={(e) => setSubject(e.target.value)}
                    placeholder={t("grievances.subjectPlaceholder")} required maxLength={200}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">{t("grievances.description")}</Label>
                  <Textarea
                    id="description" value={description} onChange={(e) => setDescription(e.target.value)}
                    placeholder={t("grievances.descriptionPlaceholder")}
                    required maxLength={4000}
                  />
                </div>
                {error && (
                  <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
                )}
                <div className="flex gap-2">
                  <Button type="submit" disabled={submitting}>
                    {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("grievances.submitGrievance")}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        <div className="mt-6 space-y-3">
          {grievances.length === 0 && !showForm && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
              <MessageSquareWarning className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{t("grievances.emptyTitle")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("grievances.emptySubtitle")}</p>
              </div>
            </div>
          )}

          {grievances.map((g) => (
            <Card key={g.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{g.subject}</p>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">{g.ticket_no}</p>
                  </div>
                  <Badge variant={STATUS_VARIANT[g.status]}>{t(`grievances.${STATUS_KEY[g.status]}`)}</Badge>
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{g.description}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("grievances.filed")} {new Date(g.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>
    </div>
  );
}
