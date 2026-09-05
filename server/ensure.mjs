#!/usr/bin/env node
// switchXprovider — daemon bootstrap.
// Exits immediately if the proxy is already up; otherwise spawns it detached.
// Called from the plugin's SessionStart hook so the proxy is always running.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load, LOG_PATH } from './lib/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = load();
const port = cfg.port || 8787;

async function isUp() {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1200);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: ac.signal });
      return resp.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

if (await isUp()) {
  process.exit(0);
}

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
process.exit(0);
