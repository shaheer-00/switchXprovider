// switchXprovider — per-model pricing for cost estimation.
//
// Gateway providers (agentrouter, bynara, seekai, etc.) typically use flat-rate
// subscriptions, free tiers, or credit systems — their per-token cost is $0 for
// the user. Official providers (Anthropic direct, OpenRouter) charge per-token.
//
// The pricing table below covers every model we can see in usage tracking:
//   - Claude models from Anthropic API — official published rates
//   - DeepSeek models — official DeepSeek pricing (very cheap)
//   - GLM models — Z.AI pricing
//   - Free-tier gateway models — $0 (bynara, agentrouter free tiers)
//
// Models not in the table default to $0. Update when new models appear.
//
// Prices are per-1M tokens (multiply by token count, divide by 1M).

export const PRICING = {
  // ── Claude models (Anthropic official) ──────────────────────────
  // Opus 5 launched 2026-07-24 at the same price as Opus 4.8: $5/$25,
  // cache read $0.50 (0.1x), cache write $6.25 (1.25x).
  // https://www.anthropic.com/news/claude-opus-5
  'claude-opus-5':         { input: 5.00, output: 25.00, cacheRead: 0.50, cacheCreate: 6.25 },
  'claude-opus-4-8':       { input: 5.00, output: 25.00, cacheRead: 0.50, cacheCreate: 6.25 },
  'claude-opus-5-thinking':{ input: 5.00, output: 25.00, cacheRead: 0.50, cacheCreate: 6.25 },
  // Sonnet 5: the planned step-up to $3/$15 (set for 2026-09-01) was
  // cancelled on 2026-08-10 — $2/$10 is the permanent standard rate.
  'claude-sonnet-5':       { input:  2.00, output: 10.00, cacheRead: 0.20, cacheCreate:  2.50 },
  // Haiku 4.5: $1/$5 (the previous $0.80/$4 row was Haiku 3.5 pricing).
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheCreate: 1.25 },

  // ── DeepSeek (official, very cheap) ─────────────────────────────
  'deepseek-chat':         { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheCreate: 0.14 },
  'deepseek-v4-flash':     { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheCreate: 0.14 },
  'deepseek-v4-flash-free':{ input: 0.00, output: 0.00, cacheRead: 0.00,  cacheCreate: 0.00  },

  // ── Z.AI GLM ────────────────────────────────────────────────────
  // GLM-5.2/5.1/5.3 share the same rate card ($1.40/$4.40, cache read $0.26,
  // cached-input storage free). GLM-5.3-Flash: $0.15/$0.50.
  'glm-5.3':               { input: 1.40, output: 4.40, cacheRead: 0.26,  cacheCreate: 0.00 },
  'glm-5.2':               { input: 1.40, output: 4.40, cacheRead: 0.26,  cacheCreate: 0.00 },
  'glm-5.3-flash':         { input: 0.15, output: 0.50, cacheRead: 0.03,  cacheCreate: 0.00 },
  'glm-4.6':               { input: 0.70, output: 0.70, cacheRead: 0.07,  cacheCreate: 0.70  },
  'glm-4.5-air':           { input: 0.10, output: 0.10, cacheRead: 0.01,  cacheCreate: 0.10  },

  // ── Moonshot Kimi ───────────────────────────────────────────────
  'kimi-k2.5':             { input: 0.60, output: 3.00, cacheRead: 0.10,  cacheCreate: 0.00 },
  'kimi-k2':               { input: 0.60, output: 2.50, cacheRead: 0.10,  cacheCreate: 0.00 },

  // ── Xiaomi MiMo (¥1/¥2 per 1M ≈ $0.14/$0.28 after the 2026-05 cut) ──
  'mimo-v2.5':             { input: 0.14, output: 0.28, cacheRead: 0.003, cacheCreate: 0.00 },
  'mimo-v2.5-free':        { input: 0.00, output: 0.00, cacheRead: 0.00,  cacheCreate: 0.00  },

  // ── MiniMax M3 (list price; standard ≤512K tier) ────────────────
  'minimax-m3':            { input: 0.60, output: 2.40, cacheRead: 0.12,  cacheCreate: 0.00 },
  'minimax-m3-free':       { input: 0.00, output: 0.00, cacheRead: 0.00,  cacheCreate: 0.00  },

  // ── Alibaba Qwen ────────────────────────────────────────────────
  'qwen3.8-flash':         { input: 0.15, output: 0.47, cacheRead: 0.016, cacheCreate: 0.23 },

  // ── Free-tier gateway variants (explicit -free model IDs) ───────
  // Only models whose ID says -free are free; base IDs carry real rates.

  // ── OpenRouter (example rates) ──────────────────────────────────
  'anthropic/claude-opus-5':   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheCreate: 6.25 },
  'anthropic/claude-sonnet-5': { input:  2.00, output: 10.00, cacheRead: 0.20, cacheCreate:  2.50 },
  'anthropic/claude-haiku-4.5':{ input:  1.00, output:  5.00, cacheRead: 0.10, cacheCreate: 1.25 },
};

