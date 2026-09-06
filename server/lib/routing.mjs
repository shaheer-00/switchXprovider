// switchXprovider — Claude Code routing control.
//
// Flips ~/.claude/settings.json between "traffic goes through the local proxy"
// and "traffic goes to Anthropic directly". Mirrors the installer's transform
// (backup first, env keys only) so the two never fight over the file.
//
// Use case: subscription users keep routing OFF most of the time (their plan
// quota), and flip it ON when Claude Code shows the ~90% usage warning —
// traffic then flows through their configured gateway providers until the
// quota window resets.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];

function settingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}
function backupPath() {
  return settingsPath() + '.switchx-backup';
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n');
}

export function routingState(port) {
  const settings = readSettings();
  const env = settings.env || {};
  return {
    configured: env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${port}`,
    baseUrl: env.ANTHROPIC_BASE_URL || null,
  };
}

// Point Claude Code at the local proxy.
export function enableRouting(port, log) {
  const sp = settingsPath();
  const settings = readSettings();
  // Backup only if the current file isn't already proxy-routed, so we never
  // back up the proxy config over the user's original.
  if (fs.existsSync(sp) && settings.env?.ANTHROPIC_BASE_URL !== `http://127.0.0.1:${port}`) {
    fs.copyFileSync(sp, backupPath());
  }
  settings.env = { ...(settings.env || {}) };
  settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  settings.env.ANTHROPIC_AUTH_TOKEN = 'switchx-local';
  settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'switchx:opus';
  settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'switchx:sonnet';
  settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'switchx:haiku';
  writeSettings(settings);
  log(`Routing ENABLED — Claude Code now talks to http://127.0.0.1:${port}. Restart Claude Code to apply.`);
  return { enabled: true };
}

// Point Claude Code back at Anthropic directly.
export function disableRouting(port, log) {
  const bp = backupPath();
  const settings = readSettings();
  if (!settings.env) return { enabled: false, changed: false };
  // If a pre-install backup exists, restore just its values for our env keys —
  // the user's other settings (permissions etc.) may have changed since, so
  // restoring the whole file would clobber them.
  let restored = 0;
  if (fs.existsSync(bp)) {
    try {
      const backup = JSON.parse(fs.readFileSync(bp, 'utf8'));
      const benv = backup.env || {};
      for (const k of ENV_KEYS) {
        if (k in benv) { settings.env[k] = benv[k]; restored++; }
        else delete settings.env[k];
      }
    } catch { /* unreadable backup — fall through to plain strip */ }
  }
  // A re-run of the installer can have backed up an already-proxied
  // settings.json; restoring those values would silently keep routing on.
  if (settings.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${port}`) {
    restored = 0;
    for (const k of ENV_KEYS) delete settings.env[k];
  }
  if (!restored) {
    for (const k of ENV_KEYS) delete settings.env[k];
  }
  if (!Object.keys(settings.env).length) delete settings.env;
  writeSettings(settings);
  log(restored
    ? 'Routing DISABLED — original env settings restored from the installer backup. Restart Claude Code to apply.'
    : 'Routing DISABLED — proxy env keys removed from settings.json. Restart Claude Code to apply.');
  return { enabled: false, restored: restored > 0 };
}
