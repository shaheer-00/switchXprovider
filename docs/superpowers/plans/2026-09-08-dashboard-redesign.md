# Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the switchXprovider dashboard (`public/index.html`) to a Linear/Vercel-grade dark design — new token system, shell, and component styling — with zero behavioral change.

**Architecture:** Approach C from the spec — build a fresh CSS token layer and app shell, keep every render function's logic, restyle each view's HTML templates against the new tokens in 6 verified passes. One file, no new dependencies, no server changes.

**Tech Stack:** Vanilla CSS (custom properties), vanilla JS (untouched except template class names + canvas color constants), system font stacks.

**Spec:** `docs/superpowers/specs/2026-09-08-dashboard-redesign-design.md`

## Global Constraints

- Single file: all changes inside `public/index.html` (README screenshots update is the only other file, Task 6).
- Zero external assets: no font CDN, no icon libraries. Icons stay inline SVG. Fonts are system stacks.
- All JS logic untouched: no changes to fetch calls, state handling, event delegation, wizard, share-card math. Only allowed JS edits: (a) class names inside template strings, (b) canvas color constants, (c) the `VIEWS` array order for keyboard shortcuts.
- `npm test` must pass (115 assertions) after every task — it doesn't touch CSS, so a failure means you broke JS.
- Browser verification after every task: every view clickable, zero console errors.
- No new features. No mobile work. Bubbles stay.
- Commit message style: `feat:`/`style:` prefix, one commit per task. **No AI attribution in commits. Confirm with the user before every commit.** Tag/release only at the very end (v0.3.0, decided with user).

## Verification protocol (every task)

The proxy runs at http://127.0.0.1:8787 with real data. After each task's edits:

1. Hard-reload the dashboard in a browser (Playwright MCP is set up and working).
2. Click through every nav view; confirm no console errors (`browser_console_messages` level=error must return 0).
3. Exercise one interaction relevant to the views touched by the task.
4. `npm test` → expect `115 passed, 0 failed`.

If any view is visually broken mid-task in a way that blocks the next task, stop and fix within the task — the plan's tasks each end on a fully-working dashboard.

## Current file landmarks (line numbers as of v0.2.4, will drift as tasks land)

```
7      <style> opens
757    </style>
759    <body>
776    <div class="app">  — .app > aside + main layout
785    <nav id="nav"> — 8 buttons, data-view attrs
821    .sidebottom — connection status, GitHub/coffee links
837    #view-overview … 1321 #view-events (9 view sections)
1350   #share popup
1448   <script> opens
3129   </script>
```

The JS render functions to know: `renderUsage` (usage view), `renderProviders`, `renderEvents`, `renderPricing`, `renderDiscover`, `renderWizard`, `drawShareCard`, `gotoView`. CSS is one block (lines 7–757); it gets fully replaced across Tasks 1–2, then extended per-task.

---

### Task 1: Token system + app shell

**Files:**
- Modify: `public/index.html` (CSS block lines 7–757 rewritten; `<body>`/`<aside>` skeleton lines 759–835 restructured)

**Interfaces:**
- Produces: the `:root` token set and shell class names (`.app`, `.aside`, `.navgroup`, `.navlbl`, `.viewhead`, `.view`, `.card`, `.sub`) that all later tasks style templates against. Produces nav button order matching the new `VIEWS` array.

- [ ] **Step 1: Replace the `:root` variables + base rules at the top of the `<style>` block**

Replace the existing `:root` and base-element rules with exactly:

```css
:root {
  --bg: #0a0a0c;
  --surface: #111114;
  --surface-2: #17171b;
  --border: #1f1f23;
  --text: #ececf1;
  --muted: #8e8e96;
  --dim: #5c5c64;
  --accent: #6e79f4;
  --accent-2: #22d3ee;
  --green: #34d399;
  --amber: #fbbf24;
  --red: #f87171;
  --mono: "JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace;
  --sans: Inter, -apple-system, "Segoe UI", system-ui, sans-serif;
  --r-sm: 6px; --r-md: 8px; --r-lg: 10px;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-6: 24px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { color-scheme: dark; }
body {
  background: var(--bg);
  color: var(--text);
  font: 13px/1.5 var(--sans);
  letter-spacing: -0.01em;
  -webkit-font-smoothing: antialiased;
}
::selection { background: rgba(110,121,244,.35); }
```

