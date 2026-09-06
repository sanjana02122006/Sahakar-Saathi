"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { type Message, type Profile, type Scheme } from "@/lib/types";
import { useI18n } from "@/lib/i18n/provider";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sprout, Send, Mic, MicOff, LogOut, Plus, Loader2, Settings, Volume2, VolumeX,
  Scale, FileText, ShieldCheck, Wallet, MessageSquareWarning,
} from "lucide-react";

const SUGGESTIONS = [
  { icon: Scale, titleKey: "suggestionLawTitle", questionKey: "suggestionLawQuestion" },
  { icon: ShieldCheck, titleKey: "suggestionPmfbyTitle", questionKey: "suggestionPmfbyQuestion" },
  { icon: FileText, titleKey: "suggestionPacsTitle", questionKey: "suggestionPacsQuestion" },
  { icon: Wallet, titleKey: "suggestionFinanceTitle", questionKey: "suggestionFinanceQuestion" },
] as const;

const BCP47: Record<string, string> = {
  en: "en-IN", hi: "hi-IN", mr: "mr-IN", ta: "ta-IN", te: "te-IN",
  bn: "bn-IN", gu: "gu-IN", kn: "kn-IN", pa: "pa-IN",
};

// Where a turn originated. Determines where the reply's voice plays:
// "browser" -> laptop/browser speaker only (current default behavior).
// "esp32"   -> the physical terminal's speaker only — the laptop MUST
// stay silent, since the person who asked isn't necessarily at the
// laptop at all. This travels send() -> chat reply -> speak() as a
// plain function argument (never a shared ref) for the same reason
// autoSend already does: an origin tag read back out of shared state
// inside an async callback could be clobbered by a second, unrelated
// turn starting before the first one's reply comes back.
type TurnOrigin = "browser" | "esp32";

