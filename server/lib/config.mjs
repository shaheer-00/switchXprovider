// switchXprovider — config storage (~/.claude/switchx/config.json)
// Zero dependencies. Config holds providers, per-provider stats, and an event log.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { estimateCost } from './pricing.mjs';

// Home is overridable (SWITCHX_HOME) so tests can run against an isolated config.
export const DIR = process.env.SWITCHX_HOME
  ? path.resolve(process.env.SWITCHX_HOME)
  : path.join(os.homedir(), '.claude', 'switchx');
export const CONFIG_PATH = path.join(DIR, 'config.json');
export const LOG_PATH = path.join(DIR, 'server.log');

export const DEFAULT_PORT = 8787;
export const LOCAL_TOKEN = 'switchx-local';
export const PROCESS_START = Date.now();

const DEFAULTS = {
  port: DEFAULT_PORT,
  providers: [],
  stats: {},
  events: [],
};

const TEMPLATES = [
  {
    id: 'template-anthropic',
    name: 'Anthropic (template)',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    authStyle: 'auto',
    priority: 1,
    enabled: false,
    models: { opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001' },
  },
  {
    id: 'template-openrouter',
    name: 'OpenRouter (template)',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    authStyle: 'auto',
    priority: 2,
    enabled: false,
    models: { opus: 'anthropic/claude-opus-5', sonnet: 'anthropic/claude-sonnet-5', haiku: 'anthropic/claude-haiku-4.5' },
  },
];

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const cfg = { ...structuredClone(DEFAULTS), ...raw };
    if (!Array.isArray(cfg.providers)) cfg.providers = [];
    if (!cfg.stats || typeof cfg.stats !== 'object') cfg.stats = {};
    if (!Array.isArray(cfg.events)) cfg.events = [];
    return cfg;
  } catch {
    const cfg = structuredClone(DEFAULTS);
    cfg.providers = structuredClone(TEMPLATES);
    save(cfg);
    return cfg;
  }
}

export function save(cfg) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

// Debounced save — proxy traffic updates stats on every request; don't hit the disk each time.
let saveTimer = null;
export function persistSoon(cfg, delayMs = 3000) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      save(cfg);
    } catch (err) {
      console.error('switchx: failed to save config:', err.message);
    }
  }, delayMs);
  if (saveTimer.unref) saveTimer.unref();
}

export function newId() {
  return crypto.randomUUID();
}

export function statsFor(cfg, id) {
  if (!cfg.stats[id]) {
    cfg.stats[id] = {
      requests: 0,
      successes: 0,
      failures: 0,
      emaLatencyMs: null,
      consecutiveFailures: 0,
      deadUntil: 0,
      deadReason: null,
      lastError: null,
      lastCheck: 0,
    };
  }
  const s = cfg.stats[id];
  for (const k of ['requests', 'successes', 'failures', 'consecutiveFailures', 'deadUntil', 'lastCheck']) {
    if (typeof s[k] !== 'number') s[k] = 0;
  }
  return s;
}

export function logEvent(cfg, msg) {
  cfg.events.unshift({ ts: Date.now(), msg });
  if (cfg.events.length > 200) cfg.events.length = 200;
  persistSoon(cfg);
}

// ---- usage tracking ----

export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0, costUsd: 0 };
}

function bump(bucket, u, cost) {
  bucket.inputTokens += u.input || 0;
  bucket.outputTokens += u.output || 0;
  bucket.cacheReadTokens += u.cacheRead || 0;
  bucket.cacheCreationTokens += u.cacheCreation || 0;
  bucket.requests++;
  if (cost) bucket.costUsd = (bucket.costUsd || 0) + cost;
}

export function recordUsage(cfg, providerId, providerName, u, model) {
  if (!u || (!u.input && !u.output && !u.cacheRead && !u.cacheCreation)) return;
  if (!cfg.usage) cfg.usage = { totals: emptyUsage(), byProvider: {}, byModel: {}, daily: {} };
  const day = new Date().toISOString().slice(0, 10);
  const cost = estimateCost(u, model);
  cfg.usage.byProvider[providerId] ??= { name: providerName, ...emptyUsage() };
  cfg.usage.daily[day] ??= emptyUsage();
  bump(cfg.usage.totals, u, cost);
  bump(cfg.usage.byProvider[providerId], u, cost);
  bump(cfg.usage.daily[day], u, cost);
  if (model) {
    cfg.usage.byModel[model] ??= { ...emptyUsage() };
    bump(cfg.usage.byModel[model], u, cost);
  }
  persistSoon(cfg);
}

export function pushRequest(cfg, record) {
  if (!Array.isArray(cfg.requests)) cfg.requests = [];
  cfg.requests.unshift(record);
  if (cfg.requests.length > 100) cfg.requests.length = 100;
  persistSoon(cfg);
}

// Global counters (failovers etc.) — survives restarts alongside the config.
export function countFailover(cfg) {
  cfg.counters ??= { failovers: 0 };
  cfg.counters.failovers++;
  persistSoon(cfg);
}