Remove the old decorative background layer (`.bgfx`, `.blob`, `.grid` divs at line 760 and their CSS) — Linear style is a flat near-black page.

- [ ] **Step 2: Restructure the sidebar**

Keep the `<aside>` element and all its JS-referenced IDs (`nav`, `navPricing`, `navEvents`, `sideDot`, `sideStatus`, `sideActive`, `sidePort`). Reorganize the nav into three labeled groups with this structure (reuse the existing inline SVG icons per view):

```html
<nav id="nav">
  <div class="navgroup">
    <div class="navlbl">Monitor</div>
    <button data-view="overview" class="active">…icon… <span class="lbl">Overview</span></button>
    <button data-view="usage">… <span class="lbl">Usage</span></button>
    <button data-view="events">… <span class="lbl">Events</span> <span class="navbadge" id="navEvents"></span></button>
  </div>
  <div class="navgroup">
    <div class="navlbl">Configure</div>
    <button data-view="providers">… <span class="lbl">Providers</span></button>
    <button data-view="pricing">… <span class="lbl">Pricing</span> <span class="navbadge" id="navPricing"></span></button>
    <button data-view="discover">… <span class="lbl">Discover</span></button>
  </div>
  <div class="navgroup">
    <div class="navlbl">System</div>
    <button data-view="settings">… <span class="lbl">Settings</span></button>
    <button data-view="help">… <span class="lbl">Help</span></button>
  </div>
</nav>
```

Shell CSS (sidebar 220px, nav buttons as quiet rows, active = filled pill):

```css
.app { display: flex; min-height: 100vh; }
aside {
  width: 220px; flex: none; display: flex; flex-direction: column;
  border-right: 1px solid var(--border); background: var(--bg);
  padding: var(--sp-4) var(--sp-3); gap: var(--sp-4);
}
.brand { display: flex; gap: 10px; align-items: center; padding: 0 var(--sp-2); }
.brandmark {
  width: 28px; height: 28px; border-radius: var(--r-sm); flex: none;
  background: var(--accent); color: #fff; font-weight: 800; font-size: 14px;
  display: grid; place-items: center;
}
nav { display: flex; flex-direction: column; gap: var(--sp-4); flex: 1; }
.navgroup { display: flex; flex-direction: column; gap: 2px; }
.navlbl {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--dim); padding: 0 var(--sp-2) var(--sp-1);
}
nav button {
  display: flex; align-items: center; gap: 10px; width: 100%;
  background: none; border: 0; border-radius: var(--r-sm);
  color: var(--muted); font: 500 13px var(--sans); padding: 6px var(--sp-2);
  cursor: pointer; transition: background 150ms ease, color 150ms ease;
}
nav button:hover { background: var(--surface-2); color: var(--text); }
nav button.active { background: var(--surface-2); color: var(--text); }
nav button.active .ico { color: var(--accent); }
nav button .ico { width: 16px; height: 16px; display: grid; place-items: center; color: var(--dim); }
nav button .ico svg { width: 15px; height: 15px; }
```

- [ ] **Step 3: Content column + view header**

```css
main { flex: 1; min-width: 0; padding: var(--sp-6); max-width: 1200px; }
.view { display: none; }
.view.active { display: block; animation: viewfade 150ms ease; }
@keyframes viewfade { from { opacity: 0; } to { opacity: 1; } }
.viewhead {
  display: flex; align-items: center; gap: var(--sp-3);
  margin-bottom: var(--sp-6);
}
.viewhead h1 { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; }
.viewhead .sub { color: var(--muted); font-size: 13px; }
.viewhead .actions { margin-left: auto; display: flex; gap: var(--sp-2); }
```

Keep the existing per-view `viewhead` markup — only class names change where a header has an actions row.

- [ ] **Step 4: Bridge styles so un-styled views still render sanely**

The existing view markup still references old classes (`.stat`, `.card`, `.skel`, etc.). Add a temporary bridge block at the END of the style block mapping old class names onto new tokens (e.g. `.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); }`, same for `.card`, `.prow`, `.formcard`, `.skel`). These bridges get deleted task-by-task as views are restyled; all remaining bridges are deleted in Task 6.

