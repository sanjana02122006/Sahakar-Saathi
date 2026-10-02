# Document Integrity Anchoring — Build Spec

Adds a blockchain layer to Sahakar Saathi: every official PDF ingested into
the knowledge base gets its SHA-256 hash written to Polygon Amoy (testnet).
When a chat answer is sourced from a hash-anchored document, the UI shows a
badge that starts as "Anchored" and upgrades to "✓ Blockchain Verified"
once a live integrity check confirms the stored file still matches the
chain record — or flags "⚠ Integrity check failed" if it doesn't. See
"Anchored vs. Verified" below for why this is two states, not one.

**One-line explanation for judges:** RAG retrieves the information; the AI
explains it; blockchain verifies that the source document hasn't been
altered since it was registered. Blockchain does NOT verify the document is
legally correct — only that it's byte-identical to what was originally
anchored.

**Note on scale:** Polygon Amoy is a public testnet — describe this to
judges as a prototype verification mechanism, not production-grade
government document certification. A real deployment would need its own
review of network choice, key custody, and whether a testnet's lack of
real economic finality is acceptable for the actual use case.

**Revision note (post-review):** this version folds in a review pass that
caught a real bug in the first draft — `verified: Boolean(chain_tx_hash)`
only proves a transaction was once recorded, not that the document sitting
in Storage right now still matches it. "Anchored" and "Verified" are now
treated as two different states throughout this spec (see the Verification
section) — anchored means a tx hash exists; verified means a fresh re-hash
was just checked against that tx on-chain and they matched.

**Scope discipline — read this before writing code:** this is an ADDITIVE
integrity layer on top of the existing `ingest` → `kb_documents`/`kb_chunks`
→ `match_kb_chunks` → `chat` pipeline. It does not replace RAG, does not
change how Gemini is called, and does not touch the avatar feature, voice
pipeline, or ESP32 firmware. If you find yourself editing
`supabase/functions/speak`, `transcribe`, `trigger-mic`, `voice-fetch`,
`voice-output`, or `voice-upload`, stop — none of those are in scope.

---

## Current state (verified against the live repo before writing this spec)

- `ingest` Edge Function takes raw `content` text only — no PDF upload, no
  file handling, no hashing. Admin-gated via `profiles.role = 'admin'`.
- `kb_documents` has no `sha256_hash`, no chain fields, no `source_type`.
- `match_kb_chunks` RPC (migration `0002_rls.sql`) returns
  `(id, content, title, category, source_url, similarity)` — no
  `document_id`, so `chat/index.ts`'s `citations` array can't currently
  reference a document to look up its chain status.
- No Storage bucket exists for PDFs yet, but there IS an existing pattern to
  follow: `device-audio` bucket (migration `0005_device_audio_queue.sql`).
- 7 migrations exist (`0001`–`0007`). This feature adds `0008`.
- No blockchain dependency installed yet (`package.json` / Edge Function
  imports).

---

## Architecture overview

```
Admin uploads PDF
      │
      ▼
Supabase Storage (new bucket: kb-pdfs, admin-write-only)
      │
      ▼
extract text → SHA-256 hash ──────────────┐
      │                                   │
      ▼                                   ▼
chunk → embed (Gemini) → kb_chunks   check: hash already in
      │                              kb_documents? skip re-embed
      ▼                              if so (cost-saving rule)
kb_documents row written
(sha256_hash, source_type='pdf',
 chain_tx_hash=null initially)
      │
      ▼
Polygon Amoy: write hash in a transaction  ← LAST step, after
      │                                       embeddings succeed
      ▼
kb_documents.chain_tx_hash + chain_network updated
      │
      ▼
   (ready for chat retrieval)

────────────────────────────────────────────────────────

User asks a question
      │
      ▼
chat Edge Function → match_kb_chunks (now also returns document_id)
      │
      ▼
Gemini generates answer from retrieved chunks (UNCHANGED)
      │
      ▼
citations[] now includes: anchored (bool), chain_tx_hash, chain_network
      │
      ▼
Frontend shows "Anchored" state immediately from anchored === true,
then calls verify-document (document_id) to re-check integrity —
see "Anchored vs. Verified" section below for why these are two calls,
not one, and why the badge updates in two stages
```

