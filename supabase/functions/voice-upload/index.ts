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
// TWO request shapes are accepted:
//
// (A) multipart/form-data — the ORIGINAL contract, kept as-is:
//             device_key  - same DEVICE_API_KEY trigger-mic already validates
//             file        - WAV audio
//             lang        - BCP-47 code, e.g. "en-IN" (optional)
//
// (B) application/json, chunked session protocol — ADDED to work around a
//     confirmed defect in the ESP32's installed arduino-esp32 core: its
//     WiFiClientSecure/mbedTLS write path (send_ssl_data) does not
//     correctly loop on partial mbedtls_ssl_write() returns for long
//     single-shot bodies. This is a real, documented upstream bug (fixed
//     in espressif/arduino-esp32 PR #11865, merged 2025-09-24 — i.e. only
//     in cores newer than that; not something this project can safely
//     assume is present). It reproduced identically two different ways on
//     real hardware: a raw WiFiClientSecure loop failing mid-write at byte
//     5632, and HTTPClient::sendRequest()'s OWN internal retry loop later
//     still failing with HTTPC_ERROR_SEND_PAYLOAD_FAILED (-3) at ~15.9s —
//     both funnel through the same broken primitive for a ~150-180KB body.
//     The fix is architectural on the ESP32 side: never attempt one large
//     HTTPS write. Instead split the WAV into small chunks, each sent as
//     its own independent HTTPS POST (small JSON+base64 body, well clear
//     of the size/duration where the write bug manifests):
//
//       { action: "start",  device_key, lang? }                    -> { session_id }
//       { action: "chunk",  session_id, data: base64 }              -> { ok: true, received }
//       { action: "finish", session_id }                            -> { ok: true, text }
//
//     Chunks are appended in arrival order (no seq field) — safe here
//     because the ESP32 firmware sends them one at a time, sequentially,
//     over independent HTTPS requests, awaiting each response before
//     starting the next; there is exactly one client per session and no
//     concurrent/out-of-order sends. Session state is held in-memory
//     (module-level Map) for the lifetime of this function instance,
//     keyed by session_id — acceptable for a single-device MVP with one
//     in-flight recording at a time; no new table/bucket needed. A
//     session gets the full audio assembled from its chunks and is
//     transcribed via the SAME Sarvam call as before once "finish"
//     arrives. Stale sessions (client crashed mid-upload) are swept on
//     every request so memory can't grow unbounded.
// Response: { ok: true, text: string } | { ok: true, session_id } | { ok: true, received }
//         | { error, unsupported?: boolean }
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

// ---------- chunked-session state ----------
// Bound on session lifetime and count so a crashed/never-finished client
// can't leak memory across warm invocations of this function instance.
const SESSION_TTL_MS = 2 * 60 * 1000; // a single recording is a few seconds of audio; 2 minutes is generous
const MAX_SESSION_BYTES = 4 * 1024 * 1024; // far above any real push-to-talk clip; guards against a runaway/buggy client

interface UploadSession {
  chunks: Uint8Array[];
  totalBytes: number;
  lang: string | null;
  createdAt: number;
}

const sessions = new Map<string, UploadSession>();

function sweepStaleSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- shared: transcribe + broadcast (used by both request shapes) ----------
async function transcribeAndBroadcast(fileBytes: Uint8Array, lang: string | null): Promise<{ ok: true; text: string } | { ok: false; status: number; body: Record<string, unknown> }> {
  if (!SARVAM_API_KEY) {
    return { ok: false, status: 503, body: { error: "Voice transcription is not configured yet.", unsupported: true } };
  }

  const forward = new FormData();
  forward.set("file", new File([fileBytes], "recording.wav", { type: "audio/wav" }));
  forward.set("model", "saaras:v3");
  if (lang) forward.set("language_code", lang);

  const sarvamRes = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": SARVAM_API_KEY },
    body: forward,
  });

  if (!sarvamRes.ok) {
    const detail = await sarvamRes.text();
    const unsupported = sarvamRes.status === 400 || sarvamRes.status === 422;
    return { ok: false, status: 502, body: { error: "Transcription failed", detail: detail.slice(0, 400), unsupported } };
  }

  const sarvamData = await sarvamRes.json();
  const text: string = sarvamData.transcript ?? "";

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

  return { ok: true, text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const contentType = req.headers.get("content-type") || "";

  try {
    // ================= Shape (B): chunked JSON session protocol =================
    if (contentType.includes("application/json")) {
      sweepStaleSessions();

      const body = await req.json().catch(() => ({}));
      const action = body?.action;

      if (action === "start") {
        if (!body.device_key || body.device_key !== DEVICE_API_KEY) {
          return json({ error: "Invalid device key" }, 401);
        }
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, {
          chunks: [],
          totalBytes: 0,
          lang: typeof body.lang === "string" && body.lang ? body.lang : null,
          createdAt: Date.now(),
        });
        return json({ ok: true, session_id: sessionId });
      }

      if (action === "chunk") {
        const session = sessions.get(body.session_id);
        if (!session) return json({ error: "Unknown or expired session_id" }, 404);
        if (typeof body.data !== "string" || !body.data) {
          return json({ error: "`data` (base64) is required" }, 400);
        }

        const bytes = base64ToBytes(body.data);
        if (session.totalBytes + bytes.length > MAX_SESSION_BYTES) {
          sessions.delete(body.session_id);
          return json({ error: "Session exceeded max allowed size" }, 413);
        }

        session.chunks.push(bytes);
        session.totalBytes += bytes.length;
        return json({ ok: true, received: session.totalBytes });
      }

      if (action === "finish") {
        const session = sessions.get(body.session_id);
        if (!session) return json({ error: "Unknown or expired session_id" }, 404);
        sessions.delete(body.session_id); // claim immediately — a retried finish must not double-transcribe

        if (session.totalBytes === 0) {
          return json({ error: "Session has no uploaded audio" }, 400);
        }

        const fileBytes = new Uint8Array(session.totalBytes);
        let offset = 0;
        for (const chunk of session.chunks) {
          fileBytes.set(chunk, offset);
          offset += chunk.length;
        }

        const result = await transcribeAndBroadcast(fileBytes, session.lang);
        if (!result.ok) return json(result.body, result.status);
        return json({ ok: true, text: result.text });
      }

      return json({ error: "Unknown or missing `action` (expected start|chunk|finish)" }, 400);
    }

    // ================= Shape (A): original multipart/form-data =================
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

    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const result = await transcribeAndBroadcast(fileBytes, typeof lang === "string" && lang ? lang : null);
    if (!result.ok) return json(result.body, result.status);
    return json({ ok: true, text: result.text });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
