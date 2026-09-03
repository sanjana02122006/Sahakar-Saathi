"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { LANGUAGES } from "@/lib/types";
import { useI18n } from "@/lib/i18n/provider";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sprout, Loader2 } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace("/dashboard");
    });
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    else router.replace("/dashboard");
    setLoading(false);
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden flex-col justify-between bg-primary p-12 text-primary-foreground lg:flex">
        <div className="flex items-center gap-2.5">
          <Sprout className="h-6 w-6" />
          <span className="text-lg font-semibold tracking-tight">{t("app.name")}</span>
        </div>
        <div className="space-y-5">
          <h1 className="max-w-md text-4xl font-semibold leading-tight tracking-tight">
            {t("app.tagline")}
          </h1>
          <p className="max-w-md text-sm leading-relaxed text-primary-foreground/70">
            {t("app.description")}
          </p>
          <div className="flex flex-wrap gap-1.5 pt-2">
            {LANGUAGES.map((l) => (
              <span
                key={l.code}
                className="rounded-full bg-primary-foreground/10 px-2.5 py-1 text-xs text-primary-foreground/80"
              >
                {l.native}
              </span>
            ))}
          </div>
        </div>
        <p className="text-xs text-primary-foreground/50">{t("app.org")}</p>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 lg:hidden">
              <Sprout className="h-5 w-5 text-primary" />
              <span className="font-semibold tracking-tight">{t("app.name")}</span>
            </div>
            <LanguageSwitcher className="ml-auto" />
          </div>

          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">{t("login.welcomeBack")}</h2>
            <p className="text-sm text-muted-foreground">{t("login.signInSubtitle")}</p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t("login.emailLabel")}</Label>
              <Input
                id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder={t("login.emailPlaceholder")} required autoComplete="email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{t("login.passwordLabel")}</Label>
              <Input
                id="password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••" required minLength={6}
                autoComplete="current-password"
              />
            </div>

            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("login.signIn")}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">{t("login.noAccountYet")}</p>
        </div>
      </div>
    </main>
  );
}