---

## Database changes — migration `0008_blockchain_verification.sql`

```sql
-- kb_documents: add integrity + chain fields.
-- "anchored_at" (not "verified_at") is deliberate: this timestamp only
-- records when the hash was WRITTEN to chain. It says nothing about
-- whether the stored file still matches it right now — that's a separate,
-- repeatable check (see verify-document below), not a one-time fact.
alter table public.kb_documents
  add column source_type   text not null default 'text'
              check (source_type in ('text', 'pdf')),
  add column sha256_hash   text,          -- hex digest of the ORIGINAL file bytes
  add column chain_tx_hash text,          -- Polygon Amoy transaction hash, null until anchored
  add column chain_network text,          -- e.g. 'polygon-amoy' — future-proofs a network change
  add column anchored_at   timestamptz,   -- when the chain WRITE succeeded (not a verification result)
  add column storage_path  text;          -- object path in kb-pdfs, e.g. '<doc_id>.pdf' — needed so
                                           -- verify-document can re-fetch and re-hash the stored file

-- One hash maps to exactly one document — this IS the "don't re-embed
-- unchanged documents" check: look this up before doing any embedding work.
create unique index if not exists kb_documents_sha256_idx
  on public.kb_documents(sha256_hash) where sha256_hash is not null;

-- RLS: unchanged. kb_documents is already admin-write, public-read via
-- existing policy from 0002_rls.sql — these new columns inherit that.
```

**Do not add a `verified` column to `kb_chunks`.** Join through
`document_id` instead (see RPC change below) — one source of truth for
verification status, not a denormalized copy that can drift.

### `match_kb_chunks` RPC — extend, don't replace

**Fixed from the first draft:** Postgres rejects `CREATE OR REPLACE
FUNCTION` when the return type/column set changes — it errors with
"cannot change return type of existing function." The original draft's SQL
would have failed on first apply. The correct sequence is `DROP FUNCTION`
then `CREATE FUNCTION`, with the `revoke`/`grant` from `0002_rls.sql`
reapplied explicitly (a drop does not preserve grants on the old function).

```sql
drop function if exists public.match_kb_chunks(vector, int, kb_category);

create function public.match_kb_chunks(
  query_embedding vector(768),
  match_count int default 5,
  filter_category kb_category default null
)
returns table (
  id uuid, content text, title text, category kb_category,
  source_url text, similarity float,
  document_id uuid,            -- NEW
  chain_tx_hash text,          -- NEW
  chain_network text           -- NEW
)
language sql stable security definer set search_path = public as $$
  select c.id, c.content, d.title, d.category, d.source_url,
         1 - (c.embedding <=> query_embedding) as similarity,
         d.id, d.chain_tx_hash, d.chain_network
  from public.kb_chunks c
  join public.kb_documents d on d.id = c.document_id
  where c.embedding is not null
    and (filter_category is null or d.category = filter_category)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- MUST re-apply — DROP does not carry grants forward from the old function.
revoke all on function public.match_kb_chunks(vector, int, kb_category) from public, anon;
grant execute on function public.match_kb_chunks(vector, int, kb_category) to authenticated, service_role;
```

The return shape is still additive in spirit — three new trailing columns,
nothing removed, nothing renamed — but the migration mechanics now
correctly reflect how Postgres actually handles a function signature
change. Every existing caller keeps working unchanged once the grants are
back in place; `chat/index.ts` is the only caller today.

---

## Storage — new bucket `kb-pdfs`

Follow the exact pattern already established by `device-audio`
(migration `0005`). Admin-write (insert/update/delete restricted to
`profiles.role = 'admin'`), authenticated-read (so `ingest` and any future
re-verify tooling can fetch the stored original for hash comparison).

