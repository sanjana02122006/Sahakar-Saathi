# Physical Voice-Button Trigger — Architecture Review

Senior-architecture pass on two candidate designs for: ESP32-C3 touch sensor →
signal → already-open, already-logged-in browser tab on `cglachatbot.netlify.app`
→ existing mic function → existing Sarvam STT. No implementation yet.

---

## 0. The one fact everything else depends on — verified, not assumed

**Chrome's user-gesture requirement is per-permission, not per-call.**

Confirmed against Chrome's own WebRTC gesture policy (not the unrelated
autoplay policy, which only governs `<audio>`/`<video>` playback):

> Once permission has already been obtained, activation of the media capture
> device should not require a user gesture.

Practical meaning:
- **First mic use ever, this browser profile, this origin:** needs a real
  user gesture (a click) to show the permission prompt and get it granted.
- **Every use after that**, for as long as the permission stays granted
  (`chrome://settings/content/microphone` shows the origin as Allowed):
  `getUserMedia()` can be called from *any* JS trigger — a `setTimeout`, a
  WebSocket message, a Supabase Realtime callback — with no click involved.

This directly resolves your items 17/18/19/20: **automatic mic start after
the first manual grant is realistic and Chrome-supported, not a workaround.**
Both plans below rely on exactly this, and neither needs a trick to get
around a restriction — there isn't one to get around, post-grant.

