// =====================================================================
// Edge Function: voice-output
// Called by the browser (authenticated, existing Supabase session —
// NOT the device key) right after speak() gets a TTS clip back from
// Sarvam (WAV/PCM as of this project's ESP32 integration — see
// speak/index.ts). Mirrors that same audio into private Storage + a
// queue row so the ESP32 terminal can retrieve it later via voice-fetch.
// Does NOT replace or delay the browser's own playback — speak() keeps
// playing the clip locally exactly as before; this is purely a side
// channel. Format-agnostic: stores whatever `mime` it's given, so this
// function itself needed no logic change for the MP3->WAV switch.
//
// Deploy:  supabase functions deploy voice-output --project-ref <ref>
// Secrets: none beyond what's already set (SUPABASE_SERVICE_ROLE_KEY,
//          SUPABASE_URL — both auto-injected by the platform)
//
// Request:  POST, JSON, Authorization: Bearer <user's Supabase session token>
//             { audio: string (base64), mime: string }
// Response: { ok: true } | { error }
//
// Auth model: verifies the caller's JWT exactly like `chat` does — this
// is the one new function in this pass that authenticates as a real user,
// not a device key, because only a browser with a legitimate session
// should be able to queue audio for playback on someone's hardware.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // ---------- auth: same pattern as chat/index.ts ----------
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return json({ error: "Missing Authorization header" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Invalid or expired token" }, 401);
    const userId = userData.user.id;

    // ---------- input ----------
    const { audio, mime } = await req.json().catch(() => ({}));
    if (typeof audio !== "string" || !audio) {
      return json({ error: "`audio` (base64) is required" }, 400);
    }
    // Default matches speak()'s current output (audio/wav) rather than
    // the old MP3-era default — this only matters if mime is omitted,
    // which the browser's actual call site never does today.
    const contentType = typeof mime === "string" && mime ? mime : "audio/wav";
    const ext = contentType === "audio/wav" ? "wav" : contentType === "audio/mpeg" ? "mp3" : "bin";

    // ---------- decode + upload to private Storage ----------
    const bytes = base64ToBytes(audio);
    const objectPath = `${userId}/${crypto.randomUUID()}.${ext}`;

    const { error: uploadErr } = await admin.storage
      .from("device-audio")
      .upload(objectPath, bytes, { contentType, upsert: false });
    if (uploadErr) throw new Error(`storage upload: ${uploadErr.message}`);

    // ---------- queue row ----------
    const { error: insertErr } = await admin.from("device_audio_queue").insert({
      target_user_id: userId,
      audio_path: objectPath,
      mime: contentType,
    });
    if (insertErr) throw new Error(`queue insert: ${insertErr.message}`);

    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
