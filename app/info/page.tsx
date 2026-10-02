import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sahakar Saathi — Field Guide",
  description:
    "Plain-language walkthrough of the whole system — hardware pins, the voice round trip, and the AI pipeline.",
};

// Static reference page for the team (pins, architecture, AI pipeline).
// No auth, no client state -- a plain server component so it always
// renders even if JS fails to load, and stays reachable at a stable URL
// (cglachatbot.netlify.app/info) independent of login status.
//
// Content is authored as raw HTML/SVG strings (not JSX) because large
// hand-built diagrams are far less error-prone to write and edit as
// plain markup than as JSX (no class->className / attribute-casing /
// self-closing-tag conversion to get wrong). Every custom class is
// scoped under the single .field-guide wrapper so nothing here can
// collide with Tailwind utility classes used elsewhere in the app.

const STYLES = `
.field-guide{
  --bg:#F7F5F1; --bg-raised:#FFFFFF; --bg-sunken:#EFEBE3;
  --ink:#1D2024; --ink-soft:#4B4F45; --ink-faint:#7A7D71;
  --line:#DAD4C6; --line-soft:#E7E2D5;
  --accent:#2F6B4F; --accent-ink:#FFFFFF; --accent-soft:#E4EEE7; --accent-soft-ink:#1F4E39;
  --warn:#B5651D; --warn-soft:#FBEAD9; --warn-soft-ink:#7A430F;
  --pin-io:#2F6B4F; --pin-power:#B5651D; --pin-gnd:#4B4F45;
  --code-bg:#EFEAE0; --code-ink:#3A3D33;
  --shadow: 0 1px 2px rgba(29,32,36,.04), 0 6px 20px -8px rgba(29,32,36,.12);
  background:var(--bg); color:var(--ink);
  font-family:"Source Sans 3", ui-sans-serif, system-ui, sans-serif;
  font-size:16px; line-height:1.6;
  min-height:100vh;
}
@media (prefers-color-scheme: dark){
  .field-guide:not([data-theme="light"]){
    --bg:#15181C; --bg-raised:#1C2024; --bg-sunken:#101316;
    --ink:#E7E5E0; --ink-soft:#B7B9AE; --ink-faint:#7D8177;
    --line:#31352F; --line-soft:#282C27;
    --accent:#5FA787; --accent-ink:#0D1712; --accent-soft:#1E2E26; --accent-soft-ink:#8FC7AB;
    --warn:#D98A45; --warn-soft:#33251A; --warn-soft-ink:#EBB27D;
    --pin-io:#5FA787; --pin-power:#D98A45; --pin-gnd:#9CA090;
    --code-bg:#20241F; --code-ink:#C9CDBF;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 10px 28px -10px rgba(0,0,0,.5);
  }
}
.field-guide[data-theme="dark"]{
  --bg:#15181C; --bg-raised:#1C2024; --bg-sunken:#101316;
  --ink:#E7E5E0; --ink-soft:#B7B9AE; --ink-faint:#7D8177;
  --line:#31352F; --line-soft:#282C27;
  --accent:#5FA787; --accent-ink:#0D1712; --accent-soft:#1E2E26; --accent-soft-ink:#8FC7AB;
  --warn:#D98A45; --warn-soft:#33251A; --warn-soft-ink:#EBB27D;
  --pin-io:#5FA787; --pin-power:#D98A45; --pin-gnd:#9CA090;
  --code-bg:#20241F; --code-ink:#C9CDBF;
  --shadow: 0 1px 2px rgba(0,0,0,.3), 0 10px 28px -10px rgba(0,0,0,.5);
}

.field-guide *{box-sizing:border-box;}
.field-guide h1,.field-guide h2,.field-guide h3,.field-guide h4{font-family:"Fraunces", Georgia, serif; text-wrap:balance; color:var(--ink); margin:0;}
.field-guide code, .field-guide .mono{font-family:"JetBrains Mono", ui-monospace, monospace;}
.field-guide a{color:var(--accent);}

/* ---------- Top bar ---------- */
.field-guide .topbar{
  display:flex; align-items:baseline; justify-content:space-between; gap:16px;
  padding:22px 28px; max-width:1180px; margin:0 auto;
  border-bottom:1px solid var(--line);
}
.field-guide .brand{display:flex; align-items:baseline; gap:10px;}
.field-guide .brand-mark{
  font-family:"Fraunces", serif; font-weight:600; font-size:1.05rem;
  color:var(--accent-ink); background:var(--accent);
  padding:3px 9px; border-radius:5px; letter-spacing:.02em;
}
.field-guide .brand-name{font-family:"Fraunces", serif; font-weight:600; font-size:1.15rem;}
.field-guide .brand-sub{color:var(--ink-faint); font-size:.82rem;}
.field-guide .topbar-right{font-size:.78rem; color:var(--ink-faint); text-align:right; line-height:1.5;}

/* ---------- Layout: side nav + content ---------- */
.field-guide .layout{display:grid; grid-template-columns:220px 1fr; gap:48px; max-width:1180px; margin:0 auto; padding:0 28px;}
@media (max-width:900px){ .field-guide .layout{grid-template-columns:1fr;} .field-guide .side-nav{display:none;} }

.field-guide .side-nav{position:sticky; top:28px; align-self:start; padding-top:40px; font-size:.86rem;}
.field-guide .side-nav .nav-label{color:var(--ink-faint); font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; margin-bottom:10px; font-weight:600;}
.field-guide .side-nav ol{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; counter-reset:navsec;}
.field-guide .side-nav li{counter-increment:navsec;}
.field-guide .side-nav a{
  display:flex; gap:8px; padding:7px 10px; border-radius:6px; color:var(--ink-soft);
  text-decoration:none; border-left:2px solid transparent;
}
.field-guide .side-nav a::before{content:counter(navsec,decimal-leading-zero); color:var(--ink-faint); font-family:"JetBrains Mono",monospace; font-size:.72rem; padding-top:1px;}
.field-guide .side-nav a:hover{background:var(--bg-sunken); color:var(--ink);}

.field-guide main{padding-top:40px; min-width:0;}

/* ---------- Sections ---------- */
.field-guide section{padding-bottom:64px; border-bottom:1px solid var(--line-soft); margin-bottom:64px; scroll-margin-top:24px;}
.field-guide section:last-child{border-bottom:none;}
.field-guide .sec-head{display:flex; align-items:baseline; gap:14px; margin-bottom:8px;}
.field-guide .sec-num{font-family:"JetBrains Mono",monospace; color:var(--accent); font-size:1rem; font-weight:600;}
.field-guide .sec-title{font-size:1.7rem; font-weight:600;}
.field-guide .sec-dek{color:var(--ink-soft); font-size:1rem; max-width:62ch; margin:10px 0 28px;}

.field-guide p{max-width:68ch; color:var(--ink-soft);}
.field-guide p.lead{color:var(--ink); font-size:1.05rem;}
.field-guide strong{color:var(--ink); font-weight:600;}

/* ---------- Callouts ---------- */
.field-guide .callout{
  display:flex; gap:14px; padding:16px 18px; border-radius:10px; margin:20px 0;
  border:1px solid var(--line); background:var(--bg-raised); box-shadow:var(--shadow);
}
.field-guide .callout.warn{background:var(--warn-soft); border-color:transparent;}
.field-guide .callout .icon{font-family:"JetBrains Mono",monospace; font-weight:700; font-size:.72rem; letter-spacing:.05em;
  color:var(--warn-soft-ink); background:transparent; border:1.5px solid var(--warn-soft-ink); border-radius:5px;
  padding:3px 7px; height:fit-content; white-space:nowrap; text-transform:uppercase;}
.field-guide .callout p{margin:0; max-width:none; color:var(--warn-soft-ink); font-size:.92rem;}
.field-guide .callout p strong{color:var(--warn-soft-ink);}

/* ---------- Diagram: signal path ---------- */
.field-guide .signal-path{
  display:grid; grid-template-columns:1fr auto 1fr auto 1fr; align-items:center;
  gap:0; margin:8px 0 32px; padding:26px 20px; background:var(--bg-raised); border:1px solid var(--line);
  border-radius:14px; box-shadow:var(--shadow);
}
.field-guide .sp-node{text-align:center; padding:0 10px;}
.field-guide .sp-icon{font-size:1.6rem; margin-bottom:6px;}
.field-guide .sp-node .sp-title{font-weight:600; font-size:.95rem;}
.field-guide .sp-node .sp-sub{color:var(--ink-faint); font-size:.76rem; margin-top:2px;}
.field-guide .sp-arrow{display:flex; flex-direction:column; align-items:center; color:var(--ink-faint); padding:0 6px;}
.field-guide .sp-arrow .sp-line{width:100%; height:1.5px; background:var(--line); position:relative; min-width:36px;}
.field-guide .sp-arrow .sp-line::after{content:"›"; position:absolute; right:-3px; top:50%; transform:translateY(-52%); color:var(--accent); font-size:1.1rem; font-weight:700;}
.field-guide .sp-arrow .cap{font-size:.68rem; margin-top:6px; color:var(--ink-faint); white-space:nowrap;}
@media (max-width:760px){
  .field-guide .signal-path{grid-template-columns:1fr; gap:14px;}
  .field-guide .sp-arrow{flex-direction:row; justify-content:center;}
  .field-guide .sp-arrow .sp-line{height:24px; width:1.5px;}
  .field-guide .sp-arrow .sp-line::after{content:"⌄"; right:auto; left:50%; top:auto; bottom:-4px; transform:translateX(-50%);}
}

/* ---------- Pin table ---------- */
.field-guide .pin-table-wrap{overflow-x:auto; border:1px solid var(--line); border-radius:12px; box-shadow:var(--shadow); background:var(--bg-raised);}
.field-guide table{width:100%; border-collapse:collapse; font-size:.9rem;}
.field-guide thead th{
  text-align:left; font-family:"Source Sans 3",sans-serif; text-transform:uppercase; letter-spacing:.06em;
  font-size:.7rem; color:var(--ink-faint); font-weight:600; padding:12px 16px; border-bottom:1px solid var(--line);
  background:var(--bg-sunken);
}
.field-guide tbody td{padding:12px 16px; border-bottom:1px solid var(--line-soft); vertical-align:top; color:var(--ink-soft);}
.field-guide tbody tr:last-child td{border-bottom:none;}
.field-guide tbody td strong{color:var(--ink);}
.field-guide .pin-chip{
  display:inline-flex; align-items:center; gap:5px; font-family:"JetBrains Mono",monospace; font-weight:700;
  font-size:.82rem; padding:3px 9px; border-radius:5px; white-space:nowrap;
}
.field-guide .pin-chip.io{background:var(--accent-soft); color:var(--accent-soft-ink);}
.field-guide .pin-chip.pwr{background:var(--warn-soft); color:var(--warn-soft-ink);}
.field-guide .pin-chip.gnd{background:var(--bg-sunken); color:var(--ink-soft); border:1px solid var(--line);}
.field-guide .shared-badge{
  display:inline-block; margin-left:6px; font-size:.66rem; text-transform:uppercase; letter-spacing:.04em;
  color:var(--warn-soft-ink); background:var(--warn-soft); padding:1px 6px; border-radius:4px; font-weight:700;
}

/* ---------- Wiring diagram ---------- */
.field-guide .wiring{
  background:var(--bg-raised); border:1px solid var(--line); border-radius:14px; padding:28px;
  box-shadow:var(--shadow); overflow-x:auto;
}
.field-guide .wiring svg{display:block; margin:0 auto; min-width:640px;}

/* ---------- Pipeline (numbered, real sequence) ---------- */
.field-guide .pipeline{display:flex; flex-direction:column; gap:0; margin-top:8px;}
.field-guide .step{
  display:grid; grid-template-columns:44px 1fr; gap:18px; padding:20px 0; position:relative;
}
.field-guide .step:not(:last-child)::after{
  content:""; position:absolute; left:21px; top:56px; bottom:-8px; width:1.5px; background:var(--line);
}
.field-guide .step-num{
  width:44px; height:44px; border-radius:50%; background:var(--bg-sunken); border:1.5px solid var(--line);
  display:flex; align-items:center; justify-content:center; font-family:"JetBrains Mono",monospace;
  font-weight:700; color:var(--accent); font-size:.95rem; z-index:1;
}
.field-guide .step-body{padding-top:4px;}
.field-guide .step-title{font-weight:600; font-size:1.02rem; margin-bottom:4px;}
.field-guide .step-fn{
  display:inline-block; font-family:"JetBrains Mono",monospace; font-size:.72rem; font-weight:600;
  background:var(--accent-soft); color:var(--accent-soft-ink); padding:2px 8px; border-radius:5px; margin-left:8px;
  vertical-align:middle;
}
.field-guide .step p{margin:6px 0 0; font-size:.92rem; max-width:64ch;}

/* ---------- Function ledger ---------- */
.field-guide .fn-grid{display:grid; grid-template-columns:1fr; gap:1px; background:var(--line); border:1px solid var(--line); border-radius:12px; overflow:hidden; box-shadow:var(--shadow);}
.field-guide .fn-row{display:grid; grid-template-columns:190px 1fr; gap:16px; background:var(--bg-raised); padding:14px 18px;}
.field-guide .fn-row .fn-name{color:var(--accent-soft-ink); background:var(--accent-soft); display:inline-block; padding:3px 9px; border-radius:5px; font-size:.8rem; font-weight:700; height:fit-content;}
.field-guide .fn-row p{margin:0; font-size:.88rem; color:var(--ink-soft); max-width:none;}
@media (max-width:640px){ .field-guide .fn-row{grid-template-columns:1fr;} }

/* ---------- Language flow ---------- */
.field-guide .lang-hub{
  display:grid; grid-template-columns:220px 1fr; gap:28px; align-items:center;
  background:var(--bg-raised); border:1px solid var(--line); border-radius:14px; padding:28px; box-shadow:var(--shadow);
}
.field-guide .lang-source{text-align:center;}
.field-guide .lang-source .dot{
  width:96px; height:96px; border-radius:50%; background:var(--accent); color:var(--accent-ink);
  display:flex; align-items:center; justify-content:center; margin:0 auto 10px; font-family:"Fraunces",serif;
  font-weight:600; font-size:.85rem; line-height:1.25; padding:8px; text-align:center; box-shadow:var(--shadow);
}
.field-guide .lang-source .cap{font-size:.78rem; color:var(--ink-faint); max-width:20ch; margin:0 auto;}
.field-guide .lang-targets{display:grid; grid-template-columns:1fr 1fr; gap:12px;}
.field-guide .lang-target{border:1px solid var(--line); border-radius:10px; padding:12px 14px; background:var(--bg-sunken);}
.field-guide .lang-target .t-title{font-weight:600; font-size:.88rem;}
.field-guide .lang-target .t-sub{font-size:.78rem; color:var(--ink-faint); margin-top:2px;}
@media (max-width:640px){ .field-guide .lang-hub{grid-template-columns:1fr;} .field-guide .lang-targets{grid-template-columns:1fr;} }

.field-guide .chip-row{display:flex; flex-wrap:wrap; gap:8px; margin-top:14px;}
.field-guide .lang-chip{
  font-family:"JetBrains Mono",monospace; font-size:.78rem; font-weight:600; padding:5px 11px; border-radius:20px;
  background:var(--bg-sunken); border:1px solid var(--line); color:var(--ink-soft);
}
.field-guide .lang-chip b{color:var(--ink); font-family:"Source Sans 3",sans-serif; font-weight:600; margin-left:5px;}

/* ---------- Data table (schema) ---------- */
.field-guide .schema-note{font-size:.82rem; color:var(--ink-faint); margin-top:10px;}

/* ---------- Stack grid ---------- */
.field-guide .stack-grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:14px; margin-top:8px;}
.field-guide .stack-card{
  background:var(--bg-raised); border:1px solid var(--line); border-radius:12px; padding:18px; box-shadow:var(--shadow);
}
.field-guide .stack-card .s-eyebrow{font-size:.7rem; text-transform:uppercase; letter-spacing:.07em; color:var(--accent); font-weight:700; margin-bottom:8px;}
.field-guide .stack-card .s-title{font-weight:600; font-size:1rem; margin-bottom:6px;}
.field-guide .stack-card p{font-size:.86rem; margin:0; max-width:none;}

/* ---------- Q&A ---------- */
.field-guide .qa{background:var(--bg-raised); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:12px; box-shadow:var(--shadow);}
.field-guide .qa .q{font-weight:600; color:var(--ink); margin-bottom:6px; display:flex; gap:8px;}
.field-guide .qa .q::before{content:"Q"; font-family:"JetBrains Mono",monospace; color:var(--accent); font-weight:700;}
.field-guide .qa .a{font-size:.92rem; color:var(--ink-soft); margin:0; max-width:none; padding-left:20px;}

.field-guide footer{max-width:1180px; margin:0 auto; padding:32px 28px 60px; color:var(--ink-faint); font-size:.8rem;}
`;

