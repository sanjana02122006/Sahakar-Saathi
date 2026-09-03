#!/usr/bin/env node
/**
 * Ingests every JSON doc in supabase/kb-corpus/ via the deployed `ingest`
 * Edge Function. Requires:
 *   - the `ingest` function deployed with GEMINI_API_KEY set
 *   - an admin user's access token (profiles.role = 'admin')
 *
 * Usage:
 *   ADMIN_JWT=<access_token> node scripts/ingest-corpus.mjs
 *
 * Get ADMIN_JWT by signing in through the app and running, in the browser
 * console: (await supabase.auth.getSession()).data.session.access_token
 */
import fs from "node:fs";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env.local");
const env = Object.fromEntries(
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const JWT = process.env.ADMIN_JWT;

if (!SUPABASE_URL) { console.error("NEXT_PUBLIC_SUPABASE_URL missing from .env.local"); process.exit(1); }
if (!JWT) { console.error("Set ADMIN_JWT env var to a signed-in admin user's access token."); process.exit(1); }

const corpusDir = path.join(process.cwd(), "supabase", "kb-corpus");
const files = fs.readdirSync(corpusDir).filter((f) => f.endsWith(".json")).sort();

if (files.length === 0) { console.error("No .json files found in supabase/kb-corpus/"); process.exit(1); }

console.log(`Ingesting ${files.length} document(s) into ${SUPABASE_URL} ...\n`);

for (const file of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(corpusDir, file), "utf8"));
  process.stdout.write(`  ${file} ... `);

  const res = await fetch(`${SUPABASE_URL}/functions/v1/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${JWT}` },
    body: JSON.stringify(doc),
  });

  if (!res.ok) {
    console.log(`FAILED (${res.status})`);
    console.log("   ", (await res.text()).slice(0, 300));
    continue;
  }

  const result = await res.json();
  console.log(`ok — ${result.chunks} chunks, ${result.embedded} embedded`);
}

console.log("\nDone.");