// Estimate cost in dollars for a set of token counts.
// model: the mapped model name as returned by the provider.
// providerId + pricingCfg (cfg.pricing) enable the full resolution order:
//   1. per-provider override  pricing.providerOverrides[`${providerId} ${model}`]
//   2. alias → canonical, then user model override  pricing.overrides[canonical]
//   3. built-in table above
//   4. no price → $0 (model shows as "unpriced" in the dashboard)
export function effectivePrice(model, providerId, pricing = {}) {
  const providerKey = providerId ? `${providerId} ${model}` : null;
  const perProvider = providerKey ? (pricing.providerOverrides || {})[providerKey] : null;
  if (perProvider) return { price: perProvider, source: 'provider' };
  const canonical = (pricing.aliases || {})[model] || model;
  const user = (pricing.overrides || {})[canonical];
  if (user) return { price: user, source: 'user' };
  const builtin = PRICING[canonical];
  if (builtin) return { price: builtin, source: 'builtin' };
  return { price: null, source: 'none' };
}

export function estimateCost(u, model, providerId, pricing) {
  const { price: p } = effectivePrice(model, providerId, pricing);
  if (!p) return 0;
  const input  = (u.input  || 0) * (p.input  / 1_000_000);
  const output = (u.output || 0) * (p.output / 1_000_000);
  const cacheR = (u.cacheRead       || 0) * (p.cacheRead / 1_000_000);
  const cacheC = (u.cacheCreation   || 0) * (p.cacheCreate / 1_000_000);
  return input + output + cacheR + cacheC;
}

// Normalize a model name for alias clustering: lowercase, spaces/underscores
// → dashes, and strip marketing suffixes (-free, -latest, -preview).
export function normalizeModelName(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-(free|latest|preview)$/, '');
}

// Suggest groups of model names that are probably the same underlying model
// (e.g. "GLM-5.2" and "GLM-5.2-Free" on different providers).
export function aliasSuggestions(modelNames) {
  const byBase = new Map();
  for (const m of modelNames) {
    if (!m) continue;
    const base = normalizeModelName(m);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(m);
  }
  return [...byBase.values()].filter((g) => g.length > 1);
}

