# Dashboard Redesign — v0.3.0 Design Spec

**Date:** 2026-09-08
**Status:** Approved in conversation, pending spec review
**Target release:** v0.3.0 (minor — visible UI breaking change)

## Goal

Full visual and structural redesign of the switchXprovider dashboard
(`public/index.html`) to a Linear/Vercel-grade dark aesthetic. Pure refresh —
no new features, no behavioral changes, no mobile work. All rendering JS
logic stays intact; only the CSS layer, HTML skeleton, and HTML template
class names change.

## Constraints

- **Single file, zero dependencies** — the dashboard stays one
  `public/index.html` with no external assets (no font CDN, no icon lib;
  icons are inline SVG, fonts are system stacks).
- **Desktop-only** — no responsive breakpoints beyond what exists (Claude
  Code users are on desktops).
- **All JS behavior preserved** — the v0.2.4 bug fixes (pricing delegation,
  wizard state, share card math, day keys) live in the JS and must not be
  touched except for template class names and canvas color constants.
- **Bubbles stay** — the traffic-flow physics playground on Overview is
  kept as-is functionally, restyled only.
- **Test suite** — `npm test` (115 assertions) must stay green throughout;
  it exercises the server, not CSS.

## Design language

### Tokens (CSS custom properties on `:root`)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0a0a0c` | page background |
| `--surface` | `#111114` | cards |
| `--surface-2` | `#17171b` | raised surfaces: table headers, hover, inputs |
| `--border` | `#1f1f23` | all hairlines |
| `--text` | `#ececf1` | primary text |
| `--muted` | `#8e8e96` | secondary text |
| `--dim` | `#5c5c64` | labels, micro-copy |
| `--accent` | `#6e79f4` | the single accent (indigo) |
| `--accent-2` | `#22d3ee` | chart secondary series only |
| `--green` `--amber` `--red` | (current palette values, adjusted for the darker bg) | status only — never decoration |

### Typography

- Stack: `Inter, -apple-system, "Segoe UI", system-ui, sans-serif` (system
  rendering; Inter is used when the OS has it, no download)
- Mono stack: `"JetBrains Mono", "Cascadia Code", Consolas, monospace` —
  used for ALL numbers, token counts, model IDs, URLs, timestamps, prices
- Base 13px / 1.5 line-height; section labels 12px uppercase with `0.08em`
  tracking; micro-labels 11px; hero numbers 28px mono

### Rhythm

- Spacing scale: 4 / 8 / 12 / 16 / 24
- Radii: 6 (chips) / 8 (cards, inputs) / 10 (modals)
- Shadow: ONLY on popovers/modals — `0 8px 32px rgba(0,0,0,.5)`. Cards use
  1px borders, no elevation.
- Motion: 150ms ease on hover/active state changes only. No entrance
  animations. Count-up number animations and bubble physics are untouched.

## Shell

- **Sidebar (220px):** logo block (SX mark + "switchXprovider" + version),
  grouped nav with inline SVG icons and labels, footer with routing status
  (ON through proxy / OFF direct) and update marker.
- **Nav groups:** Monitor (Overview, Usage, Events) · Configure (Providers,
  Pricing, Discover) · System (Help, Settings). Pricing nav is a top-level
  entry; Share stays a popup from Overview, not a nav entry.
- **Active nav item:** subtle filled pill (`--surface-2`), accent icon.
- **Content column:** max-width 1200px, per-view header — title (18px),
  subtitle (muted 13px), right-aligned actions row.
- Keyboard shortcuts (existing 1-9 view switching) map to the new nav order.

## Components

| Component | Spec |
|---|---|
| Stat tile | `--surface` card; dim uppercase 12px label; 28px mono number; muted sub-detail; optional count-up (existing JS) |
| Table | hairline row dividers (`--border`), no zebra, 13px, sticky header in scroll areas, right-aligned mono numbers |
| Status | 6px dot + label — green pulsing (active/up), amber (cooldown), red (down), gray (disabled) |
| Buttons | primary: `--accent` fill, white text; secondary: 1px `--border` on `--surface`; ghost: transparent, muted text; danger: red text ghost. All 8px radius |
| Inputs | `--surface-2` bg, 1px `--border`, focus = 2px accent ring, 8px radius |
| Pills/badges | 4px radius, `--surface-2` bg, 11px |
| Toasts | bottom-right stack, `--surface-2`, border-left 2px semantic color |
| Modals | centered card, backdrop `rgba(0,0,0,.6)` + `backdrop-filter: blur(4px)` |
| Empty states | centered dim icon + one-line explanation + primary action where applicable |

## Per-view treatment

- **Overview** — hero row of stat tiles (tokens incl. cache, cost, requests,
  today); traffic bubbles widget (bubbles: `--surface` fill + `--border`
  ring, canvas palette remapped to tokens); recent events preview.
- **Providers** — table-first: priority order controls (▲▼ kept), status
  dots, masked keys in mono, inline test/edit/delete actions, cooldown
  countdown chips. Add/edit form renders as a slide-over card above the
  table.
- **Discover** — card grid (auto-fill, min 280px); prominent FREE badge;
  rating as 5-dot row; one-click setup fills the Providers form.
- **Usage** — stat tiles top; 14-day chart (in = `--accent`, out =
  `--accent-2`, hairline grid lines, hover tooltips kept); per-provider
  bars; per-model table.
- **Pricing** — unpriced-models callout card; alias suggestion groups as
  connected chips; full model table; price editor modal; recalc prompt
  banner.
- **Events** — timeline list: mono timestamps, colored type markers, search
  filter (kept), clear action in header.
- **Share** — popup restyled to new components. The four share-card THEMES
  (Midnight/Aurora/Light/Terminal) are exported art, not dashboard UI, and
  are NOT redesigned.
- **Help** — doc layout: in-view anchor sidebar (sticky right or left), code
  blocks on `--surface-2`, numbered fix steps, back-to-top.
- **Settings** — grouped sections: Config (export/import as file-card
  actions), Catalog (remote URL, reset), Danger zone (usage reset) with
  red-tinted border.

## Implementation plan (6 passes, one commit each)

1. **Tokens + shell** — new `:root` tokens, sidebar, content column,
   topbar-less layout; existing views render inside new shell with
   temporary bridge styles so nothing is broken mid-pass.
2. **Shared components** — buttons, inputs, tables, pills, toasts, modals,
   stat tiles, status dots; every view's static markup restyled.
3. **Overview + Providers** — full template restyle; canvas color constants
   for bubbles remapped.
4. **Usage + Pricing + Events** — chart restyle, tables, callouts.
5. **Discover + Settings + Help**.
6. **Share popup + polish** — share controls restyled, contrast audit
   (WCAG AA on text tokens), focus-visible states, final cross-view pass.

### Verification per pass

- Browser check against live proxy (127.0.0.1:8787): click through every
  view, zero console errors, verify one interaction per view (nav, provider
  edit modal, pricing editor, etc.).
- `npm test` green after every pass.
- Screenshot diff of Overview kept for the release notes / README update.

### Files touched

- `public/index.html` (CSS block rewritten; HTML skeleton restructured;
  render-function template strings get new class names; canvas color
  constants remapped)
- `README.md` (screenshots replaced, only after pass 6)

## Out of scope

- New features (command palette, live-refresh, etc.)
- Light theme / theme toggle
- Mobile / responsive redesign
- Share-card exported themes
- Any server-side change (all API contracts unchanged)