const OVERVIEW = `
<section id="overview">
  <div class="sec-head"><span class="sec-num">01</span><h2 class="sec-title">The big picture</h2></div>
  <p class="sec-dek">A cooperative-society member touches a small speaker box, asks a question out loud in their own language, and hears a spoken answer back — grounded in real Ministry of Cooperation rules, not guesswork.</p>

  <div class="signal-path">
    <div class="sp-node"><div class="sp-icon">🖐️</div><div class="sp-title">ESP32 device</div><div class="sp-sub">touch, mic, speaker</div></div>
    <div class="sp-arrow"><div class="sp-line"></div><div class="cap">home / venue WiFi</div></div>
    <div class="sp-node"><div class="sp-icon">☁️</div><div class="sp-title">Supabase cloud</div><div class="sp-sub">database · functions · realtime</div></div>
    <div class="sp-arrow"><div class="sp-line"></div><div class="cap">internet, anywhere</div></div>
    <div class="sp-node"><div class="sp-icon">💻</div><div class="sp-title">Browser dashboard</div><div class="sp-sub">one logged-in account</div></div>
  </div>

  <p class="lead">Three things carry the whole demo:</p>
  <p><strong>1. The device never talks to the browser directly.</strong> Everything routes through the cloud, so the box and the laptop don't even need to be on the same network — they just both need internet.</p>
  <p><strong>2. The AI doesn't invent answers.</strong> It first searches a small library of real scheme documents for relevant passages, then writes its reply grounded in what it found — and says "I'm not sure, ask your PACS" when nothing relevant exists.</p>
  <p><strong>3. One language setting controls everything at once</strong> — the screen text, what the AI writes back, and what the speaker says out loud. Change it once, the whole experience switches.</p>
</section>`;

