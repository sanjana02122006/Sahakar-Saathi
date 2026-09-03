// =====================================================================
// Edge Function: trigger-mic
// Lets a hardware device (ESP32 button) remotely start the microphone
// on an already-open browser tab, via Supabase Realtime Broadcast.
//
// This does NOT do speech-to-text itself — it just pings the browser,
// which then runs its own existing Sarvam STT flow exactly as if the
// user had clicked the mic button by hand.
//
// Deploy:  supabase functions deploy trigger-mic --project-ref <ref>
// Secrets: supabase secrets set DEVICE_API_KEY=...
//
// Request:  POST { device_key: string }
// Response: { ok: true } | { error }
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
    const { device_key } = await req.json().catch(() => ({}));
    if (!device_key || device_key !== DEVICE_API_KEY) {
      return json({ error: "Invalid device key" }, 401);
    }

    const client = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const channel = client.channel(`mic-trigger-${TARGET_USER_ID}`);
    await channel.subscribe();
    await channel.send({
      type: "broadcast",
      event: "start_mic",
      payload: { source: "esp32-button", at: new Date().toISOString() },
    });
    await client.removeChannel(channel);

    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
