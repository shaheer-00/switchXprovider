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

// Setting this env key tells Claude Code you don't want claude.ai org
// connectors loaded — which hides the startup warning about them being
// disabled by auth precedence. Connectors can't load through the proxy
// anyway (the same auth precedence blocks them), so hiding costs nothing.
// Verified against the Claude Code 2.1.x binary: the warning is only shown
// for the api_key_precedence eligibility reason, not for an intentional opt-out.
const CONNECTORS_KEY = 'ENABLE_CLAUDEAI_MCP_SERVERS';

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

// A settings.json is "already switchX-routed" if it points at a local proxy
// AND carries a switchX signature (our token or sentinel models) — not just
// any localhost URL, which could be the user's own gateway. If the port
// changed since routing was enabled, comparing against the current port alone
// would treat a still-proxied settings.json as "original" and back the proxy
// config over the pristine backup.
function isSwitchxRouted(env) {
  if (!env) return false;
  const local = typeof env.ANTHROPIC_BASE_URL === 'string'
    && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(env.ANTHROPIC_BASE_URL);
  const signed = env.ANTHROPIC_AUTH_TOKEN === 'switchx-local'
    || Object.values(env).includes('switchx:opus')
    || Object.values(env).includes('switchx:sonnet')
    || Object.values(env).includes('switchx:haiku');
  return local && signed;
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
  // Backup only if the current file isn't already switchX-routed (any port),
  // so we never back up the proxy config over the user's original.
  if (fs.existsSync(sp) && !isSwitchxRouted(settings.env)) {
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
  // Guard against ANY switchX-shaped proxy config — the port may have changed.
  if (isSwitchxRouted(settings.env)) {
    restored = 0;
    for (const k of ENV_KEYS) delete settings.env[k];
  }
  if (!restored) {
    for (const k of ENV_KEYS) delete settings.env[k];
  }
  // Routing off means claude.ai connectors become loadable again (subscription
  // auth) — drop the opt-out so they come back instead of staying silently off.
  delete settings.env[CONNECTORS_KEY];
  if (!Object.keys(settings.env).length) delete settings.env;
  writeSettings(settings);
  log(restored
    ? 'Routing DISABLED — original env settings restored from the installer backup. Restart Claude Code to apply.'
    : 'Routing DISABLED — proxy env keys removed from settings.json. Restart Claude Code to apply.');
  return { enabled: false, restored: restored > 0 };
}

// ---- Claude Code "claude.ai connectors are disabled" startup warning ----
// While routed through the proxy, Claude Code warns at startup that its auth
// env takes precedence over the claude.ai login and org connectors won't
// load. Setting CONNECTORS_KEY='0' opts out of connector loading on purpose,
// which hides the warning. See the comment on CONNECTORS_KEY above.

export function warningState() {
  const settings = readSettings();
  const env = settings.env || {};
  return { hidden: env[CONNECTORS_KEY] === '0' };
}

export function setWarningHidden(hidden, log) {
  const settings = readSettings();
  settings.env = { ...(settings.env || {}) };
  if (hidden) {
    settings.env[CONNECTORS_KEY] = '0';
  } else {
    delete settings.env[CONNECTORS_KEY];
    if (!Object.keys(settings.env).length) delete settings.env;
  }
  writeSettings(settings);
  log(hidden
    ? 'Claude Code connectors warning hidden (claude.ai connectors opted out). Restart Claude Code to apply.'
    : 'Claude Code connectors warning restored. Restart Claude Code to apply.');
  return { hidden };
}