const STACK = `
<section id="stack">
  <div class="sec-head"><span class="sec-num">02</span><h2 class="sec-title">The stack, at a glance</h2></div>

  <div class="stack-grid">
    <div class="stack-card"><div class="s-eyebrow">Frontend</div><div class="s-title">Next.js + React</div><p>The browser dashboard everyone sees, styled with Tailwind CSS.</p></div>
    <div class="stack-card"><div class="s-eyebrow">Backend</div><div class="s-title">Supabase</div><p>Database, login, live broadcast channels, file storage, and the 8 cloud functions — all in one platform.</p></div>
    <div class="stack-card"><div class="s-eyebrow">Understanding &amp; writing</div><div class="s-title">Google Gemini</div><p>Turns text into meaning-fingerprints for search, and writes the actual replies.</p></div>
    <div class="stack-card"><div class="s-eyebrow">Speaking &amp; listening</div><div class="s-title">Sarvam AI</div><p>An Indic-language specialist — converts speech to text and text to speech in all 9 supported languages.</p></div>
    <div class="stack-card"><div class="s-eyebrow">Hardware</div><div class="s-title">ESP32-C3</div><p>Touch sensor, digital microphone, and amplifier + speaker — the physical terminal.</p></div>
    <div class="stack-card"><div class="s-eyebrow">Fallback</div><div class="s-title">Web Speech API</div><p>If Sarvam is unavailable, the browser's own built-in voice features quietly take over so the demo never breaks.</p></div>
  </div>
</section>`;

