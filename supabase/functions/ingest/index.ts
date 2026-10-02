// =====================================================================
// Edge Function: ingest
// Admin-only. Chunks a source document, embeds each chunk, and stores it
// in kb_documents / kb_chunks so the chat function can retrieve it.
//
// Deploy: supabase functions deploy ingest --project-ref <ref>
// Call (text, UNCHANGED):
//   POST { title, category, source_url?, lang?, content }
// Call (PDF, NEW -- see BLOCKCHAIN-PLAN.md):
//   POST { title, category, source_url?, lang?, pdf_base64 }           (small PDFs, <~4MB base64)
//   POST { title, category, source_url?, lang?, pdf_storage_path }     (large PDFs, pre-uploaded to kb-pdfs)
//   Authorization: Bearer <JWT of a user whose profile.role = 'admin'>
//
// Exactly one of content / pdf_base64 / pdf_storage_path is required.
// This hashes+chunks+embeds the PDF but does NOT write anything on-chain
// -- that is a separate, explicit step via the `anchor-document` function,
// called after this one succeeds (see BLOCKCHAIN-PLAN.md's "chain write
// is the last step, after embeddings succeed" rule).
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.11.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
// text-embedding-004 was retired by Google; gemini-embedding-001 is current as of 2026-08.
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIM = 768; // truncated via outputDimensionality — must match chat/index.ts and vector(768)

const KB_PDFS_BUCKET = "kb-pdfs";
// Server-side cap independent of the client's claimed size — a safety net,
// not the primary defense (the primary defense is the admin gate itself).
const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20MB
// Below this, extracted text is almost certainly a scanned image with no
// real text layer, regardless of page count — see scanned-PDF check below.
const MIN_TEXT_CHARS_PER_PAGE = 20;
const MIN_TOTAL_TEXT_CHARS = 50;

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

/** sha256 hex digest of raw bytes — hashes the ORIGINAL file, never extracted text. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Extract text from a PDF's raw bytes using unpdf (Deno-compatible, no
 * native/Node fs/Buffer assumptions — confirmed via an isolated smoke
 * test before this was wired in; see BLOCKCHAIN-PLAN.md's PDF library note).
 */
async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; numPages: number }> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return { text: text ?? "", numPages: pdf.numPages ?? 1 };
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

    const {
      title, category, source_url = null, lang = "en",
      content, pdf_base64, pdf_storage_path,
    } = await req.json();

    if (!title || !category) {
      return json({ error: "`title` and `category` are required" }, 400);
    }

    const provided = [content, pdf_base64, pdf_storage_path].filter((v) => v != null && v !== "");
    if (provided.length !== 1) {
      return json({ error: "Exactly one of `content`, `pdf_base64`, or `pdf_storage_path` is required" }, 400);
    }

    // =================================================================
    // PDF path (NEW)
    // =================================================================
    if (pdf_base64 || pdf_storage_path) {
      let bytes: Uint8Array;
      let storagePath: string;
      let alreadyInBucket = false;

      if (pdf_base64) {
        try {
          bytes = base64ToBytes(pdf_base64);
        } catch {
          return json({ error: "`pdf_base64` is not valid base64" }, 400);
        }
        storagePath = ""; // assigned after we know the document id (duplicate check happens first)
      } else {
        // pdf_storage_path: client already uploaded directly to kb-pdfs.
        // Fetch the bytes ourselves for hashing/extraction — never trust
        // claimed metadata from the client.
        const { data: fileBlob, error: dlErr } = await admin.storage
          .from(KB_PDFS_BUCKET)
          .download(pdf_storage_path);
        if (dlErr || !fileBlob) {
          return json({ error: "Could not download `pdf_storage_path` from kb-pdfs", detail: dlErr?.message }, 400);
        }
        bytes = new Uint8Array(await fileBlob.arrayBuffer());
        storagePath = pdf_storage_path;
        alreadyInBucket = true;
      }

      if (bytes.length === 0) {
        return json({ error: "Uploaded PDF is empty" }, 400);
      }
      if (bytes.length > MAX_PDF_BYTES) {
        return json({ error: `PDF exceeds the ${MAX_PDF_BYTES / (1024 * 1024)}MB limit` }, 400);
      }
      // Minimal content-type sniff: real PDFs start with "%PDF-". Client-claimed
      // content-type is never trusted alone — this checks the actual bytes.
      const header = new TextDecoder().decode(bytes.slice(0, 5));
      if (header !== "%PDF-") {
        return json({ error: "File does not appear to be a valid PDF" }, 400);
      }

      // Hash the ORIGINAL file bytes — reproducible forever, independent of
      // any PDF-extraction library's behavior/version.
      const sha256_hash = await sha256Hex(bytes);

      // Duplicate-hash detection — the "don't re-embed unchanged documents"
      // cost control. Must happen BEFORE any embedding call.
      const { data: existing } = await admin
        .from("kb_documents")
        .select("id")
        .eq("sha256_hash", sha256_hash)
        .maybeSingle();
      if (existing) {
        return json({ document_id: existing.id, already_ingested: true, chunks: 0, embedded: 0 });
      }

      // Extract text BEFORE inserting anything — a scanned/no-text PDF must
      // never produce a kb_documents row with empty kb_chunks.
      let extracted: { text: string; numPages: number };
      try {
        extracted = await extractPdfText(bytes);
      } catch (err) {
        return json({
          error: "pdf_extraction_failed",
          detail: `Could not parse PDF: ${String(err).slice(0, 300)}`,
        }, 400);
      }

      const trimmed = extracted.text.trim();
      const perPageAvg = trimmed.length / Math.max(1, extracted.numPages);
      const looksScanned = trimmed.length < MIN_TOTAL_TEXT_CHARS || perPageAvg < MIN_TEXT_CHARS_PER_PAGE;
      if (looksScanned) {
        return json({
          document_id: null,
          error: "scanned_pdf_needs_ocr",
          detail: "This PDF appears to be scanned images with no extractable text. OCR is required before it can be ingested.",
        }, 422);
      }

      // Upload to kb-pdfs if it arrived inline (pdf_storage_path is already there).
      const docIdForPath = crypto.randomUUID();
      if (!alreadyInBucket) {
        storagePath = `${docIdForPath}.pdf`;
        const { error: upErr } = await admin.storage
          .from(KB_PDFS_BUCKET)
          .upload(storagePath, bytes, { contentType: "application/pdf", upsert: false });
        if (upErr) throw new Error(`storage upload: ${upErr.message}`);
      }

      const { data: doc, error: docErr } = await admin
        .from("kb_documents")
        .insert({
          id: docIdForPath,
          title, category, source_url, lang,
          source_type: "pdf",
          sha256_hash,
          storage_path: storagePath,
          chain_tx_hash: null, // anchoring is a SEPARATE step — see anchor-document
        })
        .select("id")
        .single();
      if (docErr) throw new Error(`document insert: ${docErr.message}`);

      const parts = chunk(trimmed);
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

      return json({ document_id: doc.id, already_ingested: false, chunks: rows.length, embedded });
    }

    // =================================================================
    // Text path — EXISTING BEHAVIOR, completely unchanged.
    // =================================================================
    if (!content) {
      return json({ error: "`content` is required for the text path" }, 400);
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
