# Sahakar Saathi — Implementation Plan

**SIH 2026 · PS 26088** — Multilingual Cooperative Governance & Legal Assistance Chatbot
**Org:** Ministry of Cooperation · **Dept:** NCCT · **Theme:** Agriculture, FoodTech & Rural Development

---

## 1. Architecture

Frontend is a **Next.js 14 static export** (`output: "export"`) — no Node server, deployable to any CDN,
Netlify, GitHub Pages or an offline kiosk. Backend is **Supabase Edge Functions** (Deno) plus Postgres
with pgvector. Auth is browser-side; every table is protected by RLS, so a stolen anon key exposes nothing.

```
Browser (static Next.js)
  |
  |-- supabase-js  ------> Supabase Auth  (JWT, persisted in browser)
  |-- supabase-js  ------> Postgres REST  (RLS-scoped reads: profiles, schemes)
  |-- fetch()      ------> Edge Function /chat
                              |-- verify JWT (service role)
                              |-- embed question    -> Gemini text-embedding-004
                              |-- retrieve top-5    -> match_kb_chunks() / pgvector
                              |-- generate answer   -> gemini-2.0-flash
                              |-- persist both turns -> messages
                              '-- return { reply, citations, conversation_id }
```

**Why this split:** static export means zero server cost and trivial hosting; the Edge Function exists
because the Gemini key must never reach the browser, and because RAG retrieval needs `service_role`
to call the security-definer match function.

---

## 2. Current status

### Done and verified
- Supabase project `chatbot` (`njpxixfcctodjejtgmwj`, ap-south-1) — migrations applied against the live DB.
- 7 tables, **RLS enabled on all**, 9 policies. Verified: a signed-out anon request to
  `conversations` and `schemes` returns `[]`, not data.
- `pgvector` + `pgcrypto` installed. `match_kb_chunks()` created, `execute` revoked from `anon`.
- 5 schemes seeded (PMFBY, KCC, PACS-CSC, SAHAKAR-M, NCDC-YUVA).
- Frontend: **typecheck clean, `npm run build` produces a static export** — 6 routes prerendered
  (`/`, `/login`, `/dashboard`, `/settings`, `/grievances`, `/_not-found`).
- `.env.local` populated with real anon + service-role keys via `npm run env:pull`.
- **Full auth + data flow tested end-to-end against the live DB** (scripted, not just typechecked):
  signup → auto-created profile (trigger fires, seeds `preferred_lang` from signup metadata) →
  settings PATCH persists → grievance insert returns an auto-generated `GRV-XXXXXXXX` ticket →
  grievance list reads back → schemes readable when authenticated. All via REST, RLS enforced
  throughout. Test user was created and deleted; no residue in the DB.
- Settings page (`/settings`) built: English-default / Multilingual toggle, per-language default,
  profile fields (name, phone, state, district, PACS). Writes to the existing `profiles` columns —
  no new migration needed.
- Grievances page (`/grievances`) built: submission form (category, subject, description) and a
  status-badged list. Dashboard's "File a grievance" now links here instead of only being reachable
  via a chat prompt.
- `transcribe` Edge Function written (**Sarvam AI** `saaras:v3` via `POST /speech-to-text`) and the
  dashboard's mic button wired to call it first, falling back to the browser's Web Speech API
  automatically on any failure — missing key, a failed request, no `MediaRecorder` support, or mic
  permission denied. **Not deployed** — see below.
- `supabase/kb-corpus/` — 5 ready-to-ingest documents (Multi-State Cooperative Societies Act member
  rights, model PACS by-laws, PMFBY claims/timelines, KCC/financial literacy, grievance escalation
  path), plus `scripts/ingest-corpus.mjs` to push them through `ingest` in one run.
- `netlify.toml` added (`publish = "out"`, SPA fallback, basic security headers) — ready to connect
  a Netlify site to this repo with zero extra config.
- Staging auth setting changed: **email auto-confirm enabled** on the Supabase project so demo
  signups don't stall waiting on a confirmation email (this was flagged as a risk in §7; now closed).

### Written but NOT yet deployed or runtime-tested (blocked on keys you're providing)
- `supabase/functions/chat/index.ts` — needs `GEMINI_API_KEY` + `supabase functions deploy chat`.
  **The dashboard's send path has never received a real reply and will show the fallback error
  message until this is deployed. This is still the single biggest open item.**
- `supabase/functions/ingest/index.ts` — same; also needs an admin-role user (see Phase 2).
- `supabase/functions/transcribe/index.ts` — needs `SARVAM_API_KEY` + `supabase functions deploy transcribe`.
  Until deployed, every mic tap silently falls through to Web Speech, which already works today —
  voice input is not blocked, just not yet on Sarvam.

None of this required real accounts or payment info, which is why it could proceed without the
keys. Deploying the three functions is the only remaining step gated on you.

---

## 3. Data model