const HARDWARE = `
<section id="hardware">
  <div class="sec-head"><span class="sec-num">03</span><h2 class="sec-title">Hardware &amp; pin breakdown</h2></div>
  <p class="sec-dek">One ESP32-C3 board, three components. The clever part: the microphone and the speaker <em>share</em> two pins on purpose.</p>

  <div class="wiring">
    <svg viewBox="0 0 900 360" role="img" aria-label="Wiring diagram of ESP32-C3 with TTP223 touch sensor, INMP441 microphone and MAX98357A amplifier">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--ink-faint)"></path>
        </marker>
      </defs>
      <rect x="370" y="120" width="160" height="120" rx="10" fill="var(--bg-sunken)" stroke="var(--line)" stroke-width="1.5"></rect>
      <text x="450" y="172" text-anchor="middle" font-family="Fraunces, serif" font-weight="600" font-size="17" fill="var(--ink)">ESP32-C3</text>
      <text x="450" y="192" text-anchor="middle" font-family="Source Sans 3, sans-serif" font-size="11" fill="var(--ink-faint)">Dev Module</text>

      <rect x="60" y="24" width="180" height="90" rx="10" fill="var(--bg-raised)" stroke="var(--line)" stroke-width="1.5"></rect>
      <text x="150" y="52" text-anchor="middle" font-family="Fraunces, serif" font-weight="600" font-size="15" fill="var(--ink)">TTP223</text>
      <text x="150" y="69" text-anchor="middle" font-family="Source Sans 3, sans-serif" font-size="11" fill="var(--ink-faint)">touch sensor</text>
      <text x="150" y="88" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="11" font-weight="700" fill="var(--pin-io)">OUT → GPIO3</text>
      <line x1="240" y1="69" x2="368" y2="145" stroke="var(--pin-io)" stroke-width="1.75" marker-end="url(#arrow)"></line>

      <rect x="60" y="140" width="200" height="120" rx="10" fill="var(--bg-raised)" stroke="var(--line)" stroke-width="1.5"></rect>
      <text x="160" y="168" text-anchor="middle" font-family="Fraunces, serif" font-weight="600" font-size="15" fill="var(--ink)">INMP441</text>
      <text x="160" y="185" text-anchor="middle" font-family="Source Sans 3, sans-serif" font-size="11" fill="var(--ink-faint)">I2S microphone</text>
      <text x="160" y="207" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="700" fill="var(--pin-io)">SCK → GPIO4</text>
      <text x="160" y="223" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="700" fill="var(--pin-io)">WS  → GPIO5</text>
      <text x="160" y="239" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="700" fill="var(--pin-io)">SD  → GPIO6</text>
      <line x1="260" y1="200" x2="368" y2="188" stroke="var(--pin-io)" stroke-width="1.75" marker-end="url(#arrow)"></line>

      <rect x="660" y="140" width="200" height="120" rx="10" fill="var(--bg-raised)" stroke="var(--line)" stroke-width="1.5"></rect>
      <text x="760" y="168" text-anchor="middle" font-family="Fraunces, serif" font-weight="600" font-size="15" fill="var(--ink)">MAX98357A</text>
      <text x="760" y="185" text-anchor="middle" font-family="Source Sans 3, sans-serif" font-size="11" fill="var(--ink-faint)">I2S amplifier</text>
      <text x="760" y="207" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="700" fill="var(--pin-io)">BCLK → GPIO4</text>
      <text x="760" y="223" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="700" fill="var(--pin-io)">LRC  → GPIO5</text>
      <text x="760" y="239" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="700" fill="var(--pin-io)">DIN  → GPIO7</text>
      <line x1="660" y1="200" x2="532" y2="188" stroke="var(--pin-io)" stroke-width="1.75" marker-end="url(#arrow)"></line>

      <rect x="700" y="290" width="120" height="54" rx="10" fill="var(--bg-sunken)" stroke="var(--line)" stroke-width="1.5"></rect>
      <text x="760" y="313" text-anchor="middle" font-family="Fraunces, serif" font-weight="600" font-size="13" fill="var(--ink)">Speaker</text>
      <text x="760" y="330" text-anchor="middle" font-family="Source Sans 3, sans-serif" font-size="10" fill="var(--ink-faint)">SPK+ / SPK−</text>
      <line x1="760" y1="260" x2="760" y2="288" stroke="var(--ink-faint)" stroke-width="1.5" marker-end="url(#arrow)"></line>

      <text x="450" y="278" text-anchor="middle" font-family="Source Sans 3, sans-serif" font-size="12" fill="var(--warn-soft-ink)" font-weight="600">GPIO4 + GPIO5 are shared between mic and amp</text>
      <text x="450" y="296" text-anchor="middle" font-family="Source Sans 3, sans-serif" font-size="11" fill="var(--ink-faint)">safe because the device only ever listens OR speaks, never both</text>
    </svg>
  </div>

  <div class="callout" style="margin-top:24px;">
    <span class="icon">Why it works</span>
    <p><strong>Push-to-talk = half-duplex.</strong> The board is never listening and speaking at the same time, so GPIO4 (clock) and GPIO5 (word-select) are wired once and just get reassigned in software — record mode configures them for the microphone, playback mode tears that down and reconfigures the exact same two pins for the amplifier.</p>
  </div>

  <div class="pin-table-wrap" style="margin-top:20px;">
    <table>
      <thead><tr><th>GPIO</th><th>Wired to</th><th>Signal</th><th>Role</th></tr></thead>
      <tbody>
        <tr><td><span class="pin-chip io">GPIO3</span></td><td><strong>TTP223</strong> touch sensor — OUT</td><td>Digital in, HIGH = touched</td><td>The push-to-talk button. Held down while speaking; a plain quick tap is reserved for the 5-tap WiFi-setup gesture.</td></tr>
        <tr><td><span class="pin-chip io">GPIO4</span> <span class="shared-badge">shared</span></td><td><strong>INMP441</strong> SCK <em>or</em> <strong>MAX98357A</strong> BCLK</td><td>I2S bit clock</td><td>Paces every audio bit in or out, one way at a time.</td></tr>
        <tr><td><span class="pin-chip io">GPIO5</span> <span class="shared-badge">shared</span></td><td><strong>INMP441</strong> WS <em>or</em> <strong>MAX98357A</strong> LRC</td><td>I2S word-select</td><td>Marks left/right sample boundaries for whichever chip is active.</td></tr>
        <tr><td><span class="pin-chip io">GPIO6</span></td><td><strong>INMP441</strong> SD</td><td>Digital in</td><td>The raw microphone audio data, one direction only — into the board.</td></tr>
        <tr><td><span class="pin-chip io">GPIO7</span></td><td><strong>MAX98357A</strong> DIN</td><td>Digital out</td><td>The reply audio data, one direction only — out to the amplifier.</td></tr>
        <tr><td><span class="pin-chip pwr">3.3V</span></td><td>TTP223 VCC · INMP441 VDD</td><td>Power</td><td>Both small chips run on the board's 3.3V rail.</td></tr>
        <tr><td><span class="pin-chip pwr">5V / VBUS</span></td><td>MAX98357A VIN</td><td>Power</td><td>The amplifier needs 5V to drive the speaker with real volume.</td></tr>
        <tr><td><span class="pin-chip gnd">GND</span></td><td>All three modules</td><td>Ground</td><td>Common ground shared by every component, including the INMP441's L/R pin, which is tied to GND to select its left audio channel.</td></tr>
      </tbody>
    </table>
  </div>
  <p class="schema-note">Source: <code>esp32-firmware/voice_terminal.ino</code>, header comment and <code>#define PIN_*</code> block.</p>
</section>`;

