# EXISTING VOICE PIPELINE

Two independent, already-working voice paths exist today, both living entirely
inside `app/dashboard/page.tsx` (a single client component — no separate hooks
file, no separate mic component). Neither path is a hook or a reusable
component; both are closures defined inline in `DashboardPage`.

**Input (speech → text):**
```
user gesture (click, or hardware "start" broadcast)
  → startSarvamRecording(autoSend: boolean)
  → getUserMedia({ audio: true })
  → MediaRecorder (audio/webm, browser default codec/sample rate)
  → user speaks
  → stop() called (click, or hardware "stop" broadcast)
  → rec.onstop fires
  → Blob assembled from collected chunks
  → POST multipart/form-data → Edge Function `transcribe`
  → transcribe forwards to Sarvam AI (api.sarvam.ai/speech-to-text)
  → { text } returned
  → either setInput(text) [manual] or send(text) [hardware, autoSend=true]
```

**Output (text → speech):**
```
chat reply received in send()
  → speak(text) called automatically after every assistant reply
  → POST JSON → Edge Function `speak`
  → speak forwards to Sarvam AI (api.sarvam.ai/text-to-speech)
  → { audio: base64, mime: "audio/mpeg" } returned
  → new Audio(`data:${mime};base64,${audio}`) → .play()
```

Both paths have a same-origin, same-tab, browser-native fallback
(`webSpeechFallback` for input, `speechSynthesis` for output) that activates
automatically if Sarvam is unreachable/unconfigured — this fallback is
irrelevant to hardware integration (the ESP32 has no browser) but is
mentioned because it shares code paths with the primary flow and must not be
broken by any change.

A third, separate mechanism already exists and is live: a Supabase Realtime
**control-only** channel that lets a physical button remotely start/stop the
*existing* browser-side recording described above. It does not transport
audio — see § SUPABASE FLOW and § ESP32 INTEGRATION OPTIONS.

---

# FILES AND FUNCTIONS

## Frontend

