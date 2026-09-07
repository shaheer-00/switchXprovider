#!/usr/bin/env node
// switchXprovider — daemon bootstrap + update manager.
// Called from the plugin's SessionStart hook so the proxy is always running.
//
// Three jobs:
//   1. proxy down                         → start it
//   2. proxy up, running a newer version  → do nothing (a newer install is live)
//   3. proxy up, running an older version → write an update marker, restart
//      the proxy from this (newer) install — plugin updates apply themselves
//
// `node ensure.mjs --replace` — invoked by an old proxy handing over via
// /api/update-restart: shut that proxy down, wait for the port, start ours.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load, LOG_PATH, DIR } from './lib/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
const UPDATE_MARKER_PATH = path.join(DIR, 'update-available.json');
const cfg = load();
const port = cfg.port || 8787;
const BASE = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// true when a is strictly newer than b (plain x.y.z compare)
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function tryFetch(url, opts, timeoutMs = 1500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isUp() {
  const resp = await tryFetch(`${BASE}/healthz`);
  return Boolean(resp?.ok);
}

async function runningStatus() {
  const resp = await tryFetch(`${BASE}/api/status`);
  if (!resp?.ok) return null;
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

async function shutdownRunning() {
  await tryFetch(`${BASE}/api/shutdown`, { method: 'POST' });
}

// Wait until the proxy stops answering (max ~10s) + brief settle delay.
async function waitGone() {
  for (let i = 0; i < 50; i++) {
    if (!(await isUp())) break;
    await sleep(200);
  }
  await sleep(300); // let the OS release the port
}

function spawnServer() {
  const serverPath = path.join(__dirname, 'server.mjs');
  const logFd = fs.openSync(LOG_PATH, 'a');
  try {
    const child = spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.unref();
    fs.writeSync(logFd, `[ensure] spawned server pid ${child.pid} at ${new Date().toISOString()}\n`);
  } finally {
    fs.closeSync(logFd);
  }
}

async function replaceRunning() {
  await shutdownRunning();
  await waitGone();
  spawnServer();
}

if (process.argv.includes('--replace')) {
  await replaceRunning();
  process.exit(0);
}

if (await isUp()) {
  const st = await runningStatus();
  const running = st?.version;
  if (!running || newer(PKG.version, running)) {
    // Record the pending update for the dashboard, then swap the proxy in place.
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(UPDATE_MARKER_PATH, JSON.stringify({ version: PKG.version, path: PLUGIN_ROOT, ts: Date.now() }, null, 2));
    } catch { /* marker is best-effort — the restart below is what matters */ }
    console.log(`switchXprovider updated ${running || 'unknown'} → ${PKG.version} — restarting proxy`);
    await replaceRunning();
  }
  process.exit(0);
}

spawnServer();
process.exit(0);
