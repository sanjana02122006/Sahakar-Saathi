-- =====================================================================
-- Migration 0002: Row Level Security
-- Every user-owned table is owner-scoped. Reference data is read-only
-- to authenticated users. Writes to reference data are service_role only.
-- =====================================================================

alter table public.profiles      enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
alter table public.grievances    enable row level security;
alter table public.kb_documents  enable row level security;
alter table public.kb_chunks     enable row level security;
alter table public.schemes       enable row level security;

-- ---------- profiles ----------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (auth.uid() = id);

-- ---------- conversations ----------
drop policy if exists conversations_all_own on public.conversations;
create policy conversations_all_own on public.conversations
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- messages ----------
drop policy if exists messages_all_own on public.messages;
create policy messages_all_own on public.messages
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- grievances ----------
drop policy if exists grievances_all_own on public.grievances;
create policy grievances_all_own on public.grievances
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- reference data: read-only to signed-in users ----------
drop policy if exists kb_documents_read on public.kb_documents;
create policy kb_documents_read on public.kb_documents
  for select to authenticated using (true);

drop policy if exists kb_chunks_read on public.kb_chunks;
create policy kb_chunks_read on public.kb_chunks
  for select to authenticated using (true);

drop policy if exists schemes_read on public.schemes;
create policy schemes_read on public.schemes
  for select to authenticated using (true);

-- ---------- RAG match function (runs as definer, still read-only) ----------
create or replace function public.match_kb_chunks(
  query_embedding vector(768),
  match_count int default 5,
  filter_category kb_category default null
)
returns table (id uuid, content text, title text, category kb_category, source_url text, similarity float)
language sql stable security definer set search_path = public as $$
  select c.id, c.content, d.title, d.category, d.source_url,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.kb_chunks c
  join public.kb_documents d on d.id = c.document_id
  where c.embedding is not null
    and (filter_category is null or d.category = filter_category)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

revoke all on function public.match_kb_chunks(vector, int, kb_category) from public, anon;
grant execute on function public.match_kb_chunks(vector, int, kb_category) to authenticated, service_role;
