-- Migration 0004: per-user Gemini model preference
-- Lets a user switch models from Settings if their current one hits its
-- free-tier daily quota, without needing a code change or redeploy.
alter table public.profiles
  add column if not exists preferred_model text not null default 'gemini-3.1-flash-lite';
