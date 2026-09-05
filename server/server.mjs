#!/usr/bin/env node
// switchXprovider — the proxy server.
//
// Routes:
//   /            web dashboard
//   /healthz     liveness ping (used by ensure.mjs and the dashboard)
//   /api/*       management API (providers, status, events)
//   anything else is forwarded to the active provider (Anthropic API shape:
//   /v1/messages, /v1/messages/count_tokens, ...)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, LOG_PATH, CONFIG_PATH } from './lib/config.mjs';
import { handleProxy } from './lib/proxy.mjs';
import { handleApi } from './lib/api.mjs';
import { startHealthLoop } from './lib/health.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');

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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('switchXprovider: dashboard file missing: ' + INDEX_PATH);
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;

  try {
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
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

    // Everything else: Anthropic API traffic → proxy it.
    const rawBody = await readRawBody(req);
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
});
