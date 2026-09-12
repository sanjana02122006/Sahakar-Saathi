# Guide Avatar Feature — Build Spec

Test-only feature for the `cglachatbot1.netlify.app` deploy. Four visually
distinct guide avatars behind a live switcher, so they can be compared on the
deployed site and the losers deleted.

**This is a throwaway test.** Commit the pre-existing work FIRST (Step 0) so
`git reset --hard <that commit>` cleanly reverts everything below.

---

## Step 0 — Checkpoint commit (do this before writing any feature code)

Working tree has 5 modified files plus untracked `.mcp.json`.

`.mcp.json` has been inspected and is SAFE to commit — it contains only a
Supabase project ref in a URL, no token, no key.

```bash
git add -A
git commit -m "Checkpoint: env/docs/firmware tweaks before avatar guide test"
```

Record the resulting SHA at the top of the feature commit message so the revert
target is obvious.

---

## Design rationale (read before building)

The four avatars differ **in kind**, not in skin. Plant / robot / human /
abstract are four different answers to "what is this assistant?", which is what
makes the live comparison worth deploying.

Two rules that apply to ALL variants:

1. **One fixed designed character per variant.** DiceBear is a *seeded*
   generator built to give many users *different* faces. An ambassador is the
   opposite: every citizen must see the identical character every session. So
   where DiceBear is used, the seed is a hardcoded constant and the generated
   SVG string is produced ONCE at module scope — never per-render, never from
   user id, never random.
2. **Always happy.** Government mascots are upbeat. No neutral, sad, confused
   or angry expressions in any state. `thinking` is *cheerful concentration*,
   never a frown.

---

## The four variants

### 1. `sprout` — "Sahakar Mitra" (recommended default)

Custom inline SVG. Your copyright — no third-party license at all.

A rounded seedling with a warm face; two leaves act as arms. Derived from the
`Sprout` lucide icon already used as the app mark in `app/login/page.tsx` and
the dashboard header, so mascot and logo become one coherent brand.

- Colors: `--primary` teal for the body, `--accent` for leaf highlights.
- Happy: permanent gentle smile. Leaves lift/wave while `delivering`.
- No gender, ethnicity or age — safest for a 9-language national portal.
- ~80 lines of SVG, zero dependencies.

### 2. `robot` — "Seva"

DiceBear **Bottts**, pinned to ONE hardcoded seed and a locked teal palette.

- Soft-cornered robot head, large friendly eyes, small antenna.
- Happy: wide curved-arc mouth. Antenna bobs during `thinking`.
- Reads unmistakably as "AI assistant" — sets honest expectations rather than
  impersonating a human officer.
- LICENSE CAVEAT: Bottts is under the *artist's own terms* (free for personal
  and commercial use), NOT a standard OSI/CC license. Acceptable for this test
  deploy. If it wins the comparison, get the terms reviewed before any real
  government launch. Note this in the PR/commit body.

### 3. `human` — "Mitra Didi"

**Open Peeps** (Pablo Stanley), **CC0 / public domain, no attribution** — the
cleanest license of the four.

Pick ONE specific head + smiling-face + hair combination by hand and freeze it
as a static SVG committed into the repo. Do NOT generate it per-user.

- Highest warmth and trust for rural / low-literacy users; a human face reads
  as "a person is helping me".
- Open Peeps ships explicit smiling face components — choose one and keep it.
- CONSIDERATION: the only variant carrying implied gender and ethnicity. Real
  factor on a national portal; flagged deliberately, not an oversight.

### 4. `lotus` — "Kamal"

Custom inline SVG. Your copyright.

Non-figurative: a soft lotus / chakra-like form that pulses, rotates and blooms
through the states. No face — all expression is carried by motion plus the
reply cloud.

- The most formally "government" option; echoes official Indian visual language.
- **HARD CONSTRAINT:** it must NOT resemble the State Emblem of India (the
  Sarnath Lion Capital) or any actual state insignia — those are legally
  protected under the State Emblem of India (Prohibition of Improper Use) Act.
  Keep it a generic decorative lotus/bloom. Do not add lions, wheels rendered
  as an Ashoka Chakra, or any tricolour arrangement.
- Warmth comes from soft rounded petals and gentle easing, not a smiley.
- Ages best, most culturally neutral, most likely to survive a design review.

---

## Architecture

### New files

