// =====================================================================
// Edge Function: ingest
// Admin-only. Chunks a source document, embeds each chunk, and stores it
// in kb_documents / kb_chunks so the chat function can retrieve it.
//
// Deploy: supabase functions deploy ingest --project-ref <ref>
// Call:   POST { title, category, source_url?, lang?, content }
//         Authorization: Bearer <JWT of a user whose profile.role = 'admin'>
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
// text-embedding-004 was retired by Google; gemini-embedding-001 is current as of 2026-08.
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIM = 768; // truncated via outputDimensionality — must match chat/index.ts and vector(768)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

/** Paragraph-aware chunking with a soft character budget. */
function chunk(text: string, max = 1200): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    if ((buf + "\n\n" + p).length > max && buf) { out.push(buf); buf = p; }
    else { buf = buf ? `${buf}\n\n${p}` : p; }
  }
  if (buf) out.push(buf);
  return out;
}

async function embed(text: string): Promise<number[] | null> {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBED_DIM,
      }),
    },
  );
  if (!r.ok) return null;
  const j = await r.json();
  return j?.embedding?.values ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
    if (!token) return json({ error: "Missing Authorization header" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: u, error: uErr } = await admin.auth.getUser(token);
    if (uErr || !u?.user) return json({ error: "Invalid token" }, 401);

    // admin gate
    const { data: prof } = await admin.from("profiles").select("role").eq("id", u.user.id).single();
    if (prof?.role !== "admin") return json({ error: "Admin role required" }, 403);

    const { title, category, source_url = null, lang = "en", content } = await req.json();
    if (!title || !category || !content) {
      return json({ error: "`title`, `category` and `content` are required" }, 400);
    }

    const { data: doc, error: docErr } = await admin
      .from("kb_documents")
      .insert({ title, category, source_url, lang })
      .select("id")
      .single();
    if (docErr) throw new Error(`document insert: ${docErr.message}`);

    const parts = chunk(content);
    const rows: any[] = [];
    let embedded = 0;

    for (const part of parts) {
      const vector = await embed(part);
      if (vector) embedded++;
      rows.push({
        document_id: doc.id,
        content: part,
        embedding: vector,
        token_count: Math.ceil(part.length / 4),
      });
    }

    const { error: chunkErr } = await admin.from("kb_chunks").insert(rows);
    if (chunkErr) throw new Error(`chunk insert: ${chunkErr.message}`);

    return json({ document_id: doc.id, chunks: rows.length, embedded });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
