// switchXprovider — Chaptions: per-project usage attribution.
//
// The proxy sees tokens per request but not which project a request came
// from. Claude Code, however, stamps every request with
// `metadata.user_id: "…_session_<uuid>"`, and locally every session UUID
// has a transcript file at ~/.claude/projects/<encoded-path>/<uuid>.jsonl.
// Resolving session → project directory gives us per-project attribution.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Extract the session UUID out of a metadata.user_id value. Two shapes seen
// in the wild: the standard "user_<hash>_account_<hash>_session_<uuid>" and
// a JSON-string payload {"device_id":…,"session_id":…} some clients send.
export function sessionFromMetadata(body) {
  const uid = body?.metadata?.user_id;
  if (typeof uid !== 'string') return null;
  const m = /session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(uid);
  if (m) return m[1].toLowerCase();
  try {
    const j = JSON.parse(uid);
    if (j && typeof j.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(j.session_id)) return j.session_id.toLowerCase();
  } catch { /* plain string — no session */ }
  return null;
}

// ---- session → project directory map (cached, refreshed hourly) ----

let cache = null; // Map<sessionUuid, projectDirName>
let cacheAt = 0;
const REFRESH_MS = 60 * 60_000;

export function projectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function scan() {
  const map = new Map();
  let entries = [];
  try { entries = fs.readdirSync(projectsDir(), { withFileTypes: true }); } catch { return map; }
  for (const dir of entries) {
    if (!dir.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(projectsDir(), dir.name)); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) map.set(f.replace(/\.jsonl$/, '').toLowerCase(), dir.name);
    }
  }
  return map;
}

export function sessionProject(sessionId) {
  if (!sessionId) return null;
  if (!cache || Date.now() - cacheAt > REFRESH_MS) {
    cache = scan();
    cacheAt = Date.now();
  }
  return cache.get(sessionId) || null;
}

// Pretty display name for an encoded project directory
// ("F--Claude-vibeXcode-Skills-switchXprovider" → "switchXprovider").
export function projectDisplayName(dirName) {
  if (!dirName) return 'unknown';
  const parts = String(dirName).split('-');
  // take the trailing segments up to ~2 words if they look like a name —
  // fall back to the full encoded name when short
  return dirName.length <= 24 ? dirName : parts.slice(-2).join('-');
}