```
components/avatar/index.tsx          <GuideAvatar variant state size />  — single entry point
components/avatar/sprout.tsx         variant 1
components/avatar/robot.tsx          variant 2
components/avatar/human.tsx          variant 3
components/avatar/lotus.tsx          variant 4
components/avatar/speech-bubble.tsx  the "reply cloud" + tail
components/avatar/switcher.tsx       the test-only variant picker
lib/avatar-context.tsx               variant choice + localStorage persistence
```

### Public API — all four variants are drop-in swappable

```tsx
type AvatarVariant = "sprout" | "robot" | "human" | "lotus";
type AvatarState   = "idle" | "listening" | "thinking" | "delivering";

<GuideAvatar variant={variant} state={avatarState} size={40} />
```

The avatar is presentational only: it takes a state and renders. It never
starts, stops, or touches audio.

### Dependencies

`@dicebear/core` + `@dicebear/collection` (core is MIT).

Generate at **module scope** with a fixed seed, then `toDataUriSync()` once:

```tsx
// module scope — runs once, not per render
const SEVA_URI = createAvatar(botttsNeutral, { seed: "seva-fixed", /* locked palette */ }).toDataUriSync();
```

Variant 3 (Open Peeps) should be committed as a **static SVG file**, not
generated — it is one hand-picked character, so there is nothing to generate.

---

## State machine

```
idle → listening → thinking → delivering → idle
```

**The avatar has no voice of its own and produces no audio.** It is a visual
companion that sits beside the reply. The fourth state is named `delivering`
(NOT "speaking") to keep that unambiguous: it means "this reply is still being
delivered to the user", by either of the two delivery channels below.

Derive the state; do NOT add a parallel state machine. Three flags already
exist in `app/dashboard/page.tsx`:

- `sending`   (line 53) → `thinking`
- `listening` (line 54) → `listening`
- `booting`   (line 55) → boot screen

### What bounds `delivering`

A reply is delivered by one of two channels, and the animation must run until
whichever one is active has finished. Both need a small amount of new state
because neither is currently tracked in React.

**Channel A — browser TTS is reading it aloud.** Two separate code paths, both
inside the existing `speak()` (line ~304) and `speakWithBrowser()` (line ~280):

- Sarvam path: `new Audio(...)` assigned to `audioRef`. Hook its `play` /
  `ended` / `error` / `pause` events.
- `speechSynthesis` fallback: hook the utterance's `onstart` / `onend` /
  `onerror`.

**Channel B — no audio at all.** If `muted` is true, the Sarvam request fails
*and* the browser fallback is unavailable, or the turn is
`origin === "esp32"` (which deliberately plays nothing locally — see the long
comment at line ~286), then nothing reads the text. In that case fall back to a
**reading-time estimate**: animate for `clamp(1800ms, words / 3.5 * 1000, 12000ms)`
so the avatar still animates "until the text is read", just by the human eye
rather than a speech engine.

One state value covers both channels:

```tsx
// Which message the avatar is currently animating alongside, or null.
const [deliveringId, setDeliveringId] = useState<string | null>(null);
```

Keyed **by message id**, not a boolean, so the avatar animates next to the
correct reply rather than all of them at once.

Clear it in all of: `ended`, `error`, `pause`, the estimate timeout, and the
existing mute handler (which already calls `audioRef.current?.pause()` and
`speechSynthesis.cancel()`). Guard the timeout so a new turn starting mid-
animation cancels the previous one — store the timer in a ref and clear it on
each new reply.

Then, per message:

```tsx
const avatarState: AvatarState =
  sending                    ? "thinking"
  : listening                ? "listening"
  : deliveringId === m.id    ? "delivering"
  : "idle";
```

**Do NOT reuse `replayingId` / `replayedId` (lines 402-403).** Those track the
ESP32 *device* replay button — a different concern from the on-screen avatar.
Leave that logic completely untouched.

Optional, only if it falls out cleanly: the per-message replay button could
also set `deliveringId` so the avatar re-animates on replay. Skip it if it
complicates the replay path at all — the replay feature is newer than this one
and must not regress.

| State | Trigger | Avatar behavior |
|---|---|---|
| `idle` | default | gentle breathing / float |
| `listening` | `listening === true` | pulsing ring, attentive |
| `thinking` | `sending === true` | animated "…" dots in the cloud |
| `delivering` | `deliveringId === m.id` | subtle bob / leaf-wave beside the reply; settles to `idle` when delivery ends |

---

## Mount points (5)

1. **Login** — `app/login/page.tsx:44`, inside the teal brand panel. Avatar +
   welcome cloud, alongside the existing `Sprout` mark.
2. **Boot / loading** — `app/dashboard/page.tsx:501`. The bare spinner becomes
   avatar + "Getting things ready…" cloud.