- [ ] **Step 5: Update the `VIEWS` array to the new nav order**

In the script (near line 2459), change to:

```js
const VIEWS = ['overview', 'usage', 'events', 'providers', 'pricing', 'discover', 'settings', 'help'];
```

This matches the sidebar order so keys 1–8 land where the eye expects. (Share is a popup, not a view — unchanged.)

- [ ] **Step 6: Verify per protocol + screenshot**

Every view reachable, no console errors, `npm test` green. Take a screenshot of Overview for the task record.

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "style: dashboard shell — token system, grouped sidebar, content column"
```

---

### Task 2: Shared components

**Files:**
- Modify: `public/index.html` (CSS block — component layer after the shell rules; small markup class renames in static HTML)

**Interfaces:**
- Consumes: Task 1 tokens.
- Produces: the component classes every later task's templates use: `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.card`, `.stat`, `.statlabel`, `.statnum`, `.statdetail`, `.tbl`, `.dot`, `.dot-up/.dot-down/.dot-cd/.dot-off`, `.pill`, `.input`, `.toast`, `.modal`, `.empty`.

- [ ] **Step 1: Write the component CSS block** (insert after the shell rules)

```css
/* ---- buttons ---- */
.btn, .shbtn, button.primary {
  display: inline-flex; align-items: center; gap: 6px;
  font: 600 12.5px var(--sans); border-radius: var(--r-sm);
  padding: 7px 14px; cursor: pointer; border: 1px solid transparent;
  transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
}
.btn-primary, button.primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: #7d87f6; }
.btn-secondary { background: var(--surface); border-color: var(--border); color: var(--text); }
.btn-secondary:hover { background: var(--surface-2); }
.btn-ghost { background: none; color: var(--muted); }
.btn-ghost:hover { color: var(--text); background: var(--surface-2); }
.btn-danger { background: none; color: var(--red); border-color: transparent; }
.btn-danger:hover { background: rgba(248,113,113,.08); }

/* ---- cards & stats ---- */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--sp-4); }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--sp-4); }
.statlabel { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim); font-weight: 600; }
.statnum { font: 700 28px var(--mono); letter-spacing: -0.02em; margin: 6px 0 2px; }
.statdetail { color: var(--muted); font-size: 12px; font-family: var(--mono); }

/* ---- tables ---- */
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th {
  text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--dim); font-weight: 600; padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border); background: var(--surface);
}
.tbl td { padding: 10px var(--sp-3); border-bottom: 1px solid var(--border); }
.tbl tr:last-child td { border-bottom: 0; }
.tbl tr:hover td { background: var(--surface-2); }
.tbl .num { text-align: right; font-family: var(--mono); }

/* ---- status dots ---- */
.dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 7px; vertical-align: middle; }
.dot-up { background: var(--green); box-shadow: 0 0 0 0 rgba(52,211,153,.5); animation: dotpulse 2s infinite; }
.dot-down { background: var(--red); }
.dot-cd { background: var(--amber); }
.dot-off { background: var(--dim); }
@keyframes dotpulse { 70% { box-shadow: 0 0 0 5px rgba(52,211,153,0); } 100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); } }

/* ---- pills, inputs, toasts, modals, empty states ---- */
.pill { display: inline-flex; align-items: center; gap: 5px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 11px; color: var(--muted); }
.input, input, select, textarea {
  background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--r-sm); padding: 7px 10px; font: 13px var(--sans); width: 100%;
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
.toast { position: fixed; right: var(--sp-4); bottom: var(--sp-4); background: var(--surface-2); border: 1px solid var(--border); border-left: 2px solid var(--accent); border-radius: var(--r-sm); padding: 10px 14px; font-size: 13px; z-index: 200; }
.toast.err { border-left-color: var(--red); }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); backdrop-filter: blur(4px); display: grid; place-items: center; z-index: 100; }
.modal .card { box-shadow: 0 8px 32px rgba(0,0,0,.5); }
.empty { text-align: center; color: var(--dim); padding: var(--sp-6); }
.mono { font-family: var(--mono); }
```

Adjust the existing toast/modal markup classes to match (`.toast` container id `toast` if present, `.share` popup becomes `.modal`-compatible in Task 6 — do not touch it yet).

- [ ] **Step 2: Apply component classes to static markup in all view sections** (the non-JS-rendered parts: view headers, section labels, static buttons like "Share stats", "Recalculate costs"). JS-rendered templates are NOT touched in this task — bridges keep them sane.

- [ ] **Step 3: Verify per protocol** — all views, interactions: one button hover/click per component type, console clean, `npm test` green.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "style: shared component layer — buttons, stats, tables, dots, inputs, toasts, modals"
```

