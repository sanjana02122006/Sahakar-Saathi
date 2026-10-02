// =====================================================================
// Edge Function: chat
// Multilingual cooperative-governance assistant.
//
// Flow: verify JWT -> ensure conversation -> embed question ->
//       retrieve KB chunks (pgvector) -> Gemini answer in user's language
//       -> persist both turns -> return reply + citations.
//
// Deploy:  supabase functions deploy chat --project-ref <ref>
// Secrets: supabase secrets set GEMINI_API_KEY=...
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;

// text-embedding-004 and gemini-2.0-flash were retired by Google; current models as of 2026-08.
const EMBED_MODEL = "gemini-embedding-001"; // truncated to 768 dims via outputDimensionality — matches vector(768)
const EMBED_DIM = 768;

// Each Gemini model has its OWN separate free-tier daily quota. A user's
// preferred_model (set in Settings) is tried first; if it's rate-limited
// (429) we fall through this stable chain automatically so one exhausted
// model never dead-ends a conversation. Order = broadest quota first.
const DEFAULT_CHAT_MODEL = "gemini-3.1-flash-lite";
const FALLBACK_CHAT_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LANG_NAMES: Record<string, string> = {
  en: "English", hi: "Hindi", mr: "Marathi", ta: "Tamil", te: "Telugu",
  bn: "Bengali", gu: "Gujarati", kn: "Kannada", pa: "Punjabi",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

function systemPrompt(langName: string, context: string) {
  return `You are "Sahakar Saathi", an assistant for the Ministry of Cooperation (India), helping cooperative members, farmers and rural stakeholders.

Scope: cooperative laws and by-laws, Ministry of Cooperation schemes, PACS services, PMFBY crop insurance, financial literacy, and grievance redressal.

Rules:
- Reply ONLY in ${langName}. Use simple words a rural user understands. Avoid legal jargon; if a legal term is unavoidable, explain it in one short phrase.
- Ground your answer in the CONTEXT below whenever it is relevant. Do not invent scheme names, section numbers, amounts, or deadlines.
- If the context does not cover the question, say plainly that you are unsure and direct the user to their nearest PACS, District Cooperative Officer, or the official portal.
- For grievances, give the concrete steps and the correct authority to approach.
- Be concise: your ENTIRE reply must be a complete, self-contained answer of at most 80 words and at most 3-4 sentences. Do not truncate mid-thought -- choose what to include so the answer is complete and finishes with proper punctuation within that limit.
- Never present yourself as a substitute for official legal advice.

CONTEXT:
${context || "(no retrieved documents — answer from general cooperative knowledge and be explicit about uncertainty)"}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // ---------- auth ----------
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return json({ error: "Missing Authorization header" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Invalid or expired token" }, 401);
    const userId = userData.user.id;

    const { data: profile } = await admin
      .from("profiles").select("preferred_model").eq("id", userId).single();
    const preferredModel = profile?.preferred_model || DEFAULT_CHAT_MODEL;
    // Try the user's chosen model first, then fall through the stable chain,
    // skipping duplicates if their choice is already in it.
    const modelChain = [preferredModel, ...FALLBACK_CHAT_MODELS.filter((m) => m !== preferredModel)];

    // ---------- input ----------
    const { message, lang = "en", conversation_id } = await req.json();
    if (typeof message !== "string" || !message.trim()) {
      return json({ error: "`message` is required" }, 400);
    }
    const question = message.trim().slice(0, 2000);
    const langName = LANG_NAMES[lang] ?? "English";
    const startedAt = Date.now();

    // ---------- ensure conversation ----------
    let convId = conversation_id as string | null;
    if (!convId) {
      const { data, error } = await admin
        .from("conversations")
        .insert({
          user_id: userId,
          lang,
          title: question.slice(0, 60) + (question.length > 60 ? "…" : ""),
        })
        .select("id")
        .single();
      if (error) throw new Error(`conversation insert: ${error.message}`);
      convId = data.id;
    }

    // ---------- retrieve (best-effort; chat still works with an empty KB) ----------
    let citations: { title: string; source_url: string | null; similarity: number }[] = [];
    let context = "";

    try {
      const embRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: `models/${EMBED_MODEL}`,
            content: { parts: [{ text: question }] },
            outputDimensionality: EMBED_DIM,
          }),
        },
      );

      if (embRes.ok) {
        const emb = await embRes.json();
        const vector = emb?.embedding?.values;
        if (Array.isArray(vector)) {
          const { data: chunks } = await admin.rpc("match_kb_chunks", {
            query_embedding: vector,
            match_count: 5,
            filter_category: null,
          });
          if (chunks?.length) {
            context = chunks
              .map((c: any, i: number) => `[${i + 1}] ${c.title}\n${c.content}`)
              .join("\n\n");
            const seen = new Set<string>();
            citations = chunks
              .filter((c: any) => !seen.has(c.title) && seen.add(c.title))
              .map((c: any) => ({
                title: c.title,
                source_url: c.source_url ?? null,
                similarity: Number(c.similarity?.toFixed?.(3) ?? 0),
              }));
          }
        }
      }
    } catch (_) {
      // Retrieval is non-fatal — fall through to an ungrounded answer.
    }

    // ---------- generate, with automatic fallback across models on quota exhaustion ----------
    let reply: string | null = null;
    let modelUsed: string | null = null;
    let lastError: { status: number; detail: string } | null = null;

    for (const model of modelChain) {
      const genRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt(langName, context) }] },
            contents: [{ role: "user", parts: [{ text: question }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
          }),
        },
      );

      if (genRes.ok) {
        const gen = await genRes.json();
        reply = gen?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? null;
        modelUsed = model;
        break;
      }

      const detail = await genRes.text();
      lastError = { status: genRes.status, detail };
      if (genRes.status !== 429) break; // only quota errors are worth trying the next model for
      console.error(`model ${model} exhausted (429), trying next in chain`);
    }

    if (!reply) {
      if (lastError?.status === 429) {
        return json({
          error: "All configured models are temporarily at their usage limit. Please try again shortly, or pick a different model in Settings.",
          detail: lastError.detail.slice(0, 500),
        }, 429);
      }
      return json({
        error: "Model request failed",
        detail: (lastError?.detail ?? "unknown error").slice(0, 500),
      }, 502);
    }

    // ---------- persist both turns ----------
    const { error: msgErr } = await admin.from("messages").insert([
      {
        conversation_id: convId, user_id: userId, role: "user", content: question,
        lang, mode: "text", citations: [], latency_ms: null,
      },
      {
        conversation_id: convId, user_id: userId, role: "assistant", content: reply,
        lang, mode: "text", citations, latency_ms: Date.now() - startedAt,
      },
    ]);
    if (msgErr) console.error("message insert failed:", msgErr.message);

    await admin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId);

    return json({
      reply, citations, conversation_id: convId, latency_ms: Date.now() - startedAt,
      model_used: modelUsed, fell_back: modelUsed !== preferredModel,
    });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