| File | Relevant exports/functions | Role |
|---|---|---|
| `app/dashboard/page.tsx` | `startSarvamRecording(autoSend)` (line 116) | Starts `getUserMedia` + `MediaRecorder`; on stop, POSTs to `transcribe`; calls `send()` or `setInput()` depending on `autoSend` |
| | `stopSarvamRecording()` (line 111) | `mediaRecorderRef.current?.stop()` — this is the **entire** stop implementation; everything else (blob build, upload, transcript) happens inside `rec.onstop`, an event handler attached once in `startSarvamRecording` |
| | `webSpeechFallback(autoSend)` (line 92) | Browser `SpeechRecognition` fallback, mirrors the same autoSend behavior |
| | `toggleMic()` (line 174) | Manual mic-button click handler; calls `startSarvamRecording(false)` / `stopSarvamRecording()` |
| | hardware-trigger `useEffect` (line 200) | Subscribes to `mic-trigger-${profile.id}` Realtime channel, routes `mic_control` broadcasts to `startSarvamRecording(true)` / `stopSarvamRecording()` |
| | `speak(text)` (line 247) | POSTs to `speak`, plays returned base64 audio via `new Audio(...)` |
| | `speakWithBrowser(text)` (line 235) | `speechSynthesis` fallback for `speak()` |
| | `send(text)` (line 276) | POSTs to `chat`, persists reply, calls `speak(data.reply)` |
| | State: `listening`, `transcribing`, `sending`, `muted` (lines 36-46) | Recording-active / STT-in-flight / chat-in-flight / TTS-muted flags |
| | Refs: `mediaRecorderRef`, `audioChunksRef`, `recognitionRef`, `audioRef`, `seenNoncesRef`, `listeningRef` | MediaRecorder instance, accumulated audio chunks, Web Speech instance, currently-playing `<audio>`, dedup set for hardware broadcast nonces, live-read mirror of `listening` for the broadcast handler's closure |
| `lib/supabase.ts` | `supabase` (browser client) | `createClient` with `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `persistSession: true` |
| `lib/types.ts` | `Profile`, `Message`, `GEMINI_MODELS`, `LANGUAGES` | Shared types; `Profile.id` is the value used to scope the Realtime channel name |

**No separate microphone component exists.** There is no `<Mic />` component,
no `useMicrophone` hook, no `useVoiceInput` hook. All logic is inline
closures inside the page component, all writing to that page's local state.

## Backend (Supabase Edge Functions, Deno)

| File | Role |
|---|---|
| `supabase/functions/transcribe/index.ts` | Sarvam STT proxy. Accepts `multipart/form-data`, forwards to `api.sarvam.ai/speech-to-text` |
| `supabase/functions/speak/index.ts` | Sarvam TTS proxy. Accepts JSON `{text, lang}`, forwards to `api.sarvam.ai/text-to-speech`, returns base64 audio |
| `supabase/functions/chat/index.ts` | RAG + Gemini chat. Verifies Supabase JWT, embeds question, retrieves KB chunks, generates reply with model fallback chain, persists to `messages`/`conversations` |
| `supabase/functions/trigger-mic/index.ts` | Device-key-authenticated control signal. Broadcasts `mic_control {action, nonce, ts}` on Realtime — **no audio involved** |
| `supabase/functions/ingest/index.ts` | Admin-only KB document loader (unrelated to voice; found during audit, not modified) |
| `supabase/config.toml` | Per-function `verify_jwt` flags — see § SUPABASE FLOW |

## Database

| File | Role |
|---|---|
| `supabase/migrations/0001_init.sql` | `profiles`, `conversations`, `messages`, `kb_documents`, `kb_chunks`, `grievances`, `schemes`. **No audio/blob table. No Storage bucket declared anywhere in the migrations.** |
| `supabase/migrations/0002_rls.sql` | RLS policies, `match_kb_chunks` RPC |
| `supabase/migrations/0004_model_pref.sql` | Adds `profiles.preferred_model` |

---

# CURRENT AUDIO FORMAT

**Recording (browser → transcribe):**
- API: `navigator.mediaDevices.getUserMedia({ audio: true })` + `MediaRecorder` — confirmed at `app/dashboard/page.tsx:123-124`. Not Web Audio API, not AudioWorklet, not a raw WebSocket stream.
- Representation: `Blob`, explicitly typed `audio/webm` at construction (`app/dashboard/page.tsx:131`) — but note this is the Blob's declared MIME type, not necessarily a re-encode; the actual codec inside is whatever `MediaRecorder`'s default is for that browser (Chrome: Opus in a WebM container).
- Sample rate: **not explicitly configured anywhere in this code.** No `sampleRate` constraint is passed to `getUserMedia`, no `audioBitsPerSecond` is passed to `MediaRecorder`. Whatever the browser/OS default input device sample rate is (commonly 48kHz) is what's captured. **REQUIRES VERIFICATION** if a target rate matters for a downstream step — it currently doesn't, because Sarvam receives the whole file and handles it internally.
- MIME type sent to `transcribe`: `audio/webm` (Blob type) inside a `multipart/form-data` field named `file`, filename `recording.webm` (`app/dashboard/page.tsx:139`).
- Streaming vs. batch: **batch, not streamed.** Recording happens entirely in-browser; nothing is sent anywhere until `rec.onstop` fires (i.e., until the user/hardware signals stop) and the full Blob exists.
- User gesture dependency: `getUserMedia` itself requires a prior user gesture only for the **first ever grant** of the mic permission for this origin in this browser profile (browser policy, not app code) — confirmed against Chrome/W3C's own gesture-requirement discussion during a previous architecture pass in this project. After that one-time grant, `startSarvamRecording()` can be, and already is, called with **no click at all** — it's invoked directly from the Realtime broadcast handler (`app/dashboard/page.tsx:217`) today. This is proof, not a inference: the hardware start/stop flow already works today calling this exact code path with zero user gesture per-call.

**transcribe → Sarvam (server-side, `supabase/functions/transcribe/index.ts:46-49`):**
- Forwards the received `file` field as-is inside a new `multipart/form-data` request, field name `file`, filename preserved (or defaulted to `audio.webm`).
- Adds `model: "saaras:v3"` and, if provided, `language_code`.
- Documented-accepted formats per this file's own header comment (line 11): `wav/mp3/aac/aiff/ogg/opus/flac/m4a/amr/wma/webm/pcm`. **`webm` is explicitly in this list — the current browser output format is already accepted without conversion.**

**Output (speak → browser):**
- `speak` requests `output_audio_codec: "mp3"` from Sarvam (`supabase/functions/speak/index.ts:61`) and returns `{ audio: <base64>, mime: "audio/mpeg" }`.
- Browser plays via `new Audio("data:audio/mpeg;base64,...")` (`app/dashboard/page.tsx:267`) — a data URI, not a Blob URL, not a MediaSource stream.
- **The raw bytes ARE accessible before playback** — `data.audio` is a plain base64 string sitting in a JS variable the instant the `speak` fetch resolves, before `new Audio(...)` is ever constructed. Nothing about the current implementation requires playing it in the browser first; it could be forwarded elsewhere (e.g., to an ESP32) using the exact same fetched value, unmodified.

---

# SARVAM STT FLOW

| Item | Value | Source |
|---|---|---|
| Frontend entry point | `startSarvamRecording` → `rec.onstop` (async IIFE) | `app/dashboard/page.tsx:129-163` |
| Edge Function called | `transcribe` | `supabase/functions/transcribe/index.ts` |
| Frontend → Function request | `POST {SUPABASE_URL}/functions/v1/transcribe`, `Authorization: Bearer <session.access_token>`, body `multipart/form-data` with fields `file` (Blob) and `lang` (BCP-47 string) | `app/dashboard/page.tsx:138-146` |
| Function → Sarvam request | `POST https://api.sarvam.ai/speech-to-text`, header `api-subscription-key: SARVAM_API_KEY`, body `multipart/form-data` with `file`, `model: "saaras:v3"`, optional `language_code` | `supabase/functions/transcribe/index.ts:46-55` |
| Audio format Sarvam expects | wav/mp3/aac/aiff/ogg/opus/flac/m4a/amr/wma/webm/pcm (per this function's own comment, not independently re-verified against Sarvam's live docs in this pass — was verified against Sarvam's docs when this function was originally built) | `supabase/functions/transcribe/index.ts:11` |
| Authentication (browser→function) | **Platform-level Supabase JWT required** — `verify_jwt = true` in `config.toml` for `transcribe`. The function code itself does NOT re-check the JWT or extract a user id from it — auth is enforced entirely by the Supabase gateway before the request body ever reaches this function's code. | `supabase/config.toml:9-10`, `supabase/functions/transcribe/index.ts` (no `auth.getUser` call present) |
| Authentication (function→Sarvam) | `SARVAM_API_KEY` secret, server-side only | `supabase/functions/transcribe/index.ts:16` |
| Response format | `{ text: string, detected_lang?: string }` on success; `{ error, unsupported?: boolean }` on failure | `supabase/functions/transcribe/index.ts:64, 34, 43, 60, 67` |
| Transcript extraction | `data.text` read directly, no parsing/cleanup | `app/dashboard/page.tsx:148, 154` |
| Error handling | `res.ok === false` or `data.unsupported === true` → falls back to `webSpeechFallback(autoSend)`, preserving the autoSend flag | `app/dashboard/page.tsx:149-152` |
| Loading state | `setTranscribing(true/false)` wraps the whole fetch; surfaced in UI as a spinner + disabled input | `app/dashboard/page.tsx:136, 161`, `app/dashboard/page.tsx:499, 509` |

**Can the existing endpoint directly accept ESP32-generated WAV/PCM?**
Yes, structurally — `wav` and `pcm` are both in the function's documented
accepted-format list (line 11), and the function does zero format
inspection/validation of the incoming file; it forwards whatever `file`
field it receives, unmodified, straight to Sarvam. **No code-level barrier
exists to accepting a WAV file from a source other than `MediaRecorder`.**
The only two things that must be correct are: (1) the field name must be
`file` inside real `multipart/form-data` (not raw binary body — the function
calls `req.formData()`, which would fail/reject a raw-binary POST), and (2)
whatever bytes are sent must be a format Sarvam itself actually accepts —
this function does not independently validate that; a bad file would simply
surface as whatever error Sarvam's API returns, forwarded back verbatim
(line 57-60).

**If conversion is necessary:** based on the above, **no conversion should
be necessary** for 16kHz/16-bit/mono PCM wrapped in a proper WAV header —
provided the ESP32-side request is real multipart form data with a `file`
field, matching what this function already expects. **REQUIRES
IMPLEMENTATION DECISION:** whether the ESP32 sends the request directly to
`transcribe` (bypassing `trigger-mic` and JWT auth entirely) or whether a
new/modified Edge Function receives it — see § ESP32 INTEGRATION OPTIONS,
this is the central open architecture question this audit is meant to
surface, not resolve unilaterally.

---

# AI FLOW

```
question (string)
  ↓
send(text) — app/dashboard/page.tsx:276
  ↓
POST {SUPABASE_URL}/functions/v1/chat
  Authorization: Bearer <session.access_token>
  body: { message, lang, conversation_id }
  ↓
Edge Function `chat` — supabase/functions/chat/index.ts
  ↓
  1. admin.auth.getUser(token) — explicit JWT verification IN CODE (unlike transcribe/speak)
  2. read profiles.preferred_model
  3. embed question — Gemini gemini-embedding-001, truncated to 768 dims
  4. retrieve — admin.rpc("match_kb_chunks", ...)
  5. generate — loop over [preferredModel, ...FALLBACK_CHAT_MODELS], stop on first 2xx or non-429
  6. persist both turns to `messages`, touch `conversations.updated_at`
  ↓
response: { reply, citations, conversation_id, latency_ms, model_used, fell_back }
  ↓
setMessages(...) — appends to UI
  ↓
speak(data.reply) — automatically invoked, no button
```

| Item | Value |
|---|---|
| Exact function (frontend) | `send(text)` — `app/dashboard/page.tsx:276` |
| Exact function (backend) | default export `Deno.serve` handler — `supabase/functions/chat/index.ts:69` |
| Request body | `{ message: string, lang: string, conversation_id: string \| null }` |
| Response body | `{ reply: string, citations: Citation[], conversation_id: string, latency_ms: number, model_used: string \| null, fell_back: boolean }` on success; `{ error: string, detail?: string }` on failure |
| Conversation/session state | `conversationId` React state, `null` until the first message of a session creates a row in `conversations`; subsequent calls in the same session pass that id back so `chat` appends to the same conversation | `app/dashboard/page.tsx:34`, `supabase/functions/chat/index.ts:104-117` |
| Authentication | **Explicit, in-code**: `Authorization: Bearer` header required, verified via `admin.auth.getUser(token)`; a real Supabase user id (`userId`) is extracted and used for both the conversation ownership and the `profiles.preferred_model` lookup — this is the ONE function of the three voice-adjacent functions that actually knows who the caller is, not just that the platform gateway allowed the request through | `supabase/functions/chat/index.ts:75-85` |
| Can it already be triggered programmatically, no button? | **Yes, already proven** — `send()` is called automatically today from the hardware auto-send path (`app/dashboard/page.tsx:101, 155`) with zero user interaction beyond the physical touch release. No change needed here for ESP32 integration; this half of the pipeline is already fully hands-free. |

---

# TTS FLOW

```
data.reply (string, from chat response)
  ↓
speak(text) — app/dashboard/page.tsx:247, called unconditionally after every reply
  ↓
if (muted) return  — the ONLY gate; no button press required otherwise
  ↓
POST {SUPABASE_URL}/functions/v1/speak
  Authorization: Bearer <session.access_token>
  body: { text, lang }
  ↓
Edge Function `speak` — supabase/functions/speak/index.ts
  ↓
  POST https://api.sarvam.ai/text-to-speech
    header: api-subscription-key
    body: { text, target_language_code, speaker, model: "bulbul:v3",
            output_audio_codec: "mp3", pace: 1.0 }
  ↓
response: { audios: [base64] }
  ↓
returned to browser as: { audio: base64string, mime: "audio/mpeg" }
  ↓
new Audio(`data:audio/mpeg;base64,${audio}`).play()
```

| Item | Value |
|---|---|
| Exact function (frontend) | `speak(text)` — `app/dashboard/page.tsx:247` |
| Exact function (backend) | `Deno.serve` handler — `supabase/functions/speak/index.ts:33` |
| Voice/model | `bulbul:v3`, one fixed speaker per language via `SPEAKER_BY_LANG` map (e.g. `priya` for `en-IN`, `shubh` for `hi-IN`) — `supabase/functions/speak/index.ts:27-31, 49` |
| Response format | **base64 string inside JSON**, NOT a URL, NOT streaming, NOT a raw Blob over the wire (base64-encoded text is what actually crosses the HTTP boundary; it's decoded into audio bytes only client-side via the data URI) | `supabase/functions/speak/index.ts:72-76` |
| Where/how browser plays it | `new Audio(...)`, standard HTML5 Audio element, `data:` URI — `app/dashboard/page.tsx:267-269` |
| **Are raw audio bytes accessible before playback?** | **Yes — this is the key finding for ESP32 output.** `data.audio` (line 260) is a plain base64 string, fully in hand, the instant the `fetch` to `speak` resolves — before any `Audio` object is created. The current code happens to immediately hand it to `new Audio(...)`, but nothing about the data's shape requires that; the exact same string is what would need to reach the ESP32. |

**Determining the easiest way to reuse the existing TTS result for ESP32:**
No backend change is required to `speak` itself to make the bytes available —
they're already returned in the JSON response, unmodified, ready to be sent
anywhere. The open question is purely **transport**: how does that base64
payload (or the raw bytes it decodes to) get from the browser (which already
has it) to the ESP32. That is a frontend-side or new-relay-side decision,
not a `speak` function change. See § ESP32 INTEGRATION OPTIONS and
§ BROWSER → ESP32 AUDIO.

---

# SUPABASE FLOW

**Client initialization:** `lib/supabase.ts` — single browser client,
`persistSession: true`, `autoRefreshToken: true`. No server-side Supabase
client exists in the frontend build (impossible under `output: "export"` —
confirmed via `next.config.mjs:3`, this is a fully static site with **no
Next.js API routes, no server runtime of any kind**). Every one of the four
Edge Functions creates its *own* separate `createClient` instance
server-side using the **service role key**, not the anon key — confirmed in
`chat/index.ts:79`, `trigger-mic/index.ts:54`. `transcribe` and `speak` do
NOT create a Supabase client at all (no DB/Realtime access needed for
either).

**Authentication:** Supabase Auth, email/password (confirmed via
`app/login/page.tsx`, out of scope for this audit but relevant context) — no
OAuth/magic-link/social providers evidenced in the codebase searched.

**Realtime usage — the ONLY two locations in the entire codebase:**
1. `app/dashboard/page.tsx:203-233` — browser subscribes to
   `supabase.channel(\`mic-trigger-${profile.id}\`)`, listens for
   `broadcast` events named `mic_control`.
2. `supabase/functions/trigger-mic/index.ts:54-84` — server creates its own
   Realtime client (service-role auth), joins the **same** channel name
   pattern (hardcoded to one user id, `TARGET_USER_ID`, line 30), and
   broadcasts one `mic_control` event.

**Realtime channel naming:** `mic-trigger-${user_id}` (hyphen, not the
colon-separated `mic-trigger:<user_id>` mentioned in the prompt's own
"previous trigger architecture" section — **the actual deployed code uses a
hyphen, not a colon.** This is a direct discrepancy between what the prompt
assumed and what's actually running; flagging per the audit's explicit
"do not assume" instruction.)

**Realtime event naming:** `mic_control` (not `start_mic`, which was an
earlier, now-superseded name from before the START/STOP bug fix — confirmed
by git history in this session, not guessed).

**Realtime payload (actual, current):**
```json
{ "action": "start" | "stop", "nonce": "<uuid>", "ts": "<iso8601>", "source": "esp32-button" }
```
This matches the prompt's described payload shape exactly.

**Can Realtime be used for ESP32 → browser signalling?**
**Yes — already in production use for exactly this, today.** This is proven,
not theoretical.

**Can Realtime be used for browser → ESP32 (or ESP32 → browser) AUDIO
transport?**
**Not advisable, and this must not be assumed.** Verified against Supabase's
own documentation during this audit (not assumed from memory): Realtime
Broadcast on the **Free plan has a 256 KB maximum message size**; the
general documented ceiling across all plans is 1 MB. A 16kHz/16-bit/mono PCM
WAV recording runs approximately 32 KB **per second** of audio
(16000 samples/sec × 2 bytes/sample). An 8-second utterance already
approaches or exceeds the Free-tier 256 KB ceiling; even the 1 MB
all-plans ceiling caps out around 30 seconds. **This project's specific
Supabase plan tier was NOT determinable from the Management API during this
audit** (the API used does not expose billing tier) — REQUIRES VERIFICATION
in the Supabase dashboard before finalizing, but even the more generous 1 MB
figure is a real ceiling a longer utterance could hit, and Realtime
Broadcast is explicitly a fire-and-forget signalling mechanism, not
designed or documented as a file-transfer channel. Base64-encoding audio for
a JSON broadcast payload also adds ~33% overhead on top of the raw byte
count, making the effective ceiling lower still.

**Existing `transcribe` function:** see § SARVAM STT FLOW — already accepts
arbitrary multipart file uploads with no origin/source validation beyond the
platform JWT gate.

**Existing `speak` function:** see § TTS FLOW — no changes needed for
ESP32 to receive its output; only the transport out of the browser is
undetermined.

**Existing `chat` function:** already callable with zero user gesture (see
§ AI FLOW) — no changes needed for hardware integration.

**Storage:** **NOT FOUND IN CODEBASE.** No `supabase.storage` calls, no
bucket creation in any migration, confirmed via full-codebase grep during
this audit.

**Database tables relevant to conversations/audio:** `conversations`,
`messages` (has a `mode` column, `'text' | 'voice'`, already distinguishing
voice-originated messages — `supabase/migrations/0001_init.sql:52`). **No
table stores audio bytes or audio file references anywhere.**

---

# ESP32 INTEGRATION OPTIONS

Evaluated against the actual constraints found above: static-export site
(no server routes possible outside Edge Functions), existing `transcribe`
already accepts arbitrary multipart uploads with no source validation,
Realtime Broadcast payload ceiling makes it unsuitable for audio, deployed
HTTPS-only origin (`cglachatbot.netlify.app` per the prompt; Supabase
functions are HTTPS-only by nature).

| | **A: ESP32→Edge Function→Realtime notify** | **B: ESP32→direct web endpoint** | **C: ESP32→WebSocket** | **D: ESP32→Storage→Realtime notify** |
|---|---|---|---|---|
| Implementation complexity | Low — reuses `trigger-mic`'s existing auth pattern; add a new Edge Function (or extend `transcribe`) that accepts audio + broadcasts a "new audio ready" event instead of a bare start/stop | Not viable as literally stated — this static-export site has **no web endpoint of its own** to receive a POST (confirmed: `output: "export"`, no API routes exist or are possible). Would require a *separate* server, which doesn't exist. | Medium-high — no WebSocket server exists anywhere in this stack today; would be new infrastructure (either a Supabase Edge Function acting as a WS endpoint, which Deno Deploy supports, or an entirely separate service) | Medium — new Edge Function to receive+store the upload, but Storage itself is zero-code (managed by Supabase) |
| Latency | Upload time + one Realtime round-trip (~200-600ms observed for the existing control-only broadcast in this project) | N/A | Potentially lowest if a persistent connection is kept warm, but nothing today keeps one warm | Upload + Storage write + Realtime round-trip; strictly more hops than A |
| Browser compatibility | High — reuses the exact Realtime client already working in production here | N/A | Requires new client-side WebSocket handling not present anywhere in this codebase today | High — same Realtime client, plus a Storage `download`/signed-URL fetch |
| Reliability | High — same pattern as the already-working `trigger-mic`, which has been verified end-to-end in this project | N/A | New failure surface (connection drops, reconnect logic) with zero existing code to build on | High, but two network hops (upload, then browser download) instead of one |
| Max practical audio size | Bounded by Edge Function memory (256MB) and CPU-time limit (2s/request, verified from Supabase's own limits docs during this audit) — CPU time ≠ wall-clock for I/O-bound forwarding, so this is likely fine for short push-to-talk clips but **REQUIRES VERIFICATION** under real load | N/A | Bounded mainly by whatever the chosen WS server allows — undefined since none exists | Storage itself has generous size limits (GBs); the constraint shifts to Edge Function memory for the receiving upload step, same as A |
| Requires existing STT changes? | No — can literally forward the received file straight into the same Sarvam call `transcribe` already makes | N/A | Would need new server-side logic to bridge WS→Sarvam; STT call itself unchanged but its trigger path is entirely new | No — browser downloads from Storage then POSTs to the existing `transcribe` unchanged |
| Works with deployed HTTPS Netlify site? | Yes — Supabase Edge Functions are already HTTPS and already called cross-origin from this exact Netlify domain today (`chat`, `transcribe`, `speak`, `trigger-mic` all already work this way) | N/A | Would need a `wss://` endpoint the Netlify-hosted page connects out to — no such endpoint exists | Yes — same as A |
| Requires ESP32 to know user credentials? | No — same device-key pattern already proven safe in `trigger-mic` | N/A | Would need its own auth scheme, undesigned | No — same device-key pattern |
| Requires a PC/local service? | No | Would require standing up one, which doesn't exist today | Would require standing up one, unless hosted as a Deno-based Edge Function (Supabase does support WebSocket Edge Functions, but none exists in this project currently) | No |

**Option E (a variant worth naming explicitly):** extend the *existing*
`transcribe` function itself to optionally accept a `device_key` field as an
**alternative** auth path alongside its current platform-JWT gate, and to
optionally broadcast a Realtime "transcript ready" event after producing the
transcript, instead of only returning it in the HTTP response (which the
ESP32, sitting on a different network path, may not get to keep a
connection open long enough to receive reliably). This reuses the *most*
existing code of any option, at the cost of blending two different auth
models (JWT-gated browser callers vs. device-key hardware callers) inside
one function — a real design tradeoff, not a free win, and one that should
be a deliberate decision rather than incidental.

**Recommendation:** **Option A variant (equivalent in spirit to Option E
above)** — a **new** Edge Function (not a modification of `transcribe`) that:
1. Accepts the device key (same pattern as `trigger-mic`) + a multipart
   audio upload from the ESP32.
2. Forwards that audio to Sarvam via the same call `transcribe` already
   makes (extract that call into a small shared helper, or literally
   duplicate the ~15 lines — either is reasonable for a two-caller
   codebase this size).
3. Persists the resulting transcript nowhere new — instead broadcasts it
   (not the audio) over the **already-working** `mic-trigger-<user_id>`
   Realtime channel, as a new event (e.g. `voice_transcript`), which the
   browser already knows how to subscribe to.
4. The browser's existing `send()` function is then called with that
   transcript, exactly as it already is for the current hardware
   auto-send path — **zero changes needed to `send()`, `chat`, or `speak`.**

This keeps a hard architectural line: **raw audio bytes never need to cross
Realtime** (respecting the payload-size finding above), the *only* thing
broadcast is a short transcript string, which comfortably fits any Realtime
payload ceiling. It reuses `trigger-mic`'s already-proven device-key
pattern, reuses `transcribe`'s already-proven Sarvam call, and reuses the
dashboard's already-proven Realtime subscription and auto-send logic almost
entirely unchanged (extend the existing `mic_control` handler's `on()` calls
to also listen for one more event name).

Why not D: introduces Storage, a genuinely new subsystem for this project,
for no benefit over A in this specific case — the audio doesn't need to
persist anywhere; it's consumed once and discarded, same as the browser's
own `MediaRecorder` Blob today.

Why not C: no WebSocket infrastructure exists in this codebase in any form
today; building one is strictly more new surface area than extending the
already-proven HTTP+Realtime pattern this project already runs in
production.

---

# FINAL API CONTRACT

**REQUIRES IMPLEMENTATION DECISION** on exact function/event names — the
below is the audit's recommended contract, consistent with everything
verified above, not yet implemented or agreed.

### ESP32 → backend (new Edge Function, name TBD — suggest `voice-upload`)

```
POST https://njpxixfcctodjejtgmwj.supabase.co/functions/v1/voice-upload
Content-Type: multipart/form-data

Fields:
  device_key   (string, required)  — same DEVICE_API_KEY secret trigger-mic already uses
  file         (binary, required)  — WAV, 16kHz, 16-bit, mono (see § ESP32 → BROWSER AUDIO FORMAT)
  lang         (string, optional)  — BCP-47, e.g. "hi-IN", forwarded to Sarvam same as today

Response (success):
  200 { "ok": true, "text": "<transcript>" }

Response (bad key):
  401 { "error": "Invalid device key" }

Response (Sarvam/transcription failure):
  502 { "error": "Transcription failed", "detail": "...", "unsupported": bool }
```

Internally, on success this function also broadcasts:
```
channel: mic-trigger-<TARGET_USER_ID>   (same channel already in use — no new subscription needed on the browser)
event:   voice_transcript                (NEW event name, additive — does not replace mic_control)
payload: { "text": "<transcript>", "nonce": "<uuid>", "ts": "<iso8601>", "source": "esp32-mic" }
```

### Browser event handling (extend the existing `.on()` chain at
`app/dashboard/page.tsx:204`, do not replace it)

```
channel.on("broadcast", { event: "voice_transcript" }, ({ payload }) => {
  // same nonce-dedup as mic_control
  // call the EXISTING send(payload.text) — no new function
})
```

### Browser → ESP32 (TTS audio) — **REQUIRES IMPLEMENTATION DECISION**,
not resolvable purely from codebase inspection; this is a genuinely new
direction of data flow that doesn't exist in any form today. See
§ BROWSER → ESP32 AUDIO for the tradeoffs; no file in this codebase
currently sends anything to a physical device. Two contract sketches,
neither implemented:

**Sketch 1 — ESP32 polls a Realtime-signalled Edge Function:**
```
Browser, after speak() resolves, additionally broadcasts:
  event: tts_ready
  payload: { audio_ref: "<some short-lived reference>", nonce, ts }

ESP32, on receiving any signal it can observe (see note below on how an
ESP32 would even receive a Realtime broadcast — REQUIRES IMPLEMENTATION
DECISION, ESP32 has no Supabase Realtime client library used anywhere in
this project; would need to either poll an Edge Function or hold its own
WebSocket, which is new infrastructure per § ESP32 INTEGRATION OPTIONS):

GET https://.../functions/v1/voice-fetch?ref=<audio_ref>&device_key=...
  → 200, Content-Type: audio/mpeg, raw MP3 bytes (NOT base64 — ESP32 has
    no reason to pay the ~33% base64 overhead if the Edge Function can
    return raw bytes directly)
```

**Sketch 2 — ESP32 short-polls after every upload it makes:**
Simpler, no Realtime-on-ESP32 problem, more requests. The ESP32's own
`voice-upload` call could itself long-poll and return the TTS audio bytes
directly once the whole `chat`+`speak` round-trip on the browser side
completes — but this requires the ESP32's single HTTP request to stay open
for the full duration of transcription+chat+TTS, which given the observed
`chat` latency (multiple seconds, per this session's own testing history in
this project) is a genuinely fragile design for an HTTP client without
demonstrated long-request handling.

**This document does not pick one — that choice affects ESP32 firmware
architecture significantly and should be made deliberately, not
incidentally, per the prompt's own instruction not to guess.**

---

# EXACT FILE CHANGE PLAN

No files have been modified during this audit. The following is what the
recommended architecture (§ ESP32 INTEGRATION OPTIONS, Option A variant)
would require, for review before any implementation begins.

**FILE 1:**
path: `supabase/functions/voice-upload/index.ts` (new)
purpose: Accept ESP32 audio upload, transcribe via existing Sarvam call, broadcast transcript over the existing Realtime channel
changes: New file. Device-key auth (copy pattern from `trigger-mic/index.ts:47-49`). Multipart parsing + Sarvam forward (copy pattern from `transcribe/index.ts:38-55`). Realtime broadcast (copy pattern from `trigger-mic/index.ts:54-84`, new event name `voice_transcript`).

**FILE 2:**
path: `supabase/config.toml`
purpose: Register the new function's JWT policy
changes: Add `[functions.voice-upload]` with `verify_jwt = false` (same reasoning as `trigger-mic` — ESP32 cannot produce a Supabase JWT)

**FILE 3:**
path: `app/dashboard/page.tsx`
purpose: Handle the new `voice_transcript` broadcast event
changes: Inside the existing `channel.on("broadcast", { event: "mic_control" }, ...)` block's sibling registrations (line ~204), add one more `.on("broadcast", { event: "voice_transcript" }, ...)` handler that dedups by nonce (reuse `seenNoncesRef`, already generic) and calls the existing `send(payload.text)`. No new state, no new refs beyond what's already there.

**FILE 4 (only if TTS-to-ESP32 is in scope for this pass — REQUIRES DECISION per contract sketches above):**
path: TBD based on Sketch 1 vs Sketch 2 decision
purpose: Deliver TTS audio bytes to the ESP32
changes: Not specifiable without the transport decision above being made first.

**ESP32 firmware (not part of this codebase, out of audit scope for exact
diffs, but the contract it must implement):**
- Existing touch-down/hold/release state machine (already built per this
  project's prior work) triggers WAV recording via INMP441 instead of an
  empty `trigger-mic` start/stop call.
- On release: POST the WAV file as `multipart/form-data` to the new
  `voice-upload` endpoint with the existing `device_key`.
- TTS playback path: undetermined pending the Sketch 1/2 decision above.

---

# IMPLEMENTATION ORDER

1. Decide and document the browser→ESP32 TTS transport (Sketch 1 vs 2 vs
   another) — this is the one remaining open architectural question;
   everything else in this audit has a clear, low-risk recommended path.
2. Build `voice-upload` (FILE 1) and deploy with `verify_jwt = false`
   (FILE 2) — testable in isolation with `curl`, exactly as `trigger-mic`
   was verified in this project's prior sessions, before touching any
   frontend or firmware code.
3. Extend the dashboard's Realtime handler (FILE 3) — testable with the
   same simulated-broadcast technique already used and proven in this
   project's prior sessions (a Node script subscribing to the same channel
   and firing a real broadcast, verifying the handler's observable
   behavior) before real hardware is involved.
4. Only after 2 and 3 are independently verified working, move to ESP32
   firmware changes (audio capture + upload), so a hardware bug is never
   confused with a backend bug.
5. Implement whichever TTS-to-ESP32 transport was decided in step 1, last
   — it is the only leg of this pipeline with literally zero existing code
   or proven pattern to build on in this codebase, so it carries the most
   implementation risk and should not block validating the input half
   first.

---

# RISKS / BLOCKERS

- **Supabase plan/tier for this project was not determinable from the
  Management API used during this audit.** Directly affects whether the
  Realtime-payload-size finding uses the 256 KB or 1 MB ceiling — though
  per the recommended architecture, this stops mattering, since audio never
  crosses Realtime under Option A. REQUIRES VERIFICATION only if a future
  design choice reintroduces audio-over-Realtime.
- **Edge Function CPU-time limit (2s/request, per Supabase's own
  documentation) vs. actual observed `chat` latency.** This project's own
  prior session testing observed multi-second `chat` response times. CPU
  time is not wall-clock time for I/O-bound waiting, so this is very likely
  fine, but has not been independently re-verified in this audit pass —
  REQUIRES VERIFICATION under a real timed test if TTS-to-ESP32 Sketch 2
  (long-held ESP32 request) is chosen, since that design is the one most
  sensitive to this limit.
- **No existing code anywhere in this repository sends data TO a physical
  device.** Every existing Realtime/HTTP flow is either browser-initiated
  or ESP32→backend. The browser→ESP32 leg is net-new in every sense — no
  pattern to extend, no prior art in this codebase to lean on. This is the
  single highest-uncertainty piece of the whole integration and the audit
  deliberately does not resolve it unilaterally.
- **`transcribe` and `speak` currently authenticate only via the platform
  JWT gate, with no in-code user identification** (unlike `chat`, which
  explicitly resolves a `userId`). The recommended new `voice-upload`
  function bypasses the JWT gate entirely (`verify_jwt = false`, matching
  `trigger-mic`) and instead trusts the device key alone. This means
  **anyone who obtains the device key can transcribe arbitrary audio
  through this project's Sarvam quota**, same exposure `trigger-mic`
  already has today for start/stop control — not a new risk class, but
  worth naming explicitly since it now extends to consuming paid STT
  quota, not just a free control signal. The prompt's own instruction to
  flag the device key as "prototype-only, rotate before production" is
  acknowledged and applies identically here.
- **`DEVICE_API_KEY` is currently embedded directly in ESP32 firmware
  source** (per this project's own prior session history) — the prompt
  already correctly identifies this as prototype-only. No production
  hardening (e.g., a provisioning flow that injects the key at flash time
  rather than compiling it into source) exists or is proposed as part of
  this audit; flagged as a pre-production blocker, not a prototype blocker.
- **ESP32 RAM for buffering a full WAV recording before upload.** Not
  determinable from this codebase (the ESP32 firmware itself is outside
  this repository/audit scope) — REQUIRES VERIFICATION against the actual
  firmware's buffering strategy (full-clip-in-RAM vs. chunked/streaming
  upload), which has direct implications for maximum practical utterance
  length independent of any backend limit found above.
