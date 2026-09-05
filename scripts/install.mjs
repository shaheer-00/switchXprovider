#!/usr/bin/env node
// switchXprovider — Claude Code setup (LAST step of installation).
//
// Order matters: once settings.json points at this proxy, Claude Code can
// only reach an API through it. If no provider is configured yet, Claude
// Code gets stuck with no API access. So this script REFUSES to touch
// settings.json until the proxy is running and at least one enabled provider
// has an API key. `--force` skips the safety checks.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from '../server/lib/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORCE = process.argv.includes('--force');

const cfg = load();
const port = cfg.port || 8787;
const base = `http://127.0.0.1:${port}`;

const ENV_TO_SET = {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  ANTHROPIC_AUTH_TOKEN: 'switchx-local',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'switchx:opus',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'switchx:sonnet',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'switchx:haiku',
};

async function ping(timeoutMs = 1500) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(`${base}/healthz`, { signal: ac.signal });
      return r.ok;
    } finally { clearTimeout(t); }
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureProxy() {
  if (await ping()) return true;
  // Self-daemonizing bootstrap — starts the server detached, exits fast.
  spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'ensure.mjs')], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if (await ping()) return true;
  }
  return false;
}

async function main() {
  console.log('switchXprovider setup\n');

  // ---- Check 1: proxy running ----
  if (!(await ensureProxy())) {
    console.error(`ERROR: proxy not reachable at ${base} and could not be started.`);
    console.error('Start it manually:  node server/ensure.mjs');
    console.error('Then re-run this installer.');
    process.exit(1);
  }
  console.log(`✓ proxy running at ${base}`);

  // ---- Check 2: at least one enabled provider with an API key ----
  // (maskKey === '' means no key — the dashboard's status view masks keys,
  // and an empty mask can only mean an empty key.)
  let providers = [];
  try {
    const r = await fetch(`${base}/api/status`);
    const status = await r.json();
    providers = status.providers || [];
  } catch (err) {
    console.error(`ERROR: could not read proxy status: ${err.message}`);
    process.exit(1);
  }
  const ready = providers.filter((p) => p.enabled && p.maskedKey);
  if (!FORCE && !ready.length) {
    console.error('ERROR: no enabled provider with an API key is configured yet.');
    console.error(`
Why this matters: the moment settings.json points at the proxy, ALL Claude Code
traffic goes through it. With no provider configured, Claude Code would be
completely stuck — no API access at all.

Do this first:
  1. Open the dashboard:  ${base}
  2. Add a provider (name, base URL, API key, model IDs) and enable it
  3. Click "test" to confirm it is reachable
  4. Re-run this installer

To skip these safety checks anyway:  node scripts/install.mjs --force
`);
    process.exit(1);
  }
  console.log(`✓ ${ready.length} provider(s) ready: ${ready.map((p) => p.name).join(', ')}`);

  // ---- Check 3 (informational): are any of them reachable right now ----
  const reachable = [];
  for (const p of ready) {
    try {
      const r = await fetch(`${base}/api/providers/${p.id}/test`, { method: 'POST' });
      const j = await r.json();
      if (j.ok) reachable.push(p.name);
    } catch { /* unreachable */ }
  }
  if (reachable.length) {
    console.log(`✓ reachable now: ${reachable.join(', ')}`);
  } else {
    console.log('⚠ WARNING: none of the providers answered a health probe right now.');
    console.log('  Failover needs a working provider eventually — Claude Code may be');
    console.log('  unable to complete requests until one recovers. Proceeding anyway');
    console.log('  (providers can come back later; auto-recovery handles it).');
  }

  // ---- All checks passed → now, and only now, touch settings.json ----
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const backupPath = settingsPath + '.switchx-backup';

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    // no settings file yet — create fresh
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, backupPath);
    console.log(`\nBackup written: ${backupPath}`);
  }

  settings.env = { ...(settings.env || {}) };
  const changes = [];
  for (const [k, v] of Object.entries(ENV_TO_SET)) {
    const old = settings.env[k];
    if (old === v) {
      changes.push(`  =  ${k} = ${v}`);
    } else {
      changes.push(`  ${old ? '~' : '+'}  ${k} = ${v}${old ? `  (was: ${old})` : ''}`);
    }
    settings.env[k] = v;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Updated: ${settingsPath}\n`);
  console.log(changes.join('\n'));

  // Shell/system env vars can shadow settings.json env — surface any conflicts.
  const conflicts = Object.keys(ENV_TO_SET).filter((k) => process.env[k]);
  if (conflicts.length) {
    console.log(`\nWARNING: these environment variables are also set in your shell/system and may override settings.json:`);
    for (const k of conflicts) console.log(`  ${k} = ${process.env[k]}`);
    console.log('Remove them (System Properties → Environment Variables, or your shell profile) so the proxy settings take effect.');
  }

  console.log(`
Done. Final step: restart Claude Code.

If Claude Code ever gets stuck after this: restore the backup —
  copy "${backupPath}" "${settingsPath}"
then fix the provider in the dashboard (${base}) and re-run this installer.
`);
}

main().catch((err) => {
  console.error('installer failed:', err.message);
  process.exit(1);
});
