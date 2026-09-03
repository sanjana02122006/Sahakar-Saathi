-- =====================================================================
-- Migration 0006: device_voice_upload_sessions / device_voice_upload_chunks
-- Persists the ESP32's chunked voice-upload protocol (start/chunk/finish,
-- see supabase/functions/voice-upload/index.ts) across independent Edge
-- Function invocations. The prior implementation held session state in a
-- module-level in-memory Map, which is NOT shared across isolates/
-- instances -- a `chunk` request landing on a different instance than the
-- one that handled `start` sees no session at all, which is exactly the
-- real-hardware failure this migration fixes ("Unknown or expired
-- session_id" on the very first chunk).
--
-- Design: chunk bytes are stored as individual small rows (~4KB each,
-- matching the firmware's UPLOAD_CHUNK_BYTES), NOT as one growing blob
-- and NOT in Supabase Storage. A full ~150KB recording is ~40 rows --
-- trivial for Postgres, keeps FINISH's reassembly a single ordered
-- SELECT, and cleanup is a plain cascading DELETE with no orphaned
-- Storage objects to separately sweep. This mirrors the same
-- service-role-only access model already used by device_audio_queue
-- (migration 0005): no direct browser/ESP32 access to either table --
-- only voice-upload's own service-role client touches them, with
-- device_key authentication enforced in function code exactly like
-- every other device-facing function in this project.
-- =====================================================================

create table if not exists public.device_voice_upload_sessions (
  session_id      uuid primary key default gen_random_uuid(),
  device_key_hash text not null,       -- sha-256 of the validated device_key, never the raw key -- ties chunk/finish to the same device that started the session without persisting the secret itself
  lang            text,
  expected_size   bigint,              -- reserved for a future Content-Length-style pre-declaration; the current firmware doesn't send one, so this stays null and finish() falls back to summing received chunk bytes
  received_bytes  bigint not null default 0,
  status          text not null default 'open' check (status in ('open', 'finished', 'expired')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '2 minutes')  -- matches the previous in-memory SESSION_TTL_MS; a single recording is a few seconds of audio, 2 minutes is generous
);

create index if not exists device_voice_upload_sessions_expiry_idx
  on public.device_voice_upload_sessions (expires_at)
  where status = 'open';

create table if not exists public.device_voice_upload_chunks (
  session_id  uuid not null references public.device_voice_upload_sessions(session_id) on delete cascade,
  seq         integer not null,        -- assigned server-side as "next chunk index for this session", not client-supplied -- the ESP32 sends chunks strictly sequentially over independent awaited requests, so a simple counter is sufficient and can't be reordered by the client
  bytes       bytea not null,
  created_at  timestamptz not null default now(),
  primary key (session_id, seq)
);

alter table public.device_voice_upload_sessions enable row level security;
alter table public.device_voice_upload_chunks enable row level security;

-- No policies for `authenticated` or `anon` on either table -- RLS with
-- zero policies denies all access by default. Only `service_role` (used
-- internally by voice-upload via SUPABASE_SERVICE_ROLE_KEY) bypasses RLS,
-- which is the correct access pattern here: the ESP32 never talks to
-- Postgres directly, only through the function, which itself re-checks
-- device_key on every single start/chunk/finish call.

comment on table public.device_voice_upload_sessions is
  'In-progress ESP32 chunked voice uploads. A session normally lives only a few seconds (start -> ~40 chunks -> finish) and is deleted by finish() on completion. Sessions abandoned mid-upload (e.g. device lost WiFi) are left for a manual/future cleanup sweep: delete from device_voice_upload_sessions where status = ''open'' and expires_at < now();';
comment on table public.device_voice_upload_chunks is
  'Chunk bytes for an in-progress device_voice_upload_sessions row. Deleted automatically via ON DELETE CASCADE when the parent session row is deleted.';