// Recalculate every stored usage bucket's costUsd with the CURRENT effective
// prices. Exact wherever we have a per-provider-per-model-per-day breakdown
// (cfg.usage.pmDaily, recorded since tracking exists); older history keeps its
// share of the old cost, scaled by the tracked portion's old→new price factor.
export function recalcCosts(cfg) {
  const usage = cfg.usage;
  if (!usage) return { totalsCostUsd: 0 };
  const pm = usage.pmDaily || {};

  // pass 1: snapshot what each tracked bucket cost at its recorded prices
  const oldTrackedByModel = new Map();
  for (const models of Object.values(pm)) {
    for (const [model, days] of Object.entries(models)) {
      for (const b of Object.values(days)) {
        oldTrackedByModel.set(model, (oldTrackedByModel.get(model) || 0) + (b.costUsd || 0));
      }
    }
  }

  // pass 2: exact recomputation of the tracked breakdown at current prices
  const newByModel = new Map();
  const newDaily = new Map();
  const newByProvider = new Map();
  const trackedTokDaily = new Map();    // day → tracked tokens
  const trackedTokByProvider = new Map(); // providerId → tracked tokens
  for (const [providerId, models] of Object.entries(pm)) {
    for (const [model, days] of Object.entries(models)) {
      for (const [day, b] of Object.entries(days)) {
        const { price: p } = effectivePrice(model, providerId, cfg.pricing);
        const cost = p
          ? ((b.inputTokens || 0) * p.input + (b.outputTokens || 0) * p.output +
             (b.cacheReadTokens || 0) * p.cacheRead + (b.cacheCreationTokens || 0) * p.cacheCreate) / 1_000_000
          : 0;
        b.costUsd = cost;
        newByModel.set(model, (newByModel.get(model) || 0) + cost);
        newDaily.set(day, (newDaily.get(day) || 0) + cost);
        newByProvider.set(providerId, (newByProvider.get(providerId) || 0) + cost);
        const tok = (b.inputTokens || 0) + (b.outputTokens || 0);
        trackedTokDaily.set(day, (trackedTokDaily.get(day) || 0) + tok);
        trackedTokByProvider.set(providerId, (trackedTokByProvider.get(providerId) || 0) + tok);
      }
    }
  }

  // Legacy usage (recorded before pmDaily tracking existed): byModel keeps
  // per-model token totals, so legacy model costs reprice exactly at the
  // model-level price; daily/byProvider have no model split, so their legacy
  // share scales by the legacy price-change factor.
  const trackedTokens = new Map(); // model → tokens (for legacy subtraction)
  for (const models of Object.values(pm)) {
    for (const [model, days] of Object.entries(models)) {
      let t = trackedTokens.get(model) || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      for (const b of Object.values(days)) {
        t.inputTokens += b.inputTokens || 0;
        t.outputTokens += b.outputTokens || 0;
        t.cacheReadTokens += b.cacheReadTokens || 0;
        t.cacheCreationTokens += b.cacheCreationTokens || 0;
      }
      trackedTokens.set(model, t);
    }
  }
  let legacyOld = 0;
  let legacyNew = 0;
  const legacyModelCost = new Map();
  for (const [model, b] of Object.entries(usage.byModel || {})) {
    const tracked = trackedTokens.get(model) || {};
    const legacyIn = Math.max(0, (b.inputTokens || 0) - (tracked.inputTokens || 0));
    const legacyOut = Math.max(0, (b.outputTokens || 0) - (tracked.outputTokens || 0));
    const legacyCr = Math.max(0, (b.cacheReadTokens || 0) - (tracked.cacheReadTokens || 0));
    const legacyCc = Math.max(0, (b.cacheCreationTokens || 0) - (tracked.cacheCreationTokens || 0));
    const legacyOldCost = Math.max(0, (b.costUsd || 0) - (oldTrackedByModel.get(model) || 0));
    const { price: p } = effectivePrice(model, undefined, cfg.pricing);
    const cost = p
      ? (legacyIn * p.input + legacyOut * p.output + legacyCr * p.cacheRead + legacyCc * p.cacheCreate) / 1_000_000
      : 0;
    legacyModelCost.set(model, cost);
    legacyOld += legacyOldCost;
    legacyNew += cost;
  }
  // Daily/per-provider buckets have no model split, so legacy cost is
  // distributed across them by each bucket's un-tracked token share. (Scaling
  // the old cost fails when history was recorded entirely at $0 — the share
  // of zero is zero.) Buckets with NO un-tracked tokens at all (e.g. fully-
  // cached legacy history) get an equal split of the legacy cost — the sums
  // stay consistent with usage.totals instead of inventing or dropping money.
  const tokOf = (b) => (b.inputTokens || 0) + (b.outputTokens || 0) + (b.cacheReadTokens || 0) + (b.cacheCreationTokens || 0);
  let legacyTokDaily = 0;
  let legacyTokByProvider = 0;
  for (const [day, b] of Object.entries(usage.daily || {})) {
    legacyTokDaily += Math.max(0, tokOf(b) - (trackedTokDaily.get(day) || 0));
  }
  for (const [providerId, b] of Object.entries(usage.byProvider || {})) {
    legacyTokByProvider += Math.max(0, tokOf(b) - (trackedTokByProvider.get(providerId) || 0));
  }
  const allocByTokens = (legacyTokens, legacyTokTotal, bucketCount) => {
    if (legacyTokTotal > 0) return (legacyNew * legacyTokens) / legacyTokTotal;
    if (legacyNew > 0 && bucketCount > 0) return legacyNew / bucketCount; // no token signal — equal split keeps the sums right
    return 0;
  };
  const legacyDayCount = Object.keys(usage.daily || {}).length;
  const legacyProvCount = Object.keys(usage.byProvider || {}).length;

  for (const [model, b] of Object.entries(usage.byModel || {})) {
    b.costUsd = (newByModel.get(model) || 0) + (legacyModelCost.get(model) || 0);
  }
  for (const [day, b] of Object.entries(usage.daily || {})) {
    const legacyTokens = Math.max(0, tokOf(b) - (trackedTokDaily.get(day) || 0));
    b.costUsd = (newDaily.get(day) || 0) + allocByTokens(legacyTokens, legacyTokDaily, legacyDayCount);
  }
  for (const [providerId, b] of Object.entries(usage.byProvider || {})) {
    const legacyTokens = Math.max(0, tokOf(b) - (trackedTokByProvider.get(providerId) || 0));
    b.costUsd = (newByProvider.get(providerId) || 0) + allocByTokens(legacyTokens, legacyTokByProvider, legacyProvCount);
  }
  usage.totals.costUsd = [...newByModel.values()].reduce((s, c) => s + c, 0) + legacyNew;

  return { totalsCostUsd: usage.totals.costUsd };
}

// Format a dollar amount smartly: <$0.01 → "<$0.01", <$1 → "¢N", ≥$1 → "$N.NN"
export function fmtCost(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 0.01) return '<$0.01';
  if (n < 1)    return '¢' + (n * 100).toFixed(0);
  return '$' + n.toFixed(2);
}
