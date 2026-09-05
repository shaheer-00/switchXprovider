---
description: Add or manage a provider in switchXprovider (API key, models, priority)
---

# switchXprovider — add/manage provider

Help the user add a new API provider to the switchXprovider proxy.

## Easiest path

Tell the user the dashboard handles this visually: **http://127.0.0.1:8787** — add/edit providers, set priorities with ▲▼, test connectivity, watch failover live.

## Via API (if the user prefers the terminal)

Add a provider (replace the values, ask the user for their real key/models):
```
curl -s -X POST http://127.0.0.1:8787/api/providers -H "content-type: application/json" -d '{
  "name": "My provider",
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "sk-...",
  "authStyle": "anthropic",
  "enabled": true,
  "models": {
    "opus": "claude-opus-5",
    "sonnet": "claude-sonnet-5",
    "haiku": "claude-haiku-4-5-20251001"
  }
}'
```

Notes:
- `authStyle`: leave as `"auto"` (default) — it sends both auth header styles and works with every provider. Only set `"anthropic"` or `"bearer"` if a provider explicitly rejects extra headers (rare).
- Priority is assigned automatically (new providers go last); reorder with `POST /api/providers/<id>/up` or `/down`, or in the dashboard.
- After adding, verify with `curl -s http://127.0.0.1:8787/api/status` and test with `curl -s -X POST http://127.0.0.1:8787/api/providers/<id>/test`.

## Other management operations

- Edit: `PUT /api/providers/<id>` (omit `apiKey` or send `""` to keep the existing key)
- Delete: `DELETE /api/providers/<id>`
- Reset a "down" provider immediately: `POST /api/providers/<id>/reset`
- Show current state: `/switchx`
