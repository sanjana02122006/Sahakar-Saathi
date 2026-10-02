-- =====================================================================
-- Migration 0008: blockchain_verification
-- Adds document-integrity-anchoring: official PDFs get SHA-256 hashed,
-- the hash is written to Polygon Amoy (testnet), and kb_documents gains
-- the fields needed to track that. See BLOCKCHAIN-PLAN.md for the full
-- feature spec this migration implements.
--
-- "anchored_at" (not "verified_at") is deliberate: this timestamp only
-- records when the hash was WRITTEN to chain. It says nothing about
-- whether the stored file still matches it right now -- that's a
-- separate, repeatable check performed by the verify-document Edge
-- Function, not a one-time fact stored here.
--
-- No `verified` boolean is added anywhere (not here, not on kb_chunks).
-- "Anchored" (a tx hash exists) and "Verified" (a fresh re-hash just
-- matched, done NOW) are different states by design -- collapsing them
-- into one stored boolean was the exact bug caught in this feature's
-- first draft review. Verification status is always computed live by
-- verify-document, joined through document_id -- never denormalized.
-- =====================================================================

alter table public.kb_documents
  add column if not exists source_type   text not null default 'text'
              check (source_type in ('text', 'pdf')),
  add column if not exists sha256_hash   text,          -- hex digest of the ORIGINAL file bytes
  add column if not exists chain_tx_hash text,          -- Polygon Amoy transaction hash, null until anchored
  add column if not exists chain_network text,          -- e.g. 'polygon-amoy' -- future-proofs a network change
  add column if not exists anchored_at   timestamptz,   -- when the chain WRITE succeeded (not a verification result)
  add column if not exists storage_path  text;          -- object path in kb-pdfs, e.g. '<doc_id>.pdf' -- needed so
                                                         -- verify-document can re-fetch and re-hash the stored file

-- One hash maps to exactly one document -- this IS the "don't re-embed
-- unchanged documents" check: look this up before doing any embedding work.
create unique index if not exists kb_documents_sha256_idx
  on public.kb_documents(sha256_hash) where sha256_hash is not null;

-- RLS: unchanged. kb_documents is already admin-write, public-read via
-- existing policy from 0002_rls.sql -- these new columns inherit that.

-- ---------------------------------------------------------------------
-- match_kb_chunks RPC -- extend, don't replace.
--
-- Postgres rejects `CREATE OR REPLACE FUNCTION` when the return type /
-- column set changes -- it errors with "cannot change return type of
-- existing function." The correct sequence is DROP then CREATE, with
-- the revoke/grant from 0002_rls.sql reapplied explicitly (a DROP does
-- not preserve grants on the old function).
-- ---------------------------------------------------------------------

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

-- MUST re-apply -- DROP does not carry grants forward from the old function.
revoke all on function public.match_kb_chunks(vector, int, kb_category) from public, anon;
grant execute on function public.match_kb_chunks(vector, int, kb_category) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Storage: new bucket `kb-pdfs`, following the exact pattern already
-- established by `device-audio` (migration 0005's comment references
-- it; the bucket+policies live here since this is the first migration
-- in this project to actually create one via SQL).
-- Admin-write (insert/update/delete restricted to profiles.role =
-- 'admin'), authenticated-read (so `ingest` and verify-document can
-- fetch the stored original for hash comparison).
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('kb-pdfs', 'kb-pdfs', false)
on conflict (id) do nothing;

drop policy if exists "kb-pdfs admin write" on storage.objects;
create policy "kb-pdfs admin write" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'kb-pdfs'
    and (select role from public.profiles where id = auth.uid()) = 'admin'
  );

drop policy if exists "kb-pdfs admin update" on storage.objects;
create policy "kb-pdfs admin update" on storage.objects
  for update to authenticated using (
    bucket_id = 'kb-pdfs'
    and (select role from public.profiles where id = auth.uid()) = 'admin'
  ) with check (
    bucket_id = 'kb-pdfs'
    and (select role from public.profiles where id = auth.uid()) = 'admin'
  );

drop policy if exists "kb-pdfs admin delete" on storage.objects;
create policy "kb-pdfs admin delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'kb-pdfs'
    and (select role from public.profiles where id = auth.uid()) = 'admin'
  );

drop policy if exists "kb-pdfs authenticated read" on storage.objects;
create policy "kb-pdfs authenticated read" on storage.objects
  for select to authenticated using (bucket_id = 'kb-pdfs');
