// =====================================================================
// Edge Function: voice-upload
// Receives a WAV recording from the ESP32 push-to-talk terminal,
// transcribes it via the SAME Sarvam call `transcribe` already makes,
// and broadcasts the transcript (never the audio) on the existing
// mic-trigger-<user_id> Realtime channel the dashboard already
// subscribes to. The browser then calls its own existing send(text) —
// this function does not touch chat or speak at all.
//
// Deploy:  supabase functions deploy voice-upload --project-ref <ref>
// Secrets: supabase secrets set DEVICE_API_KEY=... SARVAM_API_KEY=...
//          (both already set for trigger-mic / transcribe respectively)
//
// Request:  multipart/form-data
//             device_key  - same DEVICE_API_KEY trigger-mic already validates
//             file        - WAV audio (16kHz/16-bit/mono from the ESP32,
//                            but this function does no format validation,
//                            same as transcribe — whatever Sarvam accepts works)
//             lang        - BCP-47 code, e.g. "en-IN" (optional)
// Response: { ok: true, text: string } | { error, unsupported?: boolean }
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEVICE_API_KEY = Deno.env.get("DEVICE_API_KEY")!;
const SARVAM_API_KEY = Deno.env.get("SARVAM_API_KEY");

// Same hardcoded target as trigger-mic — this is a single-device MVP
// wired to one demo account (swethasanjana122@gmail.com). Kept in sync
// with trigger-mic/index.ts intentionally; not imported/shared because
// Edge Functions each deploy as independent bundles in this project.
const TARGET_USER_ID = "70f276d5-3117-4b16-aa31-eb941d8c4e53";

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
    return json({ error: "Voice transcription is not configured yet.", unsupported: true }, 503);
  }

  try {
    const incoming = await req.formData();
    const deviceKey = incoming.get("device_key");
    const file = incoming.get("file");
    const lang = incoming.get("lang");

    if (!deviceKey || deviceKey !== DEVICE_API_KEY) {
      return json({ error: "Invalid device key" }, 401);
    }
    if (!(file instanceof File)) {
      return json({ error: "`file` (audio) is required" }, 400);
    }

    // ---------- transcribe: identical call shape to transcribe/index.ts ----------
    const forward = new FormData();
    forward.set("file", file, file.name || "recording.wav");
    forward.set("model", "saaras:v3");
    if (typeof lang === "string" && lang) forward.set("language_code", lang);

    const sarvamRes = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: { "api-subscription-key": SARVAM_API_KEY },
      body: forward,
    });

    if (!sarvamRes.ok) {
      const detail = await sarvamRes.text();
      const unsupported = sarvamRes.status === 400 || sarvamRes.status === 422;
      return json({ error: "Transcription failed", detail: detail.slice(0, 400), unsupported }, 502);
    }

    const sarvamData = await sarvamRes.json();
    const text: string = sarvamData.transcript ?? "";

    // ---------- broadcast transcript on the existing channel ----------
    // Empty transcript (silence, noise-only clip) is not an error — Sarvam
    // legitimately returns "" for that — but there's nothing useful to send
    // the browser, so skip the broadcast and just report it back to the ESP32.
    if (text.trim()) {
      const client = createClient(SUPABASE_URL, SERVICE_ROLE, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const channel = client.channel(`mic-trigger-${TARGET_USER_ID}`);

      // Same join-before-send fix already applied in trigger-mic: broadcast
      // is unreliable until the channel has actually completed SUBSCRIBED.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("channel join timed out")), 5000);
        channel.subscribe((status) => {
          if (status === "SUBSCRIBED") { clearTimeout(timeout); resolve(); }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timeout);
            reject(new Error(`channel join failed: ${status}`));
          }
        });
      });

      await channel.send({
        type: "broadcast",
        event: "voice_transcript",
        payload: {
          text,
          nonce: crypto.randomUUID(),
          ts: new Date().toISOString(),
          source: "esp32-mic",
        },
      });
      await client.removeChannel(channel);
    }

    return json({ ok: true, text });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
