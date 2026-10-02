"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { type Message, type Profile, type Scheme } from "@/lib/types";
import { useI18n } from "@/lib/i18n/provider";
import { DICTS } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sprout, Send, Mic, MicOff, LogOut, Plus, Loader2, Settings, Volume2, VolumeX,
  Scale, FileText, ShieldCheck, Wallet, MessageSquareWarning, Check,
} from "lucide-react";
// Guide avatar — presentational-only test feature (see AVATAR-PLAN.md).
// Produces no audio; only reflects existing sending/listening/deliveringId
// state visually. AvatarSwitcher is test-only scaffolding to be removed
// once a variant is picked.
import { GuideAvatar, type AvatarState } from "@/components/avatar";
import { AvatarSwitcher } from "@/components/avatar/switcher";
import { SpeechBubble, ThinkingDots } from "@/components/avatar/speech-bubble";
import { useAvatarVariant } from "@/lib/avatar-context";
// Blockchain document-integrity badge (see BLOCKCHAIN-PLAN.md). Additive
// to the citation chip below — does not replace or restyle it.
import { VerifyBadge } from "@/components/verify-badge";
import { useVerifyDocument } from "@/lib/verify-document";

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

// Blockchain-anchoring badge for one citation chip (see BLOCKCHAIN-PLAN.md).
// A separate component — not inlined into the citations.map() below — because
// useVerifyDocument() is a hook and therefore cannot be called directly
// inside a .map() callback in the parent component's body. Renders nothing
// when the citation was never chain-anchored at all (anchored !== true),
// exactly as the spec's state table requires: no badge, not a neutral one.
function CitationAnchorBadge({ documentId }: { documentId: string }) {
  const { result, status } = useVerifyDocument(documentId);
  return <VerifyBadge status={status} explorerUrl={result?.explorer_url} />;
}

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

  // ---------- guide avatar (presentational only, see AVATAR-PLAN.md) ----------
  // Which message the avatar is currently animating alongside, or null.
  // Keyed by message id (not a boolean) so the avatar animates next to the
  // correct reply rather than all of them at once. Set/cleared only by
  // listeners attached to the EXISTING audio/speechSynthesis paths below —
  // never drives or delays audio itself.
  const [deliveringId, setDeliveringId] = useState<string | null>(null);
  // Reading-time-estimate fallback timer (Channel B: muted or no audio
  // available at all). Stored in a ref so a new reply starting mid-
  // animation can cancel the previous turn's timer before starting its own.
  const deliverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { variant: avatarVariant } = useAvatarVariant();

  // Clear the pending reading-time-estimate timer on unmount so its
  // setTimeout callback never fires setDeliveringId after this component
  // is gone (avoids a setState-after-unmount warning).
  useEffect(() => {
    return () => {
      if (deliverTimeoutRef.current) clearTimeout(deliverTimeoutRef.current);
    };
  }, []);

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

  // Clears any pending reading-time-estimate timer and, if it was the one
  // driving the avatar for `id`, clears deliveringId too. Guards against a
  // new turn starting mid-animation stepping on a stale timeout from the
  // previous one.
  function clearDeliverEstimate() {
    if (deliverTimeoutRef.current) {
      clearTimeout(deliverTimeoutRef.current);
      deliverTimeoutRef.current = null;
    }
  }

  // Channel B (no audio at all): animate the avatar for a reading-time
  // estimate instead of a real playback event, so it still animates
  // "until the text is read", just by the human eye rather than a speech
  // engine. Clamped 1800ms-12000ms based on word count.
  function deliverByReadingEstimate(messageId: string | undefined, text: string) {
    if (!messageId) return;
    clearDeliverEstimate();
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const ms = Math.min(12000, Math.max(1800, (words / 3.5) * 1000));
    setDeliveringId(messageId);
    deliverTimeoutRef.current = setTimeout(() => {
      setDeliveringId((cur) => (cur === messageId ? null : cur));
      deliverTimeoutRef.current = null;
    }, ms);
  }

  function speakWithBrowser(text: string, messageId?: string) {
    if (!("speechSynthesis" in window)) {
      // No TTS available at all — fall back to the reading-time estimate.
      deliverByReadingEstimate(messageId, text);
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = BCP47[lang] || "en-IN";
    if (messageId) {
      clearDeliverEstimate();
      u.onstart = () => setDeliveringId(messageId);
      u.onend = () => setDeliveringId((cur) => (cur === messageId ? null : cur));
      u.onerror = () => setDeliveringId((cur) => (cur === messageId ? null : cur));
    }
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
  async function speak(text: string, origin: TurnOrigin, messageId?: string) {
    if (origin === "esp32") {
      // Channel B for the guide avatar: nothing plays on the laptop for an
      // esp32-origin turn (see the long comment above) — the avatar still
      // animates via the reading-time estimate so it isn't left idle while
      // the ESP32's own speaker is delivering the reply.
      deliverByReadingEstimate(messageId, text);
      await mirrorAudioToDevice(text);
      return;
    }

    if (muted) {
      // Channel B: muted means nothing will read this reply aloud at all —
      // the avatar still animates via the reading-time estimate.
      deliverByReadingEstimate(messageId, text);
      return;
    }

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
        speakWithBrowser(text, messageId);
        return;
      }

      if (audioRef.current) audioRef.current.pause();
      const audio = new Audio(`data:${data.mime};base64,${data.audio}`);
      audioRef.current = audio;
      if (messageId) {
        clearDeliverEstimate();
        audio.onplay = () => setDeliveringId(messageId);
        audio.onended = () => setDeliveringId((cur) => (cur === messageId ? null : cur));
        audio.onerror = () => setDeliveringId((cur) => (cur === messageId ? null : cur));
        audio.onpause = () => setDeliveringId((cur) => (cur === messageId ? null : cur));
      }
      audio.play().catch(() => speakWithBrowser(text, messageId));
    } catch {
      speakWithBrowser(text, messageId);
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
  // Returns whether the clip actually made it into the device queue, so
  // the per-message replay button can show a real success/failure state
  // instead of optimistically claiming it worked. The automatic
  // esp32-origin call site ignores this return value, exactly as before.
  async function mirrorAudioToDevice(text: string): Promise<boolean> {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return false;

      const speakRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ text, lang: BCP47[lang] || "en-IN" }),
      });
      const speakData = await speakRes.json();
      if (!speakRes.ok || speakData.unsupported || !speakData.audio) {
        console.error("[esp32 voice-output] speak() failed, nothing queued for the device:", speakData.error);
        return false;
      }

      const outputRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/voice-output`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ audio: speakData.audio, mime: speakData.mime }),
      });
      if (!outputRes.ok) {
        console.error("[esp32 voice-output] queue insert failed:", await outputRes.text());
        return false;
      }
      return true;
    } catch (err) {
      // Non-fatal by design: a hardware terminal that's offline, slow, or
      // failing should never break the dashboard's chat UI. The ESP32
      // simply won't have this reply queued; the user sees the text
      // reply either way (send() already appended it before speak() runs).
      console.error("[esp32 voice-output] mirror failed:", err);
      return false;
    }
  }

  /* ---------- manual replay to the hardware speaker ----------
   * Re-sends an already-displayed assistant reply to the physical
   * terminal on demand. Reuses mirrorAudioToDevice() rather than adding
   * a parallel path: TTS is regenerated from the same stored text and
   * queued through the same voice-output endpoint the automatic
   * esp32-origin flow uses, so the device sees an ordinary queued clip
   * and needs no special handling to tell a replay from a first play.
   *
   * The ESP32 collects it via its idle voice-fetch poll (see
   * IDLE_POLL_INTERVAL_MS in esp32-firmware/voice_terminal.ino) -- which
   * is what makes this button work at all while the device is sitting
   * idle, rather than the clip waiting in the queue until someone next
   * presses the physical button.
   *
   * Keyed by message id so only the pressed row shows a spinner, and a
   * second press is ignored while one is already in flight.
   */
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [replayedId, setReplayedId] = useState<string | null>(null);

  async function replayOnDevice(message: Message) {
    if (replayingId) return; // one at a time -- avoids queueing the same clip twice on a double-click
    setReplayingId(message.id);
    setReplayedId(null);
    const ok = await mirrorAudioToDevice(message.content);
    setReplayingId(null);
    if (ok) {
      setReplayedId(message.id);
      // Clear the confirmation after a few seconds so the row returns to
      // its normal state rather than looking permanently "sent".
      setTimeout(() => setReplayedId((cur) => (cur === message.id ? null : cur)), 4000);
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
      speak(finalReply, origin, reply.id);
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
        <div className="flex items-center gap-3">
          <GuideAvatar variant={avatarVariant} state="thinking" size={48} />
          <SpeechBubble state="thinking">
            <span className="text-sm text-muted-foreground">{t("avatar.gettingReady")}</span>
          </SpeechBubble>
        </div>
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
          {/* Test-only guide-avatar variant picker — see AVATAR-PLAN.md. */}
          <AvatarSwitcher />
          <Button variant="ghost" size="sm" onClick={() => { setMessages([]); setConversationId(null); }}>
            <Plus className="h-4 w-4" /> {t("common.new")}
          </Button>
          <Button
            variant="ghost" size="icon"
            onClick={() => {
              setMuted((m) => !m);
              audioRef.current?.pause();
              speechSynthesis.cancel();
              // Muting mid-delivery must stop the avatar's animation too —
              // otherwise it keeps "delivering" forever since pause()/cancel()
              // above don't reliably fire onpause/onend in every browser.
              clearDeliverEstimate();
              setDeliveringId(null);
            }}
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
            {schemes.map((s) => {
              // The short code (KCC, PACS-CSC, ...) is an official
              // abbreviation and stays unlocalized in every language, same
              // as it would appear in a real government document. Only the
              // descriptive name underneath is translated, via
              // lib/i18n/<lang>.ts's `schemes` section (keyed by this same
              // code). t() falls back to the raw "schemes.CODE" path when
              // a translation is missing in BOTH the current language and
              // English -- that's not a usable label, so fall back to the
              // DB's own English s.name instead for any future scheme code
              // that hasn't been translated yet.
              const schemeName = t(`schemes.${s.code}`);
              const displayName = schemeName === `schemes.${s.code}` ? s.name : schemeName;
              return (
                <button
                  key={s.id}
                  onClick={() => send(t("dashboard.explainScheme", { name: displayName }))}
                  className="w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-secondary"
                >
                  <span className="block font-medium leading-tight">{s.code}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                    {displayName}
                  </span>
                </button>
              );
            })}
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
                <div className="flex items-start gap-3">
                  <GuideAvatar variant={avatarVariant} state="idle" size={48} />
                  <div>
                    <h1 className="text-2xl font-semibold tracking-tight">
                      {t("dashboard.namaste")}{profile?.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}.
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">{t("avatar.welcome")}</p>
                  </div>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{t("dashboard.subtitle")}</p>
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
                {messages.map((m) => {
                  // Guide avatar state for THIS message only — derived, not a
                  // parallel state machine (see AVATAR-PLAN.md). Only ever
                  // "delivering" for the specific assistant message currently
                  // being read aloud (or animating on the reading-time
                  // estimate); every other message just sits idle.
                  const avatarState: AvatarState =
                    m.role === "assistant" && deliveringId === m.id ? "delivering" : "idle";
                  return (
                  <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex items-start gap-2"}>
                    {m.role === "assistant" && (
                      <div className="mt-0.5 shrink-0">
                        <GuideAvatar variant={avatarVariant} state={avatarState} size={32} />
                      </div>
                    )}
                    <div
                      className={
                        m.role === "user"
                          ? "max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground"
                          : "max-w-[92%] space-y-2"
                      }
                    >
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</p>
                      {m.role === "assistant" && m.content.trim() && (
                        <button
                          onClick={() => replayOnDevice(m)}
                          disabled={replayingId !== null}
                          title={t("dashboard.playOnDevice")}
                          aria-label={t("dashboard.playOnDevice")}
                          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-50"
                        >
                          {replayingId === m.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : replayedId === m.id ? (
                            <Check className="h-3.5 w-3.5 text-primary" />
                          ) : (
                            <Volume2 className="h-3.5 w-3.5" />
                          )}
                          {replayedId === m.id ? t("dashboard.sentToDevice") : t("dashboard.playOnDevice")}
                        </button>
                      )}
                      {m.citations?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {m.citations.map((c, i) => {
                            // Citation titles come from kb_documents.title
                            // (English source documents) via the chat
                            // function's RAG lookup -- there's no per-
                            // language column or document id in this
                            // payload to key off (see the `citations`
                            // section of lib/i18n/en.ts for why). Direct
                            // dictionary lookup by the English title text
                            // itself, falling back to that same English
                            // text for any title not yet translated.
                            const localizedTitle = (DICTS[lang] as any)?.citations?.[c.title] ?? c.title;
                            return (
                              // Fragment wraps the EXISTING citation chip (untouched) plus the
                              // new blockchain-anchoring badge appended after it (see
                              // BLOCKCHAIN-PLAN.md) -- the chip's own <a> tag, className, and
                              // href are unmodified below.
                              <span key={i} className="inline-flex items-center gap-1">
                                <a
                                  href={c.source_url ?? "#"}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary"
                                >
                                  {localizedTitle}
                                </a>
                                {c.anchored && c.document_id && (
                                  <CitationAnchorBadge documentId={c.document_id} />
                                )}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                  );
                })}
                {sending && (
                  <div className="flex items-center gap-2">
                    <GuideAvatar variant={avatarVariant} state="thinking" size={32} />
                    <SpeechBubble state="thinking">
                      <ThinkingDots label={t("dashboard.thinking")} />
                    </SpeechBubble>
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
