// Standalone end-to-end test for the blockchain document-integrity feature.
// Uses the service-role key already present in .env.local (same key the
// Edge Functions themselves trust) via plain fetch against Supabase's
// REST/Auth/Functions endpoints directly -- avoids @supabase/supabase-js's
// realtime client entirely (which needs a global WebSocket this Node
// version lacks), since this script never needs a realtime subscription.
// No secrets are printed; nothing is sent anywhere except this project's
// own Supabase URL, exactly as the Edge Functions themselves already do.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE || !ANON_KEY) {
  console.error("Missing env"); process.exit(1);
}

function log(step, obj) {
  console.log(`\n=== ${step} ===`);
  console.log(JSON.stringify(obj, null, 2).slice(0, 2000));
}

async function authAdmin(path, body, method = "POST") {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function restTable(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function callFn(fn, token, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function minimalPdf(bodyLines) {
  const text = bodyLines.map((l) => `BT /F1 12 Tf 50 ${700 - l.y} Td (${l.text}) Tj ET`).join("\n");
  const stream = text;
  return Buffer.from(
    `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 612 792]/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length ${stream.length}>>
stream
${stream}
endstream
endobj
xref
0 6
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF`,
    "latin1"
  );
}

function blankPdf() {
  return Buffer.from(
    `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/Resources<<>>/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj
4 0 obj<</Length 0>>
stream
endstream
endobj
xref
0 5
trailer<</Size 5/Root 1 0 R>>
startxref
0
%%EOF`,
    "latin1"
  );
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
}

async function main() {
  const testEmail = `blockchain-test-${Date.now()}@example.com`;
  const password = "TestPassword123!";

  // 1. Create a throwaway test user via the Auth admin REST API
  const created = await authAdmin("/users", { email: testEmail, password, email_confirm: true });
  log("1. Create test user", created);
  if (created.status >= 300 || !created.data.id) {
    record("create test user", false, created);
    return finish();
  }
  const userId = created.data.id;
  record("create test user", true, { userId });

  // 2. Promote to admin via the profiles table (service role bypasses RLS)
  const promoted = await restTable(`/profiles?id=eq.${userId}`, {
    method: "PATCH",
    body: { role: "admin" },
    headers: { Prefer: "return=representation" },
  });
  log("2. Promote to admin", promoted);
  record("promote to admin", promoted.status < 300, promoted);

  // 3. Sign in to get a real JWT via the same path the frontend uses
  const session = await signIn(testEmail, password);
  log("3. Sign in", { status: session.status, hasToken: !!session.data.access_token });
  if (!session.data.access_token) {
    record("sign in", false, session);
    return finish(userId);
  }
  const token = session.data.access_token;
  record("sign in (get JWT)", true, {});

  // 4. ingest — real PDF with extractable text
  const pdfBytes = minimalPdf([
    { y: 0, text: "PMFBY Crop Insurance Test Document" },
    { y: 30, text: "This is a test of blockchain anchoring for Sahakar Saathi." },
  ]);
  const pdfBase64 = pdfBytes.toString("base64");

  const ingestRes = await callFn("ingest", token, {
    title: "Blockchain Test PMFBY Document",
    category: "pmfby",
    pdf_base64: pdfBase64,
  });
  log("4. ingest (PDF, has real text)", ingestRes);
  record("ingest accepts real PDF", ingestRes.status === 200 && !!ingestRes.data.document_id, ingestRes.data);

  if (ingestRes.status !== 200 || !ingestRes.data.document_id) {
    return finish(userId);
  }
  const documentId = ingestRes.data.document_id;

  // 5. Re-ingest identical PDF — must detect duplicate hash
  const dupRes = await callFn("ingest", token, {
    title: "Blockchain Test PMFBY Document (dup)",
    category: "pmfby",
    pdf_base64: pdfBase64,
  });
  log("5. ingest (duplicate hash)", dupRes);
  record(
    "duplicate hash detected, no re-embed",
    dupRes.status === 200 && dupRes.data.already_ingested === true,
    dupRes.data
  );

  // 6. verify-document BEFORE anchoring
  const preVerify = await callFn("verify-document", token, { document_id: documentId });
  log("6. verify-document (before anchor)", preVerify);
  record("verify-document returns not_anchored pre-anchor", preVerify.data.status === "not_anchored", preVerify.data);

  // 7. anchor-document
  const anchorRes = await callFn("anchor-document", token, { document_id: documentId });
  log("7. anchor-document", anchorRes);
  const walletConfigured = anchorRes.status !== 503;
  record(
    "anchor-document responds correctly given wallet state",
    walletConfigured
      ? anchorRes.status === 200 && !!anchorRes.data.chain_tx_hash
      : anchorRes.data.error === "chain_signer_not_configured",
    anchorRes.data
  );

  // 8. verify-document AFTER anchoring, only if anchoring actually succeeded
  if (anchorRes.status === 200 && anchorRes.data.chain_tx_hash) {
    const postVerify = await callFn("verify-document", token, { document_id: documentId });
    log("8. verify-document (after anchor)", postVerify);
    record("verify-document returns verified post-anchor", postVerify.data.status === "verified", postVerify.data);
  } else {
    log("8. SKIPPED", { reason: "anchor-document did not succeed (expected without a funded wallet secret)" });
    record("verify-document post-anchor", null, "skipped — wallet not configured, expected in this environment");
  }

  // 9. scanned/no-text PDF must be rejected, not silently ingested
  const blankBase64 = blankPdf().toString("base64");
  const scannedRes = await callFn("ingest", token, {
    title: "Blank Scanned Test Document",
    category: "pmfby",
    pdf_base64: blankBase64,
  });
  log("9. ingest (blank/no-text PDF)", scannedRes);
  record(
    "scanned/no-text PDF rejected with clear error",
    scannedRes.status !== 200 && scannedRes.data.error === "scanned_pdf_needs_ocr",
    scannedRes.data
  );

  // 10. existing text-ingestion path must be completely unaffected
  const textRes = await callFn("ingest", token, {
    title: "Blockchain Test Text Document",
    category: "pmfby",
    content: "Plain text ingestion regression check: this path must be byte-for-byte unchanged by the PDF feature.",
  });
  log("10. ingest (plain text, regression)", textRes);
  record("existing text-ingest path still works unmodified", textRes.status === 200 && !!textRes.data.document_id, textRes.data);

  // 11. chat citations carry `anchored`, not `verified`
  const chatRes = await callFn("chat", token, { message: "What is PMFBY?", lang: "en" });
  log("11. chat (citation shape)", {
    status: chatRes.status,
    citationsSample: chatRes.data?.citations?.slice(0, 3),
  });
  const citationsOk =
    chatRes.status === 200 &&
    Array.isArray(chatRes.data.citations) &&
    (chatRes.data.citations.length === 0 ||
      Object.prototype.hasOwnProperty.call(chatRes.data.citations[0], "anchored"));
  record("chat citations carry `anchored` field (not `verified`)", citationsOk, chatRes.data?.citations);

  return finish(userId);
}

async function finish(userId) {
  if (userId) {
    await authAdmin(`/users/${userId}`, undefined, "DELETE").catch(() => {});
    console.log("\n(test user cleaned up)");
  }

  console.log("\n\n========== TEST SUMMARY ==========");
  for (const r of results) {
    const mark = r.pass === true ? "PASS" : r.pass === false ? "FAIL" : "SKIP";
    console.log(`[${mark}] ${r.name}`);
  }
  const failed = results.filter((r) => r.pass === false);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (excluding skips).`);
  if (failed.length) {
    console.log("\nFAILED CHECKS DETAIL:");
    for (const f of failed) console.log(`- ${f.name}:`, JSON.stringify(f.detail).slice(0, 500));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exitCode = 1;
});