3. **Empty state** — `app/dashboard/page.tsx:557`. Avatar greets next to the
   existing "Namaste, {name}" heading.
4. **Every assistant reply** — the message map around line 600. Avatar bust to
   the left of assistant messages; the message becomes the reply cloud with a
   tail. This is the main visual change, and the primary place the avatar
   "appears near the reply box" and animates while the reply is being read.
5. **Thinking indicator** — replaces the current `Loader2 + t("dashboard.thinking")`
   line with avatar + animated-dots cloud.

### CRITICAL — treat the message JSX as append-only

The assistant-message block (~line 600-645) contains the **replay-on-device
button** and **citation chips**, both landed in the last few commits
(`e4e9077`, `6407798`). WRAP that JSX; do not rewrite or re-indent it. The
replay button's `replayingId` / `replayedId` logic and the citation
`DICTS[lang].citations[...]` lookup must come through byte-identical.

---

## Variant switcher (test-only)

`components/avatar/switcher.tsx`, mounted in the dashboard header next to
`LanguageSwitcher`. Persists to `localStorage` via `lib/avatar-context.tsx`.

Mark it clearly in a comment as **test-only scaffolding to be removed once a
variant is chosen** — it should not ship to a real government deployment.

Default variant: `sprout`.

---

## i18n — non-negotiable in this codebase

Add an `avatar:` section to `lib/i18n/en.ts` (the source-of-truth file), then
propagate the SAME keys to **all 9 language files** (`hi, mr, ta, te, bn, gu,
kn, pa`). There is a generator at `scripts/generate-translations.mjs`.

Keys needed:

```
avatar.welcome        "Namaste! I'm here to help."
avatar.gettingReady   "Getting things ready…"
avatar.thinking       "Let me look that up…"
avatar.listening      "I'm listening…"
avatar.chooseGuide    "Choose your guide"
avatar.name.sprout    "Sahakar Mitra"
avatar.name.robot     "Seva"
avatar.name.human     "Mitra Didi"
avatar.name.lotus     "Kamal"
```

`t()` already falls back to English for missing keys, but ship all 9 anyway —
a half-translated UI is exactly the kind of thing a demo audience notices.

---

## Accessibility (govt-portal requirements)

- **`prefers-reduced-motion: reduce` → all animation off.** Legally relevant
  for a government site, not optional.
- `aria-hidden="true"` on the decorative avatar SVG; the reply-cloud text stays
  in normal reading order and is unchanged for screen readers.
- The avatar is **purely additive** — never replace text with imagery. Every
  string currently on screen must still be on screen.
- Animate with CSS `transform` / `opacity` only. Do not touch the audio path,
  the ESP32 realtime channel, or anything in `speak()` / `speakWithBrowser()`
  beyond attaching the listeners that set and clear `deliveringId`. The avatar
  must never produce, delay, or suppress audio — if every avatar file were
  deleted, voice output must behave exactly as it does today.

---

## Static-export constraint

`next.config.mjs` sets `output: "export"`. Therefore:

- **No runtime calls to `api.dicebear.com`.** Everything renders offline from
  local packages or committed SVG.
- No server components, no route handlers, no `next/image` optimization.
- All four variants must work with JS-generated-at-build or inline SVG only.

---

## Deploy to cglachatbot1.netlify.app

`netlify.toml` is already correct (`npm run build` → publish `out`).

- **There is no git remote configured** (`git remote -v` is empty), so this is
  a manual CLI deploy: `netlify deploy --prod --dir=out`.
- Netlify env must have `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, or login fails silently on the deployed
  site with no console error that points at the cause.
- Verify `npm run build` passes locally before deploying.

---

## Definition of done

- [ ] Step 0 checkpoint commit exists, SHA recorded
- [ ] All 4 variants render in all 4 states
- [ ] Switcher swaps them live, choice persists across reload
- [ ] Avatar animates beside a reply until TTS finishes (Sarvam path)
- [ ] Same when the browser `speechSynthesis` fallback reads it
- [ ] Muted / no-audio turn still animates on the reading-time estimate,
      then settles to `idle` — never animates forever
- [ ] A second question mid-animation cancels the first cleanly
- [ ] Replay button + citation chips still work, untouched
- [ ] Voice output unchanged: ESP32-origin turns still play on the device
      only, laptop stays silent
- [ ] All 9 language files have the `avatar` keys
- [ ] `prefers-reduced-motion` verified with the OS setting on
- [ ] `npm run build` passes (static export, no API calls at runtime)
- [ ] Deployed and compared on cglachatbot1.netlify.app