```sql
insert into storage.buckets (id, name, public) values ('kb-pdfs', 'kb-pdfs', false)
  on conflict (id) do nothing;

create policy "kb-pdfs admin write" on storage.objects
  for insert with check (
    bucket_id = 'kb-pdfs'
    and (select role from public.profiles where id = auth.uid()) = 'admin'
  );
-- mirror for update/delete; select policy for authenticated read.
```

---

## Edge Function changes

### `ingest` — extend to accept a PDF, keep the text path working

Current signature: `POST { title, category, source_url?, lang?, content }`.

New signature, backward compatible:
`POST { title, category, source_url?, lang?, content?, pdf_base64?,
pdf_storage_path? }` — exactly one of `content` / `pdf_base64` /
`pdf_storage_path` required (see the size-threshold note below for why
there are now two different ways to hand over a PDF).

**Upload path — fixed from the first draft.** Sending an entire PDF as
base64 through a single Edge Function request inflates the payload by
~33% and holds the whole thing in function memory at once; fine for a
small scheme leaflet, risky for a large multi-page government guideline
document given Edge Function payload/memory limits. Use a size threshold:

- **Small PDFs (under ~4MB base64-encoded):** keep the simple
  `pdf_base64` path below — no extra round-trip, fine for most scheme PDFs.
- **Larger PDFs:** the admin UI uploads the file DIRECTLY to the `kb-pdfs`
  Storage bucket first (client → Supabase Storage, not through this
  function at all), then calls `ingest` with `pdf_storage_path` pointing
  at the uploaded object. `ingest` fetches the bytes from Storage itself
  for hashing/extraction instead of receiving them in the request body.
  Validate `content-type: application/pdf` and a max size server-side in
  both paths — never trust the client's claimed file type alone.

```
if pdf_base64 OR pdf_storage_path provided:
  1. obtain bytes — either decode pdf_base64, or download from
     kb-pdfs at pdf_storage_path (already uploaded by the client)
  2. sha256_hash = sha256(bytes)   ← hash the ORIGINAL file bytes, not
                                      extracted text (text extraction can
                                      be lossy/non-deterministic across
                                      library versions — the hash must be
                                      reproducible from the same PDF forever)
  3. check kb_documents for an existing row with this sha256_hash
     → if found: return early with { document_id, already_ingested: true,
       chunks: 0, embedded: 0 } — THIS is the "don't re-embed unchanged
       documents" cost control from the requirements
  4. if arrived via pdf_base64: upload bytes to kb-pdfs at `${doc_id}.pdf`
     (the pdf_storage_path case is already in the bucket — just record
     the path, don't re-upload)
  5. extract text from the PDF (see library choice below)
  6. SCANNED-PDF CHECK (new — see rationale below): if extracted text is
     empty or below a minimum length/word-count threshold relative to the
     PDF's page count, STOP here. Do not insert kb_chunks with near-empty
     content. Return { document_id: null, error: "scanned_pdf_needs_ocr",
     detail: "This PDF appears to be scanned images with no extractable
     text. OCR is required before it can be ingested." } — a clear,
     actionable error, not a silently useless knowledge-base entry.
  7. continue with EXISTING chunk() → embed() → kb_chunks insert, unchanged
  8. insert kb_documents row with source_type='pdf', sha256_hash,
     storage_path, chain_tx_hash=null (anchoring happens in a SEPARATE
     step, see below)
else:
  existing text path, completely unchanged, source_type defaults to 'text'
  (text-sourced docs are never chain-anchored — there's no original file
  to hash; only PDFs go through the chain step)
```

**Why the scanned-PDF check matters:** many real government PDFs —
especially older circulars — are scanned images with no embedded text
layer. A standard extractor (`pdf-parse`, `unpdf`, etc.) returns an empty
or near-empty string for these, and without this check `ingest` would
silently create a `kb_documents` row with zero usable `kb_chunks` — RAG
would then "cite" a verified document that actually contributes nothing to
any answer. Catching this at ingest time and surfacing "OCR required" is
far better than discovering it later as unexplained bad retrieval. OCR
integration itself (e.g. a Tesseract pass) is explicitly OUT OF SCOPE for
this feature — the fix here is detection and a clear error, not solving
OCR.

