-- =====================================================================
-- SIH 2026 / PS 26088 — Multilingual Cooperative Governance & Legal Bot
-- Ministry of Cooperation · NCCT
-- Migration 0001: core schema
-- =====================================================================

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ---------- enums ----------
do $$ begin
  create type app_role     as enum ('member','officer','admin');
  create type msg_role     as enum ('user','assistant','system');
  create type input_mode   as enum ('text','voice');
  create type kb_category   as enum ('cooperative_law','bylaws','ministry_scheme','pacs_service','pmfby','financial_literacy','grievance');
  create type grievance_status as enum ('open','in_review','escalated','resolved','closed');
exception when duplicate_object then null; end $$;

-- ---------- profiles (1:1 with auth.users) ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text,
  phone         text,
  preferred_lang text not null default 'en',
  state         text,
  district      text,
  pacs_name     text,
  role          app_role not null default 'member',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------- conversations ----------
create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null default 'New conversation',
  lang        text not null default 'en',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists conversations_user_idx on public.conversations(user_id, updated_at desc);

-- ---------- messages ----------
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            msg_role not null,
  content         text not null,
  lang            text not null default 'en',
  mode            input_mode not null default 'text',
  citations       jsonb not null default '[]'::jsonb,
  latency_ms      integer,
  created_at      timestamptz not null default now()
);
create index if not exists messages_conv_idx on public.messages(conversation_id, created_at);

-- ---------- knowledge base (RAG) ----------
create table if not exists public.kb_documents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  category    kb_category not null,
  source_url  text,
  lang        text not null default 'en',
  created_at  timestamptz not null default now()
);

create table if not exists public.kb_chunks (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.kb_documents(id) on delete cascade,
  content      text not null,
  embedding    vector(768),
  token_count  integer,
  created_at   timestamptz not null default now()
);
create index if not exists kb_chunks_doc_idx on public.kb_chunks(document_id);
create index if not exists kb_chunks_embedding_idx
  on public.kb_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ---------- grievances ----------
create table if not exists public.grievances (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  ticket_no   text not null unique default 'GRV-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
  subject     text not null,
  description text not null,
  category    kb_category not null default 'grievance',
  status      grievance_status not null default 'open',
  lang        text not null default 'en',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists grievances_user_idx on public.grievances(user_id, created_at desc);

-- ---------- schemes (public reference data) ----------
create table if not exists public.schemes (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name         text not null,
  ministry     text not null default 'Ministry of Cooperation',
  summary      text not null,
  benefits     text,
  eligibility  text,
  apply_url    text,
  category     kb_category not null default 'ministry_scheme',
  created_at   timestamptz not null default now()
);

-- ---------- updated_at trigger ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$ begin
  create trigger t_profiles_touch      before update on public.profiles      for each row execute function public.touch_updated_at();
  create trigger t_conversations_touch before update on public.conversations for each row execute function public.touch_updated_at();
  create trigger t_grievances_touch    before update on public.grievances    for each row execute function public.touch_updated_at();
exception when duplicate_object then null; end $$;

-- ---------- auto-create profile on signup ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, preferred_lang)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), coalesce(new.raw_user_meta_data->>'preferred_lang','en'))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();
