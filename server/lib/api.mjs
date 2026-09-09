// switchXprovider — management REST API for the dashboard and slash commands.
// Bound to 127.0.0.1 only; API keys are masked in responses.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newId, statsFor, logEvent, persistSoon, emptyUsage, DIR, PROCESS_START } from './config.mjs';
import { PRICING, effectivePrice, aliasSuggestions, recalcCosts } from './pricing.mjs';
import { enabledSorted, isDown, COOLDOWNS } from './proxy.mjs';
import { probe, deepCheck, fetchModels } from './health.mjs';
import { enableRouting, disableRouting } from './routing.mjs';

const JSON_HDR = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_SEED_PATH = path.join(__dirname, '..', 'catalog.json');
const CATALOG_CACHE_PATH = path.join(DIR, 'catalog-cache.json');
// Plugin version (package.json at repo root) — reported via /api/status so the
// SessionStart hook and the dashboard can detect a stale running proxy.
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
// Marker written by ensure.mjs when a newer install exists: {version, path, ts}.
// Consumed by /api/status (dashboard popup) and /api/update-restart.
const UPDATE_MARKER_PATH = path.join(DIR, 'update-available.json');
// Official upstream catalog — the copy shipped in this repo, served raw from GitHub.
// "Restore official" syncs the local cache to it so users always get the maintained list.
const OFFICIAL_CATALOG_URL =
  'https://raw.githubusercontent.com/shaheer-00/switchXprovider/master/server/catalog.json';

function send(res, status, obj) {
  res.writeHead(status, JSON_HDR);
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return key.slice(0, 2) + '…';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function providerView(cfg, p) {
  const s = statsFor(cfg, p.id);
  const down = isDown(s);
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    maskedKey: maskKey(p.apiKey),
    authStyle: p.authStyle,
    protocol: p.protocol || 'anthropic',
    models: p.models || {},
    priority: p.priority,
    enabled: p.enabled,
    status: !p.enabled ? 'disabled' : down ? 'down' : 'up',
    statusDetail: down ? s.deadReason : null,
    downForMs: down ? s.deadUntil - Date.now() : 0,
    downTotalMs: down ? Math.max(1, s.deadUntil - (s.lastError?.ts || Date.now() - 60_000)) : 0,
    stats: {
      requests: s.requests,
      successes: s.successes,
      failures: s.failures,
      emaLatencyMs: s.emaLatencyMs,
      consecutiveFailures: s.consecutiveFailures,
      lastError: s.lastError,
    },
  };
}

function activeProviderName(cfg) {
  const alive = enabledSorted(cfg).find((p) => !isDown(statsFor(cfg, p.id)));
  return alive ? alive.name : null;
}

// ---- provider catalog (curated seed + optional remote overlay) ----

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadSeedCatalog() {
  return readJsonSafe(CATALOG_SEED_PATH) || { version: 1, providers: [] };
}

function loadRemoteCatalog() {
  return readJsonSafe(CATALOG_CACHE_PATH);
}

function mergedCatalog() {
  const seed = loadSeedCatalog();
  const remote = loadRemoteCatalog();
  const byId = new Map();
  for (const p of seed.providers || []) byId.set(p.id, p);
  for (const p of remote?.providers || []) {
    if (p && p.id && p.baseUrl) byId.set(p.id, { ...(byId.get(p.id) || {}), ...p, source: 'remote' });
  }
  return {
    version: seed.version,
    seedUpdated: seed.updated || null,
    remoteUpdated: remote?.updated || null,
    catalogUrlConfigured: Boolean(remote?.fetchedFrom),
    providers: [...byId.values()].sort((a, b) => (b.rating || 0) - (a.rating || 0)),
  };
}

async function refreshRemoteCatalog(cfg, url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const resp = await fetch(url, {
      headers: { 'user-agent': 'switchxprovider-catalog/1' },
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`catalog URL returned ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data.providers) || !data.providers.length) {
      throw new Error('catalog JSON must contain a non-empty "providers" array');
    }
    for (const p of data.providers) {
      if (!p.id || !p.baseUrl || !p.name) throw new Error('every catalog provider needs id, name, baseUrl');
    }
    const cache = { ...data, fetchedFrom: url, fetchedAt: Date.now() };
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CATALOG_CACHE_PATH, JSON.stringify(cache, null, 2));
    cfg.catalogUrl = url;
    persistSoon(cfg, 0);
    logEvent(cfg, `Provider catalog refreshed from ${url} (${data.providers.length} entries)`);
    return cache;
  } finally {
    clearTimeout(timer);
  }
}

// Is Claude Code's settings.json pointed at this proxy?
function claudeCodeStatus(cfg) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const env = settings.env || {};
    return {
      configured: env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${cfg.port}`,
      baseUrl: env.ANTHROPIC_BASE_URL || null,
      models: env.ANTHROPIC_DEFAULT_SONNET_MODEL || null,
    };
  } catch {
    return { configured: false, baseUrl: null, models: null };
  }
}