const ROUNDTRIP = `
<section id="roundtrip">
  <div class="sec-head"><span class="sec-num">04</span><h2 class="sec-title">One voice round trip, start to finish</h2></div>
  <p class="sec-dek">Narrate this during the demo — it's the exact order of events between a touch and a spoken answer.</p>

  <div class="pipeline">
    <div class="step"><div class="step-num">1</div><div class="step-body"><div class="step-title">Touch and speak</div>
    <p>Holding the TTP223 starts recording. Audio streams straight to the board's flash storage as a WAV file — not held in memory — because nobody knows in advance how long someone will talk.</p></div></div>

    <div class="step"><div class="step-num">2</div><div class="step-body"><div class="step-title">Release to stop</div>
    <p>Letting go finalizes the WAV file and immediately starts uploading it over WiFi.</p></div></div>

    <div class="step"><div class="step-num">3</div><div class="step-body"><div class="step-title">Speech becomes text</div><span class="step-fn">voice-upload</span>
    <p>The recording is sent to <strong>Sarvam AI's speech-to-text model</strong>, which turns the spoken words into a plain text sentence.</p></div></div>

    <div class="step"><div class="step-num">4</div><div class="step-body"><div class="step-title">Text reaches the browser</div>
    <p>The transcript is broadcast on a live cloud channel. The dashboard tab that's logged into the paired account receives it instantly, as if it had been typed by hand.</p></div></div>

    <div class="step"><div class="step-num">5</div><div class="step-body"><div class="step-title">The AI answers</div><span class="step-fn">chat</span>
    <p>The question is checked against a small library of real scheme documents, then Gemini writes a short, grounded reply — see section 06 for exactly how.</p></div></div>

    <div class="step"><div class="step-num">6</div><div class="step-body"><div class="step-title">Text becomes speech</div><span class="step-fn">speak</span>
    <p><strong>Sarvam AI's text-to-speech model</strong> reads the reply aloud in the selected language and hands back a ready-to-play audio file.</p></div></div>

    <div class="step"><div class="step-num">7</div><div class="step-body"><div class="step-title">The clip waits its turn</div><span class="step-fn">voice-output</span>
    <p>Because this turn came from the physical device, the laptop stays silent — the clip is queued in the cloud specifically for the hardware to collect.</p></div></div>

    <div class="step"><div class="step-num">8</div><div class="step-body"><div class="step-title">The device asks for it</div><span class="step-fn">voice-fetch</span>
    <p>The board has been periodically checking "anything for me?" since it finished uploading. It downloads the clip, and the clip is marked delivered so it's never played twice.</p></div></div>

    <div class="step"><div class="step-num">9</div><div class="step-body"><div class="step-title">Reply plays out loud</div>
    <p>Audio streams straight into the speaker as it arrives — never saved to the board's storage first — so a long reply is never limited by how much flash space is free.</p></div></div>
  </div>
</section>`;

