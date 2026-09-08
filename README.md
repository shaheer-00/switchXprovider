<div align="center">

# switchXprovider

**Never stop coding when a provider dies.**

A zero-dependency Claude Code plugin that routes your API traffic through a local
proxy with automatic failover, auto-recovery, live usage analytics — and
**every provider free out of the box (free models, credits, or daily-login rewards)**, with more on the way.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![Buy me a coffee](https://img.shields.io/badge/%E2%98%95-buy%20me%20a%20coffee-FFDD00)](https://buymeacoffee.com/shaheer0.0)

*An alternative to OmniRouter — your keys, your machine, no middleman.*

</div>

---

![switchXprovider dashboard](docs/screenshots/overview.png)

<details>
<summary><b>📷 More screenshots</b></summary>

| Providers — priority & failover state | Discover — curated catalog |
|---|---|
| ![Providers](docs/screenshots/providers.png) | ![Discover](docs/screenshots/discover.png) |

| Usage — per provider & model, estimated cost | Events — failovers, recoveries |
|---|---|
| ![Usage](docs/screenshots/usage.png) | ![Events](docs/screenshots/events.png) |

| Share — build a stats card, export as PNG | The card itself — 4 themes, 5 time periods |
|---|---|
| ![Share widget](docs/screenshots/share.png) | ![Share card](docs/screenshots/share-card.png) |

| Pricing — per-model rates, aliases, recalculation | Settings |
|---|---|
| ![Pricing](docs/screenshots/pricing.png) | ![Settings](docs/screenshots/settings.png) |

| Help — common issues and fixes |
|---|
| ![Help](docs/screenshots/help.png) |

</details>

## ✨ Highlights

| | |
|---|---|
| 🆓 **Free providers included** | Every provider in the shipped catalog has a free tier (free models, credits, or daily-login rewards) — and the catalog keeps growing |
| 🔀 **Automatic failover** | Provider dies mid-request? Retried on the next one before you notice |
| 🔁 **Auto-recovery** | Down providers are re-probed every 30s and return to rotation on their own |
| 🔑 **Your keys, your machine** | Traffic goes straight to the provider — no third party in the path |
| 🚀 **Zero dependencies** | One Node process, ~12 files, under 6,000 lines — readable in an afternoon |
| 📊 **Usage & cost analytics** | Tokens, latency, success rate, and estimated cost per provider / model / day |
| 💰 **Pricing editor** | Real market rates built in; set prices per model or per provider, alias same models under different names, and recalculate history when prices change |
| 🆘 **Built-in Help** | Troubleshooting view in the dashboard — claude-mem capture sync, stale proxy after updates, env-var conflicts, cooldowns, and more |
| 📤 **Shareable stats card** | Build a pretty usage card in the dashboard — pick period, stats, and theme — export or share it as a PNG |
| 🧭 **Provider discovery** | Curated catalog with one-click setup, plus community-maintained remote catalogs |

---

## How it differs from OmniRoute

Both projects solve *"never stop coding when a provider dies"* — but with opposite trust models. **OmniRoute pools free community tokens and routes your traffic through their infrastructure. switchXprovider routes your traffic directly to providers you control.**

| | switchXprovider | OmniRoute |
|---|:---:|:---:|
| **Traffic path** | Claude Code → your machine → your provider, directly | Claude Code → OmniRoute's gateway → pooled providers |
| **Keys** | Yours only — never leaves your `~/.claude` | Pooled community keys handled by their service |
| **Free tokens** | Freemium providers built in + your providers' free tiers | ~1.5B/month pooled across 352+ providers |
| **Footprint** | One Node process, 0 dependencies, ~12 files | Full gateway infrastructure |
| **Auditability** | under 6,000 lines you can read in an afternoon | Centralized service |
| **Provider choice** | Any Anthropic-compatible endpoint you have a key for | Their supported provider pool |
| **Usage analytics** | Token/latency/success tracking of *your* traffic, locally | Gateway-side stats |
| **Cost** | Free (your provider usage) | Free tier + premium |

**Pick switchXprovider if:** you have provider keys or subscriptions (Anthropic, Z.AI GLM coding plan, DeepSeek, OpenRouter, gateways), want your API traffic to go straight to the provider with no middleman, and want a tiny auditable proxy instead of a service.

**Pick OmniRoute if:** you have no keys at all and want free pooled community tokens, accepting a third party in the path.

They also compose — run OmniRouter as one provider entry in switchXprovider, and its outage fails over to your backup key automatically.

## 🆓 Free providers, built in

The plugin ships with a curated catalog in which **every provider has a free tier** — free models, free credits, or daily-login rewards you can route through right away:

| Provider | Free offering |
|---|---|
| **AgentRouter** | Free GLM & DeepSeek models behind one endpoint |
| **Bynara** | Generous free tier — MiMo, DeepSeek, MiniMax free models; solid last-resort fallback |
| **SeekAi** | Free models at sign-up |
| **GoRouter** | Free tier + per-token Claude-family models, incl. thinking variants |
| **TabiToken** | Free tier — token-based, model IDs from your dashboard |
| **BlueSminds** | Free tier — Anthropic-compatible (new-api based) |
| **B.AI** | Free tier — invite-based |
| **APInex** | Free tier — "one API for every model" |

Combine them with daily-login rewards (most gateways hand out free credits or tokens for a daily check-in — sign out and back in **every day** to claim) and failover, and you have a zero-cost coding pipeline with redundancy. **More free providers are being added to the catalog continually** — and you can plug in any community-maintained catalog via Settings → Remote catalog.

> **Affiliate disclosure:** sign-up links in the Discover catalog are affiliate/referral links — signing up through them supports switchXprovider development at no extra cost to you.

## Install

**Via plugin marketplace (recommended):**

```
/plugin marketplace add shaheer-00/switchXprovider
/plugin install switchXprovider@switchx-marketplace
```

Then run `/switchx-install` — it walks you through the whole setup (proxy start, adding a provider, switching settings.json over) and refuses to break your setup along the way.

**Local, without the marketplace:**

```
git clone https://github.com/shaheer-00/switchXprovider
/plugin marketplace add /path/to/switchXprovider
/plugin install switchXprovider@switchx-marketplace
```

**Standalone (no plugin registration — dashboard and proxy only, no slash commands or auto-start hook):**

```
git clone https://github.com/shaheer-00/switchXprovider
node switchXprovider/server/ensure.mjs
```

## What it does

- **Set-and-forget Claude Code config** — `~/.claude/settings.json` is written once (by the installer) with sentinel model names. Provider switches never touch it again, and no Claude Code restart is needed to fail over.
- **Priority routing** — you set the provider order (1 = highest). Traffic always goes to the highest-priority *healthy* provider.
- **Automatic failover** — on failure the same request is retried on the next provider in the priority list:
  | Signal | Meaning | Base cooldown |
  |---|---|---|
  | 401 / 403 | bad or revoked key | 60 min |
  | 402 | out of credits | 30 min |
  | 429 | rate limited / usage window | 5 min (respects `retry-after`) |
  | 404 | model missing on provider | 2 min |
  | 5xx / 529 | provider trouble | 1 min |
  | network / timeout | unreachable | 30 s |
- **Auto-learning cooldowns** — cooldowns scale up to 8× with consecutive failures (exponential backoff), and honor upstream `retry-after` headers. Each provider tracks requests, success rate, and EMA latency.
- **Auto-recovery** — a background health loop re-probes down providers every 30s (and just before cooldown expiry); a recovered provider returns to rotation automatically at its priority (e.g. when your Claude subscription window resets, you drift back to provider #1 with zero action).
- **Usage analytics** — the proxy reads token usage (`input`/`output`/`cache_read`/`cache_creation`) out of every response — streaming and non-streaming — without touching the stream, and tracks totals per provider, per model, and per day. The dashboard shows animated stat cards, a 14-day usage chart, per-provider token share, a per-model table, and a live request feed (model, tokens, latency, status).
- **Cost tracking** — every request is priced against a per-model rate table (Claude models at official Anthropic rates, GLM/DeepSeek/Kimi/MiMo/MiniMax/Qwen at current market rates, explicit `-free` variants at $0), so you can see roughly what your traffic would cost if you paid per-token. Estimated cost shows up as a hero pill, a stat card with today/7-day breakdowns, per-day chart tooltips, per-provider bars, and a per-model table column. Estimates only — gateway subscriptions, credits, and promos aren't modelled.
- **Pricing editor** — the Pricing view lists every model seen in usage, mapped on a provider, or known built-in, with its effective rate and where it comes from (built-in / your override / per-provider). Set a price universally or per provider (e.g. $0 for a free-tier gateway, market rate elsewhere). Models the same under different names across providers (GLM-5.2 / GLM-5.2-Free) are auto-detected and can be aliased to share one price while stats stay separate. Unpriced models are badged instead of silently costing $0. When a price changes, the dashboard asks whether to recalculate past usage with the new price or apply it from now on — recalculation is exact for per-provider/model/day tracked history, and there's a manual *Recalculate costs* button for history recorded before a price existed.
- **Shareable stats card** — the Overview's *Share stats* button opens a popup where you compose a usage card: pick a time period (today / 7d / 14d / 30d / all-time), toggle which stats show (tokens, estimated cost, daily chart, top provider & model), and choose one of four themes (Midnight, Aurora, Light, Terminal). The live preview is the exported image — download it as a PNG or hand it straight to the OS share sheet where the browser supports it. Rendered entirely in-browser on a canvas, no external services.
- **Traffic flow playground** — the overview's Traffic flow widget renders your providers as free-floating bubbles around the switchX core. Drag them anywhere (both sides), toss them and watch them bounce off the walls — purely cosmetic, nothing about routing changes. Edges redraw live as bubbles move; the active route keeps its animated gradient. Click a bubble to open that provider in the Providers view.
- **Provider discovery** — a curated catalog of gateways — **all with free tiers (free models, credits, or daily-login rewards), and more added over time** — with descriptions, ratings, pricing notes, and one-click prefill of the add-provider form. A remote catalog (same JSON schema, e.g. a raw GitHub file) can be set in Discover → Catalog source and overrides matching entries — useful for community-maintained lists.
- **Config backup** — export/import the full provider list (including keys) as JSON from the dashboard.
- **Install status detection** — the dashboard reads `~/.claude/settings.json` and shows whether Claude Code is actually routed through the proxy.
- **Help & troubleshooting** — a built-in Help view with the common problems and their fixes: claude-mem capture dying after proxy setup (with the credentials-sync hook fix), statusline plugins showing stale mode labels, the proxy serving old code after a plugin update, shell `ANTHROPIC_*` env vars overriding `settings.json`, providers stuck in cooldown, model-name mismatches across providers, $0 cost estimates, and a dead dashboard.
- **Deadlock protection** — if *every* provider is down, cooldowns reset (at most once a minute) and the request is retried rather than hard-failing; a full outage returns a clear error instead of hammering dead providers on every request.

## Setup

> ⚠️ **Order matters.** The moment `settings.json` points at the proxy, ALL Claude Code traffic goes through it — if no provider is configured yet, Claude Code is completely stuck with no API access. So the installer runs checks and **refuses to touch `settings.json` until the proxy is running and at least one enabled provider has an API key**.

Correct order:

```
node server/ensure.mjs       # 1. start the proxy (daemonizes)
open http://127.0.0.1:8787   # 2. add a provider (API key + model IDs), click "test"
node scripts/install.mjs     # 3. NOW switch Claude Code to the proxy (backs up settings.json)
                             # 4. restart Claude Code
```

Or as a plugin: the `SessionStart` hook auto-starts the proxy, and `/switchx-install` runs the installer with the same checks. `--force` skips them.

> **If Claude Code gets stuck after installing:** restore the backup —
> `copy ~/.claude/settings.json.switchx-backup ~/.claude/settings.json` — then fix the provider in the dashboard and re-run the installer.
>
> Shell/system `ANTHROPIC_*` environment variables override `settings.json` — remove them or nothing here takes effect. The installer warns about conflicts it can see.

## Use

- **Dashboard:** http://127.0.0.1:8787 — add/edit/delete providers, reorder priority (▲▼), test connectivity (including a check that your configured model IDs actually exist on the provider), watch status and the event log live, check estimated costs, and edit per-model prices in the Pricing view. The Traffic flow bubbles on the Overview page are draggable just for fun. The **Share stats** button on the Overview exports your usage as a shareable PNG card.
- **Commands:** `/switchx` (status), `/switchx-add` (add provider), `/switchx-install` (run installer).
- **Config lives in** `~/.claude/switchx/config.json` (providers + keys + stats). Server log: `~/.claude/switchx/server.log`.

## Adding a provider

In the dashboard or via `POST /api/providers`:

| Field | Notes |
|---|---|
| `baseUrl` | e.g. `https://api.anthropic.com`, `https://openrouter.ai/api/v1` — `/v1` duplication is handled |
| `apiKey` | provider key |
| `authStyle` | `auto` (default — sends both header styles, works everywhere), or force `anthropic` / `bearer` for rare strict providers |
| `models` | real model IDs for the `opus` / `sonnet` / `haiku` slots — the proxy maps `switchx:sonnet` → your value |

## How the model mapping works

Claude Code sends `model: "switchx:sonnet"` (or opus/haiku) because that's what the installer put in `settings.json`. The proxy rewrites `switchx:<slot>` to the active provider's model for that slot before forwarding, so every provider can use completely different model names — including non-Anthropic gateways that expose Anthropic-compatible `/v1/messages` endpoints.

## Security

- 🔒 Proxy binds to **127.0.0.1 only** — never reachable from the network.
- 🔑 API keys are stored in plaintext in `~/.claude/switchx/config.json` (same trust level as your `~/.claude` directory) and are masked in all API/dashboard responses.

## Remote catalog schema

Host a JSON file (e.g. `catalog.json` in a GitHub repo, served via `raw.githubusercontent.com`) and paste its URL into Settings → Remote catalog. Entries with the same `id` as the built-in catalog override it:

```json
{
  "version": 1,
  "updated": "2026-09-05",
  "providers": [
    {
      "id": "my-gateway",
      "name": "My Gateway",
      "baseUrl": "https://api.example.com",
      "authStyle": "auto",
      "description": "What it is and why you'd use it.",
      "website": "https://example.com",
      "docsUrl": "https://docs.example.com",
      "pricing": "per-token | subscription | free",
      "freeTier": true,
      "rating": 4.5,
      "tags": ["community"],
      "models": { "opus": "...", "sonnet": "...", "haiku": "..." }
    }
  ]
}
```

`id`, `name`, `baseUrl` are required; everything else is optional. Ratings are editorial — set them yourself for your community.

## Support

If switchXprovider saves your session, consider supporting development: ☕ **[Buy me a coffee](https://buymeacoffee.com/shaheer0.0)**

## Files

```
.claude-plugin/plugin.json   plugin manifest + SessionStart hook (auto-start)
server/server.mjs            HTTP server: dashboard / API / proxy routing
server/ensure.mjs            daemon bootstrap (used by the hook)
server/lib/config.mjs        config + stats + event log (~/.claude/switchx/)
server/lib/proxy.mjs         forwarding, model rewrite, failover, cooldowns
server/lib/health.mjs        background probes, auto-recovery
server/lib/api.mjs           management REST API
server/lib/pricing.mjs       model rate table, aliases, cost recalculation
server/lib/routing.mjs       flip routing on/off (proxy vs direct Anthropic)
server/catalog.json          curated provider catalog (free-tier gateways)
public/index.html            dashboard (single file, no external assets)
commands/switchx*.md         slash commands
scripts/install.mjs          one-time settings.json installer
test/run-tests.mjs           end-to-end tests (failover, mapping, recovery)
```
