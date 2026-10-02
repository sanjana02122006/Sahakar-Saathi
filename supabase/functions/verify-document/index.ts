// =====================================================================
// Edge Function: verify-document
// THE MOST IMPORTANT PIECE of the blockchain-anchoring feature — see
// BLOCKCHAIN-PLAN.md's "Anchored vs. Verified" section for why this
// function exists at all (the first draft's bug was reporting
// `verified: Boolean(chain_tx_hash)`, which only proves a transaction
// was recorded at some point, not that the file sitting in Storage
// right now still matches it).
//
// Read-only, side-effect-free, NO admin gate (any authenticated user may
// trigger a verification — same trust level as reading a citation at
// all), and — this is load-bearing — NO signer/private-key code
// anywhere in this file. Reading a public testnet transaction needs no
// private key. If a future edit imports POLYGON_SIGNER_PRIVATE_KEY into
// this function, that is a sign it has drifted from its intended
// read-only scope — stop and re-read BLOCKCHAIN-PLAN.md.
//
// This function NEVER writes to kb_documents, never calls Gemini, and
// never touches a signer wallet.
//
// Deploy:  supabase functions deploy verify-document --project-ref <ref>
// Call:    POST { document_id }
//          Authorization: Bearer <JWT of any authenticated user>
// Returns: { status: "not_anchored" | "storage_mismatch" | "chain_mismatch" | "verified", ... }
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { ethers } from "https://esm.sh/ethers@6.13.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const POLYGON_RPC_URL = Deno.env.get("POLYGON_RPC_URL") || "https://rpc-amoy.polygon.technology";
const EXPLORER_BASE = "https://amoy.polygonscan.com/tx/";
const KB_PDFS_BUCKET = "kb-pdfs";

// In-memory cache of successful verifications, per document_id, for a
// short window — re-verifying on every single chat reply would otherwise
// mean a Polygon RPC read (plus a Storage download) for every citation
// shown. This is a plain module-level Map, which is per-isolate (same
// caveat noted in migration 0006 for the old voice-upload session Map) —
// acceptable here because a cache MISS just means "do the real check
// again," never a correctness problem, unlike that earlier session-state
// bug. A short TTL keeps the frontend's "confirmed N minutes ago" badge
// copy roughly honest.
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const verifyCache = new Map<string, { result: Record<string, unknown>; at: number }>();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // Authenticated, but NOT admin-gated — verification is a read-only
    // integrity check, safe for any signed-in user (same trust level as
    // reading a citation at all).
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
    if (!token) return json({ error: "Missing Authorization header" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: u, error: uErr } = await admin.auth.getUser(token);
    if (uErr || !u?.user) return json({ error: "Invalid token" }, 401);

    const { document_id } = await req.json();
    if (!document_id) return json({ error: "`document_id` is required" }, 400);

    const cached = verifyCache.get(document_id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return json({ ...cached.result, cached: true, checked_at: new Date(cached.at).toISOString() });
    }

    // ---------------------------------------------------------------
    // Step 1: fetch the row. No tx hash at all -> nothing to verify yet.
    // ---------------------------------------------------------------
    const { data: doc, error: docErr } = await admin
      .from("kb_documents")
      .select("id, sha256_hash, chain_tx_hash, chain_network, storage_path")
      .eq("id", document_id)
      .single();
    if (docErr || !doc) return json({ error: "Document not found" }, 404);

    if (!doc.chain_tx_hash) {
      const result = { status: "not_anchored", document_id: doc.id };
      return json(result); // not cached — this can change the moment anchor-document runs
    }

    if (!doc.storage_path || !doc.sha256_hash) {
      // Anchored in theory but missing the fields needed to re-check —
      // treat as a chain mismatch rather than silently claiming "verified".
      const result = {
        status: "chain_mismatch",
        document_id: doc.id,
        detail: "Row is missing storage_path or sha256_hash needed to re-verify.",
      };
      return json(result);
    }

    // ---------------------------------------------------------------
    // Step 2: re-download the file from Storage and re-hash it NOW.
    // ---------------------------------------------------------------
    const { data: fileBlob, error: dlErr } = await admin.storage
      .from(KB_PDFS_BUCKET)
      .download(doc.storage_path);
    if (dlErr || !fileBlob) {
      return json({
        status: "storage_mismatch",
        document_id: doc.id,
        detail: `Could not download stored file: ${dlErr?.message ?? "not found"}`,
      });
    }

    const bytes = new Uint8Array(await fileBlob.arrayBuffer());
    const freshHash = await sha256Hex(bytes);

    // ---------------------------------------------------------------
    // Step 3: compare against kb_documents.sha256_hash. Mismatch here
    // means the STORED FILE was altered after ingest — fail immediately,
    // no need to even call the chain.
    // ---------------------------------------------------------------
    if (freshHash !== doc.sha256_hash) {
      const result = { status: "storage_mismatch", document_id: doc.id };
      verifyCache.set(document_id, { result, at: Date.now() });
      return json(result);
    }

    // ---------------------------------------------------------------
    // Step 4: fetch the actual on-chain transaction (READ-ONLY RPC call —
    // no signer, no private key, reading a public testnet tx needs none)
    // and extract the hash written as calldata.
    // ---------------------------------------------------------------
    const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
    let tx;
    try {
      tx = await provider.getTransaction(doc.chain_tx_hash);
    } catch (err) {
      return json({
        status: "chain_mismatch",
        document_id: doc.id,
        detail: `Could not read transaction from chain: ${String(err).slice(0, 300)}`,
      });
    }

    if (!tx || !tx.data) {
      const result = {
        status: "chain_mismatch",
        document_id: doc.id,
        detail: "Transaction not found on-chain, or has no calldata.",
      };
      return json(result);
    }

    // tx.data is the calldata we wrote in anchor-document: "0x" + 64 hex chars.
    const onChainHash = tx.data.toLowerCase().replace(/^0x/, "");
    const dbHash = doc.sha256_hash.toLowerCase().replace(/^0x/, "");

    // ---------------------------------------------------------------
    // Step 5: compare the on-chain hash against kb_documents.sha256_hash.
    // Mismatch here means the DB row doesn't match what was actually
    // anchored.
    // ---------------------------------------------------------------
    if (onChainHash !== dbHash) {
      const result = {
        status: "chain_mismatch",
        document_id: doc.id,
        chain_tx_hash: doc.chain_tx_hash,
      };
      return json(result);
    }

    const result = {
      status: "verified",
      document_id: doc.id,
      chain_tx_hash: doc.chain_tx_hash,
      chain_network: doc.chain_network,
      explorer_url: `${EXPLORER_BASE}${doc.chain_tx_hash}`,
    };
    verifyCache.set(document_id, { result, at: Date.now() });
    return json(result);
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
