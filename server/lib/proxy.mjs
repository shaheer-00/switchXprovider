// switchXprovider — request forwarding, model rewriting, failover, cooldowns.
//
// Claude Code talks to this proxy with sentinel model names (switchx:opus /
// switchx:sonnet / switchx:haiku — set by the installer in settings.json).
// The proxy rewrites the model to the active provider's real model ID and
// forwards the request. On retryable errors it marks the provider down and
// retries the same request on the next provider by priority.

import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { statsFor, logEvent, persistSoon, recordUsage, pushRequest, countFailover } from './config.mjs';

// Time allowed for upstream to send response headers (streams may run much longer).
const HEADER_TIMEOUT_MS = 60_000;

// Base cooldowns per failure kind. Auto-learning: multiplied by up to 8x
// based on consecutive failures, and extended by upstream `retry-after`.
export const COOLDOWNS = {
  auth: 60 * 60_000,     // 401/403 — key invalid, give it an hour
  payment: 30 * 60_000,  // 402 — out of credits
  rate: 5 * 60_000,      // 429 — rate limited / usage window
  notfound: 2 * 60_000,  // 404 — model missing on this provider
  server: 60_000,        // 5xx/529 — provider trouble, short cooldown
  network: 30_000,       // connect failure / timeout
};

const RETRYABLE_STATUS = new Set([401, 402, 403, 404, 408, 429, 500, 502, 503, 504, 529]);

export function enabledSorted(cfg) {
  return cfg.providers
    .filter((p) => p.enabled)
    .slice()
    .sort((a, b) => (a.priority || 99) - (b.priority || 99));
}

export function isDown(stats) {
  return (stats.deadUntil || 0) > Date.now();
}

function classify(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'payment';
  if (status === 429) return 'rate';
  if (status === 404) return 'notfound';
  return 'server';
}

function cooldownMs(kind, retryAfterSec, stats) {
  let ms = COOLDOWNS[kind];
  if (retryAfterSec && Number.isFinite(retryAfterSec)) {
    ms = Math.max(ms, retryAfterSec * 1000);
  }
  const backoff = Math.min(2 ** Math.min(stats.consecutiveFailures || 0, 3), 8);
  return ms * backoff;
}

function markDown(cfg, p, kind, detail, retryAfterSec) {
  const s = statsFor(cfg, p.id);
  s.consecutiveFailures = (s.consecutiveFailures || 0) + 1;
  s.deadUntil = Date.now() + cooldownMs(kind, retryAfterSec, s);
  s.deadReason = `${kind}: ${String(detail).slice(0, 200)}`;
  s.lastError = { ts: Date.now(), kind, detail: String(detail).slice(0, 300) };
  logEvent(
    cfg,
    `Provider "${p.name}" down (${kind}${retryAfterSec ? `, retry-after ${retryAfterSec}s` : ''}) — cooldown ${Math.round((s.deadUntil - Date.now()) / 1000)}s. Detail: ${String(detail).slice(0, 120)}`
  );
}

function markSuccess(cfg, p, latencyMs) {
  const s = statsFor(cfg, p.id);
  s.requests++;
  s.successes++;
  s.consecutiveFailures = 0;
  s.deadUntil = 0;
  s.deadReason = null;
  s.emaLatencyMs = s.emaLatencyMs == null
    ? latencyMs
    : Math.round(s.emaLatencyMs * 0.7 + latencyMs * 0.3);
  persistSoon(cfg);
}

// Rewrite sentinel model names to the provider's real model IDs.
export function mapModel(p, model) {
  if (typeof model !== 'string') return model;
  const m = /^switchx:(opus|sonnet|haiku)$/i.exec(model);
  if (!m) return model;
  const slot = m[1].toLowerCase();
  const models = p.models || {};
  return models[slot] || models.sonnet || model;
}

// Join provider base URL with the incoming path, avoiding /v1 duplication
// for bases like https://openrouter.ai/api/v1.
function targetUrl(baseUrl, url) {
  let base = String(baseUrl || '').replace(/\/+$/, '');
  const path = url; // includes pathname + search
  if (/\/v\d+$/.test(base) && /^\/v\d+\//.test(path)) {
    base = base.replace(/\/v\d+$/, '');
  }
  return base + path;
}

function buildHeaders(p, req) {
  const h = {
    'content-type': req.headers['content-type'] || 'application/json',
    accept: req.headers['accept'] || '*/*',
  };
  for (const k of ['anthropic-beta', 'anthropic-version']) {
    if (req.headers[k]) h[k] = req.headers[k];
  }
  // Forward the client's user-agent (this is Claude Code traffic). Fall back
  // to a claude-cli UA — some gateways fingerprint and reject other clients.
  h['user-agent'] = req.headers['user-agent'] || 'claude-cli/2.0.14 (external, cli)';
  const style = p.authStyle || 'auto';
  if (style === 'bearer') {
    h['authorization'] = `Bearer ${p.apiKey}`;
  } else if (style === 'anthropic') {
    h['x-api-key'] = p.apiKey;
    if (!h['anthropic-version']) h['anthropic-version'] = '2023-06-01';
  } else {
    // auto: send both — each provider reads the header it knows and ignores
    // the other, so no configuration is needed. Harmless in practice.
    h['x-api-key'] = p.apiKey;
    h['authorization'] = `Bearer ${p.apiKey}`;
    if (!h['anthropic-version']) h['anthropic-version'] = '2023-06-01';
  }
  return h;
}

