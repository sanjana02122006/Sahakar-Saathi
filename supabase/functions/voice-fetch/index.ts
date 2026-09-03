// =====================================================================
// Edge Function: voice-fetch
// Polled by the ESP32 after a successful voice-upload. Returns the
// newest unconsumed TTS clip queued for this device's target user (see
// voice-output), as raw audio bytes — never base64, the ESP32 has no
// reason to pay that encoding overhead over its own network hop.
//
// Deploy:  supabase functions deploy voice-fetch --project-ref <ref>
// Secrets: supabase secrets set DEVICE_API_KEY=...  (already set)
//
// Request:  GET /functions/v1/voice-fetch?device_key=<DEVICE_API_KEY>
// Response: 204 No Content                     — nothing queued
//           200, Content-Type: audio/wav, body — raw WAV/PCM bytes
//           401 { error }                       — bad/missing device key
//
// Content-Type is read straight from the queue row's stored `mime`
// (set by voice-output from whatever speak() produced) — this function
// needed NO logic change for the MP3->WAV switch, only this comment.
//
// Marks the row consumed_at = now() as part of the SAME request that
// serves it, using a single UPDATE ... WHERE consumed_at IS NULL guard —
// this is the safeguard against replaying the same clip to two overlapping
// polls (see comment above the query below for why this is safe without
// a separate row lock).
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEVICE_API_KEY = Deno.env.get("DEVICE_API_KEY")!;

// Same hardcoded target as trigger-mic / voice-upload.
const TARGET_USER_ID = "70f276d5-3117-4b16-aa31-eb941d8c4e53";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  try {
    const url = new URL(req.url);
    const deviceKey = url.searchParams.get("device_key");
    if (!deviceKey || deviceKey !== DEVICE_API_KEY) {
      return json({ error: "Invalid device key" }, 401);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Find the newest unconsumed row for this target user.
    const { data: pending, error: selErr } = await admin
      .from("device_audio_queue")
      .select("id, audio_path, mime")
      .eq("target_user_id", TARGET_USER_ID)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (selErr) throw new Error(`queue select: ${selErr.message}`);
    if (!pending) return new Response(null, { status: 204, headers: CORS });

    // Claim it: UPDATE ... WHERE id = ? AND consumed_at IS NULL, then check
    // rowcount. A single ESP32 device polling sequentially (this project's
    // actual usage pattern — one physical button, push-to-talk, not
    // concurrent) never races itself, but this guard is what makes a
    // double-fired poll (e.g. a retried HTTP request after a flaky
    // response) safe rather than merely unlikely to duplicate audio.
    const { data: claimed, error: updErr } = await admin
      .from("device_audio_queue")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", pending.id)
      .is("consumed_at", null)
      .select("id")
      .maybeSingle();

    if (updErr) throw new Error(`queue claim: ${updErr.message}`);
    if (!claimed) {
      // Another concurrent poll claimed it first between our SELECT and
      // UPDATE — correct outcome is "nothing for you", not an error.
      return new Response(null, { status: 204, headers: CORS });
    }

    const { data: fileData, error: dlErr } = await admin.storage
      .from("device-audio")
      .download(pending.audio_path);
    if (dlErr || !fileData) throw new Error(`storage download: ${dlErr?.message ?? "no data"}`);

    const bytes = new Uint8Array(await fileData.arrayBuffer());
    return new Response(bytes, {
      status: 200,
      headers: { ...CORS, "Content-Type": pending.mime || "audio/wav", "Content-Length": String(bytes.length) },
    });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
