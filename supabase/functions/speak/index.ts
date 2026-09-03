// =====================================================================
// Edge Function: speak
// Text-to-speech via Sarvam AI Bulbul v3 (POST https://api.sarvam.ai/text-to-speech).
// Keeps SARVAM_API_KEY server-side; returns base64 audio the browser plays
// directly, replacing the robotic browser speechSynthesis voice.
//
// Deploy:  supabase functions deploy speak --project-ref <ref>
// Secrets: supabase secrets set SARVAM_API_KEY=...  (shared with transcribe)
//
// Request:  { text: string, lang: string }             (lang like "hi-IN")
// Response: { audio: string, mime: "audio/wav" } | { error, unsupported?: boolean }
// =====================================================================

const SARVAM_API_KEY = Deno.env.get("SARVAM_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// One natural-sounding bulbul:v3 voice per language, picked for a warm,
// clear tone appropriate for guidance/legal content rather than casual chat.
const SPEAKER_BY_LANG: Record<string, string> = {
  "en-IN": "priya", "hi-IN": "shubh", "mr-IN": "ritu", "ta-IN": "kavya",
  "te-IN": "shreya", "bn-IN": "ishita", "gu-IN": "roopa", "kn-IN": "kavitha",
  "pa-IN": "simran",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!SARVAM_API_KEY) {
    // Signals the frontend to fall back to speechSynthesis rather than
    // surfacing a raw error to a rural user mid-conversation.
    return json({ error: "Voice output is not configured yet.", unsupported: true }, 503);
  }

  try {
    const { text, lang = "en-IN" } = await req.json();
    if (typeof text !== "string" || !text.trim()) {
      return json({ error: "`text` is required" }, 400);
    }

    const speaker = SPEAKER_BY_LANG[lang] ?? "priya";
    // bulbul:v3 caps at 2500 chars; trim generously so a long answer never 502s.
    const clipped = text.trim().slice(0, 2000);

    const res = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: { "api-subscription-key": SARVAM_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: clipped,
        target_language_code: lang,
        speaker,
        model: "bulbul:v3",
        output_audio_codec: "mp3",
        pace: 1.0,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      const unsupported = res.status === 400 || res.status === 422;
      return json({ error: "Speech synthesis failed", detail: detail.slice(0, 400), unsupported }, 502);
    }

    const data = await res.json();
    const audio = data.audios?.[0];
    if (!audio) return json({ error: "No audio returned", unsupported: true }, 502);

    return json({ audio, mime: "audio/mpeg" });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