---

### Task 3: Overview + Providers views

**Files:**
- Modify: `public/index.html` — `#view-overview` and `#view-providers` sections; render functions `renderProviders`, stat-hero markup in `renderUsage` that targets Overview (`heroTotalTok`, `heroCost`, `stTotal` etc. — only class attributes in the template strings); bubbles canvas color constants.

**Interfaces:**
- Consumes: Task 2 component classes.
- Produces: restyled Overview and Providers; bubble canvas palette mapped to tokens.

- [ ] **Step 1: Overview hero + stat tiles** — hero row: big tokens tile (statnum 28px mono) + cost + requests + today; each a `.stat` card with `.statlabel/.statnum/.statdetail`. Keep all element IDs (`stTotal`, `stTotalDetail`, `stReqs`, `stToday`, `stTodayDetail`, `stCost`, `stCostDetail`, `heroTotalTok`, `heroCost`) — the JS targets them by ID, class names only change.

- [ ] **Step 2: Bubbles widget restyle** — container gets `.card`; find the canvas bubble draw colors in the JS (constants near the traffic-flow code) and remap: bubble fill `#111114`, bubble stroke `#1f1f23`, active route `#6e79f4` → `#22d3ee` gradient, text `#ececf1`. Physics code untouched.

- [ ] **Step 3: Providers table-first layout** — restyle `renderProviders` template: provider rows become a `.tbl` with columns: priority (▲▼ buttons), name + status dot, models (mono, dim), masked key (mono), latency/success (`.num`), actions (test/edit/delete ghost buttons + reset when down). The add/edit form card (`.formcard`) gets `.card` + `.input` styling; the key hint stays.

- [ ] **Step 4: Delete the Task 1 bridge rules that only these views used** (`.prow`-style provider cards, overview stat bridges).

- [ ] **Step 5: Verify per protocol** — interactions: reorder a provider (▲▼), open edit form, close it; bubbles draggable; console clean; `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "style: overview + providers — stat hero, provider table, bubble palette"
```

---

### Task 4: Usage + Pricing + Events views

**Files:**
- Modify: `public/index.html` — `#view-usage`, `#view-pricing`, `#view-events`; templates in `renderUsage` (chart + provider bars + model table), `renderPricing`, `renderEvents`.

**Interfaces:**
- Consumes: Task 2 component classes.
- Produces: restyled Usage/Pricing/Events.

- [ ] **Step 1: Usage** — stat tiles top (`.stat` row). 14-day chart: bar-in `var(--accent)`, bar-out `var(--accent-2)`, 30% opacity gridline rows behind bars (1px `--border`), tooltips keep existing markup but get `.pill`-style surface. Per-provider bars: track = `--surface-2`, fill = `--accent`. Per-model table → `.tbl` with `.num` columns. Unpriced badge → `.pill` with amber dot.

- [ ] **Step 2: Pricing** — unpriced callout → `.card` with amber left border (2px). Alias groups: connected chips — each model name a `.pill`, group joined with a subtle 16px connector line (`--border`). Full model table → `.tbl`; source pill (`.pill`, `.mono`); per-provider price rows inside the price editor modal. Recalc banner → `.card` with amber border + primary action button.

- [ ] **Step 3: Events** — `.events` list becomes timeline: mono timestamp column (dim, 12px), colored type marker (4px×16px rounded bar: green=failover-recovered, amber=down, red=error, gray=info), message text. Search input + clear button in the viewhead actions. Filter JS untouched.

- [ ] **Step 4: Delete bridges these views used**.

- [ ] **Step 5: Verify per protocol** — interactions: hover a chart day (tooltip), open pricing editor, set + revert a price, events filter; console clean; `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "style: usage, pricing, events — chart, tables, timeline"
```

---

### Task 5: Discover + Settings + Help views