**PDF text extraction library:** use `unpdf` (Deno-compatible, no native
bindings) or `pdf-parse` via esm.sh — verify whichever is chosen actually
runs in the Supabase Edge Function's Deno runtime before committing to it;
do a one-function smoke test first since several popular PDF libraries
assume Node's `fs`/Buffer and fail silently in Deno.

### New Edge Function: `anchor-document`

Deliberately a SEPARATE function from `ingest`, called as a second step —
this is what makes "chain write is the last step, after embeddings
succeed" actually true, rather than a comment that lies the moment someone
refactors `ingest`.

```
POST { document_id }
Authorization: Bearer <admin JWT>

1. admin-gate identical to ingest
2. fetch kb_documents row by document_id — require sha256_hash is not null
   and chain_tx_hash is null (idempotent: already-anchored docs are a no-op,
   not an error, so retrying a flaky call is always safe)
3. call Polygon Amoy via a JSON-RPC provider (see wallet section below):
   write sha256_hash into a transaction (simplest: as calldata on a 0-value
   tx to the admin wallet's own address, OR call a minimal single-purpose
   contract's `anchor(bytes32)` function — see Decision 2 below)
4. on success: update kb_documents SET chain_tx_hash = tx.hash,
   chain_network = 'polygon-amoy', anchored_at = now()
5. return { document_id, chain_tx_hash, explorer_url }
```

**Never send the PDF content, embeddings, or any user/chat data to the
chain.** Only the 32-byte hash goes on-chain. This is a hard constraint from
the original requirements — enforce it by construction: the only thing this
function reads from `kb_documents` is `sha256_hash`, nothing else.

### New Edge Function: `verify-document` — fixed from the first draft

**This function did not exist in the first draft, and its absence was the
central bug in that version.** The original spec set
`verified: Boolean(chain_tx_hash)` in `chat`'s citations — that only proves
a transaction was recorded *at some point in the past*. It proves nothing
about whether the PDF currently sitting in the `kb-pdfs` bucket still
matches that transaction right now. A badge built on that check would keep
showing "Verified" even if the stored file were silently replaced after
anchoring — which defeats the actual purpose of this feature.

"Anchored" and "Verified" are different states:
- **Anchored** = a `chain_tx_hash` exists on the `kb_documents` row. Cheap,
  known instantly, no network call needed — this is what `chat`'s
  citations can show immediately (see below).
- **Verified** = a fresh check, done NOW, that re-downloads the file from
  `kb-pdfs`, re-computes its SHA-256, and confirms that hash still equals
  both `kb_documents.sha256_hash` AND the hash actually recorded in the
  on-chain transaction. Requires a real-time check — not a stored boolean.

```
POST { document_id }
(No admin gate needed — verification is a read-only integrity check,
safe for any authenticated user to trigger, same trust level as reading
a citation at all.)

1. fetch kb_documents row — require chain_tx_hash is not null
   (nothing to verify against yet → return { status: "not_anchored" })
2. download the file from kb-pdfs at storage_path
3. recompute sha256 of the downloaded bytes
4. compare against kb_documents.sha256_hash:
   → mismatch here means the STORED FILE was altered after ingest,
     independent of the chain entirely. Return
     { status: "storage_mismatch" } immediately — this is already a
     failure, no need to even call the chain.
5. fetch the transaction at chain_tx_hash from Polygon Amoy (read-only
   RPC call, no signer/wallet needed for a read) and extract the hash
   that was written as calldata
6. compare the on-chain hash against kb_documents.sha256_hash:
   → mismatch here means the DATABASE ROW doesn't match what was
     actually anchored (shouldn't happen under normal operation, but
     this is exactly the check that catches it if it does). Return
     { status: "chain_mismatch" }.
   → match: return { status: "verified", chain_tx_hash, explorer_url }
```

This function is deliberately read-only and side-effect-free — it never
writes to `kb_documents`, never calls Gemini, never touches the signer
wallet (reading a public testnet transaction needs no private key). Safe
to call as often as the frontend wants, including every time a citation
with `anchored: true` is rendered.