// Pass-through stream that reads token usage out of the response while it
// flows to the client. Handles both SSE (`data:` lines: message_start carries
// input/cache tokens, message_delta carries the final output token count)
// and plain JSON responses (top-level `usage`).
export function usageTap(onDone) {
  const dec = new StringDecoder('utf8');
  let buf = '';
  let sawSse = false;
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0;

  const take = (j) => {
    const u = j?.usage || j?.message?.usage;
    if (!u) return;
    if (u.input_tokens) input = u.input_tokens;
    if (u.cache_read_input_tokens) cacheRead = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens) cacheCreation = u.cache_creation_input_tokens;
    if (u.output_tokens) output = Math.max(output, u.output_tokens); // message_delta is cumulative
  };

  return new Transform({
    transform(chunk, _enc, cb) {
      buf += dec.write(chunk);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.startsWith('data:')) {
          sawSse = true;
          const d = line.slice(5).trim();
          if (d && d !== '[DONE]') {
            try { take(JSON.parse(d)); } catch { /* partial/keepalive line */ }
          }
        }
      }
      cb(null, chunk);
    },
    flush(cb) {
      buf += dec.end();
      if (!sawSse && buf.trim()) {
        try { take(JSON.parse(buf)); } catch { /* not JSON */ }
      }
      onDone({ input, output, cacheRead, cacheCreation });
      cb();
    },
  });
}

function sanitizeRespHeaders(headers) {
  const h = {};
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    // fetch already decoded the body; forwarded lengths/encodings would lie.
    if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding') continue;
    h[k] = v;
  }
  return h;
}

async function attempt(p, req, rawBody) {
  let body;
  let mappedModel = null;
  if (rawBody && rawBody.length && req.method !== 'GET' && req.method !== 'HEAD') {
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('json')) {
      try {
        const json = JSON.parse(rawBody.toString('utf8'));
        if (typeof json.model === 'string') {
          mappedModel = mapModel(p, json.model);
          json.model = mappedModel;
        }
        body = JSON.stringify(json);
      } catch {
        body = rawBody; // not valid JSON — pass through untouched
      }
    } else {
      body = rawBody;
    }
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HEADER_TIMEOUT_MS);
  try {
    const resp = await fetch(targetUrl(p.baseUrl, req.url), {
      method: req.method,
      headers: buildHeaders(p, req),
      body,
      signal: ac.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let retryAfterSec;
      const ra = resp.headers.get('retry-after');
      if (ra) {
        const asInt = parseInt(ra, 10);
        retryAfterSec = Number.isFinite(asInt) && String(asInt) === ra.trim()
          ? asInt
          : (Date.parse(ra) - Date.now()) / 1000;
      }
      return { ok: false, status: resp.status, text, retryAfterSec, ac };
    }
    return { ok: true, resp, ac, mappedModel };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleProxy(req, res, cfg, rawBody) {
  let candidates = enabledSorted(cfg).filter((p) => !isDown(statsFor(cfg, p.id)));

  // All providers down: reset cooldowns once and try again rather than
  // hard-failing — a stale cooldown is worse than one retry round-trip.
  if (!candidates.length) {
    const all = enabledSorted(cfg);
    if (all.length) {
      logEvent(cfg, 'All providers down — resetting cooldowns and retrying');
      for (const p of all) statsFor(cfg, p.id).deadUntil = 0;
      candidates = all;
    }
  }

  if (!candidates.length) {
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: `switchXprovider: no enabled providers configured. Open http://127.0.0.1:${cfg.port} to add one.`,
      },
    }));
    return;
  }

  let lastErr = null;
  for (const p of candidates) {
    const t0 = Date.now();
    try {
      const r = await attempt(p, req, rawBody);
      if (r.ok) {
        markSuccess(cfg, p, Date.now() - t0);
        const rec = {
          ts: Date.now(),
          provider: p.name,
          model: r.mappedModel || '—',
          status: r.resp.status,
          latencyMs: Date.now() - t0,
          inTok: 0,
          outTok: 0,
        };
        res.writeHead(r.resp.status, sanitizeRespHeaders(r.resp.headers));
        // If the client hangs up, stop pulling from upstream.
        res.on('close', () => r.ac.abort());
        Readable.fromWeb(r.resp.body)
          .pipe(usageTap((u) => {
            rec.inTok = u.input + u.cacheRead + u.cacheCreation;
            rec.outTok = u.output;
            recordUsage(cfg, p.id, p.name, u, r.mappedModel);
            pushRequest(cfg, rec);
          }))
          .pipe(res);
        return;
      }

      const s = statsFor(cfg, p.id);
      s.requests++;
      s.failures++;
      lastErr = r;

      if (RETRYABLE_STATUS.has(r.status)) {
        markDown(cfg, p, classify(r.status), `${r.status} ${r.text.slice(0, 200)}`, r.retryAfterSec);
        countFailover(cfg);
        continue;
      }

      // Non-retryable client error (400/413/422...) — the request itself is
      // bad; forwarding the error beats looping through every provider.
      persistSoon(cfg);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.text);
      return;
    } catch (err) {
      const s = statsFor(cfg, p.id);
      s.requests++;
      s.failures++;
      const code = err.cause?.code || (err.name === 'AbortError' ? 'timeout' : err.message);
      markDown(cfg, p, 'network', code);
      countFailover(cfg);
      lastErr = { status: 502, text: code };
      continue;
    }
  }

  res.writeHead(lastErr?.status || 502, {
    'content-type': 'application/json',
    'x-switchx-error': 'all providers failed',
  });
  res.end(JSON.stringify({
    type: 'error',
    error: {
      type: 'api_error',
      message: `switchXprovider: all providers failed. Last error: ${lastErr?.status || 'unknown'} ${String(lastErr?.text || '').slice(0, 200)}`,
    },
  }));
}
