#!/usr/bin/env node
// End-to-end tests for switchXprovider.
// Spins up mock providers + the real proxy against an isolated SWITCHX_HOME,
// then exercises failover, model rewriting, auth rewriting, cooldown marking,
// 400 passthrough, and manual reset/recovery.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PROXY_PORT = 8899;
const MOCK_OK = 9901;
const MOCK_500 = 9902;
const MOCK_429 = 9903;
const MOCK_400 = 9904;
const MOCK_KEYONLY = 9905;
const MOCK_BearerONLY = 9906;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchx-test-'));

let passed = 0;
let failed = 0;
const children = [];

function cleanup() {
  for (const c of children) {
    try { c.kill(); } catch { /* already dead */ }
  }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* in use on Windows — fine */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function assert(cond, label, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp(url, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 500);
      try {
        const r = await fetch(url, { signal: ac.signal });
        if (r.ok) return true;
      } finally { clearTimeout(t); }
    } catch { /* retry */ }
    await sleep(150);
  }
  return false;
}

async function main() {
  // --- mock providers ---
  for (const [port, mode] of [[MOCK_OK, 'ok'], [MOCK_500, 'fail500'], [MOCK_429, 'ratelimit'], [MOCK_400, 'badreq'], [MOCK_KEYONLY, 'keyonly'], [MOCK_BearerONLY, 'beareronly']]) {
    children.push(spawn(process.execPath, [path.join(__dirname, 'mock.mjs'), String(port), mode], { stdio: 'ignore' }));
  }
  for (const port of [MOCK_OK, MOCK_500, MOCK_429, MOCK_400, MOCK_KEYONLY, MOCK_BearerONLY]) {
    assert(await waitUp(`http://127.0.0.1:${port}/v1/models`), `mock :${port} up`);
  }

  // --- isolated proxy config ---
  fs.mkdirSync(home, { recursive: true });
  const dkey = (offset) => {
    const n = new Date();
    const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  // Multi-day usage history for period-aggregation tests (keys match the API's
  // local-date format exactly — see the dense-series loop in api.mjs).
  const dayBucket = (inputTokens, outputTokens, requests, costUsd) =>
    ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, requests, costUsd });
  const seededUsage = {
    totals: { inputTokens: 1900, outputTokens: 410, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 11, costUsd: 2.4 },
    byProvider: {},
    byModel: {},
    daily: {
      [dkey(0)]: dayBucket(300, 60, 3, 0.3),    // today
      [dkey(3)]: dayBucket(1000, 200, 5, 1.5),  // inside 7d
      [dkey(10)]: dayBucket(500, 100, 2, 0.5),  // inside 14d/30d, outside 7d
      [dkey(40)]: dayBucket(100, 50, 1, 0.1),   // outside 30d, inside all-time
    },
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    port: PROXY_PORT,
    providers: [
      { id: 'p500', name: 'Broken', baseUrl: `http://127.0.0.1:${MOCK_500}`, apiKey: 'key-500', authStyle: 'anthropic', priority: 1, enabled: true, models: { sonnet: 'broken-sonnet' } },
      { id: 'p429', name: 'RateLimited', baseUrl: `http://127.0.0.1:${MOCK_429}`, apiKey: 'key-429', authStyle: 'anthropic', priority: 2, enabled: true, models: { sonnet: 'rl-sonnet' } },
      { id: 'pok', name: 'GoodProvider', baseUrl: `http://127.0.0.1:${MOCK_OK}`, apiKey: 'key-ok', authStyle: 'anthropic', priority: 3, enabled: true, models: { sonnet: 'good-sonnet', opus: 'good-opus' } },
      { id: 'p400', name: 'BadRequest', baseUrl: `http://127.0.0.1:${MOCK_400}`, apiKey: 'key-400', authStyle: 'anthropic', priority: 4, enabled: true, models: { sonnet: 'bad-sonnet' } },
    ],
    usage: seededUsage,
    stats: {},
    events: [],
  }));

  // --- start the real proxy with the test home ---
  const proxy = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
    env: { ...process.env, SWITCHX_HOME: home },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(proxy);

  console.log('\n— proxy startup —');
  assert(await waitUp(`http://127.0.0.1:${PROXY_PORT}/healthz`), 'proxy up on 8899');

  const proxyUrl = `http://127.0.0.1:${PROXY_PORT}`;

  // --- 0. usage period aggregation (from seeded multi-day history) ---
  console.log('\n— usage period aggregation —');
  let u0 = await (await fetch(`${proxyUrl}/api/usage`)).json();
  assert(u0.daily.length === 14, 'default daily series is 14 days', `got ${u0.daily.length}`);
  const P = u0.periods || {};
  const pIs = (p, exp, label) =>
    assert(P[p] && P[p].inputTokens === exp.in && P[p].outputTokens === exp.out && P[p].requests === exp.req && Math.abs((P[p].costUsd || 0) - exp.cost) < 1e-9,
      label, JSON.stringify(P[p]));
  pIs('today', { in: 300, out: 60, req: 3, cost: 0.3 }, 'periods.today = today bucket only');
  pIs('d7', { in: 1300, out: 260, req: 8, cost: 1.8 }, 'periods.d7 sums last 7 days');
  pIs('d14', { in: 1800, out: 360, req: 10, cost: 2.3 }, 'periods.d14 sums last 14 days');
  pIs('d30', { in: 1800, out: 360, req: 10, cost: 2.3 }, 'periods.d30 excludes 40-day-old bucket');
  pIs('all', { in: 1900, out: 410, req: 11, cost: 2.4 }, 'periods.all = grand totals');
  let u30 = await (await fetch(`${proxyUrl}/api/usage?days=30`)).json();
  assert(u30.daily.length === 30, '?days=30 widens dense series to 30', `got ${u30.daily.length}`);
  const d30key = dkey(3);
  const d30entry = u30.daily.find((d) => d.date === d30key);
  assert(d30entry && d30entry.inputTokens === 1000, '30-day series carries seeded history', JSON.stringify(d30entry));

  // --- 1. failover: 500 then 429 then success on third provider ---
  console.log('\n— failover through 500 and 429 —');
  let resp = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'switchx-local' },
    body: JSON.stringify({ model: 'switchx:sonnet', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
  });
  let body = await resp.json();
  assert(resp.status === 200, 'request succeeds via failover (200)', `got ${resp.status}`);
  assert(body.model === 'good-sonnet', 'model rewritten switchx:sonnet → good-sonnet', `got ${body.model}`);
  assert(body.receivedAuth === 'key-ok', 'auth rewritten to provider key', `got ${body.receivedAuth}`);

  // --- 2. dead providers marked, cooldown active ---
  console.log('\n— dead marking + status API —');
  resp = await fetch(`${proxyUrl}/api/status`);
  const status = await resp.json();
  const byId = Object.fromEntries(status.providers.map((p) => [p.id, p]));
  assert(byId.p500.status === 'down', '500 provider marked down');
  assert(byId.p429.status === 'down', '429 provider marked down');
  assert(byId.p429.statusDetail?.startsWith('rate'), '429 classified as rate limit', byId.p429.statusDetail);
  assert(byId.pok.status === 'up', 'good provider up');
  assert(status.activeProvider === 'GoodProvider', 'active provider is the healthy one', status.activeProvider);

  // --- 3. 429 retry-after respected (≥120s cooldown) ---
  assert(byId.p429.downForMs >= 119_000, 'retry-after=120 honored in cooldown', `${byId.p429.downForMs}ms`);

  // --- 4. 400 must NOT trigger failover — forwarded to client ---
  console.log('\n— 400 passthrough (no failover) —');
  // Make the good provider temporarily dead so only the 400 provider is reachable.
  await fetch(`${proxyUrl}/api/providers/pok`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'GoodProvider', baseUrl: byId.pok.baseUrl, apiKey: '', authStyle: 'anthropic', enabled: false, models: byId.pok.models }),
  });
  resp = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'switchx-local' },
    body: JSON.stringify({ model: 'switchx:sonnet', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
  });
  body = await resp.json();
  assert(resp.status === 400, '400 forwarded to client as-is', `got ${resp.status}`);
  assert(body.error?.message === 'mock bad request', '400 body passed through');

  // --- 5. reset + re-enable restores provider to rotation ---
  console.log('\n— manual reset / recovery —');
  resp = await fetch(`${proxyUrl}/api/providers/p500/reset`, { method: 'POST' });
  assert((await resp.json()).ok, 'reset endpoint works');
  // re-enable the good provider too
  await fetch(`${proxyUrl}/api/providers/pok`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'GoodProvider', baseUrl: byId.pok.baseUrl, apiKey: '', authStyle: 'anthropic', enabled: true, models: byId.pok.models }),
  });
  resp = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'switchx-local' },
    body: JSON.stringify({ model: 'switchx:opus', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
  });
  body = await resp.json();
  // p500 was reset but fails again → failover; opus slot mapped on good provider
  assert(resp.status === 200 && body.model === 'good-opus', 'opus sentinel mapped after reset+failover', `got ${resp.status} ${body.model}`);

  // --- 6. bearer auth style ---
  console.log('\n— bearer auth style —');
  resp = await fetch(`${proxyUrl}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'BearerProvider', baseUrl: `http://127.0.0.1:${MOCK_OK}/v1`,
      apiKey: 'bearer-key-1', authStyle: 'bearer', enabled: true,
      models: { sonnet: 'bearer-sonnet' },
    }),
  });
  const created = await resp.json();
  assert(resp.status === 201 && created.id, 'provider added via API');
  // Make it priority 1
  for (let i = 0; i < 6; i++) await fetch(`${proxyUrl}/api/providers/${created.id}/up`, { method: 'POST' });
  resp = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'switchx-local' },
    body: JSON.stringify({ model: 'switchx:sonnet', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
  });
  body = await resp.json();
  assert(resp.status === 200 && body.receivedAuth === 'Bearer bearer-key-1', 'bearer auth header sent', `got ${body.receivedAuth}`);
  assert(body.model === 'bearer-sonnet', 'model mapped on bearer provider', `got ${body.model}`);

  // --- 7. /v1 duplication avoided (baseUrl ended with /v1, request went to /v1/messages) ---
  assert(body.id === 'msg_mock', 'request reached mock via /v1-joined URL');

  // --- 8. authStyle auto: works with both anthropic-only and bearer-only providers ---
  console.log('\n— authStyle auto —');
  for (const [name, port, mockPort] of [['AutoKeyOnly', 9905, MOCK_KEYONLY], ['AutoBearerOnly', 9906, MOCK_BearerONLY]]) {
    resp = await fetch(`${proxyUrl}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name, baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: `key-${name}`, authStyle: 'auto',
        enabled: true, models: { sonnet: `${name.toLowerCase()}-sonnet` },
      }),
    });
    const added = await resp.json();
    assert(resp.status === 201, `${name} added`);
    for (let i = 0; i < 8; i++) await fetch(`${proxyUrl}/api/providers/${added.id}/up`, { method: 'POST' });
    resp = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'switchx-local' },
      body: JSON.stringify({ model: 'switchx:sonnet', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
    });
    body = await resp.json();
    assert(resp.status === 200, `${name} (auto) request succeeds`, `got ${resp.status} ${JSON.stringify(body).slice(0, 120)}`);
    assert(body.model === `${name.toLowerCase()}-sonnet`, `${name} model mapped`, `got ${body.model}`);
    await fetch(`${proxyUrl}/api/providers/${added.id}`, { method: 'DELETE' });
  }

  // --- 9. usage tracking: JSON + streaming responses ---
  console.log('\n— usage tracking —');
  const before = (await (await fetch(`${proxyUrl}/api/usage`)).json()).totals;
  const prev = (k) => before?.[k] || 0;
  // non-streaming (mock now returns usage: in 10, out 5)
  await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'switchx-local' },
    body: JSON.stringify({ model: 'switchx:sonnet', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
  });
  // streaming (mock SSE: in 7 + cacheRead 3, out 9)
  resp = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'switchx-local' },
    body: JSON.stringify({ model: 'switchx:sonnet', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const sseText = await resp.text();
  assert(resp.status === 200 && sseText.includes('message_stop'), 'streaming response passes through intact');

  await sleep(400); // usage recorded on stream end, persisted async
  const usage = await (await fetch(`${proxyUrl}/api/usage`)).json();
  assert(usage.totals.requests - prev('requests') === 2, 'usage counts both new requests', `got ${usage.totals.requests} (was ${prev('requests')})`);
  assert(usage.totals.inputTokens - prev('inputTokens') === 17, 'input tokens: 10 (json) + 7 (sse)', `got ${usage.totals.inputTokens}`);
  assert(usage.totals.cacheReadTokens - prev('cacheReadTokens') === 3, 'cache read tokens: 3 (sse)', `got ${usage.totals.cacheReadTokens}`);
  assert(usage.totals.outputTokens - prev('outputTokens') === 14, 'output tokens: 5 (json) + 9 (sse)', `got ${usage.totals.outputTokens}`);
  assert(usage.recent.length >= 2, 'recent request feed populated', `got ${usage.recent.length}`);
  assert(usage.recent[0].model && !usage.recent[0].model.startsWith('switchx:'), 'recent feed shows mapped model', `got ${usage.recent[0].model}`);
  const todayEntry = usage.daily.find((d) => d.date === new Date().toISOString().slice(0, 10));
  assert(todayEntry && todayEntry.requests >= 2, 'daily series has today entry', JSON.stringify(todayEntry));
  const goodUsage = usage.byProvider.find((p) => p.id === 'pok');
  assert(goodUsage && goodUsage.requests >= 2, 'by-provider usage aggregated', JSON.stringify(goodUsage));

  // --- 10. catalog, usage reset, export/import, install status ---
  console.log('\n— catalog / reset / export-import / install status —');
  let cat = await (await fetch(`${proxyUrl}/api/catalog`)).json();
  assert(Array.isArray(cat.providers) && cat.providers.length >= 5, 'seed catalog served', `got ${cat.providers?.length}`);
  assert(cat.providers.some((p) => p.id === 'agentrouter' && /^https:\/\/agentrouter\.org/.test(p.baseUrl)), 'curated gateway entry present');
  assert(cat.providers.every((p) => typeof p.rating === 'number'), 'catalog entries have ratings');

  const st = await (await fetch(`${proxyUrl}/api/status`)).json();
  assert('claudeCode' in st && typeof st.claudeCode.configured === 'boolean', 'status reports Claude Code install state', JSON.stringify(st.claudeCode));

  resp = await fetch(`${proxyUrl}/api/usage/reset`, { method: 'POST' });
  assert(resp.ok, 'usage reset works');
  let u2 = await (await fetch(`${proxyUrl}/api/usage`)).json();
  assert((u2.totals.requests || 0) === 0 && (u2.totals.inputTokens || 0) === 0, 'usage zeroed after reset', JSON.stringify(u2.totals));

  const exp = await (await fetch(`${proxyUrl}/api/export`)).json();
  assert(exp.config && Array.isArray(exp.config.providers) && exp.config.providers.length > 0, 'export returns providers');

  // import: replace with a single known provider
  resp = await fetch(`${proxyUrl}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providers: [{ name: 'Imported', baseUrl: `http://127.0.0.1:${MOCK_OK}`, apiKey: 'imp-key', models: { sonnet: 'imp-sonnet' } }] }),
  });
  const imp = await resp.json();
  assert(resp.ok && imp.imported === 1, 'import works', JSON.stringify(imp));
  const st2 = await (await fetch(`${proxyUrl}/api/status`)).json();
  assert(st2.providers.length === 1 && st2.providers[0].name === 'Imported', 'imported provider active', JSON.stringify(st2.providers.map((p) => p.name)));
  resp = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'switchx-local' },
    body: JSON.stringify({ model: 'switchx:sonnet', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
  });
  body = await resp.json();
  assert(resp.status === 200 && body.model === 'imp-sonnet', 'imported provider routes traffic', `got ${resp.status} ${body.model}`);

  resp = await fetch(`${proxyUrl}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providers: [{ name: 'Bad', baseUrl: 'ftp://nope' }] }),
  });
  assert(resp.status === 400, 'import rejects invalid baseUrl');

  // --- 11. version reporting + update marker + restart flow ---
  console.log('\n— version / update marker / restart —');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let st3 = await (await fetch(`${proxyUrl}/api/status`)).json();
  assert(st3.version === pkg.version, 'status reports own version', `${st3.version} vs ${pkg.version}`);

  const markerPath = path.join(home, 'update-available.json');
  // pending-update marker (newer version) → exposed on status
  fs.writeFileSync(markerPath, JSON.stringify({ version: '99.0.0', path: ROOT, ts: Date.now() }));
  st3 = await (await fetch(`${proxyUrl}/api/status`)).json();
  assert(st3.update?.version === '99.0.0', 'status exposes pending update', JSON.stringify(st3.update));
  assert(!st3.update?.path, 'marker install path is not exposed to the client', JSON.stringify(st3.update));

  // same-version marker → cleaned up, no update reported
  fs.writeFileSync(markerPath, JSON.stringify({ version: pkg.version, path: ROOT, ts: Date.now() }));
  st3 = await (await fetch(`${proxyUrl}/api/status`)).json();
  assert(!st3.update, 'same-version marker reports no update');
  assert(!fs.existsSync(markerPath), 'completed-update marker file deleted');

  // update-restart: spawns ensure --replace from the marker path → old dies, new comes up
  fs.writeFileSync(markerPath, JSON.stringify({ version: '99.0.0', path: ROOT, ts: Date.now() }));
  resp = await fetch(`${proxyUrl}/api/update-restart`, { method: 'POST' });
  assert(resp.ok, 'update-restart accepted', `got ${resp.status}`);
  // no marker → rejected
  fs.writeFileSync(markerPath, JSON.stringify({ version: pkg.version, path: ROOT, ts: Date.now() }));
  await (await fetch(`${proxyUrl}/api/status`)).json(); // consumes same-version marker
  resp = await fetch(`${proxyUrl}/api/update-restart`, { method: 'POST' });
  assert(resp.status === 400, 'update-restart rejected without pending update', `got ${resp.status}`);
  // put a real marker back and run the full cycle
  fs.writeFileSync(markerPath, JSON.stringify({ version: '99.0.0', path: ROOT, ts: Date.now() }));
  resp = await fetch(`${proxyUrl}/api/update-restart`, { method: 'POST' });
  assert(resp.ok, 'update-restart cycle started');
  // phase 1: old proxy must die
  let died = false;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 500);
      try { await fetch(`${proxyUrl}/healthz`, { signal: ac.signal }); } finally { clearTimeout(t); }
    } catch { died = true; break; }
  }
  assert(died, 'old proxy shut down after update-restart');
  // phase 2: replacement proxy must come back up
  let back = false;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 500);
      try { const r = await fetch(`${proxyUrl}/healthz`, { signal: ac.signal }); if (r.ok) { back = true; break; } } finally { clearTimeout(t); }
    } catch { /* not up yet */ }
  }
  assert(back, 'replacement proxy started by ensure --replace');
  st3 = await (await fetch(`${proxyUrl}/api/status`)).json();
  assert(st3.version === pkg.version, 'replacement proxy reports version');
  // (the fake 99.0.0 marker legitimately stays pending — it matches no real
  // install; same-version cleanup is covered above. Verify the replacement
  // server's marker machinery works end to end:)
  fs.writeFileSync(markerPath, JSON.stringify({ version: pkg.version, path: ROOT, ts: Date.now() }));
  st3 = await (await fetch(`${proxyUrl}/api/status`)).json();
  assert(!st3.update && !fs.existsSync(markerPath), 'replacement proxy handles marker lifecycle');

  // --- 12. shutdown endpoint (must stay LAST — kills the proxy) ---
  console.log('\n— shutdown —');
  resp = await fetch(`${proxyUrl}/api/shutdown`, { method: 'POST' });
  assert(resp.ok, 'shutdown endpoint responds ok');
  let gone = false;
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 500);
      try { await fetch(`${proxyUrl}/healthz`, { signal: ac.signal }); } finally { clearTimeout(t); }
    } catch { gone = true; break; }
  }
  assert(gone, 'proxy exits after /api/shutdown');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
