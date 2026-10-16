#!/usr/bin/env node
// switchXprovider — the proxy server.
//
// Routes:
//   /            web dashboard
//   /healthz     liveness ping (used by ensure.mjs and the dashboard)
//   /api/*       management API (providers, status, events)
//   /v1/models   returns only the 3 mapped model slots
//   /v1/human-in-the-loop, /v1/safeguards, /v1/messages/count_tokens (with
//     `safeguards`) → bypass: forwarded verbatim to the primary Anthropic
//     provider so server-side auto-mode classifier checks run unwrapped.
//   anything else is forwarded to the active provider (Anthropic API shape:
//   /v1/messages, ...)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, LOG_PATH, CONFIG_PATH } from './lib/config.mjs';
import { handleProxy } from './lib/proxy.mjs';
import { handleApi } from './lib/api.mjs';
import { startHealthLoop } from './lib/health.mjs';
import { primaryAnthropicProvider } from './lib/routing.mjs';

// Auto-mode classifier endpoints — bypass provider routing and forward to the
// primary Anthropic provider verbatim. The server-side classifier contract
// (safeguards request field + safeguard_results response) is preserved as-is;
// the proxy never rewrites or translates these, so the classifier works even
// while all other traffic is routed through gateway providers.
const AUTO_MODE_PATHS = new Set(['/v1/human-in-the-loop', '/v1/safeguards']);

// Build Anthropic-shaped headers for a bypass request to `provider`.
function anthropicHeaders(provider, req) {
  const h = {
    'user-agent': req.headers['user-agent'] || 'claude-cli/2.0.14 (external, cli)',
    accept: 'text/event-stream, application/json, */*',
  };
  if (req.headers['content-type']) h['content-type'] = req.headers['content-type'];
  if (req.headers['anthropic-version']) h['anthropic-version'] = req.headers['anthropic-version'];
  if (req.headers['anthropic-beta']) h['anthropic-beta'] = req.headers['anthropic-beta'];
  if (req.headers['x-api-key']) h['x-api-key'] = req.headers['x-api-key'];
  // Always stamp the provider's real key so the request authenticates upstream,
  // regardless of how Claude Code sent it (the sentinel token "switchx-local"
  // only works against this proxy).
  const style = provider.authStyle || 'auto';
  if (style === 'bearer') {
    h['authorization'] = `Bearer ${provider.apiKey}`;
  } else if (style === 'anthropic') {
    h['x-api-key'] = provider.apiKey;
    if (!h['anthropic-version']) h['anthropic-version'] = '2023-06-01';
  } else {
    h['x-api-key'] = provider.apiKey;
    h['authorization'] = `Bearer ${provider.apiKey}`;
    if (!h['anthropic-version']) h['anthropic-version'] = '2023-06-01';
  }
  return h;
}

// Forward a classifier request straight to the primary Anthropic provider,
// preserving the SSE / JSON stream exactly — no model rewriting, no usage
// capture, no failover. Returns false when the request isn't a bypass target.
async function handleAutoModeBypass(req, res, pathname, rawBody, cfg) {
  // Explicit classifier endpoints always bypass.
  let isClassifier = AUTO_MODE_PATHS.has(pathname);
  // /v1/messages/count_tokens only bypasses when it carries a `safeguards`
  // field — a plain token-count request should still go through normal routing
  // (and be rewritten to the active provider).
  if (!isClassifier && pathname === '/v1/messages/count_tokens' && req.method !== 'GET') {
    try {
      const json = JSON.parse(rawBody.toString('utf8'));
      if (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'safeguards')) {
        isClassifier = true;
      }
    } catch { /* not JSON — not a classifier request */ }
  }
  if (!isClassifier) return false;

  const provider = primaryAnthropicProvider(cfg);
  if (!provider) {
    // No real Anthropic (api.anthropic.com) provider is configured — the
    // server-side classifier contract can't be satisfied through a gateway
    // that doesn't implement safeguards/safeguard_results. Respond with a
    // clear, client-actionable error instead of relaying garbage (gateways
    // return HTML for these endpoints) or triggering a noisy failover.
    const hint = 'switchXprovider: auto-mode classifier requires an Anthropic provider (api.anthropic.com) configured and enabled. Add one in the dashboard and re-enable routing — the bypass will pick it up.';
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: hint } }));
    return true;
  }

  const baseUrl = String(provider.baseUrl || '').replace(/\/+$/, '');
  const url = baseUrl.endsWith('/v1') ? baseUrl + pathname : baseUrl + pathname;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120_000);
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: anthropicHeaders(provider, req),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : rawBody,
      signal: ac.signal,
    });
    // Relay status + the headers Claude Code's classifier client expects,
    // preserving the SSE / JSON framing the upstream chose. Only forward headers
    // that are actually present — Node rejects an `undefined` header value.
    const relayHeaders = {
      'content-type': upstream.headers.get('content-type') || 'application/json',
    };
    const ce = upstream.headers.get('content-encoding');
    if (ce) relayHeaders['content-encoding'] = ce;
    res.writeHead(upstream.status, relayHeaders);
    // Pump the upstream body straight to the client, byte for byte. SSE framing
    // is preserved by usageTap-free passthrough. Drain-on-close prevents the
    // undici socket-pool TypeError: terminated race (same fix as handleProxy).
    const reader = upstream.body?.getReader();
    if (reader) {
      res.on('close', () => { try { reader.cancel(); } catch {} try { ac.abort(); } catch {} });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise((r) => res.once('drain', r));
        }
      } catch (err) {
        // Client gone / upstream dropped — abort quietly; headers may be sent.
        if (err?.name === 'AbortError' || !res.writableEnded) {
          try { res.end(); } catch {}
        }
        return;
      }
    }
    res.end();
  } catch (err) {
    if (err?.name === 'AbortError') {
      res.writeHead(504, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'timeout', message: 'switchXprovider: auto-mode classifier request timed out' } }));
    } else {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `switchXprovider: auto-mode bypass failed — ${err.message}` } }));
    }
  } finally {
    clearTimeout(timer);
  }
  return true;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');

