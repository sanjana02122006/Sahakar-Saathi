// =====================================================================
// Edge Function: anchor-document
// Admin-only. Writes a kb_documents row's sha256_hash on-chain to
// Polygon Amoy (testnet) as a second, SEPARATE step after `ingest` —
// see BLOCKCHAIN-PLAN.md's "chain write is the last step, after
// embeddings succeed" rule. This function never touches Gemini, PDF
// content, or any user/chat data — it reads ONLY sha256_hash from the
// kb_documents row, by construction, and writes ONLY that 32-byte hash
// into the transaction's calldata. Nothing else from the row is ever
// read or sent anywhere.
//
// Idempotent: re-calling on an already-anchored document is a no-op
// (returns the existing chain_tx_hash), not an error — a flaky retry is
// always safe.
//
// Deploy:  supabase functions deploy anchor-document --project-ref <ref>
// Secrets: supabase secrets set POLYGON_SIGNER_PRIVATE_KEY=...
//          supabase secrets set POLYGON_RPC_URL=...   (optional override)
// Call:    POST { document_id }
//          Authorization: Bearer <JWT of a user whose profile.role = 'admin'>
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { ethers } from "https://esm.sh/ethers@6.13.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const POLYGON_SIGNER_PRIVATE_KEY = Deno.env.get("POLYGON_SIGNER_PRIVATE_KEY");
const POLYGON_RPC_URL = Deno.env.get("POLYGON_RPC_URL") || "https://rpc-amoy.polygon.technology";
const CHAIN_NETWORK = "polygon-amoy";
const EXPLORER_BASE = "https://amoy.polygonscan.com/tx/";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

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

    // admin gate — identical pattern to ingest
    const { data: prof } = await admin.from("profiles").select("role").eq("id", u.user.id).single();
    if (prof?.role !== "admin") return json({ error: "Admin role required" }, 403);

    const { document_id } = await req.json();
    if (!document_id) return json({ error: "`document_id` is required" }, 400);

    // Only sha256_hash (+ chain_tx_hash to check idempotency) is read from
    // the row — by construction, there is no code path in this function
    // that could put any other document field on-chain.
    const { data: doc, error: docErr } = await admin
      .from("kb_documents")
      .select("id, sha256_hash, chain_tx_hash")
      .eq("id", document_id)
      .single();
    if (docErr || !doc) return json({ error: "Document not found" }, 404);

    if (!doc.sha256_hash) {
      return json({ error: "Document has no sha256_hash — only PDF-sourced documents can be anchored" }, 400);
    }

    // Idempotent: already anchored is a no-op success, not an error.
    if (doc.chain_tx_hash) {
      return json({
        document_id: doc.id,
        chain_tx_hash: doc.chain_tx_hash,
        explorer_url: `${EXPLORER_BASE}${doc.chain_tx_hash}`,
        already_anchored: true,
      });
    }

    if (!POLYGON_SIGNER_PRIVATE_KEY) {
      return json({
        error: "chain_signer_not_configured",
        detail: "POLYGON_SIGNER_PRIVATE_KEY is not set. Fund a dedicated Amoy wallet via https://faucet.polygon.technology/ and run `supabase secrets set POLYGON_SIGNER_PRIVATE_KEY=...` before anchoring.",
      }, 503);
    }

    // sha256_hash is a 64-char hex string (no 0x prefix) in the DB — normalize
    // to a 0x-prefixed 32-byte hex value for calldata.
    const hashHex = doc.sha256_hash.startsWith("0x") ? doc.sha256_hash : `0x${doc.sha256_hash}`;
    if (!ethers.isHexString(hashHex, 32)) {
      return json({ error: "Stored sha256_hash is not a valid 32-byte hex digest" }, 500);
    }

    const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
    const wallet = new ethers.Wallet(POLYGON_SIGNER_PRIVATE_KEY, provider);

    let txResponse;
    try {
      // Plain 0-value transaction, hash as calldata, sent to the signer's
      // own address (Decision 2 in BLOCKCHAIN-PLAN.md — no contract
      // deployment). The transaction itself IS the permanent record.
      txResponse = await wallet.sendTransaction({
        to: wallet.address,
        value: 0n,
        data: hashHex,
      });
    } catch (err: any) {
      // Covers insufficient gas/funds, RPC errors, nonce issues, etc. —
      // kb_documents is never touched on failure, so the row correctly
      // stays in the "not yet anchored" state for a safe retry.
      return json({
        error: "chain_write_failed",
        detail: String(err?.shortMessage ?? err?.message ?? err).slice(0, 400),
      }, 502);
    }

    let receipt;
    try {
      receipt = await txResponse.wait(1);
    } catch (err: any) {
      // Transaction was submitted but failed/dropped before confirmation —
      // still don't write chain_tx_hash, since we can't confirm it landed.
      return json({
        error: "chain_confirmation_failed",
        detail: String(err?.shortMessage ?? err?.message ?? err).slice(0, 400),
        submitted_tx_hash: txResponse.hash,
      }, 502);
    }

    if (!receipt || receipt.status !== 1) {
      return json({
        error: "chain_tx_reverted",
        detail: "Transaction was mined but did not succeed (status != 1).",
        submitted_tx_hash: txResponse.hash,
      }, 502);
    }

    const { error: updErr } = await admin
      .from("kb_documents")
      .update({
        chain_tx_hash: txResponse.hash,
        chain_network: CHAIN_NETWORK,
        anchored_at: new Date().toISOString(),
      })
      .eq("id", doc.id);
    if (updErr) throw new Error(`kb_documents update after successful chain write: ${updErr.message}`);

    return json({
      document_id: doc.id,
      chain_tx_hash: txResponse.hash,
      explorer_url: `${EXPLORER_BASE}${txResponse.hash}`,
      already_anchored: false,
    });
  } catch (err) {
    console.error(err);
    return json({ error: "Internal error", detail: String(err).slice(0, 300) }, 500);
  }
});