**Caching the verify result:** since re-verifying on every single chat
reply would mean a Polygon RPC read for every citation shown, cache a
successful `verify-document` result in-memory per `document_id` for a
short window (e.g. a few minutes) in the Edge Function, or store the last
verification outcome back on `kb_documents` as `last_verified_at` +
`last_verify_status` purely as a display hint — but if doing the latter,
the frontend badge must still distinguish "verified, confirmed 3 minutes
ago" from "anchored, not yet re-checked this session," never collapse them
into one green checkmark.

### `chat` — minimal extension to `citations`

In the existing citation-building block (`chat/index.ts`, where `citations`
is assembled from `chunks`), add fields per citation, sourced directly from
the RPC's new columns — no extra query, no extra Gemini call. Note the
field is named `anchored`, not `verified` — `chat` can only report the
cheap, stored fact (a tx hash exists); confirming it's still correct right
now is `verify-document`'s job, called separately by the frontend:

```ts
citations = chunks
  .filter((c: any) => !seen.has(c.title) && seen.add(c.title))
  .map((c: any) => ({
    title: c.title,
    source_url: c.source_url ?? null,
    similarity: Number(c.similarity?.toFixed?.(3) ?? 0),
    anchored: Boolean(c.chain_tx_hash),        // NEW — "a tx hash exists", NOT "verified right now"
    document_id: c.document_id,                // NEW — needed so the frontend can call verify-document
    chain_tx_hash: c.chain_tx_hash ?? null,    // NEW
    chain_network: c.chain_network ?? null,    // NEW
  }));
```

Everything else in `chat/index.ts` — the Gemini call, the model fallback
chain, the system prompt, the conversation handling — is UNCHANGED. The
blockchain check never touches Gemini, confirmed by this diff being
entirely inside the already-existing citation-mapping step.

---

## Wallet / signer — the one open decision from the earlier discussion

Needs a wallet that can sign and submit the anchoring transaction. Options,
ranked by fit for this project:

1. **Hot wallet key in Edge Function secrets** (recommended for this
   prototype) — same trust model as `SUPABASE_SERVICE_ROLE_KEY` already
   sitting in Supabase secrets. Generate a fresh wallet dedicated to this
   purpose (never reuse a personal wallet), fund it with Amoy testnet MATIC
   from a public faucet (free, no real money since Amoy is a testnet), store
   the private key as `POLYGON_SIGNER_PRIVATE_KEY` via
   `supabase secrets set`. Low complexity, acceptable risk for a testnet
   demo — if this were mainnet/production, this decision would need
   revisiting with a proper KMS/HSM, but that's explicitly out of scope for
   a hackathon prototype.
2. Externally-owned signer service (a separate microservice holding the
   key) — more secure, meaningfully more infrastructure. Not worth it for
   this prototype; revisit only if this goes to a real government
   deployment with real funds at stake.

**Decision needed before build starts:** confirm option 1, and confirm
someone will generate the wallet + fund it from an Amoy faucet
(`https://faucet.polygon.technology/`, select Amoy) before the first
`anchor-document` call is tested.

## Smart contract vs. plain transaction — Decision 2

Two ways to get the hash on-chain:

- **Plain transaction, hash as calldata** (simplest): send a 0-value
  transaction from the signer wallet to itself with the hash in the `data`
  field. No contract deployment, no Solidity, works immediately. The
  transaction itself IS the permanent record — Polygonscan shows the
  calldata.
- **Minimal contract with an `anchor(bytes32 hash)` function emitting an
  event**: slightly more "real" for a demo (an explorer shows a decoded
  event, not raw hex), but requires deploying a contract to Amoy first and
  is an extra moving part.

**Recommendation: plain transaction for v1.** It fully satisfies "store the
hash on-chain, show the farmer a Polygonscan link" with zero additional
infrastructure. A contract can be added later as a polish pass if time
permits — it's cosmetic (nicer explorer view), not functional.

---

## Request flow — end to end

**Admin ingests and anchors a PDF:**
1. Admin UI (new, see Frontend section) uploads PDF → `ingest` with
   `pdf_base64` (or `pdf_storage_path` for larger files)