// The proxy is bound to 127.0.0.1 and holds provider API keys in memory, so
// requests must actually come from this machine. A page at attacker.test can
// rebind its DNS to 127.0.0.1, making its fetches same-origin and invisible
// to CORS — unless the Host header is checked. Every accepted request must
// name us as its host, and any Origin header must be our own origin.
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function hostAllowed(host) {
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  return LOCAL_HOSTNAMES.has(hostname);
}
function originAllowed(origin, port) {
  if (!origin || origin === 'null') return false;
  try {
    const u = new URL(origin);
    // Browsers omit the port for the scheme default (http→80, https→443);
    // u.port would be '' — compare the effective port, not the raw string.
    const effective = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
    return effective === String(port) && LOCAL_HOSTNAMES.has(u.hostname.replace(/^\[|\]$/g, '') || u.hostname);
  } catch {
    return false;
  }
}
function forbidden(res, why) {
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: `switchXprovider: request rejected (${why}). This proxy only accepts requests addressed to 127.0.0.1:${PORT}.` }));
}

const cfg = load();
const PORT = cfg.port || 8787;
const MAX_BODY = 200 * 1024 * 1024; // matches current provider request-body limits
const STARTED_AT = Date.now();

function readRawBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveIndex(res) {
  try {
    const html = fs.readFileSync(INDEX_PATH);
    // no-store: the dashboard file changes between plugin versions and during
    // development; a heuristically-cached stale copy breaks the UI in ways
    // that look like random bugs (half-loaded scripts, dead buttons).
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('switchXprovider: dashboard file missing: ' + INDEX_PATH);
  }
}

const server = http.createServer(async (req, res) => {
  // Applies to every route, proxied traffic included: rebinding protection.
  if (req.headers.origin !== undefined && !originAllowed(req.headers.origin, PORT)) {
    forbidden(res, `bad origin ${req.headers.origin}`);
    return;
  }
  if (!hostAllowed(req.headers.host)) {
    forbidden(res, `bad host ${req.headers.host}`);
    return;
  }
  const pathname = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;

  try {
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, port: PORT, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000) }));
      return;
    }

    if (pathname === '/' || pathname === '/index.html' || pathname === '/favicon.ico') {
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      serveIndex(res);
      return;
    }

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, cfg);
      return;
    }

    // Hermes / OpenAI-style /v1/models — return only the 3 mapped slots
    // (switchx:opus/sonnet/haiku) for the active provider, not the upstream's
    // full model dump.
    if (pathname === '/v1/models' || pathname === '/v1/models/') {
      const { enabledSorted, isDown } = await import('./lib/proxy.mjs');
      const { statsFor } = await import('./lib/config.mjs');
      const active = enabledSorted(cfg).find((p) => !isDown(statsFor(cfg, p.id))) || cfg.providers[0];
      const models = active?.models || {};
      const slots = ['opus', 'sonnet', 'haiku'];
      const data = slots
        .filter((s) => models[s])
        .map((s) => ({
          id: models[s],
          object: 'model',
          owned_by: active?.name || 'switchXprovider',
          status: 'active',
        }));
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ object: 'list', data }));
      return;
    }

    // Everything else: Anthropic API traffic → proxy it. Read the body first so
    // the auto-mode bypass can inspect it for the `safeguards` field.
    const rawBody = await readRawBody(req);
    // Auto-mode classifier endpoints bypass provider routing and forward
    // verbatim to the primary Anthropic provider, so server-side classifier
    // checks run without the proxy reshaping the safeguard_results contract.
    if (await handleAutoModeBypass(req, res, pathname, rawBody, cfg)) return;
    await handleProxy(req, res, cfg, rawBody);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
    }
    try {
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `switchXprovider: ${err.message}` } }));
    } catch {
      /* connection already gone */
    }
    console.error(`[switchx] ${req.method} ${pathname} failed:`, err.message);
  }
});

// 127.0.0.1 only — API keys live in this process; never expose on the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`switchXprovider proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`config: ${CONFIG_PATH}`);
});

startHealthLoop(() => cfg);

process.on('SIGINT', () => {
  console.log('switchXprovider shutting down');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(LOG_PATH, `[uncaught] ${new Date().toISOString()} ${err.stack || err.message}\n`); } catch { /* ignore */ }
  // `TypeError: terminated` from undici on client disconnect is noisy-but-
  // harmless — the client is already gone. Don't spam the log for the one
  // we can't avoid: Node fires it before the request 'close' handler finishes.
  if (err?.name === 'AbortError' || /terminated/i.test(err?.message || '')) {
    return;
  }
  console.error('[switchx] uncaught exception:', err);
});