// Re-pack priorities to a dense 1..n sequence so swaps can never hit a tie
// (a tie makes ▲/▼ an identity swap — the provider would never move).
function normalizePriorities(cfg) {
  const sorted = cfg.providers.slice().sort((a, b) => (a.priority || 99) - (b.priority || 99));
  sorted.forEach((p, i) => (p.priority = i + 1));
}

// Extract a report object from a model's reply. Handles the clean case, code
// fences, and — the common small-model failure — a wall of reasoning prose
// that ends in (or embeds) the JSON object: walk every balanced-brace block
// and take the first one that parses with a report shape. A reply that just
// echoes the prompt's shape verbatim (lazy models do this) is not a report.
const TEMPLATE_ECHO = /one short sentence|max 4 bullets|short label|formatted value|short title/;
function extractReport(text) {
  const accepts = (r) => r && (r.headline || r.charts) && !TEMPLATE_ECHO.test(JSON.stringify(r));
  const stripped = text.replace(/```(?:json)?\s*/g, '').trim();
  try {
    const r = JSON.parse(stripped);
    if (accepts(r)) return r;
  } catch { /* fall through to brace walking */ }
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = !inStr;
      else if (!inStr && c === '{') depth++;
      else if (!inStr && c === '}') {
        depth--;
        if (depth === 0) {
          try {
            const r = JSON.parse(text.slice(i, j + 1));
            if (accepts(r)) return r;
          } catch { /* not this block */ }
          break;
        }
      }
    }
  }
  return null;
}

function sanitizeProviderInput(body) {
  const errors = [];
  const name = String(body.name || '').trim();
  const baseUrl = String(body.baseUrl || '').trim();
  if (!name) errors.push('name is required');
  if (!/^https?:\/\//.test(baseUrl)) errors.push('baseUrl must start with http:// or https://');
  const models = {};
  for (const slot of ['opus', 'sonnet', 'haiku']) {
    const v = String(body.models?.[slot] || '').trim();
    if (v) models[slot] = v;
  }
  return {
    errors,
    value: {
      name,
      baseUrl,
      apiKey: String(body.apiKey || '').trim(),
      authStyle: ['anthropic', 'bearer', 'auto'].includes(body.authStyle) ? body.authStyle : 'auto',
      protocol: body.protocol === 'openai' ? 'openai' : 'anthropic',
      enabled: body.enabled !== false,
      models,
    },
  };
}

// Read the update marker. Returns {version} when a newer install is waiting,
// null otherwise. A marker matching our own version means the update already
// landed — delete it (self-cleanup after a successful restart).
function readUpdateMarker() {
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(UPDATE_MARKER_PATH, 'utf8'));
  } catch {
    return null;
  }
  if (!marker.version || !marker.path) return null;
  if (marker.version === PKG.version) {
    try { fs.rmSync(UPDATE_MARKER_PATH, { force: true }); } catch { /* best effort */ }
    return null;
  }
  return { version: marker.version }; // path stays server-side
}

export async function handleApi(req, res, pathname, cfg) {
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, action] = parts;

  try {
    // ---- GET endpoints ----
    if (method === 'GET' && resource === 'status') {
      return send(res, 200, {
        version: PKG.version,
        update: readUpdateMarker(),
        port: cfg.port,
        uptimeSec: Math.round((Date.now() - PROCESS_START) / 1000),
        activeProvider: activeProviderName(cfg),
        cooldowns: COOLDOWNS,
        claudeCode: claudeCodeStatus(cfg),
        catalogUrl: cfg.catalogUrl || null,
        providers: enabledSorted(cfg)
          .concat(cfg.providers.filter((p) => !p.enabled))
          .map((p) => providerView(cfg, p)),
        events: cfg.events.slice(0, 200),
      });    }

    if (method === 'GET' && resource === 'events') {
      return send(res, 200, { events: cfg.events });
    }

    // ---- usage analytics ----
    if (method === 'GET' && resource === 'usage') {
      const usage = cfg.usage || { totals: {}, byProvider: {}, daily: {} };
      // Dense N-day series (fill gaps with zeros so the chart never breaks).
      // ?days= widens the window (1..90, default 14) for the share card.
      let windowDays = 14;
      try {
        const raw = new URL(req.url, 'http://localhost').searchParams.get('days');
        if (raw !== null) {
          const q = Number(raw);
          if (Number.isFinite(q)) windowDays = Math.min(90, Math.max(1, Math.round(q)));
        }
      } catch { /* no/invalid query — keep default */ }
      const dayKey = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const now = new Date();
      const days = [];
      for (let i = windowDays - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const u = usage.daily?.[dayKey(d)] || {};
        days.push({
          date: dayKey(d),
          inputTokens: u.inputTokens || 0,
          outputTokens: u.outputTokens || 0,
          cacheReadTokens: u.cacheReadTokens || 0,
          cacheCreationTokens: u.cacheCreationTokens || 0,
          requests: u.requests || 0,
          costUsd: u.costUsd || 0,
        });
      }
      // Period aggregates for the share card: today / 7d / 14d / 30d / all-time,
      // summed from the full daily history (which is kept forever).
      const sumDays = (offsets) => {
        const out = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0, costUsd: 0 };
        for (const off of offsets) {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - off);
          const u = usage.daily?.[dayKey(d)] || {};
          out.inputTokens += u.inputTokens || 0;
          out.outputTokens += u.outputTokens || 0;
          out.cacheReadTokens += u.cacheReadTokens || 0;
          out.cacheCreationTokens += u.cacheCreationTokens || 0;
          out.requests += u.requests || 0;
          out.costUsd += u.costUsd || 0;
        }
        return out;
      };
      const range = (n) => Array.from({ length: n }, (_, i) => i);
      const totals = { ...emptyUsage(), ...(usage.totals || {}) };
      const periods = {
        today: sumDays(range(1)),
        d7: sumDays(range(7)),
        d14: sumDays(range(14)),
        d30: sumDays(range(30)),
        all: {
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens || 0,
          cacheCreationTokens: totals.cacheCreationTokens || 0,
          requests: totals.requests,
          costUsd: totals.costUsd || 0,
        },
      };
      const byProvider = Object.entries(usage.byProvider || {}).map(([id, u]) => ({
        id,
        name: u.name,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheCreationTokens: u.cacheCreationTokens,
        requests: u.requests,
        costUsd: u.costUsd || 0,
      }));
      const byModel = Object.entries(usage.byModel || {})
        .map(([model, u]) => ({
          model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheCreationTokens: u.cacheCreationTokens,
          requests: u.requests,
          costUsd: u.costUsd || 0,
        }))
        .sort((a, b) => ((b.inputTokens + b.outputTokens + (b.cacheReadTokens || 0) + (b.cacheCreationTokens || 0))
          - (a.inputTokens + a.outputTokens + (a.cacheReadTokens || 0) + (a.cacheCreationTokens || 0))));
      // models with no price anywhere (no model-level, no per-provider override)
      const unpricedModels = Object.keys(usage.byModel || {}).filter((m) => {
        if (effectivePrice(m, undefined, cfg.pricing).price) return false;
        return !Object.keys(cfg.pricing?.providerOverrides || {}).some((k) => k.endsWith(' ' + m));
      });
      return send(res, 200, {
        totals: { ...emptyUsage(), ...(usage.totals || {}) },
        periods,
        unpricedModels,
        counters: cfg.counters || { failovers: 0 },
        byProvider,
        byModel,
        daily: days,
        recent: (cfg.requests || []).slice(0, 40),
      });
    }

    if (method === 'POST' && resource === 'usage' && id === 'reset') {
      cfg.usage = { totals: emptyUsage(), byProvider: {}, byModel: {}, byProject: {}, daily: {} };
      cfg.requests = [];
      logEvent(cfg, 'Usage statistics reset');
      persistSoon(cfg, 0);
      return send(res, 200, { ok: true });
    }

    // ---- Chaptions: per-project usage ----
    const tokOf = (b) => (b.inputTokens || 0) + (b.cacheReadTokens || 0) + (b.cacheCreationTokens || 0) + (b.outputTokens || 0);
    if (method === 'GET' && resource === 'chaptions') {
      const usage = cfg.usage || {};
      const totals = { ...emptyUsage(), ...(usage.totals || {}) };
      const projects = Object.values(usage.byProject || {}).map((b) => ({
        dir: b.dir,
        name: b.name,
        tokens: tokOf(b),
        inputTokens: b.inputTokens || 0,
        outputTokens: b.outputTokens || 0,
        cacheReadTokens: b.cacheReadTokens || 0,
        requests: b.requests || 0,
        costUsd: b.costUsd || 0,
        byDay: Object.entries(b.byDay || {}).map(([date, d]) => ({ date, tokens: tokOf(d), requests: d.requests || 0, costUsd: d.costUsd || 0 })),
      })).sort((a, b) => b.tokens - a.tokens);
      const attributed = projects.reduce((s, p) => s + p.tokens, 0);
      const totalTokens = tokOf(totals);
      for (const p of projects) p.share = totalTokens > 0 ? p.tokens / totalTokens : 0;
      return send(res, 200, {
        totals: {
          tokens: totalTokens,
          requests: totals.requests || 0,
          costUsd: totals.costUsd || 0,
        },
        projects,
        unattributed: {
          tokens: Math.max(0, totalTokens - attributed),
          // everything recorded before project tracking shipped (or from
          // non-Claude-Code clients without a session stamp)
          note: 'recorded before project tracking existed, or from clients without a session id',
        },
      });
    }

    // AI analysis: the proxy calls itself through its own failover routing,
    // so the analysis runs on whatever provider is healthy — usually free.
    if (method === 'POST' && resource === 'chaptions' && id === 'analyze') {
      const usage = cfg.usage || {};
      const totals = { ...emptyUsage(), ...(usage.totals || {}) };
      const projects = Object.values(usage.byProject || {})
        .map((b) => ({ name: b.name, tokens: tokOf(b), costUsd: b.costUsd || 0, requests: b.requests || 0 }))
        .sort((a, b) => b.tokens - a.tokens);
      if (!projects.length) {
        return send(res, 200, { ok: false, error: 'No attributed usage yet — make some requests from Claude Code first.' });
      }
      const stats = {
        totals: { tokens: tokOf(totals), requests: totals.requests || 0, costUsd: totals.costUsd || 0 },
        projects: projects.slice(0, 10),
        topModels: Object.entries(usage.byModel || {})
          .map(([model, b]) => ({ model, tokens: tokOf(b), requests: b.requests || 0 }))
          .sort((a, b) => b.tokens - a.tokens).slice(0, 8),
        topProviders: Object.entries(usage.byProvider || {})
          .map(([id, b]) => ({ provider: b.name, tokens: tokOf(b), requests: b.requests || 0, costUsd: b.costUsd || 0 }))
          .sort((a, b) => b.tokens - a.tokens).slice(0, 6),
        daily: Object.entries(usage.daily || {})
          .map(([date, b]) => ({ date, tokens: tokOf(b), requests: b.requests || 0 }))
          .sort((a, b) => a.date < b.date ? -1 : 1).slice(-14),
      };
      const prompt = `You analyze a developer's local LLM proxy usage. Given this JSON of per-project token usage, model and provider breakdowns, and a 14-day daily series, produce a SHORT visual report.

Return ONLY valid JSON (no markdown fences, no prose outside JSON) with this exact shape:
{
  "headline": "one short sentence (max 12 words)",
  "insights": ["max 4 bullets, each max 12 words"],
  "stats": [{"label": "short label", "value": "formatted value"}],
  "charts": [
    {"type": "bar", "title": "short title", "points": [{"label": "name", "value": 123}]},
    {"type": "donut", "title": "short title", "points": [{"label": "name", "value": 123}]}
  ]
}
Rules: 2-3 charts max (e.g. projects by tokens, models donut). Numbers in charts must be raw values from the data, not invented. Keep every string short — this renders as graphs, not an essay. Respond with the JSON object only — no reasoning, no markdown, no prose. Do NOT copy the shape example verbatim — fill every field with real values from the data.

Usage data:
${JSON.stringify(stats)}`;
      // A provider can 400 a single model slot ("model not available" from a
      // dead upstream channel) — the proxy correctly passes 400s through
      // without failover, so the analysis call itself rotates across the
      // sonnet → opus → haiku slots. A slot that answers with prose instead
      // of JSON also rotates away; raw prose is the last resort.
      let lastErr = null;
      let lastRaw = null;
      for (const slotModel of ['switchx:sonnet', 'switchx:opus', 'switchx:haiku']) {
        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 60_000);
          const r = await fetch(`http://127.0.0.1:${cfg.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'switchx-local' },
            body: JSON.stringify({
              model: slotModel,
              max_tokens: 1500,
              messages: [{ role: 'user', content: prompt }],
            }),
            signal: ac.signal,
          });
          clearTimeout(timer);
          const j = await r.json().catch(() => null);
          const text = (j?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
          if (text) {
            const report = extractReport(text);
            if (report) return send(res, 200, { ok: true, report, raw: null });
            lastRaw = text;
            lastErr = `model returned prose instead of JSON (${slotModel})`;
            continue;
          }
          const why = j?.error?.message ? ` — ${j.error.message}` : '';
          lastErr = `HTTP ${r.status}${why} (${slotModel})`;
        } catch (e) {
          lastErr = `${e.message} (${slotModel})`;
        }
      }
      if (lastRaw) return send(res, 200, { ok: true, report: null, raw: lastRaw });
      return send(res, 200, {
        ok: false,
        error: `Analysis failed on every model slot (sonnet, opus, haiku). Last error: ${lastErr}. Check the provider's model IDs in the Providers view — the channel may be down upstream.`,
      });
    }

    // ---- pricing ----
    if (method === 'GET' && resource === 'pricing') {
      cfg.pricing ??= {};
      const providerOverrides = cfg.pricing.providerOverrides || {};
      const aliases = cfg.pricing.aliases || {};
      // every model we could ever price: seen in usage, mapped in a provider, or built-in
      const seen = new Map(); // model → byModel usage bucket (or null)
      for (const [model, u] of Object.entries(cfg.usage?.byModel || {})) seen.set(model, u);
      for (const p of cfg.providers) {
        for (const m of Object.values(p.models || {})) if (m && !seen.has(m)) seen.set(m, null);
      }
      for (const m of Object.keys(PRICING)) if (!seen.has(m)) seen.set(m, null);
      const models = [...seen.entries()].map(([model, u]) => {
        const { price, source } = effectivePrice(model, undefined, cfg.pricing);
        const provs = Object.entries(providerOverrides)
          .filter(([k]) => k.endsWith(' ' + model))
          .map(([k, p]) => {
            const providerId = k.slice(0, -(model.length + 1));
            return { providerId, name: cfg.providers.find((x) => x.id === providerId)?.name || providerId, price: p };
          });
        return {
          model,
          tokens: u ? (u.inputTokens || 0) + (u.outputTokens || 0) : 0,
          requests: u?.requests || 0,
          costUsd: u?.costUsd || 0,
          price,
          source: price ? source : provs.length ? 'provider' : 'none',
          unpriced: !price && !provs.length,
          providers: provs,
        };
      }).sort((a, b) => b.tokens - a.tokens);
      const suggestions = aliasSuggestions([...seen.keys()].filter((m) => !aliases[m]));
      return send(res, 200, { models, aliases, suggestions });
    }

    if (method === 'PUT' && resource === 'pricing') {
      const body = await readJson(req);
      const model = String(body.model || '').trim();
      const price = body.price;
      const NUMS = ['input', 'output', 'cacheRead', 'cacheCreate'];
      if (!model || model.length > 200) return send(res, 400, { error: 'model is required' });
      if (!price || !NUMS.every((k) => Number.isFinite(Number(price[k])) && Number(price[k]) >= 0)) {
        return send(res, 400, { error: 'price needs non-negative numbers for input, output, cacheRead, cacheCreate (per 1M tokens)' });
      }
      const p = Object.fromEntries(NUMS.map((k) => [k, Number(price[k])]));
      if (body.providerId && !cfg.providers.some((x) => x.id === body.providerId)) {
        return send(res, 400, { error: 'unknown provider' });
      }
      cfg.pricing ??= {};
      const before = effectivePrice(model, body.providerId, cfg.pricing);
      if (body.providerId) {
        cfg.pricing.providerOverrides ??= {};
        cfg.pricing.providerOverrides[`${body.providerId} ${model}`] = p;
      } else {
        cfg.pricing.overrides ??= {};
        cfg.pricing.overrides[model] = p;
      }
      logEvent(cfg, `Price set for ${model}${body.providerId ? ' (per-provider)' : ''}`);
      persistSoon(cfg, 0);
      return send(res, 200, { ok: true, changed: !before.price || JSON.stringify(before.price) !== JSON.stringify(p) });
    }

    if (method === 'POST' && resource === 'pricing' && id === 'remove') {
      const body = await readJson(req);
      const model = String(body.model || '').trim();
      if (!model) return send(res, 400, { error: 'model is required' });
      cfg.pricing ??= {};
      if (body.providerId) {
        delete cfg.pricing.providerOverrides?.[`${body.providerId} ${model}`];
      } else {
        delete cfg.pricing.overrides?.[model];
      }
      logEvent(cfg, `Price removed for ${model}${body.providerId ? ' (per-provider)' : ''}`);
      persistSoon(cfg, 0);
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && resource === 'pricing' && id === 'alias') {
      const body = await readJson(req);
      const alias = String(body.alias || '').trim();
      if (!alias) return send(res, 400, { error: 'alias is required' });
      cfg.pricing ??= {};
      cfg.pricing.aliases ??= {};
      if (!body.canonical) {
        delete cfg.pricing.aliases[alias];
        logEvent(cfg, `Model alias removed: ${alias}`);
      } else {
        const canonical = String(body.canonical).trim();
        if (canonical === alias) return send(res, 400, { error: 'alias and canonical must differ' });
        if (cfg.pricing.aliases[canonical]) return send(res, 400, { error: 'canonical is itself an alias' });
        cfg.pricing.aliases[alias] = canonical;
        logEvent(cfg, `Model alias set: ${alias} → ${canonical}`);
      }
      persistSoon(cfg, 0);
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && resource === 'pricing' && id === 'recalc') {
      const result = recalcCosts(cfg);
      logEvent(cfg, 'Usage costs recalculated with current prices');
      persistSoon(cfg, 0);
      return send(res, 200, { ok: true, ...result });
    }

    // ---- update lifecycle ----
    // Graceful stop (used by ensure.mjs when a newer install replaces us).
    if (method === 'POST' && resource === 'shutdown') {
      send(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 150); // let the response flush
      return;
    }

    // One-click update from the dashboard: hand over to the newer install's
    // ensure.mjs, which shuts us down and starts the new proxy in our place.
    if (method === 'POST' && resource === 'update-restart') {
      let marker = null;
      try {
        marker = JSON.parse(fs.readFileSync(UPDATE_MARKER_PATH, 'utf8'));
      } catch { /* no marker */ }
      if (!marker?.version || !marker.path || marker.version === PKG.version) {
        return send(res, 400, { error: 'no pending update' });
      }
      const ensurePath = path.join(marker.path, 'server', 'ensure.mjs');
      if (!fs.existsSync(ensurePath)) {
        return send(res, 400, { error: `update source not found: ${marker.path}` });
      }
      const child = spawn(process.execPath, [ensurePath, '--replace'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      logEvent(cfg, `Update to ${marker.version} requested — restarting proxy`);
      return send(res, 200, { ok: true, updatingTo: marker.version });
    }

    // ---- routing toggle (subscription users: off until usage warning) ----
    if (method === 'POST' && resource === 'routing') {
      const body = await readJson(req);
      const enabled = body.enabled === true;
      // Enabling needs at least one enabled provider — otherwise Claude Code
      // would be left with no API at all.
      if (enabled && !enabledSorted(cfg).length) {
        return send(res, 400, { error: 'add and enable at least one provider first' });
      }
      const result = enabled
        ? enableRouting(cfg.port, (msg) => logEvent(cfg, msg))
        : disableRouting(cfg.port, (msg) => logEvent(cfg, msg));
      return send(res, 200, { ok: true, ...result, ...claudeCodeStatus(cfg) });
    }

    // ---- provider catalog ----
    if (method === 'GET' && resource === 'catalog') {
      return send(res, 200, mergedCatalog());
    }

    if (method === 'POST' && resource === 'catalog' && id === 'refresh') {
      const body = await readJson(req);
      const url = String(body.url || cfg.catalogUrl || '').trim();
      if (!/^https?:\/\//.test(url)) return send(res, 400, { error: 'url must start with http:// or https://' });
      try {
        const cache = await refreshRemoteCatalog(cfg, url);
        return send(res, 200, { ok: true, fetched: cache.providers.length, fetchedFrom: cache.fetchedFrom, fetchedAt: cache.fetchedAt });
      } catch (err) {
        return send(res, 502, { error: `catalog refresh failed: ${err.message}` });
      }
    }

    // Restore the official catalog: clear any custom remote overlay and re-sync to
    // the upstream GitHub copy (falls back to the shipped seed if GitHub is unreachable).
    if (method === 'POST' && resource === 'catalog' && id === 'reset') {
      let fellBack = false;
      let fetched = 0;
      try {
        const cache = await refreshRemoteCatalog(cfg, OFFICIAL_CATALOG_URL);
        fetched = cache.providers.length;
      } catch {
        // Offline / GitHub unreachable: drop the custom overlay, keep the shipped seed.
        fellBack = true;
        try { fs.rmSync(CATALOG_CACHE_PATH, { force: true }); } catch {}
        delete cfg.catalogUrl;
        persistSoon(cfg, 0);
        logEvent(cfg, 'Provider catalog restored to the official list (offline — using shipped catalog)');
      }
      return send(res, 200, {
        ok: true,
        fetched,
        offline: fellBack,
        fetchedFrom: fellBack ? null : OFFICIAL_CATALOG_URL,
      });
    }

    // ---- config backup / restore ----
    if (method === 'GET' && resource === 'export') {
      const clone = JSON.parse(JSON.stringify({ providers: cfg.providers, usage: cfg.usage, catalogUrl: cfg.catalogUrl, port: cfg.port }));
      return send(res, 200, { exportedAt: Date.now(), config: clone });
    }

    if (method === 'POST' && resource === 'import') {
      const body = await readJson(req);
      const providers = Array.isArray(body) ? body : body.providers;
      if (!Array.isArray(providers) || !providers.length) {
        return send(res, 400, { error: 'send a config object from /api/export, or a providers array' });
      }
      const clean = [];
      for (const p of providers) {
        if (!p.name || !p.baseUrl || !/^https?:\/\//.test(p.baseUrl)) {
          return send(res, 400, { error: `provider "${p.name || '(unnamed)'}" invalid: needs name and http(s) baseUrl` });
        }
        clean.push({
          id: p.id || newId(),
          name: String(p.name),
          baseUrl: String(p.baseUrl),
          apiKey: String(p.apiKey || ''),
          authStyle: ['anthropic', 'bearer', 'auto'].includes(p.authStyle) ? p.authStyle : 'auto',
          protocol: p.protocol === 'openai' ? 'openai' : 'anthropic',
          // Honor the exported priority when every entry has a usable one;
          // array position is insertion order, not routing order.
          priority: providers.every((x) => Number.isFinite(parseInt(x.priority, 10)) && parseInt(x.priority, 10) >= 1)
            ? parseInt(p.priority, 10)
            : clean.length + 1,
          enabled: p.enabled !== false,
          models: typeof p.models === 'object' && p.models ? p.models : {},
        });
      }
      // Dedupe/compact priorities to a dense 1..N set preserving relative order.
      const byPrio = [...clean].sort((a, b) => a.priority - b.priority);
      byPrio.forEach((p, i) => { p.priority = i + 1; });
      clean.sort((a, b) => a.priority - b.priority);
      cfg.providers = clean;
      logEvent(cfg, `Imported ${clean.length} provider(s)`);
      persistSoon(cfg, 0);
      return send(res, 200, { ok: true, imported: clean.length });
    }

    // ---- model discovery: list a provider's models before it is saved ----
    // Takes raw baseUrl + apiKey (nothing is persisted), calls GET {base}/v1/models,
    // and returns the IDs so the dashboard can auto-fill the opus/sonnet/haiku
    // slots instead of asking the user to copy-paste them by hand.
    if (method === 'POST' && resource === 'providers' && id === 'fetch-models' && !action) {
      const body = await readJson(req);
      const baseUrl = String(body.baseUrl || '').trim();
      let apiKey = String(body.apiKey || '').trim();
      // Editing an existing provider: the form leaves the key blank (it's
      // stored server-side, never sent to the client), so fall back to the
      // saved key when a providerId is supplied.
      if (!apiKey && body.providerId) {
        const existing = cfg.providers.find((x) => x.id === body.providerId);
        if (existing) apiKey = existing.apiKey || '';
      }
      if (!/^https?:\/\//.test(baseUrl)) return send(res, 400, { error: 'baseUrl must start with http:// or https://' });
      if (!apiKey) return send(res, 400, { error: 'apiKey is required' });
      const target = {
        baseUrl,
        apiKey,
        authStyle: ['anthropic', 'bearer', 'auto'].includes(body.authStyle) ? body.authStyle : 'auto',
      };
      let resp2;
      try {
        resp2 = await fetchModels(target);
      } catch (e) {
        return send(res, 200, { models: [], error: `could not reach ${baseUrl} — ${e.message}` });
      }
      if (resp2.status === 401 || resp2.status === 403) {
        return send(res, 200, { models: [], error: `authentication failed (${resp2.status}) — check the API key` });
      }
      if (resp2.status === 404 || resp2.status === 405) {
        return send(res, 200, { models: [], error: 'this provider does not expose a model list — enter the model IDs manually' });
      }
      if (!resp2.ok) {
        return send(res, 200, { models: [], error: `provider returned HTTP ${resp2.status}` });
      }
      try {
        const data = await resp2.json();
        const ids = [...new Set((data.data || data.models || [])
          .map((m) => m && (m.id || m.name))
          .filter((x) => typeof x === 'string' && x))].sort();
        if (!ids.length) return send(res, 200, { models: [], error: 'model list came back empty — enter the model IDs manually' });
        return send(res, 200, { models: ids });
      } catch {
        return send(res, 200, { models: [], error: 'model list is not valid JSON — enter the model IDs manually' });
      }
    }

    // ---- provider CRUD ----
    if (resource === 'providers') {
      if (method === 'POST' && !id) {
        const body = await readJson(req);
        const { errors, value } = sanitizeProviderInput(body);
        if (errors.length) return send(res, 400, { error: errors.join('; ') });
        if (!value.apiKey) return send(res, 400, { error: 'apiKey is required' });
        const p = {
          id: newId(),
          ...value,
          priority: (cfg.providers.length || 0) + 1,
        };
        cfg.providers.push(p);
        logEvent(cfg, `Provider "${p.name}" added (priority ${p.priority})`);
        persistSoon(cfg, 0);
        return send(res, 201, providerView(cfg, p));
      }

      if (method === 'PUT' && id) {
        const p = cfg.providers.find((x) => x.id === id);
        if (!p) return send(res, 404, { error: 'provider not found' });
        const body = await readJson(req);
        const { errors, value } = sanitizeProviderInput(body);
        if (errors.length) return send(res, 400, { error: errors.join('; ') });
        // Empty apiKey on edit means "keep existing" (dashboard doesn't resend it).
        // Capture it BEFORE the assign — Object.assign would wipe it with ''.
        const prevKey = p.apiKey;
        Object.assign(p, value);
        if (!value.apiKey) p.apiKey = prevKey || '';
        if (body.priority != null) p.priority = Math.max(1, parseInt(body.priority, 10) || 1);
        logEvent(cfg, `Provider "${p.name}" updated`);
        persistSoon(cfg, 0);
        return send(res, 200, providerView(cfg, p));
      }

      if (method === 'DELETE' && id) {
        const idx = cfg.providers.findIndex((x) => x.id === id);
        if (idx === -1) return send(res, 404, { error: 'provider not found' });
        const [removed] = cfg.providers.splice(idx, 1);
        delete cfg.stats[id];
        normalizePriorities(cfg);
        logEvent(cfg, `Provider "${removed.name}" removed`);
        persistSoon(cfg, 0);
        return send(res, 200, { ok: true });
      }

      if (method === 'POST' && id && action) {
        const p = cfg.providers.find((x) => x.id === id);
        if (!p) return send(res, 404, { error: 'provider not found' });

        if (action === 'test') {
          const { ok, missing } = await deepCheck(p);
          const s = statsFor(cfg, p.id);
          if (ok && s.deadUntil) {
            s.deadUntil = 0;
            s.deadReason = null;
            logEvent(cfg, `Provider "${p.name}" passed manual test — back in rotation`);
          } else if (!ok) {
            logEvent(cfg, `Provider "${p.name}" failed manual test`);
          }
          if (missing.length) {
            logEvent(cfg, `Provider "${p.name}" missing model IDs: ${missing.join(', ')}`);
          }
          persistSoon(cfg, 0);
          return send(res, 200, { ok, missing });
        }

        if (action === 'reset') {
          const s = statsFor(cfg, p.id);
          s.deadUntil = 0;
          s.deadReason = null;
          s.consecutiveFailures = 0;
          logEvent(cfg, `Provider "${p.name}" state reset — back in rotation`);
          persistSoon(cfg, 0);
          return send(res, 200, { ok: true });
        }

        if (action === 'up' || action === 'down') {
          const sorted = cfg.providers.slice().sort((a, b) => (a.priority || 99) - (b.priority || 99));
          const idx = sorted.findIndex((x) => x.id === id);
          const swapWith = action === 'up' ? idx - 1 : idx + 1;
          if (swapWith >= 0 && swapWith < sorted.length) {
            const a = sorted[idx];
            const b = sorted[swapWith];
            const tmp = a.priority;
            a.priority = b.priority;
            b.priority = tmp;
            normalizePriorities(cfg);
            logEvent(cfg, `Priority changed: "${a.name}" → ${a.priority}, "${b.name}" → ${b.priority}`);
            persistSoon(cfg, 0);
          }
          return send(res, 200, { ok: true });
        }

        if (action === 'reorder') {
          const body = await readJson(req);
          // Sort by priority first — the array itself may not be in priority order.
          const sorted = cfg.providers.slice().sort((a, b) => (a.priority || 99) - (b.priority || 99));
          const idx = Math.max(0, Math.min(sorted.length - 1, parseInt(body.index, 10) || 0));
          const cur = sorted.findIndex((x) => x.id === id);
          if (cur === -1) return send(res, 404, { error: 'provider not found' });
          const [moved] = sorted.splice(cur, 1);
          sorted.splice(idx, 0, moved);
          // The array order IS the priority order now — assign dense 1..n from
          // position. normalizePriorities() would re-sort by the old numbers
          // and undo the move.
          cfg.providers = sorted;
          sorted.forEach((p, i) => (p.priority = i + 1));
          logEvent(cfg, `Provider "${moved.name}" moved to priority ${idx + 1}`);
          persistSoon(cfg, 0);
          return send(res, 200, { ok: true });
        }
      }
    }

    if (method === 'POST' && resource === 'events' && id === 'clear') {
      cfg.events = [];
      persistSoon(cfg, 0);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: `unknown API route: ${method} ${pathname}` });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
}