2. `ingest` hashes, checks for duplicate, rejects scanned/no-text PDFs,
   extracts+chunks+embeds, stores PDF in `kb-pdfs`, inserts `kb_documents`
   row (unanchored)
3. Admin UI calls `anchor-document` with the returned `document_id`
4. `anchor-document` writes hash to Polygon Amoy, updates the row —
   document is now ANCHORED (a tx hash exists), not yet "verified" in the
   live sense until something actually calls `verify-document`
5. Document is now fully live: retrievable by RAG, and any future chat
   citation of it can report `anchored: true` immediately

**Farmer asks a question (completely unchanged until the last step):**
1. Dashboard sends question to `chat`, exactly as today
2. `chat` embeds question, calls `match_kb_chunks` (now returns 3 extra
   columns), builds `context` for Gemini exactly as today
3. Gemini generates the answer exactly as today
4. `citations[]` in the response now carries `anchored`/`document_id`/
   `chain_tx_hash`/`chain_network` per citation
5. Dashboard renders the existing citation chip, PLUS an "Anchored" badge
   immediately when `anchored === true` (cheap, instant, no network call)
6. In the background, the dashboard calls `verify-document(document_id)`
   for each anchored citation. When that resolves `status: "verified"`,
   the badge upgrades to "✓ Blockchain Verified" with the Polygonscan
   link. If it resolves `storage_mismatch` or `chain_mismatch`, the badge
   shows a warning state instead — see Frontend section for the three
   visual states this implies.

---

## Frontend changes

### Citation chip — extend, don't redesign

The existing citation chip in `app/dashboard/page.tsx` (the
`m.citations.map(...)` block, same one already carrying the
append-only-JSX warning from the avatar feature — this is ANOTHER reason to
touch that block carefully) gets a small badge with **three states, not
one** — this is the direct UI consequence of splitting anchored from
verified, and skipping straight to a single green checkmark would recreate
the exact bug this revision fixes:

| State | When | Look |
|---|---|---|
| (none) | `anchored === false` | No badge — this citation was never chain-anchored (e.g. a text-sourced doc). |
| **Anchored** | `anchored === true`, `verify-document` still pending/not yet called | Neutral badge, e.g. "Checking…" or a muted "Anchored" pill — shown instantly from the `chat` response, before any extra network round-trip. |
| **✓ Blockchain Verified** | `verify-document` returned `status: "verified"` | Green badge, links to `https://amoy.polygonscan.com/tx/${chain_tx_hash}`. |
| **⚠ Integrity check failed** | `verify-document` returned `storage_mismatch` or `chain_mismatch` | Warning-colored badge — this is the state that actually matters most to catch; never silently fall back to the neutral "Anchored" look on a failed check. |

```tsx
// simplified sketch — actual implementation needs local state per
// citation (e.g. a small useEffect + useState keyed by document_id) to
// hold the verify-document result once it resolves
{c.anchored && (
  <button
    onClick={() => openVerification(c.document_id)}
    title={t(`verified.tooltip.${verifyState}`)}
    className={cn(
      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
      verifyState === "verified" && "bg-primary/10 text-primary",
      verifyState === "pending" && "bg-muted text-muted-foreground",
      verifyState === "failed" && "bg-destructive/10 text-destructive",
    )}
  >
    <ShieldCheck className="h-3 w-3" /> {t(`verified.badge.${verifyState}`)}
  </button>
)}
```

`ShieldCheck` is already imported in `page.tsx` for an unrelated icon use —
confirm it's still imported before reusing; if not, add it to the existing
`lucide-react` import line rather than a new import statement. Consider a
different icon for the `failed` state (e.g. `ShieldAlert`, also in
`lucide-react`) so the warning state is visually distinct at a glance, not
just a color change.

### New admin-only page: `app/admin/verify/page.tsx`

