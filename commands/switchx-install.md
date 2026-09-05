---
description: Run the switchXprovider installer — points Claude Code settings.json at the local proxy
---

# switchXprovider — install into Claude Code (LAST step)

**Order is critical.** Once `settings.json` points at the proxy, ALL Claude Code traffic goes through it. If no provider is configured yet, Claude Code gets completely stuck with no API access. The installer enforces this: it refuses to touch `settings.json` until the proxy is running and at least one enabled provider has an API key.

When it succeeds it backs up `~/.claude/settings.json` and sets:

- `ANTHROPIC_BASE_URL` = `http://127.0.0.1:8787`
- `ANTHROPIC_AUTH_TOKEN` = `switchx-local`
- `ANTHROPIC_DEFAULT_OPUS_MODEL` = `switchx:opus`
- `ANTHROPIC_DEFAULT_SONNET_MODEL` = `switchx:sonnet`
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` = `switchx:haiku`

The `switchx:*` names are sentinels — the proxy rewrites them to the active provider's real model IDs on every request, so settings.json never needs to change again when providers switch.

## Steps — in this exact order

1. Start the proxy (plugin root = parent of this file's `commands/` directory):
   ```
   node "<plugin root>/server/ensure.mjs"
   ```
2. **Add at least one provider with an API key** and enable it — dashboard: http://127.0.0.1:8787 (or `/switchx-add`). Have the user click "test" to confirm it is reachable. **Do not continue until this is done.**
3. Run the installer:
   ```
   node "<plugin root>/scripts/install.mjs"
   ```
   If it refuses, it will say why — fix that (usually: no provider yet) and re-run. `--force` skips the safety checks but should not be needed.
4. Read its output to the user, including any warnings about conflicting `ANTHROPIC_*` environment variables set in their shell/system — those override settings.json and must be removed.
5. Tell the user to **restart Claude Code** for the new environment to take effect.
6. Tell the user the escape hatch: if Claude Code gets stuck, restore `~/.claude/settings.json.switchx-backup` over `~/.claude/settings.json`.
