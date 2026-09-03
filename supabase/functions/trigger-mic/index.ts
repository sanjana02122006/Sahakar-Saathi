// =====================================================================
// Edge Function: trigger-mic
// Lets a hardware push-to-talk button (ESP32 touch sensor) remotely
// start/stop the microphone on an already-open browser tab, via
// Supabase Realtime Broadcast.
//
// This does NOT do speech-to-text itself — it just tells the browser
// "start" or "stop", which then runs its own existing Sarvam STT flow
// exactly as if the user had clicked the mic button by hand.
//
// Deploy:  supabase functions deploy trigger-mic --project-ref <ref>
// Secrets: supabase secrets set DEVICE_API_KEY=...
//
// Request:  POST { device_key: string, action: "start" | "stop" }
// Response: { ok: true, action } | { error }
//
// Auth model: a microcontroller can't do OAuth/JWT, so this uses a single
// shared device key instead of a user login — deliberately NOT the user's
// email/password. Scoped to one hardcoded user id below (Swetha's account)
// since this is a single-device MVP wired to one demo account.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEVICE_API_KEY = Deno.env.get("DEVICE_API_KEY")!;

// The account this hardware button is wired to (swethasanjana122@gmail.com).
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

  try {
    const { device_key, action } = await req.json().catch(() => ({}));
    if (!device_key || device_key !== DEVICE_API_KEY) {
      return json({ error: "Invalid device key" }, 401);
    }
    if (action !== "start" && action !== "stop") {
      return json({ error: '`action` must be "start" or "stop"' }, 400);
    }

    const client = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const channel = client.channel(`mic-trigger-${TARGET_USER_ID}`);

    // Broadcast requires the channel to have actually joined before send()
    // is reliable — subscribe() alone doesn't guarantee that by the time
    // the next line runs, so wait for the SUBSCRIBED callback explicitly.
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
      event: "mic_control",
      payload: {
        action,
        nonce: crypto.randomUUID(),
        ts: new Date().toISOString(),
        source: "esp32-button",
      },
    });
    await client.removeChannel(channel);

    return json({ ok: true, action });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
