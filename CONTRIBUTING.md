# Contributing

Thanks for considering it — contributors are added to the repo (and credited in releases), and contributing isn't only code.

## Ways to contribute

- **Share a free/freemium provider** — this counts as a contribution. If you know a gateway with a free tier, daily-login rewards, or a promo that isn't in the built-in catalog, post it in [Discussions](https://github.com/shaheer-00/switchXprovider/discussions) (or open an issue / PR). Include: `baseUrl`, which free models work, and how the free tier works (daily reward / promo / always-free). Good finds get added to `server/catalog.json`.
- **Catalog data fixes** — wrong rating, stale description, broken link: PR against `server/catalog.json`.
- **Pricing data** — new model rates or corrections for `server/lib/pricing.mjs`. Include the source.
- **Bug reports** — open an issue with: what you did, what happened, what you expected, and the relevant lines from `~/.claude/switchx/server.log`.
- **Code** — see below.

## Dev setup

```
git clone https://github.com/shaheer-00/switchXprovider
cd switchXprovider
npm test
```

Requires Node >= 18. Zero dependencies — no `npm install` needed. The test suite is self-contained end-to-end tests (failover, model mapping, recovery, pricing) in `test/run-tests.mjs`.

To run the dashboard + proxy locally:

```
npm start        # dashboard at http://127.0.0.1:8787
```

## Pull requests

- Keep PRs focused — one fix or feature per PR.
- Add or update tests in `test/run-tests.mjs` for anything behavioral (failover, cooldowns, mapping, pricing math).
- No new runtime dependencies — the zero-dependency rule is a design decision, and new deps will be rejected.
- Match the existing style: plain ESM Node, no TypeScript, no build step.
- Security issues: **never** as a PR or public issue — see [SECURITY.md](SECURITY.md).

## Project layout

```
server/server.mjs         HTTP server: dashboard / API / proxy routing
server/lib/proxy.mjs      forwarding, model rewrite, failover, cooldowns
server/lib/health.mjs     background probes, auto-recovery
server/lib/pricing.mjs    model rate table, aliases, cost recalculation
server/lib/config.mjs     config + stats + event log
server/lib/routing.mjs    flip routing on/off
server/catalog.json       curated provider catalog
public/index.html         dashboard (single file, no external assets)
test/run-tests.mjs        end-to-end tests
```