const FUNCTIONS = `
<section id="functions">
  <div class="sec-head"><span class="sec-num">05</span><h2 class="sec-title">The 8 cloud functions, one job each</h2></div>
  <p class="sec-dek">Every step above is handled by a small, single-purpose piece of backend code. None of them do more than the one thing named here.</p>

  <div class="fn-grid">
    <div class="fn-row"><span class="fn-name">trigger-mic</span><p>Lets the touch button remotely start/stop the <em>browser's own</em> microphone — a second control path for when someone's sitting at the laptop.</p></div>
    <div class="fn-row"><span class="fn-name">voice-upload</span><p>Receives the device's recording, transcribes it with Sarvam, and broadcasts the text to the browser.</p></div>
    <div class="fn-row"><span class="fn-name">chat</span><p>Searches the knowledge base, asks Gemini, returns a grounded reply, and saves the conversation.</p></div>
    <div class="fn-row"><span class="fn-name">speak</span><p>Turns a text reply into a spoken audio clip via Sarvam text-to-speech.</p></div>
    <div class="fn-row"><span class="fn-name">voice-output</span><p>Queues that audio clip specifically for the physical device to pick up.</p></div>
    <div class="fn-row"><span class="fn-name">voice-fetch</span><p>Lets the device poll for, download, and mark-as-delivered its next reply.</p></div>
    <div class="fn-row"><span class="fn-name">transcribe</span><p>Standalone speech-to-text for the browser's own on-screen mic button.</p></div>
    <div class="fn-row"><span class="fn-name">ingest</span><p>Admin-only tool that adds a new document to the knowledge base — splits it into chunks and embeds each one.</p></div>
  </div>
</section>`;

