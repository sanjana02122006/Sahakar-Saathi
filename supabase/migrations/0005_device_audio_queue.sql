-- =====================================================================
-- Migration 0005: device_audio_queue
-- Bridges the browser's existing TTS output (speak()) to the ESP32
-- hardware terminal, which cannot receive audio over Realtime (payload
-- size) and has no Supabase session (no JWT). The browser mirrors each
-- TTS clip here via the `voice-output` function; the ESP32 polls
-- `voice-fetch` for the newest unconsumed row for its target user.
--
-- Access model: no direct browser or ESP32 access to this table at all.
-- The browser never queries it (voice-output writes on the browser's
-- behalf, service-role); the ESP32 never queries it (voice-fetch reads
-- on its behalf, service-role, gated by device_key inside the function).
-- RLS therefore denies both `authenticated` and `anon` entirely — only
-- service-role Edge Functions touch this table, which is the safest
-- default and matches how `trigger-mic` already handles the ESP32 side
-- of this project (device auth lives in function code, not RLS).
-- =====================================================================

create table if not exists public.device_audio_queue (
  id            uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references auth.users(id) on delete cascade,
  audio_path    text not null,       -- object path inside the `device-audio` Storage bucket
  mime          text not null default 'audio/mpeg',
  created_at    timestamptz not null default now(),
  consumed_at   timestamptz
);

-- ESP32 polling pattern: "give me the newest row for this user where
-- consumed_at is still null". This partial index keeps that lookup cheap
-- even as old consumed rows accumulate.
create index if not exists device_audio_queue_pending_idx
  on public.device_audio_queue (target_user_id, created_at desc)
  where consumed_at is null;

alter table public.device_audio_queue enable row level security;

-- No policies are created for `authenticated` or `anon` — RLS with zero
-- policies denies all access to those roles by default. Only
-- `service_role` (used internally by every Edge Function via
-- SUPABASE_SERVICE_ROLE_KEY) bypasses RLS entirely, which is exactly the
-- access pattern this table needs: browser and ESP32 both go through a
-- function, never straight to Postgres.

-- Housekeeping: old consumed rows and abandoned unconsumed rows (e.g. the
-- ESP32 was off and never polled) shouldn't accumulate forever. No cron
-- exists in this project yet, so this is a manual/future cleanup query,
-- not an automated job -- documented here rather than silently left out.
comment on table public.device_audio_queue is
  'TTS audio queued for ESP32 pickup. No automated cleanup yet -- rows older than a day or two are safe to delete manually: delete from device_audio_queue where created_at < now() - interval ''2 days'';';
