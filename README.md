# Sahakar Sathi

Multilingual cooperative governance & legal assistance chatbot.
SIH 2026 · PS 26088 · Ministry of Cooperation / NCCT.

Next.js 14 static export + Supabase Edge Functions (Deno) + Postgres/pgvector.

See **[PLAN.md](PLAN.md)** for architecture, build order, and open work.

## Quick start

```bash
npm install

# Pull Supabase keys into .env.local
SB_TOKEN=<supabase_access_token> npm run env:pull

# Add your Gemini key to .env.local
# GEMINI_API_KEY=...   (https://aistudio.google.com/apikey)

npm run dev
```

## Deploy the backend

```bash
supabase login
supabase link --project-ref njpxixfcctodjejtgmwj
supabase secrets set GEMINI_API_KEY=...
supabase functions deploy chat
supabase functions deploy ingest

# optional — voice input
supabase secrets set SARVAM_API_KEY=...
supabase functions deploy transcribe
```

**The chat will not work until `chat` is deployed with a Gemini key.**
Until then the UI shows a fallback error message on send. Everything else (auth, settings,
grievances, voice fallback to Web Speech) already works without any key.

## Load the knowledge base

Once `ingest` is deployed and your user has `role = 'admin'` in `profiles`:

```bash
ADMIN_JWT=<your access_token> node scripts/ingest-corpus.mjs
```

Ingests the 5 starter documents in `supabase/kb-corpus/` (cooperative law, PACS by-laws, PMFBY,
KCC/financial literacy, grievance redressal). Add more `.json` files to that folder to grow it.

## Build & deploy (Netlify)

```bash
npm run build   # -> ./out (static)
npm start       # serve ./out locally
```

`netlify.toml` is preconfigured (build command, publish dir, SPA fallback). Connect the repo in
Netlify and set `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` as site env vars —
see [PLAN.md §6](PLAN.md#6-deployment) for the full walkthrough. Add the deployed URL to Supabase
Auth → URL Configuration once you have it.

## Layout

```
app/            login, dashboard (chat), settings, grievances, root redirect
components/ui/  shadcn primitives (button, input, textarea, card, label, badge)
lib/            supabase client, shared types, cn()
supabase/
  migrations/   0001 schema · 0002 RLS · 0003 seed   (already applied)
  functions/    chat (RAG + Gemini) · ingest (KB loader) · transcribe (Sarvam AI STT)
  kb-corpus/    starter knowledge-base documents (JSON, ready to ingest)
scripts/        fetch-env.mjs · ingest-corpus.mjs
netlify.toml    Netlify build/publish/redirect config
```
