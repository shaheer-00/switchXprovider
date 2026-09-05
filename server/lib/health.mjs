// switchXprovider — background health checks.
//
// A provider's cooldown expiry alone restores it to rotation. This loop probes
// slightly before expiry so a recovered provider is confirmed (and logged)
// before Claude Code's next request hits it, and it keeps stale reasons from
// lingering in the dashboard.

import { statsFor, logEvent, persistSoon } from './config.mjs';

const PROBE_LEAD_MS = 10_000; // probe this long before cooldown expiry
const RECHECK_MS = 30_000;    // re-probe down providers at most this often
const LOOP_MS = 5_000;
const PROBE_TIMEOUT_MS = 10_000;
// Some gateways (e.g. agentrouter.org) fingerprint the client and reject
// non-Claude-Code user-agents, so probes must present as claude-cli.
const CLAUDE_UA = 'claude-cli/2.0.14 (external, cli)';

// Lightweight probe: GET {base}/v1/models with the provider's auth.
// 404/405 means "endpoint not supported but server alive" — counts as healthy.
// Auth/payment/rate/server errors and network failures count as still down.
export async function probe(p) {
  try {
    const resp = await fetchModels(p);
    return ![401, 402, 403, 429, 500, 502, 503, 504, 529].includes(resp.status);
  } catch {
    return false;
  }
}

async function fetchModels(p) {
  let base = String(p.baseUrl || '').replace(/\/+$/, '');
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const style = p.authStyle || 'auto';
  let headers;
  if (style === 'bearer') {
    headers = { authorization: `Bearer ${p.apiKey}`, 'user-agent': CLAUDE_UA };
  } else if (style === 'anthropic') {
    headers = { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'user-agent': CLAUDE_UA };
  } else {
    headers = { 'x-api-key': p.apiKey, authorization: `Bearer ${p.apiKey}`, 'anthropic-version': '2023-06-01', 'user-agent': CLAUDE_UA };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Deep probe for manual tests: like probe(), but when the provider exposes a
// model list it also verifies the configured opus/sonnet/haiku IDs exist
// there. A provider can answer "reachable" while every real request 404s on
// a typo'd or retired model ID — this catches that.
export async function deepCheck(p) {
  let resp;
  try {
    resp = await fetchModels(p);
  } catch {
    return { ok: false, missing: [] };
  }
  if ([401, 402, 403, 429, 500, 502, 503, 504, 529].includes(resp.status)) {
    return { ok: false, missing: [] };
  }
  const configured = Object.entries(p.models || {})
    .filter(([, id]) => id)
    .map(([slot, id]) => ({ slot, id }));
  if (!configured.length || !resp.ok) return { ok: true, missing: [] };
  try {
    const data = await resp.json();
    const ids = new Set((data.data || data.models || []).map((m) => m && (m.id || m.name)).filter(Boolean));
    if (!ids.size) return { ok: true, missing: [] };
    const missing = configured.filter(({ id }) => !ids.has(id)).map(({ slot, id }) => `${slot}:${id}`);
    return { ok: true, missing };
  } catch {
    return { ok: true, missing: [] };
  }
}

export function startHealthLoop(getCfg) {
  const timer = setInterval(async () => {
    const cfg = getCfg();
    for (const p of cfg.providers) {
      if (!p.enabled || !p.apiKey) continue;
      const s = statsFor(cfg, p.id);
      if (!s.deadUntil || s.deadUntil <= Date.now()) continue; // healthy
      // Probe down providers periodically (RECHECK_MS) regardless of remaining
      // cooldown — long cooldowns (auth: up to 8h with backoff) otherwise keep
      // providers "down" on the dashboard long after they recover, while the
      // request path's all-down reset serves traffic just fine.
      const due = s.deadUntil - Date.now() <= PROBE_LEAD_MS
        || Date.now() - (s.lastCheck || 0) >= RECHECK_MS;
      if (!due) continue;

      s.lastCheck = Date.now();
      if (await probe(p)) {
        s.deadUntil = 0;
        s.deadReason = null;
        s.consecutiveFailures = 0;
        logEvent(cfg, `Provider "${p.name}" recovered — back in rotation`);
        persistSoon(cfg);
      }
    }
  }, LOOP_MS);
  if (timer.unref) timer.unref();
  return timer;
}
