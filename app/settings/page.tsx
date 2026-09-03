"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { LANGUAGES, GEMINI_MODELS, type Profile } from "@/lib/types";
import { useI18n } from "@/lib/i18n/provider";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ArrowLeft, Loader2, Check, Mic, Sprout, Users, Cpu } from "lucide-react";

const TEAM = [
  "Sanjana C", "Swetha E", "Prathiksha J",
  "Subetha M", "Yashitha M K", "Sri Nisha V N",
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export default function SettingsPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [booting, setBooting] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [state, setState] = useState("");
  const [district, setDistrict] = useState("");
  const [pacsName, setPacsName] = useState("");

  // Language mode: "single" pins the assistant to one language (default English).
  // "multilingual" lets the picker on the dashboard/composer switch per message.
  const [langMode, setLangMode] = useState<"single" | "multilingual">("single");
  const [defaultLang, setDefaultLang] = useState("en");
  const [model, setModel] = useState("gemini-3.1-flash-lite");

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace("/login"); return; }

      const { data: prof } = await supabase
        .from("profiles").select("*").eq("id", session.user.id).single();

      if (prof) {
        const p = prof as Profile;
        setFullName(p.full_name ?? "");
        setPhone(p.phone ?? "");
        setState(p.state ?? "");
        setDistrict(p.district ?? "");
        setPacsName(p.pacs_name ?? "");
        setDefaultLang(p.preferred_lang || "en");
        // Anyone not on plain English is treated as having opted into multilingual mode already.
        setLangMode(p.preferred_lang && p.preferred_lang !== "en" ? "multilingual" : "single");
        setModel(p.preferred_model || "gemini-3.1-flash-lite");
      }
      setBooting(false);
    })();
  }, [router]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace("/login"); return; }

    const { error } = await supabase
      .from("profiles")
      .update({
        full_name: fullName.trim() || null,
        phone: phone.trim() || null,
        state: state.trim() || null,
        district: district.trim() || null,
        pacs_name: pacsName.trim() || null,
        // Single mode always resolves to English; multilingual keeps the chosen default.
        preferred_lang: langMode === "single" ? "en" : defaultLang,
        preferred_model: model,
      })
      .eq("id", session.user.id);

    if (error) setError(error.message);
    else { setSaved(true); setTimeout(() => setSaved(false), 2500); }
    setSaving(false);
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
        <span className="font-semibold tracking-tight">{t("settings.title")}</span>
        <LanguageSwitcher className="ml-auto" />
      </header>

      <main className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6">
        <form onSubmit={save} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("settings.languageTitle")}</CardTitle>
              <CardDescription>{t("settings.languageSubtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setLangMode("single")}
                  className={`rounded-lg border p-3.5 text-left transition-colors ${
                    langMode === "single" ? "border-primary bg-accent" : "hover:bg-secondary"
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {t("settings.englishOnly")}
                    {langMode === "single" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t("settings.englishOnlyDesc")}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setLangMode("multilingual")}
                  className={`rounded-lg border p-3.5 text-left transition-colors ${
                    langMode === "multilingual" ? "border-primary bg-accent" : "hover:bg-secondary"
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {t("settings.multilingual")}
                    {langMode === "multilingual" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t("settings.multilingualDesc")}
                  </span>
                </button>
              </div>

              {langMode === "multilingual" && (
                <div className="space-y-2 pt-1">
                  <Label htmlFor="lang">{t("settings.defaultLanguage")}</Label>
                  <select
                    id="lang"
                    value={defaultLang}
                    onChange={(e) => setDefaultLang(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-64"
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>{l.native} — {l.label}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex items-start gap-2 rounded-md bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
                <Mic className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t("settings.voiceNote")}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Cpu className="h-4 w-4" />
                {t("settings.modelTitle")}
              </CardTitle>
              <CardDescription>{t("settings.modelSubtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {(["stable", "latest", "preview"] as const).map((tier) => {
                const models = GEMINI_MODELS.filter((m) => m.tier === tier);
                if (models.length === 0) return null;
                return (
                  <div key={tier} className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t(`settings.model${tier[0].toUpperCase()}${tier.slice(1)}`)}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {models.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setModel(m.id)}
                          className={`flex items-center justify-between rounded-lg border px-3.5 py-2.5 text-left text-sm transition-colors ${
                            model === m.id ? "border-primary bg-accent font-medium" : "hover:bg-secondary"
                          }`}
                        >
                          <span className="flex items-center gap-1.5">
                            {m.label}
                            {"recommended" in m && m.recommended && (
                              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                {t("settings.modelDefault")}
                              </span>
                            )}
                          </span>
                          {model === m.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("settings.profileTitle")}</CardTitle>
              <CardDescription>{t("settings.profileSubtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">{t("settings.fullName")}</Label>
                <Input id="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">{t("settings.phone")}</Label>
                <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="state">{t("settings.state")}</Label>
                  <Input id="state" value={state} onChange={(e) => setState(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="district">{t("settings.district")}</Label>
                  <Input id="district" value={district} onChange={(e) => setDistrict(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pacs">{t("settings.pacsName")}</Label>
                <Input id="pacs" value={pacsName} onChange={(e) => setPacsName(e.target.value)} placeholder={t("common.optional")} />
              </div>
            </CardContent>
          </Card>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.saveChanges")}
            </Button>
            {saved && <span className="text-sm text-muted-foreground">{t("common.saved")}</span>}
          </div>
        </form>

        <Card className="border-primary/20 bg-accent/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sprout className="h-4 w-4 text-primary" />
              {t("settings.aboutTitle")}
            </CardTitle>
            <CardDescription>{t("settings.aboutSubtitle")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              {t("settings.team")}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {TEAM.map((name) => (
                <div
                  key={name}
                  className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    {initials(name)}
                  </span>
                  <span className="text-sm font-medium">{name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