const AI = `
<section id="ai">
  <div class="sec-head"><span class="sec-num">06</span><h2 class="sec-title">How the AI actually decides what to say</h2></div>
  <p class="sec-dek">This is <strong>RAG</strong> — Retrieval-Augmented Generation: look up relevant facts first, then write an answer grounded in what was found, instead of answering purely from memory.</p>

  <div class="callout warn">
    <span class="icon">Check before demo</span>
    <p><strong>The knowledge base starts empty.</strong> Nothing seeds it automatically — someone has to have already run the admin-only <code>ingest</code> tool to load real scheme documents into it. Confirm this has been done, or the AI will honestly say "I'm not sure" to everything instead of citing real sources.</p>
  </div>

  <div class="pipeline" style="margin-top:24px;">
    <div class="step"><div class="step-num">1</div><div class="step-body"><div class="step-title">The question becomes a fingerprint of meaning</div>
    <p>Google's <strong>gemini-embedding-001</strong> converts the question into a list of 768 numbers — a coordinate for its <em>meaning</em>, not its exact words. Two differently-worded questions that mean the same thing land near the same coordinate.</p></div></div>

    <div class="step"><div class="step-num">2</div><div class="step-body"><div class="step-title">The database finds the closest matches</div>
    <p><strong>pgvector</strong> — a search extension for the Postgres database — finds which stored document passages sit nearest that coordinate, and returns the top 5.</p></div></div>

    <div class="step"><div class="step-num">3</div><div class="step-body"><div class="step-title">Those passages become the AI's context</div>
    <p>The 5 passages are handed to Gemini as reference material, alongside strict instructions: ground the answer in this text, never invent scheme names or amounts, and if nothing relevant was found, say so plainly rather than guess.</p></div></div>

    <div class="step"><div class="step-num">4</div><div class="step-body"><div class="step-title">Gemini writes the reply</div>
    <p>Default model <strong>gemini-3.1-flash-lite</strong> generates a reply capped at 80 words / 3–4 sentences, in the selected language, simple enough for a rural user. If that model's free daily quota runs out, the system quietly retries with a backup model — the demo doesn't stop.</p></div></div>
  </div>
</section>`;

const LANGUAGE = `
<section id="language">
  <div class="sec-head"><span class="sec-num">07</span><h2 class="sec-title">One language setting, everywhere</h2></div>
  <p class="sec-dek">There used to be separate language pickers for the screen, the AI, and the voice. Now there's exactly one — change it once, everything follows.</p>

  <div class="lang-hub">
    <div class="lang-source">
      <div class="dot">Selected<br>Language</div>
      <div class="cap">saved to the account, so it follows you to any device</div>
    </div>
    <div class="lang-targets">
      <div class="lang-target"><div class="t-title">Screen text</div><div class="t-sub">every button, label, heading</div></div>
      <div class="lang-target"><div class="t-title">Speech-to-text</div><div class="t-sub">what the mic listens for</div></div>
      <div class="lang-target"><div class="t-title">AI's reply</div><div class="t-sub">Gemini writes in this language</div></div>
      <div class="lang-target"><div class="t-title">Text-to-speech</div><div class="t-sub">what the speaker says aloud</div></div>
    </div>
  </div>

  <p style="margin-top:20px;"><strong>9 languages supported:</strong></p>
  <div class="chip-row">
    <span class="lang-chip">en <b>English</b></span>
    <span class="lang-chip">hi <b>हिन्दी</b></span>
    <span class="lang-chip">mr <b>मराठी</b></span>
    <span class="lang-chip">ta <b>தமிழ்</b></span>
    <span class="lang-chip">te <b>తెలుగు</b></span>
    <span class="lang-chip">bn <b>বাংলা</b></span>
    <span class="lang-chip">gu <b>ગુજરાતી</b></span>
    <span class="lang-chip">kn <b>ಕನ್ನಡ</b></span>
    <span class="lang-chip">pa <b>ਪੰਜਾਬੀ</b></span>
  </div>
</section>`;