Source: [Chrome/W3C mediacapture-extensions discussion, "Enforcing user gesture for getUserMedia"](https://github.com/w3c/mediacapture-extensions/issues/11)

One caveat worth testing, not assuming (see §7 open risks): Chrome can still
silently drop a *persisted* mic grant under some conditions (site data
cleared, "Ask every time" global setting, profile sync oddities). Item to
verify on the actual demo machine before the demo, not on stage.

---

## 1. PLAN A — Supabase / Cloud Trigger

### 1.1 Architecture

```
ESP32-C3                Supabase Edge Fn        Supabase Realtime         Browser tab
(touch sensor)  ──POST──▶  trigger-mic     ──broadcast──▶  channel  ──event──▶ (open,
                HTTPS      (validates          (in-memory,                    logged in,
                            device key)          server-managed)               subscribed)
                                                                                  │
                                                                                  ▼
                                                                          getUserMedia()
                                                                                  │
                                                                                  ▼
                                                                          existing Sarvam
                                                                          STT flow (unchanged)
```

### 1.2 Exact data flow

1. Touch released before 5s → ESP32 fires `POST https://njpxixfcctodjejtgmwj.supabase.co/functions/v1/trigger-mic` with `{ "device_key": "<DEVICE_API_KEY>" }` over TLS.
2. Edge Function (Deno, runs at Supabase's edge) checks `device_key` against a value stored only in Supabase secrets (`DEVICE_API_KEY`) — never in the DB, never in a table a browser could read.
3. On match, the function opens a Supabase Realtime connection **server-side** and calls `channel.send({ type: "broadcast", event: "start_mic", payload: {...} })` on a channel scoped to the target user (see §1.4).
4. The browser tab, already subscribed to that same channel name since page load, receives the broadcast via its already-open WebSocket to Supabase Realtime.
5. Tab's JS calls the **existing** `startSarvamRecording()` — zero changes to STT logic, per your constraint.

### 1.3 Protocols

| Hop | Protocol |
|---|---|
| ESP32 → Edge Function | HTTPS (TLS 1.2+, `WiFiClientSecure`) |
| Edge Function → Realtime | Supabase Realtime's internal server-side broadcast API (over Supabase's own infra, not public internet) |
| Realtime → Browser | WebSocket (`wss://`), already open from page load — this is the same connection type Supabase Realtime always uses |

### 1.4 Channel/event design — answering your open question

**Scope to a per-demo-session channel, not just per-user.** Rationale: a
bare per-user channel (`mic-trigger-<user_id>`) means *any* tab logged in as
that user reacts — fine for a single demo laptop, but if that account is
ever logged in elsewhere (another laptop, a phone, forgotten open tab) that
tab also fires. For a demo you want exactly one predictable target.

Recommended channel name: `mic-trigger:<user_id>:<session_token>`, where
`session_token` is a short random value the dashboard generates once on
load and displays nowhere sensitive (it's not a secret — it's a routing
key, not an auth boundary; the device key is the auth boundary). Simpler
alternative if you don't need multi-tab safety: just `mic-trigger:<user_id>`,
which is fine for a single-laptop demo and is what I'd actually ship first
(see §5 minimum viable).

**Event payload should carry a nonce + timestamp** for dedup (§1.6):
```json
{ "event": "start_mic", "payload": { "nonce": "<uuid>", "ts": "<iso8601>", "source": "esp32-button" } }
```

### 1.5 Authentication / security model

- **ESP32 → Edge Function:** shared secret (`DEVICE_API_KEY`), checked
  server-side, transmitted over TLS. This is a bearer-token-style scheme —
  adequate for a demo device, not bank-grade, but matches your explicit
  constraint of "not the user's login."
- **Edge Function → Realtime:** uses the Supabase **service role** key
  (already in the function's environment, same pattern as your other
  functions) — this is trusted server-to-server, not exposed to the ESP32
  or the browser.
- **Browser's right to listen:** the browser only *receives* — it never
  authenticates *to* trigger anything, it just listens on a channel it
  already knows the name of because it's logged in as that user. The real
  security boundary is entirely at the Edge Function (device key check);
  the channel name is not a secret and shouldn't be treated as one.

### 1.6 Preventing unauthorized triggers / replay & duplicates

- **Unauthorized trigger:** blocked by the device key check. Rotate the key
  if it ever leaks (e.g., someone extracts it from ESP32 flash — realistic
  risk for physical devices, see §7).
- **Replay:** a captured/replayed POST would still need a valid device key
  to succeed, so replay alone isn't more dangerous than a fresh forged
  request — the key is the actual control, not request-uniqueness. If you
  want defense-in-depth, add a short-lived nonce that the Edge Function
  tracks in memory for ~10s (reject duplicate nonces) — enumerated here as
  optional, not required for a demo threat model.
- **Duplicate triggers** (e.g., ESP32 retries, double-fire on a flaky
  touch): handle client-side — the dashboard should **ignore a new
  `start_mic` event if it's already listening/recording**, not queue or
  restart. Cheap, and matches "ignore mid-turn" behavior generally.

### 1.7 Network failure handling

- **ESP32 has no WiFi / Supabase unreachable:** POST fails or times out.
  ESP32 should show a distinct failure indicator (per your existing error
  branch — you already log `ERROR: Server rejected request.` for a 4xx;
  add a separate branch for connection-level failure vs. HTTP-level
  rejection, since they mean different things to a person debugging this
  on stage).
- **Realtime channel drops** (browser tab loses WebSocket briefly):
  Supabase's client SDK auto-reconnects; a trigger that arrives during the
  gap is simply missed — there's no server-side queue/replay for broadcast
  events by design (broadcast is fire-and-forget, not a durable queue).
  For a demo this is an acceptable and expected tradeoff; don't build a
  redelivery system for this.

### 1.8 ESP32 reboot behavior

Stateless from the trigger's perspective — the device key lives in ESP32
flash (same persistence mechanism you already use for saved WiFi
credentials per your existing provisioning flow). On reboot: reconnect
saved WiFi → resume touch-detection loop. No session/handshake needed with
Supabase; every trigger is an independent authenticated POST.

### 1.9 Listener/browser restart behavior

If the browser tab is closed and reopened (or refreshed), it simply
re-subscribes to the channel on load — no state to recover, since broadcast
events aren't queued. A trigger sent while no tab is subscribed is lost,
which is correct behavior for a live demo (you want "nothing happens if
the browser's not there," not a stale mic-start firing minutes later).

### 1.10 Latency

Realistic: **200–600ms** end-to-end (ESP32 → Supabase edge region
`ap-south-1`, matching your existing project region → Realtime broadcast →
browser). Bound almost entirely by ESP32's WiFi round-trip to the nearest
Supabase edge, not by Realtime itself, which is typically sub-100ms once
the request lands. Acceptable for a live demo; not perceptibly different
from a human clicking a button.

### 1.11 Internet / same-WiFi requirements

- **ESP32 needs internet access** (not just LAN) — it's calling a public
  HTTPS endpoint. Same-WiFi with the laptop is *not required* for Plan A;
  the ESP32 only needs a path to the internet, which could even be a
  different network than the laptop's.
- **Browser needs internet** (it already does, to reach Supabase/Netlify).
- No LAN-level requirement at all — this is genuinely cloud-mediated
  end-to-end, which is Plan A's main structural difference from Plan B.

### 1.12 What if the PC's IP changes / how ESP32 finds it

**Not applicable to Plan A.** The ESP32 never talks to the PC directly —
it only ever talks to Supabase's fixed, public URL. This is a structural
advantage over Plan B (see §2.12).

---

## 2. PLAN B — Local PC Background Listener

### 2.1 Architecture

```
ESP32-C3              Local Python listener         Browser tab (same PC)
(touch sensor) ──POST──▶  (Windows background   ──WebSocket──▶  (open, logged in,
  LAN HTTP               process, port 8765)      ws://localhost:PORT   connected)
                                                                          │
                                                                          ▼
                                                                   getUserMedia()
                                                                          │
                                                                          ▼
                                                                   existing Sarvam
                                                                   STT flow (unchanged)
```

### 2.2 Exact data flow

1. ESP32, on the same LAN as the PC, fires `POST http://192.168.1.100:8765/trigger` with a small JSON body including a shared secret.
2. Python listener (a lightweight local HTTP + WebSocket server) validates the secret, then pushes a message to any WebSocket client connected to it.
3. The open browser tab holds a `ws://localhost:8765` (or LAN IP) connection made when the dashboard page loaded, and receives that push.
4. Tab's JS calls the same existing `startSarvamRecording()`.

### 2.3 Protocols

| Hop | Protocol |
|---|---|
| ESP32 → Listener | Plain HTTP over LAN (no TLS needed/available for a raw local IP without extra cert work — acceptable since it's LAN-only, see §2.4) |
| Listener → Browser | WebSocket, `ws://` (not `wss://` — see §2.11 localhost caveat) |

**Why WebSocket over Server-Sent Events (your item 27):** SSE is
strictly one-directional (server → browser) and, more importantly, is
subject to a **per-origin connection limit of 6 concurrent connections**
in Chrome for non-HTTP/2 origins — a real risk if the demo laptop has
multiple tabs or the dashboard reconnects repeatedly. WebSocket has no
such low ceiling, supports the trivial bidirectional handshake this needs
for a clean "connected" ack, and is the natural fit for a
persistent-local-daemon pattern. **Recommendation: WebSocket**, matching
your own stated preference — and it's the better technical choice, not
just the convenient one.

### 2.4 Authentication / security model

- **ESP32 → Listener:** shared secret in the POST body/header, same
  pattern as Plan A's `device_key`, checked by the Python process before
  it forwards anything to the browser.
- **Listener → Browser:** this is the interesting gap. A WebSocket server
  on `localhost`/LAN IP has **no built-in authentication** — any process
  or even any other device on the LAN that knows the port can open a
  WebSocket to it unless the listener itself enforces something. Two
  options:
  - **(a)** Listener only binds to `127.0.0.1` (localhost), not `0.0.0.0`
    — this makes it unreachable from other LAN devices entirely, only
    reachable from processes on the same machine (i.e., only that PC's
    browser). **This is the right default** given your explicit goal
    ("only the PC with the listener should respond").
  - **(b)** If it must also accept the ESP32's request over LAN (it does —
    the ESP32 isn't on `localhost`), the **HTTP-in side** binds to the LAN
    IP (so the ESP32 can reach it), while the **WebSocket-out side** can
    still bind to `127.0.0.1` only, since it only needs to talk to a
    browser on that same machine. This is the correct split and is what
    I'd specify: two listeners, two bind addresses, one process.
- **Do other LAN devices threaten anything if the WS side is
  localhost-only?** No — even if another LAN device hits the HTTP `/trigger`
  endpoint with a guessed/sniffed secret, all it can do is cause *that
  specific PC's* mic to start (same blast radius as Plan A's device-key
  model). It still can't reach the WebSocket from off-machine.

### 2.5 How the ESP32 identifies/authenticates itself

Identical mechanism to Plan A — a shared secret in the request. No
difference in kind, only in where it's checked (a Python process instead
of an Edge Function).

### 2.6 How the browser knows the trigger is intended for it

Structurally simpler than Plan A: the browser is talking to
`ws://localhost:8765`, which by definition only exists on **its own
machine**. There's no "which tab/user" ambiguity to resolve — if the
WebSocket connects at all, it's the right browser, on the right PC, by
construction. This is Plan B's real advantage over Plan A's channel-scoping
problem (§1.4).

### 2.7 Preventing another device from triggering the browser

Covered in §2.4 — binding the WebSocket side to `127.0.0.1` only is the
actual mechanism, not a secret or token. This is a stronger guarantee than
Plan A's for this specific goal, because it's enforced at the network
layer, not just the application layer.

### 2.8 Duplicate triggers

Same handling as Plan A (§1.6): dashboard ignores a new trigger if already
mid-listen. The listener itself can also dedupe rapid repeat POSTs
(debounce server-side, e.g., ignore a second trigger within 1s of the
last), which is a nice-to-have, not required if the browser side already
ignores busy-state triggers.

### 2.9 Network failure handling

- **ESP32 can't reach the listener** (PC off, listener crashed, wrong IP):
  connection-level failure, same distinct-error-branch recommendation as
  §1.7.
- **Listener running but browser tab not connected to it** (tab closed,
  page not loaded, WebSocket dropped): trigger arrives at the listener but
  has nowhere to deliver it. Listener should log this clearly (per your
  stated logging requirement) rather than fail silently — this is the
  most likely on-stage failure mode for Plan B and the most important one
  to make debuggable.
- **Listener process itself dies:** ESP32's POST simply fails to connect
  (connection refused) — same as PC-off case from the ESP32's point of
  view.

### 2.10 ESP32 reboot / listener restart behavior

- ESP32 reboot: identical to Plan A (§1.8) — stateless, reconnects WiFi,
  resumes.
- **Listener restart:** if configured to auto-start with Windows (§2.13),
  a crash-and-restart is mostly self-healing, but any browser WebSocket
  connections made before the restart are now stale and won't
  auto-reconnect unless the dashboard's JS explicitly implements
  reconnect-with-backoff — this **is** new frontend logic (a small, generic
  "reconnect this WebSocket" helper), which is a reasonable and limited
  scope addition, not a redesign of anything Sarvam-related.

### 2.11 Windows-specific implementation details

- **Packaging:** `pyinstaller` (or similar) to produce a single `.exe`,
  matching your "ideally packaged into a Windows executable" ask. This is
  standard and low-risk for a small always-on TCP/WebSocket server.
- **Auto-start with Windows:** two realistic options —
  - **(a)** Place a shortcut in the user's Startup folder
    (`shell:startup`) pointing at the `.exe` — simplest, no admin rights
    needed, runs when that user logs in (which matches "demo laptop, one
    user" perfectly).
  - **(b)** Register as a Windows Service (via `pywin32` or `nssm`) — runs
    even without a user logged in, more robust, but needs admin install
    and is meaningfully more setup complexity for a one-laptop demo.
  - **Recommendation for a demo: (a).** Service-level robustness solves a
    problem you don't have (unattended multi-user boot); Startup-folder is
    simpler to install, uninstall, and debug, and is what I'd actually
    ship first if Plan B is chosen.
- **Silent background operation:** run as a windowless process
  (`pythonw.exe` or a `--noconsole` PyInstaller build) so no terminal
  window is required to stay open, per your explicit requirement.
- **Logging:** write to a rotating local log file (e.g.,
  `%LOCALAPPDATA%\VoiceButtonListener\listener.log`) rather than only
  stdout, since there's no visible console to read stdout from in silent
  mode.

### 2.12 What if the PC's IP changes

This is Plan B's real structural weakness (your item 15). If the PC's LAN
IP changes (DHCP lease renewal, different network, etc.), the ESP32's
hardcoded target IP (`192.168.1.100:8765`) goes stale and every trigger
fails until reconfigured.

Realistic mitigations, ranked:
1. **Static DHCP reservation** on the router/access point for the demo
   PC's MAC address — the pragmatic, zero-code fix. Recommend this as the
   actual operational answer, not a software one.
2. **mDNS/Bonjour** (e.g., listener advertises itself as
   `voicebutton.local`) — works well on most home/office networks, but
   ESP32-side mDNS resolution adds a dependency and a failure mode of its
   own (some networks/APs block or don't propagate mDNS reliably) — I'd
   treat this as a "nice to have later," not part of the first build.
3. Manually re-enter the PC's IP via the same AP-provisioning web page you
   already have for WiFi credentials (the ESP32's setup page could gain
   one more field: "Listener IP"). This reuses infrastructure you're
   already building for WiFi setup, so it's a small, natural extension —
   worth considering directly rather than mDNS, and simpler to reason
   about.

**Recommendation: static DHCP reservation for the demo, with option 3 as
the built-in escape hatch** if the network doesn't cooperate.

### 2.13 How the ESP32 discovers/configures the PC address

Given your constraint against over-engineering and against WiFi scanning:
extend the existing captive-portal setup page (the one that already
handles SSID/password entry) with one additional field for the listener's
IP:port, stored in the same persistent flash storage as the WiFi
credentials. No new provisioning flow — same page, one more field. This
is the most consistent choice with what's already built and tested.

### 2.14 Browser connection to the local listener — CORS/security

- The dashboard page is served from `https://cglachatbot.netlify.app`
  (a public HTTPS origin) but needs to open a WebSocket to
  `ws://localhost:8765` (a local, non-TLS origin). **This is allowed** —
  WebSocket connections are not subject to the same-origin policy the way
  `fetch`/XHR are; there's no CORS preflight for WebSocket upgrade
  requests. This is a real, browser-supported mechanism, exactly per your
  constraint — not a workaround.
- **One real Chrome catch:** pages served over HTTPS are increasingly
  restricted from making **plain HTTP** requests to private/local network
  addresses under Chrome's evolving **Private Network Access (PNA)**
  policy — this primarily targets `fetch`, but WebSocket upgrade requests
  to `ws://localhost` have historically been permitted even from HTTPS
  pages because `localhost` is treated as a trusted/secure context
  exception. **This is flagged as an unresolved risk to verify on the
  actual demo Chrome version before relying on it** (§7) — Chrome's PNA
  rollout has changed behavior across versions, and "worked before" is not
  the same as "guaranteed with the Chrome build on the demo laptop."

### 2.15 localhost vs LAN IP for the WebSocket

**Use `127.0.0.1`/`localhost` for the browser-facing WebSocket side**
(§2.4) — both for the security reason already given, and because it sits
inside Chrome's "potentially trustworthy origin" exception list, which
sidesteps most mixed-content concerns an HTTPS page would otherwise have
connecting to a plain LAN IP.

### 2.16 Is a Chrome extension necessary? (your item 28/29)

**No, not for the core requirement as specified.** A page-level WebSocket
client (plain JS already in the dashboard) can connect to
`ws://localhost:PORT` and call `getUserMedia()` directly — no extension
privileges are needed for either of those actions. An extension would only
become relevant if you needed the *browser itself* to be launched, or a
tab to be focused/opened, by the local listener — which is out of scope
here (browser is already open, per your constraint). Recommend **not**
building one; it adds install friction (extension permissions, Chrome Web
Store or manual sideload) for no capability this design actually needs.

### 2.17 Firewall implications

Windows Defender Firewall will very likely prompt on first run of the
listener `.exe` ("allow this app to communicate on private networks?"),
since it's a new process opening a listening socket. This is expected and
one-time — flag it explicitly in the install instructions so it's not a
surprise mid-setup. No firewall change is needed for the WebSocket side if
it's bound to localhost-only (§2.4), since localhost traffic doesn't cross
the firewall boundary at all.

---

## 3. Side-by-side comparison

| | **Plan A — Cloud/Supabase** | **Plan B — Local Listener** |
|---|---|---|
| Cloud dependency | Yes (Supabase Realtime) | No |
| Internet required (ESP32) | Yes | No |
| Internet required (browser) | Yes (already true today) | No |
| Same-WiFi required | No | Yes (ESP32 ↔ PC) |
| Latency | ~200–600ms | ~20–100ms (LAN-local) |
| Security model | Shared secret + server-side check; channel scoping needed | Shared secret + localhost-only WS bind (network-layer guarantee) |
| Setup complexity | Lower — deploy 1 function, set 1 secret | Higher — package, install, auto-start, firewall prompt on a specific PC |
| Reliability | Depends on Supabase uptime + ESP32 internet | Depends on that one PC being up and the listener running |
| Browser compatibility | Standard Realtime client, already a dependency in this stack | WebSocket to localhost — verify PNA behavior on demo Chrome build (§7) |
| Windows complexity | None | Real — packaging, autostart, logging, firewall |
| Offline operation | No | Yes |
| PC-specific targeting | Requires explicit channel scoping (§1.4) | Free — structural (§2.6) |
| Scalability | Scales naturally (Supabase handles fan-out) | One listener = one PC, by design (not a flaw here, just a ceiling) |
| Maintenance | One deployed function, versioned with the rest of the backend | A separate local install to keep working on a specific machine, separate from the web deploy pipeline |
| Demo suitability | High — fewer moving parts to fail on stage | High if pre-tested on the exact demo PC; more setup steps that must each be verified beforehand |

---

## 4. Recommendation

**Build Plan A first.** Reasoning, not just preference:

- It reuses infrastructure that's already deployed, tested, and working in
  this project (Supabase Edge Functions, the exact pattern your `chat`,
  `transcribe`, and `speak` functions already follow). The marginal new
  surface area is one more Edge Function and a Realtime subscription —
  small, and consistent with everything already shipped.
- It has **fewer failure domains that depend on the specific demo
  machine's OS state** — no firewall prompts, no "did the listener
  actually start silently," no packaging step. Fewer things that can be
  subtly different on the day of the demo versus when you tested it.
- Its one real unresolved question (Realtime channel scoping, §1.4) is
  a design decision to finalize, not an open technical risk — unlike
  Plan B's PNA/localhost-WebSocket behavior, which needs to be verified
  against the actual Chrome build before you can trust it (§7).

**Long-term, Plan B is architecturally the better fit *if* the deployment
target stays "one specific known PC, possibly offline."** Zero cloud
dependency and lower latency are real, durable advantages for a permanent
kiosk-style installation. But "long-term better for a fixed kiosk" and
"faster to a reliable first demo" are different questions — for the demo
itself, Plan A wins on reduced setup risk.

**Is there a reason to build both?** Only if the demo environment's
internet reliability is genuinely in question (e.g., a venue with known
flaky WiFi) — in that case Plan B becomes a real fallback rather than a
nice-to-have. Otherwise, building both before validating Plan A adds
scope without validating the harder question first (whether the whole
touch→mic loop feels right at all). Recommend: **Plan A first, evaluate
Plan B only if a specific need (offline requirement, or Plan A's channel
scoping proves awkward in practice) shows up.**

**Minimum viable implementation, each plan:**
- **Plan A MVP:** `trigger-mic` Edge Function deployed with the device key
  set; dashboard subscribes to `mic-trigger:<hardcoded_user_id>` (no
  session-token scoping — fine for a single demo laptop, per §1.4); ESP32
  sends the real device key instead of the placeholder. Three changes,
  all already scoped.
- **Plan B MVP:** Python script (not yet packaged as `.exe`) binding HTTP
  on the LAN IP and WebSocket on `127.0.0.1`; dashboard adds a WebSocket
  client with basic reconnect; manual `python listener.py` start for
  first test (packaging/autostart is a polish step *after* the core loop
  is proven, not before).

---

## 5. Unresolved technical risks — test before building

These are the specific things that must be verified on the **actual demo
hardware/browser**, not assumed from documentation, before either plan is
considered demo-ready:

1. **Mic permission persistence.** Confirm that once granted for
   `cglachatbot.netlify.app` in the demo Chrome profile, the permission
   survives a tab refresh and a browser restart, and that no Chrome
   flag/policy on that specific machine forces "ask every time." (§0)
2. **Plan B's Private Network Access behavior on the actual Chrome
   version installed on the demo PC.** Chrome's PNA rollout has moved in
   stages across versions — confirm an HTTPS page can still open
   `ws://localhost:PORT` on that exact build before relying on it. (§2.14)
3. **Realtime broadcast delivery latency under real conditions** — test
   from the actual venue's WiFi if possible, not just a home/office
   network, since Plan A's latency estimate (§1.10) assumes reasonable
   ESP32 WiFi quality.
4. **Windows Defender Firewall's exact prompt behavior** for the packaged
   listener `.exe` on the specific demo PC's current Defender
   configuration/policy — some managed/corporate Windows images block
   silent local servers outright regardless of user consent. (§2.17)
5. **Whether the demo PC's IP is actually stable enough** to skip the
   DHCP-reservation mitigation, or whether that step is mandatory. (§2.12)

---

## 6. Explicitly out of scope (per your constraints)

- No changes to Sarvam STT logic, no new speech-to-text system.
- No credentials (email/password) stored on the ESP32 in either plan.
- No pretending same-WiFi grants browser control — it doesn't, in either
  plan; every browser action in both designs happens through
  browser-supported APIs the page's own JS calls (`getUserMedia`,
  WebSocket), never through simulated clicks or external control.
- No WiFi scanning on the ESP32 — neither plan touches WiFi
  provisioning at all; that subsystem is untouched.
- No Chrome extension (§2.16) — not needed for either plan as specified.
- No full IoT platform — both plans are scoped to exactly one trigger
  path, no device registry, no multi-device fan-out, no admin UI beyond
  what's already there.

---

**Nothing in this document has been implemented or deployed.** This is
the finalized architecture for review. Once you approve a direction (or
ask for adjustments), the next step is the concrete file list and
sequence — held back per your instruction not to write final code yet.
