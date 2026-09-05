---
description: Show switchXprovider proxy status — active provider, priorities, failover state, recent events
---

# switchXprovider status

Check the local proxy and present its status.

## Steps

1. Get status:
   ```
   curl -s http://127.0.0.1:8787/api/status
   ```
2. If the curl fails, the proxy is not running. Start it, wait 2 seconds, retry:
   ```
   node "<path to switchXprovider plugin>/server/ensure.mjs"
   ```
   (This command file lives at `commands/switchx.md` inside the plugin — the plugin root is the parent of `commands/`.)

3. Present the results to the user:
   - A table of providers: name, priority, status (UP / DOWN + reason + seconds until cooldown ends / DISABLED), requests, success rate, latency
   - Which provider is currently ACTIVE (first "up" provider by priority)
   - The 5 most recent events from the `events` list, with timestamps
   - The dashboard URL: http://127.0.0.1:8787

Do not modify any provider configuration — this command is read-only. Tell the user to open the dashboard or use `/switchx-add` to make changes.
