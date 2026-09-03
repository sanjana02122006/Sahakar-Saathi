// =====================================================================
// Edge Function: transcribe
// Speech-to-text via Sarvam AI (POST https://api.sarvam.ai/speech-to-text).
// Keeps SARVAM_API_KEY server-side; the browser posts a recorded audio blob
// and gets back plain text to feed into the normal chat send() path.
//
// Deploy:  supabase functions deploy transcribe --project-ref <ref>
// Secrets: supabase secrets set SARVAM_API_KEY=...
//
// Request:  multipart/form-data
//             file  - audio blob (wav/mp3/aac/aiff/ogg/opus/flac/m4a/amr/wma/webm/pcm)
//             lang  - BCP-47 code, e.g. "hi-IN" (optional; Saaras v3 auto-detects if omitted)
// Response: { text: string, detected_lang?: string } | { error, unsupported?: boolean }
// =====================================================================

const SARVAM_API_KEY = Deno.env.get("SARVAM_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!SARVAM_API_KEY) {
    // Signals the frontend to fall back to the browser's Web Speech API
    // rather than surfacing a raw 500 to a rural user mid-conversation.
    return json({ error: "Voice transcription is not configured yet.", unsupported: true }, 503);
  }

  try {
    const incoming = await req.formData();
    const file = incoming.get("file");
    const lang = incoming.get("lang");

    if (!(file instanceof File)) {
      return json({ error: "`file` (audio) is required" }, 400);
    }

    const forward = new FormData();
    forward.set("file", file, file.name || "audio.webm");
    forward.set("model", "saaras:v3");
    if (typeof lang === "string" && lang) forward.set("language_code", lang);

    const res = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: { "api-subscription-key": SARVAM_API_KEY },
      body: forward,
    });

    if (!res.ok) {
      const detail = await res.text();
      const unsupported = res.status === 400 || res.status === 422;
      return json({ error: "Transcription failed", detail: detail.slice(0, 400), unsupported }, 502);
    }

    const data = await res.json();
    return json({ text: data.transcript ?? "", detected_lang: data.language_code ?? null });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