export default function DashboardPage() {
  const router = useRouter();
  // Single language selection drives UI chrome, assistant replies, and
  // STT/TTS together -- there is no separate "reply language" anymore.
  // Persisted to profiles.preferred_lang by the provider itself (see
  // lib/i18n/provider.tsx), so it survives a refresh and follows the
  // account, not just this browser.
  const { t, lang } = useI18n();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [booting, setBooting] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [muted, setMuted] = useState(false);

  /* ---------- auth gate + initial load ---------- */
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace("/login"); return; }

      const [{ data: prof }, { data: schemeRows }] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", session.user.id).single(),
        supabase.from("schemes").select("*").order("code"),
      ]);

      if (prof) setProfile(prof as Profile);
      if (schemeRows) setSchemes(schemeRows as Scheme[]);
      setBooting(false);
    })();
  }, [router]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  /* ---------- voice input ----------
   * Primary: record audio, send to the `transcribe` Edge Function (Sarvam AI Saaras v3 STT).
   * Fallback: browser Web Speech API — used automatically if Sarvam isn't
   * configured yet, a request fails, or the device has no MediaRecorder support.
   *
   * autoSend is decided ONCE, at the moment a recording starts, and passed
   * as a plain function argument all the way through to wherever that
   * SAME recording's transcript resolves — never read back out of a shared
   * mutable ref inside an async callback. A hardware-triggered recording
   * can take a couple of seconds to transcribe; if a shared ref were used
   * instead, any later manual click (or a second hardware trigger) during
   * that window could flip the flag before the first recording's callback
   * runs, silently turning off auto-send for an utterance that already
   * asked for it. Capturing the value in the closure makes each
   * recording's send-vs-review decision immune to whatever happens after
   * it started.
   *
   * Hardware trigger (touch-hold-release): release already signals
   * "I'm done speaking" — there's no one at the keyboard to review before
   * sending, so autoSend=true sends the moment transcription completes.
   * Manual mic-button click: autoSend=false, transcript lands in the
   * composer for the user to review/edit/send themselves, unchanged.
   */
  const webSpeechFallback = useCallback((autoSend: boolean) => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert(t("dashboard.connectionError")); return; }

    const rec = new SR();
    rec.lang = BCP47[lang] || "en-IN";
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const text = e.results[0][0].transcript;
      if (autoSend && text.trim()) send(text);
      else setInput(text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start();
    recognitionRef.current = rec;
    setListening(true);
  }, [lang]);

  const stopSarvamRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setListening(false);
  }, []);

  const startSarvamRecording = useCallback(async (autoSend: boolean) => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      webSpeechFallback(autoSend);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      audioChunksRef.current = [];

      rec.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };

      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });

        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        setTranscribing(true);
        try {
          const form = new FormData();
          form.set("file", blob, "recording.webm");
          form.set("lang", BCP47[lang] || "en-IN");

          const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/transcribe`, {
            method: "POST",
            headers: { Authorization: `Bearer ${session.access_token}` },
            body: form,
          });

          const data = await res.json();
          if (!res.ok || data.unsupported) {
            // Not configured yet, or the request failed — fall back silently.
            webSpeechFallback(autoSend);
            return;
          }
          if (data.text) {
            if (autoSend && data.text.trim()) send(data.text);
            else setInput(data.text);
          }
        } catch {
          webSpeechFallback(autoSend);
        } finally {
          setTranscribing(false);
        }
      };

      rec.start();
      mediaRecorderRef.current = rec;
      setListening(true);
    } catch {
      // Mic permission denied or unavailable — try Web Speech, which has its own prompt.
      webSpeechFallback(autoSend);
    }
  }, [lang, webSpeechFallback]);

  const toggleMic = useCallback(() => {
    if (listening) {
      if (mediaRecorderRef.current) stopSarvamRecording();
      else recognitionRef.current?.stop();
      return;
    }
    startSarvamRecording(false); // manual click — leave transcript in composer to review/edit
  }, [listening, startSarvamRecording, stopSarvamRecording]);

  /* ---------- hardware channel (ESP32 push-to-talk terminal) ----------
   * Listens on a Supabase Realtime channel scoped to this user for TWO
   * sibling event types, both broadcast by different Edge Functions on
   * the SAME channel:
   *
   *  - "mic_control" (from trigger-mic): { action: "start"|"stop" } —
   *    the browser-mic path, touch down/up remotely operating THIS
   *    device's own microphone via startSarvamRecording/stopSarvamRecording.
   *
   *  - "voice_transcript" (from voice-upload): { text } — the ESP32's OWN
   *    INMP441 microphone already recorded, uploaded, and had transcribed
   *    server-side; there is nothing to record here, just an already-final
   *    transcript to hand to the existing send() pipeline, unchanged.
   *
   * Both share one dedup Set (seenNoncesRef) since nonces are UUIDs and
   * collisions across event types are not a real concern.
   */
  const seenNoncesRef = useRef<Set<string>>(new Set());
  const listeningRef = useRef(listening);
  useEffect(() => { listeningRef.current = listening; }, [listening]);

  function isDuplicateNonce(nonce: unknown): boolean {
    if (typeof nonce !== "string" || !nonce) return false;
    if (seenNoncesRef.current.has(nonce)) return true;
    seenNoncesRef.current.add(nonce);
    if (seenNoncesRef.current.size > 50) {
      seenNoncesRef.current = new Set([...seenNoncesRef.current].slice(-25));
    }
    return false;
  }

  useEffect(() => {
    if (!profile?.id) return;

    const channel = supabase.channel(`mic-trigger-${profile.id}`);
    channel
      .on("broadcast", { event: "mic_control" }, ({ payload }) => {
        const { action, nonce } = payload ?? {};
        if (isDuplicateNonce(nonce)) return;

        // START is ignored if already recording (won't double-start).
        // STOP is ignored only if NOT currently recording (nothing to
        // stop) — never skipped just for arriving quickly after START,
        // since physical release is the authoritative "done speaking" signal.
        if (action === "start") {
          if (listeningRef.current) return;
          startSarvamRecording(true); // hardware trigger — send as soon as transcription completes
        } else if (action === "stop") {
          if (!listeningRef.current) return;
          stopSarvamRecording();
        }
      })
      .on("broadcast", { event: "voice_transcript" }, ({ payload }) => {
        const { text, nonce } = payload ?? {};
        if (isDuplicateNonce(nonce)) return;
        if (typeof text !== "string" || !text.trim()) return; // nothing to send

        // Transcript already final (ESP32's own mic + voice-upload's Sarvam
        // call produced it) — hand straight to the existing chat pipeline.
        // Deliberately NOT calling chat or speak directly here: send()
        // already owns persisting the turn and triggering speak(reply).
        // origin="esp32" here is what makes the reply's voice route to
        // the physical speaker instead of the laptop — see TurnOrigin.
        send(text, "esp32");
      })
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          // Realtime client auto-retries the underlying socket; re-issuing
          // subscribe() here handles the case where this specific channel
          // join needs to be re-established after a drop.
          channel.subscribe();
        }
      });

    return () => { supabase.removeChannel(channel); };
  }, [profile?.id, startSarvamRecording, stopSarvamRecording]);

  function speakWithBrowser(text: string) {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = BCP47[lang] || "en-IN";
    speechSynthesis.speak(u);
  }

  /* ---------- voice output ----------
   * Primary: Sarvam AI Bulbul v3 (natural Indic voices) via the `speak`
   * Edge Function. Fallback: browser speechSynthesis on any failure —
   * missing key, request error, or autoplay blocked.
   *
   * origin decides where the resulting audio plays — this is the fix for
   * "laptop must stay silent for ESP32-originated turns":
   *   "browser" (default — manual click, typed text, suggestion tap):
   *     play locally via <audio>, exactly as before. NOT mirrored to the
   *     device queue — nothing is polling for it, and queuing it would
   *     be a wasted Storage write plus a stray entry voice-fetch could
   *     hand the ESP32 on some future unrelated turn.
   *   "esp32" (the physical button triggered this turn):
   *     the laptop does NOT call new Audio(...).play() or the
   *     speechSynthesis fallback at all — only mirrorAudioToDevice()
   *     runs, queuing the clip for voice-fetch to hand to the ESP32.
   *     If Sarvam itself fails for an esp32-origin turn, there is
   *     deliberately no browser-side fallback voice either — falling
   *     back to speaking on the laptop would defeat the entire point of
   *     "the physical speaker is the output device" for this turn.
   */
  async function speak(text: string, origin: TurnOrigin) {
    if (origin === "esp32") {
      await mirrorAudioToDevice(text);
      return;
    }

    if (muted) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ text, lang: BCP47[lang] || "en-IN" }),
      });

      const data = await res.json();
      if (!res.ok || data.unsupported || !data.audio) {
        speakWithBrowser(text);
        return;
      }

      if (audioRef.current) audioRef.current.pause();
      const audio = new Audio(`data:${data.mime};base64,${data.audio}`);
      audioRef.current = audio;
      audio.play().catch(() => speakWithBrowser(text));
    } catch {
      speakWithBrowser(text);
    }
  }

  // Generates the TTS clip via the SAME `speak` Edge Function used for
  // browser playback, but only ever queues it for the ESP32 — never
  // plays it locally. Kept as its own function (rather than inlined into
  // speak()) so the "esp32 origin" branch above reads as one clear early
  // return instead of a browser-playback function with a silence flag
  // threaded through the middle of it. Receives the SAME already-
  // truncated text send() already displayed and passed to the browser's
  // own speak() call -- no separate trimming here anymore.
  async function mirrorAudioToDevice(text: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const speakRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ text, lang: BCP47[lang] || "en-IN" }),
      });
      const speakData = await speakRes.json();
      if (!speakRes.ok || speakData.unsupported || !speakData.audio) {
        console.error("[esp32 voice-output] speak() failed, nothing queued for the device:", speakData.error);
        return;
      }

      const outputRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/voice-output`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ audio: speakData.audio, mime: speakData.mime }),
      });
      if (!outputRes.ok) {
        console.error("[esp32 voice-output] queue insert failed:", await outputRes.text());
      }
    } catch (err) {
      // Non-fatal by design: a hardware terminal that's offline, slow, or
      // failing should never break the dashboard's chat UI. The ESP32
      // simply won't have this reply queued; the user sees the text
      // reply either way (send() already appended it before speak() runs).
      console.error("[esp32 voice-output] mirror failed:", err);
    }
  }

  /* ---------- send ----------
   * origin defaults to "browser" so every EXISTING call site (typed
   * text, the on-screen mic button, suggestion/scheme buttons) needs no
   * change at all and keeps playing replies on the laptop exactly as
   * before. Only the voice_transcript handler above passes "esp32".
   */
  async function send(text: string, origin: TurnOrigin = "browser") {
    const question = text.trim();
    if (!question || sending) return;

    setInput("");
    setSending(true);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace("/login"); return; }

    const optimistic: Message = {
      id: crypto.randomUUID(), conversation_id: conversationId ?? "", role: "user",
      content: question, lang, mode: listening ? "voice" : "text",
      citations: [], created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);

    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ message: question, lang, conversation_id: conversationId }),
        }
      );

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message =
          typeof data.error === "string" ? data.error : t("dashboard.connectionError");
        setMessages((m) => [...m, {
          id: crypto.randomUUID(), conversation_id: "", role: "assistant",
          content: message, lang, mode: "text", citations: [], created_at: new Date().toISOString(),
        }]);
        return;
      }

      if (data.conversation_id) setConversationId(data.conversation_id);

      // ONE AI request only (the fetch to `chat` above) -- no second
      // model call, no summarization call, no client-side truncation.
      // Response length is controlled entirely by the prompt instruction
      // in supabase/functions/chat/index.ts (systemPrompt). finalReply is
      // the ONE value used for both display and speech below -- not two
      // separately-derived texts.
      const finalReply = (data.reply ?? "").trim();

      const reply: Message = {
        id: crypto.randomUUID(), conversation_id: data.conversation_id ?? "", role: "assistant",
        content: finalReply, lang, mode: "text",
        citations: data.citations ?? [], created_at: new Date().toISOString(),
      };
      setMessages((m) => [...m, reply]);
      speak(finalReply, origin);
    } catch {
      setMessages((m) => [...m, {
        id: crypto.randomUUID(), conversation_id: "", role: "assistant",
        content: t("dashboard.connectionError"),
        lang, mode: "text", citations: [], created_at: new Date().toISOString(),
      }]);
    } finally {
      setSending(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  if (booting) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <Sprout className="h-5 w-5 text-primary" />
          <span className="font-semibold tracking-tight">{t("app.name")}</span>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <Button variant="ghost" size="sm" onClick={() => { setMessages([]); setConversationId(null); }}>
            <Plus className="h-4 w-4" /> {t("common.new")}
          </Button>
          <Button
            variant="ghost" size="icon"
            onClick={() => { setMuted((m) => !m); audioRef.current?.pause(); speechSynthesis.cancel(); }}
            title={muted ? t("dashboard.unmuteReplies") : t("dashboard.muteReplies")}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => router.push("/settings")} title={t("common.settings")}>
            <Settings className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={signOut} title={t("common.signOut")}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r p-4 lg:block">
          <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("dashboard.schemesHeading")}
          </p>
          <div className="mt-3 space-y-1">
            {schemes.map((s) => (
              <button
                key={s.id}
                onClick={() => send(t("dashboard.explainScheme", { name: s.name }))}
                className="w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-secondary"
              >
                <span className="block font-medium leading-tight">{s.code}</span>
                <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                  {s.name}
                </span>
              </button>
            ))}
          </div>

          <button
            onClick={() => router.push("/grievances")}
            className="mt-4 flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors hover:bg-secondary"
          >
            <MessageSquareWarning className="h-4 w-4 shrink-0 text-muted-foreground" />
            {t("dashboard.fileGrievance")}
          </button>
        </aside>

        {/* Chat */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
            {messages.length === 0 ? (
              <div className="mx-auto max-w-2xl pt-8 sm:pt-16">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {t("dashboard.namaste")}{profile?.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}.
                </h1>
                <p className="mt-1.5 text-sm text-muted-foreground">{t("dashboard.subtitle")}</p>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.titleKey}
                      onClick={() => send(t(`dashboard.${s.questionKey}`))}
                      className="group rounded-lg border p-3.5 text-left transition-colors hover:bg-secondary"
                    >
                      <s.icon className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
                      <span className="mt-2 block text-sm font-medium">{t(`dashboard.${s.titleKey}`)}</span>
                      <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                        {t(`dashboard.${s.questionKey}`)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-2xl space-y-5">
                {messages.map((m) => (
                  <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                    <div
                      className={
                        m.role === "user"
                          ? "max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground"
                          : "max-w-[92%] space-y-2"
                      }
                    >
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</p>
                      {m.citations?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {m.citations.map((c, i) => (
                            <a
                              key={i}
                              href={c.source_url ?? "#"}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary"
                            >
                              {c.title}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("dashboard.thinking")}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="shrink-0 border-t px-4 py-3 sm:px-6">
            <form
              onSubmit={(e) => { e.preventDefault(); send(input); }}
              className="mx-auto flex max-w-2xl items-center gap-2"
            >
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  listening
                    ? t("dashboard.listening")
                    : transcribing
                    ? t("dashboard.transcribing")
                    : t("dashboard.composerPlaceholder")
                }
                disabled={sending || transcribing}
              />
              <Button
                type="button"
                variant={listening ? "destructive" : "outline"}
                size="icon"
                onClick={toggleMic}
                disabled={transcribing}
                title={t("dashboard.voiceInput")}
              >
                {transcribing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : listening ? (
                  <MicOff className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </Button>
              <Button type="submit" size="icon" disabled={sending || !input.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            </form>
            <p className="mx-auto mt-2 max-w-2xl text-center text-xs text-muted-foreground">
              {t("dashboard.disclaimer")}
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