A minimal upload form, gated the same way `settings` checks `profile.role`
(if that pattern exists — otherwise gate client-side on `profile.role ===
'admin'` and rely on the Edge Functions' server-side gate as the real
security boundary, same as `ingest` already does). Fields: title, category
dropdown (reuse `KbCategory`), PDF file input, submit → for large files,
upload directly to `kb-pdfs` first (see the size-threshold note in the
`ingest` section), then call `ingest` (small files: inline via
`pdf_base64`) then `anchor-document` in sequence, shows the resulting
`chain_tx_hash` with a Polygonscan link once anchoring completes. If
`ingest` returns `scanned_pdf_needs_ocr`, show that error clearly instead
of a generic failure — the admin needs to know OCR is required, not just
that something went wrong.

This is new UI surface, not a modification of existing admin tooling —
confirm there isn't already an admin ingest page before building a second
one; a quick search of `app/` for `role === 'admin'` or an "admin" route
should settle it in under a minute.

### i18n

New keys needed, added to `en.ts` and propagated to all 9 language files
(same discipline as the avatar feature), one set per badge state since
there are now three:

- `verified.badge.pending` ("Anchored"), `verified.tooltip.pending`
- `verified.badge.verified` ("Blockchain Verified"), `verified.tooltip.verified`
  (explains what it does NOT mean — "This document matches what was
  originally registered" — per the requirement that users shouldn't think
  this verifies legal correctness)