| Table | Purpose | RLS |
|---|---|---|
| `profiles` | 1:1 with `auth.users`; name, phone, preferred_lang, state/district, PACS, role | owner-scoped |
| `conversations` | chat sessions, per user | owner-scoped |
| `messages` | turns; role, content, lang, mode (text/voice), citations jsonb, latency_ms | owner-scoped |
| `kb_documents` | source docs: acts, by-laws, scheme circulars | authenticated read |
| `kb_chunks` | chunked text + `vector(768)` embedding, ivfflat index | authenticated read |
| `grievances` | auto ticket `GRV-XXXXXXXX`, status workflow | owner-scoped |
| `schemes` | reference data for the sidebar | authenticated read |

A trigger on `auth.users` auto-creates a `profiles` row on signup, carrying `full_name` and
`preferred_lang` from signup metadata.

**Embedding dimension is 768** (`text-embedding-004`). Changing the embedding model means changing
the column type and reindexing — decide before ingesting the corpus.

---

## 4. Build order

### Phase 1 — Make the chat actually work (blocking; nothing else matters until this is green)
1. Get a Gemini key from https://aistudio.google.com/apikey, put it in `.env.local`.
2. `supabase login && supabase link --project-ref njpxixfcctodjejtgmwj`
3. `supabase secrets set GEMINI_API_KEY=...`
4. `supabase functions deploy chat --project-ref njpxixfcctodjejtgmwj`
5. `npm run dev`, sign up, send a message. **Confirm a real reply renders and a `messages` row is written.**
   Until this passes, treat every later phase's runtime behavior as unverified.

*Status: code complete, blocked on `GEMINI_API_KEY`. Everything downstream in this file was built
against that assumption and is ready to go the moment the key lands.*

### Phase 2 — Knowledge base ✅ content ready, ⏳ blocked on deploy
This is what makes it a *legal* assistant, not a generic chatbot.

6. Deploy `ingest` (same key/deploy pattern as Phase 1, function `ingest` instead of `chat`).
7. Promote your own user to admin (`ingest` checks `profiles.role = 'admin'`):
   ```sql
   update public.profiles set role = 'admin' where id = '<your-user-uuid>';
   ```
8. Run the starter corpus — already written in `supabase/kb-corpus/` (5 docs: Multi-State Cooperative
   Societies Act member rights, model PACS by-laws, PMFBY claims/timelines, KCC/financial literacy,
   grievance escalation path):
   ```bash
   ADMIN_JWT=<your access_token> node scripts/ingest-corpus.mjs
   ```