**Files:**
- Modify: `public/index.html` — `#view-discover`, `#view-settings`, `#view-help`; templates in the Discover render + wizard visual container, Settings static markup, Help static markup.

**Interfaces:**
- Consumes: Task 2 component classes.
- Produces: restyled Discover/Settings/Help.

- [ ] **Step 1: Discover** — card grid: `display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--sp-3);`. Each provider card = `.card` with: name + FREE badge (`.pill` with green dot, prominent top-right), description (muted), rating as 5-dot row (filled = `--accent`, empty = `--border`), pricing note, primary "Set up" button. Wizard visuals (when triggered from Discover) inherit the components — no logic changes.

- [ ] **Step 2: Settings** — three grouped `.card` sections with `.navlbl`-style group titles: Configuration (export/import as bordered file-card rows with mono filenames), Provider catalog (remote URL input + reset), Danger zone (usage reset — card border `rgba(248,113,113,.25)`, red title, danger button). Install-status panel at top as `.card` with status dot.

- [ ] **Step 3: Help** — doc layout: two-column (main content + sticky 160px anchor nav listing the problems, current-section highlighted with `.active` pill). Problem blocks: `.card` each, title 15px, code blocks on `--surface-2` mono 12px with copy affordance if one already exists, numbered fix steps with dim numbers. Back-to-top link bottom.

- [ ] **Step 4: Delete bridges these views used**.

- [ ] **Step 5: Verify per protocol** — interactions: Discover card button prefills provider form; settings export button fires download/toast; help anchor scroll; console clean; `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "style: discover, settings, help — card grid, grouped sections, doc layout"
```

---

### Task 6: Share popup, bubbles polish, final audit, README

**Files:**
- Modify: `public/index.html` (share popup, focus states, any remaining bridges); `README.md` (screenshots).

**Interfaces:**
- Consumes: all prior tasks.
- Produces: finished v0.3.0 dashboard; updated README screenshots.

- [ ] **Step 1: Share popup** — outer `.share` becomes `.modal`; inner grid: preview canvas card + controls column (period chips = `.pill` rows with `.active` state, toggles = custom checkbox on `--surface-2`, theme swatches keep their color dots). Export/share buttons = `.btn-primary` / `.btn-secondary`. **Share-card canvas themes are NOT touched** (exported art, not UI).

- [ ] **Step 2: Focus-visible audit** — add global rule `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }` and confirm tab order through sidebar → view works.

- [ ] **Step 3: Contrast audit** — verify text tokens on surfaces: `--text`/`--muted` on `--surface`/`--surface-2` meet WCAG AA (4.5:1). `--dim` is decorative/label only (12px+ uppercase) — verify ≥ 3:1; adjust `--dim` to `#6b6b74` if it misses.

- [ ] **Step 4: Delete ALL remaining bridge rules** from Task 1; grep the style block for the old class names to confirm none are orphaned.

- [ ] **Step 5: Full-protocol final pass** — every view, every interaction exercised once, zero console errors, `npm test` green. Take fresh screenshots of Overview + Providers + Usage + Discover (1400×900 viewport) and replace `docs/screenshots/*.png` accordingly (same filenames — README references stay valid).

- [ ] **Step 6: Commit + release (confirm with user first)**

```bash
git add public/index.html docs/screenshots README.md
git commit -m "style: share popup, focus/contrast audit, fresh screenshots — v0.3.0 UI"
```

Then with the user: bump versions to 0.3.0 in `package.json` + `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`, tag `v0.3.0`, push, GitHub release with before/after screenshot notes. No AI attribution anywhere.

---

## Self-review

- **Spec coverage:** tokens (T1), shell/nav groups (T1), components (T2), all 9 views (T3–T6: Overview+Providers T3, Usage+Pricing+Events T4, Discover+Settings+Help T5, Share T6), bubbles (T3 step 2), focus/contrast audit (T6), screenshots (T6), keyboard shortcut remap (T1 step 5). ✓
- **Placeholders:** none — every step carries concrete CSS/markup or a precise edit instruction anchored to named functions/IDs.
- **Consistency:** component class names defined in T2 are the ones used in T3–T6; IDs preserved everywhere the JS needs them; `VIEWS` order matches sidebar order in T1.
