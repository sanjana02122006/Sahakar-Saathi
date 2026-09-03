-- =====================================================================
-- Migration 0007: extend device_voice_upload_sessions TTL
-- Real hardware testing (see esp32-firmware/voice_terminal.ino,
-- UPLOAD_CHUNK_BYTES comment) required shrinking the chunk size from
-- 4096 to 1024 raw bytes to stay clear of a confirmed dose-dependent TLS
-- write defect in this device's arduino-esp32 core. Smaller chunks mean
-- more of them (~128 for a ~130KB recording), each opening its own TLS
-- connection -- the previous 2-minute session TTL (migration 0006,
-- matching the old in-memory SESSION_TTL_MS) leaves little margin if
-- per-chunk round trips run slower than expected on real WiFi. This
-- extends the default to 5 minutes, comfortably covering a slow upload
-- without meaningfully weakening the abandoned-session cleanup story --
-- a single push-to-talk recording is still only a few seconds of audio.
-- =====================================================================

alter table public.device_voice_upload_sessions
  alter column expires_at set default (now() + interval '5 minutes');