const ACCOUNTS = `
<section id="accounts">
  <div class="sec-head"><span class="sec-num">08</span><h2 class="sec-title">Login, and how the device is "paired"</h2></div>

  <p class="lead">Human login is ordinary — email and password through Supabase Auth. Accounts are set up ahead of time; there's no public sign-up page.</p>

  <p style="margin-top:20px;"><strong>The hardware doesn't log in at all.</strong> A microcontroller can't do a proper login flow, so instead:</p>

  <div class="callout">
    <span class="icon">In plain terms</span>
    <p>The device carries one shared secret key that proves "I'm a real device," and the server code has one specific account's ID <em>hardcoded</em> into it. Every message the device sends, and every reply it fetches, is routed to that one account — no matter where in the world that account happens to be logged in, because it's all cloud routing, not local WiFi discovery.</p>
  </div>

  <p style="margin-top:16px;">That's deliberate for this MVP stage — one demo device, one demo account, wired together directly in the code. A production version would let each physical device be linked to whichever account actually owns it, instead of one fixed ID.</p>
</section>`;

const DATA = `
<section id="data">
  <div class="sec-head"><span class="sec-num">09</span><h2 class="sec-title">What's stored, in one sentence each</h2></div>

  <div class="pin-table-wrap">
    <table>
      <thead><tr><th>Table</th><th>Holds</th></tr></thead>
      <tbody>
        <tr><td><strong>profiles</strong></td><td>One row per account — name, phone, preferred language, PACS details.</td></tr>
        <tr><td><strong>conversations</strong></td><td>One row per chat thread.</td></tr>
        <tr><td><strong>messages</strong></td><td>Every question and every reply, with which sources were cited.</td></tr>
        <tr><td><strong>kb_documents</strong></td><td>The title and source of each reference document loaded via <code>ingest</code>.</td></tr>
        <tr><td><strong>kb_chunks</strong></td><td>Each document split into small passages, with its 768-number meaning-fingerprint attached.</td></tr>
        <tr><td><strong>schemes</strong></td><td>5 real Ministry schemes shown as reference cards in the sidebar — separate from the AI's search.</td></tr>
        <tr><td><strong>grievances</strong></td><td>Complaint tickets a user has filed, with status and a ticket number.</td></tr>
        <tr><td><strong>device_audio_queue</strong></td><td>Reply clips waiting to be collected by the physical device.</td></tr>
        <tr><td><strong>device_voice_upload_sessions / _chunks</strong></td><td>An in-progress recording upload, sent in small pieces and reassembled.</td></tr>
      </tbody>
    </table>
  </div>
</section>`;

const DEMO = `
<section id="demo" style="border-bottom:none; margin-bottom:0;">
  <div class="sec-head"><span class="sec-num">10</span><h2 class="sec-title">Questions judges are likely to ask</h2></div>

  <div class="qa"><div class="q">Does it work if the device and the laptop are on different WiFi?</div><p class="a">Yes — everything routes through the cloud, so they never need to be on the same network, only both need internet.</p></div>
  <div class="qa"><div class="q">What stops the AI from making things up?</div><p class="a">It's instructed to only use the facts it retrieved, and to say "I'm not sure" and point to a real PACS officer when nothing relevant was found — rather than guess.</p></div>
  <div class="qa"><div class="q">What happens if the AI service hits a usage limit mid-demo?</div><p class="a">It automatically retries with a backup Gemini model — nothing visibly breaks.</p></div>
  <div class="qa"><div class="q">Could this support more than one physical device?</div><p class="a">The architecture allows it, but today one server-side ID is hardcoded to one demo account — a real rollout would pair each device to its owner dynamically.</p></div>
  <div class="qa"><div class="q">Why not just play the AI's answer directly through the laptop speakers?</div><p class="a">Because whoever's talking to the device often isn't sitting at the laptop — the reply is deliberately routed back to the physical terminal instead.</p></div>
</section>`;

const BODY = OVERVIEW + STACK + HARDWARE + ROUNDTRIP + FUNCTIONS + AI + LANGUAGE + ACCOUNTS + DATA + DEMO;

export default function InfoPage() {
  return (
    <div className="field-guide">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Source+Sans+3:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap"
      />

      <div className="topbar">
        <div className="brand">
          <span className="brand-mark">सह</span>
          <span className="brand-name">Sahakar Saathi</span>
          <span className="brand-sub">— field guide for the team</span>
        </div>
        <div className="topbar-right">SIH 2026 · Problem Statement 26088<br />Ministry of Cooperation / NCCT</div>
      </div>

      <div className="layout">
        <nav className="side-nav">
          <div className="nav-label">On this page</div>
          <ol>
            <li><a href="#overview">The big picture</a></li>
            <li><a href="#stack">The stack</a></li>
            <li><a href="#hardware">Hardware &amp; pins</a></li>
            <li><a href="#roundtrip">A voice round trip</a></li>
            <li><a href="#functions">The 8 functions</a></li>
            <li><a href="#ai">How the AI answers</a></li>
            <li><a href="#language">One language, everywhere</a></li>
            <li><a href="#accounts">Login &amp; pairing</a></li>
            <li><a href="#data">What&apos;s stored</a></li>
            <li><a href="#demo">Likely questions</a></li>
          </ol>
        </nav>

        <main dangerouslySetInnerHTML={{ __html: BODY }} />
      </div>

      <footer>Compiled from the project source for team prep — SIH 2026 Internal, Problem Statement 26088.</footer>
    </div>
  );
}
