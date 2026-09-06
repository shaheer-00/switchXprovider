// switchXprovider — management REST API for the dashboard and slash commands.
// Bound to 127.0.0.1 only; API keys are masked in responses.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { newId, statsFor, logEvent, persistSoon, emptyUsage, DIR, PROCESS_START } from './config.mjs';
import { enabledSorted, isDown, COOLDOWNS } from './proxy.mjs';
import { probe, deepCheck } from './health.mjs';

const JSON_HDR = { 'content-type': 'application/json' };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_SEED_PATH = path.join(__dirname, '..', 'catalog.json');
const CATALOG_CACHE_PATH = path.join(DIR, 'catalog-cache.json');

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
      enabled: body.enabled !== false,
      models,
    },
  };
}

export async function handleApi(req, res, pathname, cfg) {
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, action] = parts;

  try {
    // ---- GET endpoints ----
    if (method === 'GET' && resource === 'status') {
      return send(res, 200, {
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
      // Dense 14-day series (fill gaps with zeros so the chart never breaks).
      const days = [];
      const now = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const u = usage.daily?.[key] || {};
        days.push({
          date: key,
          inputTokens: u.inputTokens || 0,
          outputTokens: u.outputTokens || 0,
          requests: u.requests || 0,
          costUsd: u.costUsd || 0,
        });
      }
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
          requests: u.requests,
          costUsd: u.costUsd || 0,
        }))
        .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
      return send(res, 200, {
        totals: { ...emptyUsage(), ...(usage.totals || {}) },
        counters: cfg.counters || { failovers: 0 },
        byProvider,
        byModel,
        daily: days,
        recent: (cfg.requests || []).slice(0, 40),
      });
    }

    if (method === 'POST' && resource === 'usage' && id === 'reset') {
      cfg.usage = { totals: emptyUsage(), byProvider: {}, byModel: {}, daily: {} };
      cfg.requests = [];
      logEvent(cfg, 'Usage statistics reset');
      persistSoon(cfg, 0);
      return send(res, 200, { ok: true });
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
          priority: clean.length + 1,
          enabled: p.enabled !== false,
          models: typeof p.models === 'object' && p.models ? p.models : {},
        });
      }
      cfg.providers = clean;
      logEvent(cfg, `Imported ${clean.length} provider(s)`);
      persistSoon(cfg, 0);
      return send(res, 200, { ok: true, imported: clean.length });
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
        Object.assign(p, value);
        // Empty apiKey on edit means "keep existing" (dashboard doesn't resend it).
        if (!value.apiKey) p.apiKey = p.apiKey || '';
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