- `verified.badge.failed` ("Integrity check failed"),
  `verified.tooltip.failed` ("This document no longer matches its
  registered record — treat this answer's source with caution")

---

## Cost-saving strategies — mapped to concrete mechanisms

| Requirement | Mechanism |
|---|---|
| Minimize Gemini usage | No new Gemini calls anywhere in this feature — hashing and chain writes never touch Gemini. Embedding calls happen exactly as often as they do today (once per chunk, only for genuinely new documents). |
| Don't re-embed unchanged documents | `kb_documents_sha256_idx` unique index + the early-return check in `ingest` step 3 — re-uploading the identical PDF is detected before any embedding call happens. |
| Cache embeddings | Already inherent: `kb_chunks.embedding` is computed once at ingest and reused by every future chat query via `match_kb_chunks` — no change needed, this was always true. |
| Cache answers | **Explicitly NOT recommended** (per the earlier discussion) — free-text questions across 9 languages have low verbatim-repeat rates; an answer cache adds complexity for a low hit rate. Skip for v1. |
| Don't send blockchain data to Gemini | Enforced by construction: `anchor-document` never calls Gemini, and `chat`'s prompt-building step never includes `chain_tx_hash` or any chain field in the text sent to Gemini — only in the separately-returned `citations[]` JSON. |
| Don't store PDFs/personal data on-chain | Enforced by construction: `anchor-document` only ever reads `sha256_hash` from the DB — it has no code path that could put file content or user data into a transaction. |

---

## Security model

- **Chain writes are admin-only**, gated identically to `ingest` (JWT →
  `profiles.role = 'admin'` check) — not a new auth pattern, reuse the
  existing one verbatim. `anchor-document` is the only function with
  write access to the chain.
- **Chain reads are public-by-design** — anyone can look up a tx hash on
  Polygonscan; this is intentional transparency, not a leak.
  `verify-document` performs only reads (Storage read + chain read) and
  needs no admin gate — any authenticated user may trigger a
  verification, same trust level as reading a citation at all.
- **The signer private key never reaches the client** — lives only in
  Supabase secrets, used only inside `anchor-document`'s server-side Deno
  runtime. `verify-document` needs NO private key at all (reading a public
  testnet transaction requires no signer) — if its code ever imports the
  signer key, that's a sign it drifted from its intended read-only scope.
- **RLS on `kb_documents`** — unchanged from existing policy; new columns
  inherit the existing public-read/admin-write rule.

---

## What this explicitly does NOT change

- `chat`'s Gemini call, prompt, or model-fallback chain
- `match_kb_chunks`'s existing 6 columns (only additive columns)
- The text-ingest path for non-PDF documents (still works exactly as today)
- Avatar feature, voice pipeline (`speak`/`transcribe`), ESP32 firmware
- `next.config.mjs`'s static export — all chain calls happen server-side in
  Edge Functions, never from the browser, so `output: "export"` is
  unaffected (same reasoning that already applies to every other Edge
  Function call from the frontend)

---

## Implementation order (recommended)

1. Migration `0008`: schema + `kb-pdfs` bucket + the fixed
   `match_kb_chunks` drop/recreate
2. `ingest`: PDF upload (both size paths), SHA-256 hashing, duplicate
   detection, scanned-PDF detection — get this solid before touching chain
   code at all, since it's independently testable without a wallet
3. `anchor-document`: admin-only chain write
4. `verify-document`: the real integrity check — re-hash Storage, compare
   to DB, compare to on-chain record. This is the piece that was missing
   entirely from the first draft; do not consider the feature functional
   until this exists and is wired into the frontend
5. `chat` citation extension + frontend three-state badge
6. Full test pass (see test cases below) across text-ingest (regression),
   PDF-ingest, anchoring, and both the happy and failure paths of
   verification

## Definition of done

- [ ] Migration `0008` applied: new `kb_documents` columns (including
      `storage_path`, `anchored_at` not `verified_at`), unique hash index,
      `kb-pdfs` bucket + RLS policies
- [ ] `match_kb_chunks` correctly DROPPED and recreated (not
      `CREATE OR REPLACE`) with grants reapplied; returns the 3 new
      columns, old callers unaffected
- [ ] `ingest` accepts both `pdf_base64` (small files) and
      `pdf_storage_path` (large files, pre-uploaded), hashes original
      bytes, skips re-embed on duplicate hash, detects and rejects
      scanned/no-text PDFs with a clear error, stores `storage_path`,
      text path completely unchanged
- [ ] New `anchor-document` function: idempotent, admin-gated, writes only
      the hash on-chain, never Gemini/PDF content/user data
- [ ] New `verify-document` function: re-downloads from Storage, re-hashes,
      compares against both the DB row AND the actual on-chain tx data,
      returns distinct `verified` / `storage_mismatch` / `chain_mismatch` /
      `not_anchored` states — read-only, no admin gate, no signer key
- [ ] `chat`'s citations carry `anchored`/`document_id`/`chain_tx_hash`/
      `chain_network` (named `anchored`, not `verified` — chat never claims
      a live integrity check happened), rest of `chat` unchanged
- [ ] Dashboard citation chip shows all three badge states (anchored
      pending / verified / failed) backed by a real `verify-document` call,
      not a stored boolean; existing chip/replay-button JSX untouched
- [ ] Admin upload page exists (or confirmed to reuse an existing one),
      surfaces the scanned-PDF error clearly
- [ ] i18n keys (3 badge states × badge + tooltip) added across all 9
      languages
- [ ] Signer wallet generated, funded via Amoy faucet, key in Edge Function
      secrets — never committed, never in `NEXT_PUBLIC_*` — and confirmed
      `verify-document` has no code path that touches this key at all
- [ ] Test: upload a real PDF → anchor it → ask a question whose answer
      cites it → see it go Anchored → Verified → click through to
      Polygonscan and see the matching hash
- [ ] Test: anchor a document, then manually swap the file in `kb-pdfs`
      with different bytes → `verify-document` must return
      `storage_mismatch`, badge must show the failed state, not a stale
      green checkmark — this is the exact scenario the first draft's bug
      would have missed
- [ ] Test: re-upload an identical PDF → confirm `already_ingested: true`,
      zero new embedding calls, zero new chain writes
- [ ] Test: upload a scanned (image-only) PDF → confirm `ingest` rejects it
      with `scanned_pdf_needs_ocr` rather than creating empty `kb_chunks`
- [ ] Test: simulate a failed/rejected chain transaction in
      `anchor-document` (e.g. insufficient testnet gas) → confirm it
      returns a clear error and `kb_documents` stays correctly in the
      "not yet anchored" state rather than a partially-written one
- [ ] Test: existing text-ingestion and chat flows (pre-dating this
      feature) still work exactly as before — this is the actual
      regression check that "additive, not a rewrite" was honored
- [ ] `npm run build` passes (static export still holds)
