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
  'claude-opus-5':         { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreate: 18.75 },
  'claude-opus-4-8':       { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreate: 18.75 },
  'claude-opus-5-thinking':{ input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreate: 18.75 },
  'claude-sonnet-5':       { input:  3.00, output: 15.00, cacheRead: 0.30, cacheCreate:  3.75 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheCreate: 1.00 },

  // ── DeepSeek (official, very cheap) ─────────────────────────────
  'deepseek-chat':         { input: 0.14, output: 0.28, cacheRead: 0.014, cacheCreate: 0.14 },
  'deepseek-v4-flash':     { input: 0.00, output: 0.00, cacheRead: 0.00,  cacheCreate: 0.00  },  // free-tier model
  'deepseek-v4-flash-free':{ input: 0.00, output: 0.00, cacheRead: 0.00,  cacheCreate: 0.00  },

  // ── Z.AI GLM ────────────────────────────────────────────────────
  'glm-5.3':               { input: 0.00, output: 0.00, cacheRead: 0.00,  cacheCreate: 0.00  },
  'glm-4.6':               { input: 0.70, output: 0.70, cacheRead: 0.07,  cacheCreate: 0.70  },
  'glm-4.5-air':           { input: 0.10, output: 0.10, cacheRead: 0.01,  cacheCreate: 0.10  },

  // ── Free-tier gateway models (bynara, agentrouter, seekai) ──────
  'mimo-v2.5-free':        { input: 0.00, output: 0.00, cacheRead: 0.00,  cacheCreate: 0.00  },
  'minimax-m3-free':       { input: 0.00, output: 0.00, cacheRead: 0.00,  cacheCreate: 0.00  },

  // ── OpenRouter (example rates) ──────────────────────────────────
  'anthropic/claude-opus-5':   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreate: 18.75 },
  'anthropic/claude-sonnet-5': { input:  3.00, output: 15.00, cacheRead: 0.30, cacheCreate:  3.75 },
  'anthropic/claude-haiku-4.5':{ input:  0.80, output:  4.00, cacheRead: 0.08, cacheCreate:  1.00 },
};

// Estimate cost in dollars for a set of token counts.
// model: the mapped model name as returned by the provider.
export function estimateCost(u, model) {
  const p = PRICING[model];
  if (!p) return 0;
  const input  = (u.input  || 0) * (p.input  / 1_000_000);
  const output = (u.output || 0) * (p.output / 1_000_000);
  const cacheR = (u.cacheRead       || 0) * (p.cacheRead / 1_000_000);
  const cacheC = (u.cacheCreation   || 0) * (p.cacheCreate / 1_000_000);
  return input + output + cacheR + cacheC;
}

// Format a dollar amount smartly: <$0.01 → "<$0.01", <$1 → "¢N", ≥$1 → "$N.NN"
export function fmtCost(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 0.01) return '<$0.01';
  if (n < 1)    return '¢' + (n * 100).toFixed(0);
  return '$' + n.toFixed(2);
}