9. Verify retrieval: ask a question whose answer only exists in an ingested doc (e.g. "What is the
   maximum number of directors on a multi-state cooperative board?" → 21), confirm the citation
   chip appears. **Ungrounded answers are the main credibility risk with a legal-advice product —
   a judge will probe exactly this.** Add more documents over time the same way.

### Phase 3 — Grievances ✅ built and tested
10. Grievance form + status-badged list at `/grievances`, linked from the dashboard sidebar.
    Verified end-to-end against the live DB: insert, auto-ticket-number, list-back, all RLS-scoped
    to the owner. No further work required for MVP.
11. *(Stretch, not required for MVP)* Let the assistant file one conversationally via a Gemini
    function-call/tool definition, instead of only through the form.

### Phase 4 — Voice (Sarvam AI STT) ✅ built, ⏳ blocked on deploy
12. `transcribe` Edge Function written: `POST https://api.sarvam.ai/speech-to-text`, multipart
    upload, model `saaras:v3`. Deploy the same way as Phase 1/2:
    ```bash
    supabase secrets set SARVAM_API_KEY=...
    supabase functions deploy transcribe --project-ref njpxixfcctodjejtgmwj
    ```
    Dashboard mic button already calls it first and falls back to the browser's Web Speech API
    automatically on a missing key (503), a failed request, no `MediaRecorder` support, or denied
    mic permission. **No frontend work remains here**; deploying the function is the only step.

    **The language-coverage risk flagged for xAI is resolved by this switch.** Sarvam explicitly
    documents all nine of our languages with exact codes (`hi-IN`, `mr-IN`, `ta-IN`, `te-IN`,
    `bn-IN`, `gu-IN`, `kn-IN`, `pa-IN`) plus `en-IN`, and its models are trained specifically for
    Indian languages rather than being a general multilingual model — the better fit for this
    problem statement's rural/Indic user base. The `BCP47` map already in `dashboard/page.tsx`
    uses exactly these codes, so no frontend change was needed for the switch.

13. **Settings page** ✅ built and tested — `/settings`: English-default / Multilingual toggle, a
    default-language picker, and profile fields (name, phone, state, district, PACS name), all
    persisting to the existing `profiles` row. Reachable from the dashboard header's gear icon.
    TTS: Sarvam also offers text-to-speech (`Bulbul`); not wired up yet — output still uses the
    browser's `speechSynthesis`. Swapping it in later is a same-shaped addition to Phase 5, not
    required for MVP.

### Phase 5 — Polish (not started; optional beyond MVP)
14. Conversation history sidebar (load past `conversations`, resume one).
15. Dark-mode toggle (tokens already defined in `globals.css`).
16. Streaming replies so long answers feel fast.
17. PWA manifest + offline shell — genuinely useful for rural low-connectivity, and a strong demo beat.

---

## 5. Secrets and env values

`.env.local` is already populated with the two Supabase keys. **You must supply:**

| Variable | Required? | Where | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | **Yes — blocking** | https://aistudio.google.com/apikey | Free tier is enough for the demo. Powers embeddings *and* chat. |
| `SARVAM_API_KEY` | Phase 4 | https://dashboard.sarvam.ai | Speech-to-text (`saaras:v3`), Indic-first. Chosen over xAI/Whisper — see §5.1. |
| `NEXT_PUBLIC_SUPABASE_URL` | Set ✅ | — | Public by design. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Set ✅ | — | Public by design; safe *only* because RLS is on. |
| `SUPABASE_SERVICE_ROLE_KEY` | Set ✅ | — | Server-side only. Supabase injects it into Edge Functions automatically — you do **not** need to `secrets set` it. |

Set Edge Function secrets with `supabase secrets set KEY=value` — Edge Functions cannot read `.env.local`.

### 5.1 Why Sarvam AI for voice (decision record)

xAI's speech-to-text (`grok-transcribe`) was evaluated and had working code in this repo at one
point, but the team decided to go with **Sarvam AI** instead, and the `transcribe` function was
rewritten accordingly. Sarvam is trained specifically for Indian languages rather than being a
general multilingual model bolted on, and it explicitly documents support for all nine languages
this app uses (`hi-IN`, `mr-IN`, `ta-IN`, `te-IN`, `bn-IN`, `gu-IN`, `kn-IN`, `pa-IN`, `en-IN`) —
closing the "does it actually cover our languages" risk that xAI's undocumented "25 languages"
claim left open. Whisper was ruled out earlier in the process on the same grounds: benchmarks show
global ASR models sitting at 20–30% WER on Indian languages versus 7–12% for India-trained models.

If chat generation is ever swapped off Gemini (e.g. to Grok or another provider), note that
**embeddings still require Gemini regardless** — `GEMINI_API_KEY` stays required for RAG retrieval
no matter what generates the final answer, since embeddings are a separate call
(`text-embedding-004`) used at both ingest and query time.

---

## 6. Deployment

### Netlify (chosen target)
`netlify.toml` is already in the repo root: build command `npm run build`, publish directory `out`,
an SPA-style 404 fallback (needed because this is a static export with client-side routing), and
baseline security headers.

To connect:
1. Push this repo to GitHub (or connect Netlify directly to a local folder via the CLI/drag-and-drop).
2. In Netlify: **Add new site → Import from Git**, select the repo. Build settings are auto-read
   from `netlify.toml` — no manual config needed.
3. Add environment variables in Netlify's dashboard (Site settings → Environment variables):
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (values are in `.env.local`).
   Do **not** add `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, or `SARVAM_API_KEY` here — those
   belong only in Supabase Edge Function secrets, never in a static frontend's env.
4. Deploy. Once you have the `*.netlify.app` URL, add it to Supabase → Authentication → URL
   Configuration → Redirect URLs, or auth redirects (password reset, magic links) will fail.
5. Share the Netlify URL back — next step is smoke-testing signup/login/settings/grievances on the
   real deployed domain, not just `localhost`.

### Generic static host
```bash
npm run build          # -> ./out, fully static
```
`out/` can also be served from Vercel, GitHub Pages, or any static host — same redirect-URL caveat
applies.

Edge Functions deploy independently via the Supabase CLI and are not part of the static bundle.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| **Hallucinated legal advice** | System prompt forbids inventing sections/amounts and mandates "I'm unsure → contact PACS/DCO". Citations shown. Disclaimer in the composer. Strengthen with a real corpus (Phase 2). |
| Chat untested end-to-end | Phase 1 is explicitly blocking. |
| Web Speech is Chrome-only, weak on Indic | Phase 4 (Sarvam STT). Text input always works. |
| Empty KB → generic answers | Function degrades gracefully (retrieval failure is non-fatal), but demo quality depends on Phase 2. |
| ivfflat `lists=100` tuned for a large corpus | Fine for the demo; revisit if the KB stays small. |
| ~~Email confirmation blocks demo signups~~ | **Closed.** `mailer_autoconfirm` enabled on the staging project — signups get a session immediately, no email round-trip. |

---

## 8. Note on the access token

The `sbp_…` management token was used to apply migrations and pull keys, per your instruction that
this is approved staging. Flagging once, not to re-litigate: it is now in this session's history and
in your shell history. Since it grants full management access to the org, it is worth rotating before
anything from this repo becomes public or is submitted — your call, and nothing here depends on it
(the app runs on the anon + service-role keys, not the management token).

`.env.local` is gitignored. Keep it that way.
