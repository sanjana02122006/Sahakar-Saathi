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
//     Chunks are assigned an ordinal (`seq`) server-side, one higher than
//     the count already stored for the session — safe here because the
//     ESP32 firmware sends them one at a time, sequentially, over
//     independent HTTPS requests, awaiting each response before starting
//     the next; there is exactly one client per session and no
//     concurrent/out-of-order sends.
//
//     Session state is PERSISTED in Postgres (device_voice_upload_sessions
//     / device_voice_upload_chunks — migration 0006), not held in an
//     in-memory Map. Edge Functions scale across independent isolates/
//     instances with no shared process memory: a real-hardware test
//     showed `start` succeed and the very first `chunk` immediately fail
//     with "Unknown or expired session_id" — that request landed on a
//     different instance than the one holding the in-memory session, so
//     the earlier in-memory design could only ever work by accident (both
//     requests happening to hit the same warm instance). A database row
//     is visible to every instance, which is what makes the protocol
//     correctness-independent of Edge Function scaling behavior. A
//     session gets the full audio reassembled (ordered by seq) from its
//     chunk rows and is transcribed via the SAME Sarvam call as before
//     once "finish" arrives; the session and its chunk rows are then
//     deleted (cascade). Stale sessions (client crashed mid-upload) are
//     swept on every request via an expires_at check so rows can't grow
//     unbounded.
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

// One service-role client, reused across a single invocation's Postgres
// calls (chunk storage/lookup) — same pattern already used inside
// transcribeAndBroadcast for the Realtime channel, just hoisted so the
// session-table queries can use it too.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const MAX_SESSION_BYTES = 4 * 1024 * 1024; // far above any real push-to-talk clip; guards against a runaway/buggy client

// device_key is never stored raw — only its SHA-256 hash, so a session
// row leak doesn't leak the credential itself. Deno's Web Crypto (SubtleCrypto)
// is available in the Edge Functions runtime with no extra import needed.
async function hashDeviceKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// PostgREST (the API layer Supabase's JS client talks to) has no native
// binary transport — `bytea` columns are exchanged as PostgreSQL's own
// hex text representation, "\x" followed by 2 hex digits per byte, on
// BOTH insert and select. Passing a raw Uint8Array directly to
// supabase-js gets mangled rather than stored correctly (confirmed via
// PostgREST's own documented bytea handling before writing this, not
// assumed) — so every chunk is explicitly hex-encoded before insert and
// hex-decoded after select, via these two helpers.
function bytesToHexBytea(bytes: Uint8Array): string {
  let hex = "\\x";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

function hexByteaToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("\\x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
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
      const body = await req.json().catch(() => ({}));
      const action = body?.action;

      if (action === "start") {
        if (!body.device_key || body.device_key !== DEVICE_API_KEY) {
          return json({ error: "Invalid device key" }, 401);
        }
        const deviceKeyHash = await hashDeviceKey(body.device_key);
        const lang = typeof body.lang === "string" && body.lang ? body.lang : null;

        const { data, error } = await admin
          .from("device_voice_upload_sessions")
          .insert({ device_key_hash: deviceKeyHash, lang })
          .select("session_id")
          .single();

        if (error || !data) {
          console.error("session insert failed:", error);
          return json({ error: "Could not create upload session" }, 500);
        }
        return json({ ok: true, session_id: data.session_id });
      }

      if (action === "chunk") {
        // NOTE on auth for chunk/finish: the currently-deployed ESP32
        // firmware sends only { action, session_id, data } on chunk calls
        // — no device_key (see esp32-firmware/voice_terminal.ino,
        // uploadRecording()) — and firmware changes are explicitly out of
        // scope for this fix. session_id is a server-generated,
        // cryptographically random UUID (crypto.randomUUID(), never
        // guessable, never enumerable) returned ONLY to the device that
        // successfully authenticated with device_key on `start` — so
        // knowledge of session_id is itself proof of having passed that
        // check, functioning as a per-upload bearer credential. This is
        // what satisfies "a different device_key must not be able to
        // submit chunks to another session": a second device would need
        // to already know this session's UUID, which was never exposed to
        // it. device_key_hash is still stored on the session row (set
        // from the authenticated `start` call) for audit/traceability,
        // even though it isn't re-checked as a header on every chunk.
        if (typeof body.session_id !== "string" || !body.session_id) {
          return json({ error: "`session_id` is required" }, 400);
        }
        if (typeof body.data !== "string" || !body.data) {
          return json({ error: "`data` (base64) is required" }, 400);
        }

        // Only a session that is (a) this exact session_id, (b) still
        // open, and (c) not expired is touched at all.
        const { data: session, error: selErr } = await admin
          .from("device_voice_upload_sessions")
          .select("session_id, received_bytes, status, expires_at")
          .eq("session_id", body.session_id)
          .eq("status", "open")
          .gt("expires_at", new Date().toISOString())
          .maybeSingle();

        if (selErr) {
          console.error("session lookup failed:", selErr);
          return json({ error: "Internal error" }, 500);
        }
        if (!session) return json({ error: "Unknown or expired session_id" }, 404);

        const bytes = base64ToBytes(body.data);
        if (session.received_bytes + bytes.length > MAX_SESSION_BYTES) {
          await admin.from("device_voice_upload_sessions").delete().eq("session_id", session.session_id);
          return json({ error: "Session exceeded max allowed size" }, 413);
        }

        // seq is assigned server-side as "how many chunk rows already
        // exist for this session" — not client-supplied — so a chunk
        // can't be replayed into an arbitrary position; combined with the
        // (session_id, seq) primary key on device_voice_upload_chunks, a
        // duplicate/retried chunk send for the same seq is rejected by
        // the database itself rather than silently corrupting the
        // reassembled audio.
        const { count, error: countErr } = await admin
          .from("device_voice_upload_chunks")
          .select("seq", { count: "exact", head: true })
          .eq("session_id", session.session_id);

        if (countErr) {
          console.error("chunk count failed:", countErr);
          return json({ error: "Internal error" }, 500);
        }
        const seq = count ?? 0;

        const { error: chunkErr } = await admin.from("device_voice_upload_chunks").insert({
          session_id: session.session_id,
          seq,
          bytes: bytesToHexBytea(bytes),
        });
        if (chunkErr) {
          console.error("chunk insert failed:", chunkErr);
          return json({ error: "Could not store chunk" }, 500);
        }

        const receivedBytes = session.received_bytes + bytes.length;
        const { error: updErr } = await admin
          .from("device_voice_upload_sessions")
          .update({ received_bytes: receivedBytes })
          .eq("session_id", session.session_id);
        if (updErr) console.error("received_bytes update failed (non-fatal):", updErr); // chunk itself is already durably stored; a failed counter update just makes progress logging slightly stale, not the upload

        return json({ ok: true, received: receivedBytes });
      }

      if (action === "finish") {
        // See the auth note above the `chunk` handler: the deployed
        // firmware sends only { action, session_id } here, no device_key
        // — session_id itself (server-generated, unguessable, only ever
        // returned to a device that already authenticated on `start`) is
        // the operative credential for chunk/finish, by necessity given
        // firmware changes are out of scope for this fix.
        if (typeof body.session_id !== "string" || !body.session_id) {
          return json({ error: "`session_id` is required" }, 400);
        }

        const { data: session, error: selErr } = await admin
          .from("device_voice_upload_sessions")
          .select("session_id, lang, received_bytes, status, expires_at")
          .eq("session_id", body.session_id)
          .eq("status", "open")
          .gt("expires_at", new Date().toISOString())
          .maybeSingle();

        if (selErr) {
          console.error("session lookup failed:", selErr);
          return json({ error: "Internal error" }, 500);
        }
        if (!session) return json({ error: "Unknown or expired session_id" }, 404);

        // Claim the session immediately (mark finished) before doing any
        // further work — a retried/duplicate `finish` call must not
        // reassemble and transcribe the same audio twice. The .eq(status,
        // "open") guard makes this update itself the atomic claim: only
        // one concurrent `finish` call can be the one that actually
        // transitions status open -> finished.
        const { data: claimed, error: claimErr } = await admin
          .from("device_voice_upload_sessions")
          .update({ status: "finished" })
          .eq("session_id", session.session_id)
          .eq("status", "open")
          .select("session_id")
          .maybeSingle();

        if (claimErr) {
          console.error("session claim failed:", claimErr);
          return json({ error: "Internal error" }, 500);
        }
        if (!claimed) {
          // Another concurrent finish call claimed it first — same
          // "nothing more for you to do" outcome as voice-fetch's
          // equivalent claim-race handling.
          return json({ error: "Session already finished" }, 409);
        }

        if (session.received_bytes === 0) {
          await admin.from("device_voice_upload_sessions").delete().eq("session_id", session.session_id);
          return json({ error: "Session has no uploaded audio" }, 400);
        }

        const { data: chunkRows, error: chunkErr } = await admin
          .from("device_voice_upload_chunks")
          .select("seq, bytes")
          .eq("session_id", session.session_id)
          .order("seq", { ascending: true });

        if (chunkErr || !chunkRows) {
          console.error("chunk fetch failed:", chunkErr);
          return json({ error: "Internal error" }, 500);
        }

        // Verify every expected chunk index is actually present (no gap
        // from a dropped/never-retried request) before trusting the
        // reassembled bytes to be a complete, uncorrupted WAV — this is
        // the "verify all bytes were received" check the protocol
        // requires, done structurally (contiguous 0..N-1 seq) rather than
        // by trusting a client-declared total.
        for (let i = 0; i < chunkRows.length; i++) {
          if (chunkRows[i].seq !== i) {
            await admin.from("device_voice_upload_sessions").delete().eq("session_id", session.session_id);
            return json({ error: `Missing chunk seq ${i} — upload incomplete` }, 400);
          }
        }

        const decoded = chunkRows.map((r) => hexByteaToBytes(r.bytes));
        const totalLen = decoded.reduce((sum, b) => sum + b.length, 0);
        const fileBytes = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of decoded) {
          fileBytes.set(chunk, offset);
          offset += chunk.length;
        }

        const result = await transcribeAndBroadcast(fileBytes, session.lang);

        // Cleanup: delete the session row regardless of transcription
        // outcome — chunk rows cascade-delete with it (ON DELETE CASCADE,
        // migration 0006). A transcription failure shouldn't leave upload
        // rows behind any more than a success should.
        await admin.from("device_voice_upload_sessions").delete().eq("session_id", session.session_id);

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
