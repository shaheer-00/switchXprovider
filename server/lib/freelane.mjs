// switchXprovider — free-lane fingerprint for the OpenCode anonymous gateway.
//
// The public lane at https://opencode.ai/inference/v1/ serves frontier models
// (DeepSeek V4.1 Flash, Kimi K3, GLM 5.3 Flash, etc.) with no API key. It is
// gated by a v2 OpenCode client fingerprint: a specific User-Agent, a pooled
// `Bearer public` credential, a session id with a gate-validated encoding, and
// exact tool definitions for `read`/`shell` that must be byte-identical to the
// OpenCode v2 CLI. Every one of these is a 403 FreeTierError on its own.
//
// Source of truth for the shape:
//   docs/free-lane-wire.md  (measurements)
//   src/upstream.js         (this module is a port of the client seam)
//
// @module lib/freelane.mjs

import crypto from 'node:crypto';

// --- Session id minting (gate-validated encoding) ---

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const SESSION_DESCENDING_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Whether `id` is a session the upstream free tier will accept as-is. */
export function isCanonicalSession(id) {
  return typeof id === 'string' && SESSION_RE.test(id.trim()) && SESSION_DESCENDING_RE.test(id.trim().slice(4, 16));
}

/** Render `bytes` as exactly `width` base62 chars (big-endian). */
function base62Fixed(bytes, width) {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  const base = 62n;
  const out = new Array(width);
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = BASE62[Number(n % base)];
    n /= base;
  }
  return out.join('');
}

/** Encode a deterministic session id from a downstream conversation seed.
 *  Uses sha256 of `ses\0<seed>` so the same conversation keeps one stable
 *  upstream session (free-tier quota is per-session). */
export function canonicalizeSession(signal) {
  const seed = (typeof signal === 'string' && signal.trim()) ? signal.trim() : 'global';
  const digest = crypto.createHash('sha256').update(`ses\0${seed}`).digest();
  const current = (BigInt(digest[0]) << 28n | BigInt(digest[1]) << 20n | BigInt(digest[2]) << 12n |
    BigInt(digest[3]) << 4n | BigInt(digest[4]) >> 4n) << 12n | 1n;
  const inverted = ~current & 0xffffffffffffn;
  const timeHex = inverted.toString(16).padStart(12, '0');
  return `ses_${timeHex}${base62Fixed(digest.subarray(6, 16), 14)}`;
}

let lastStamp = 0;
let seq = 0;

/** Mint a fresh session id with the descending timestamp layout the gate accepts. */
export function mintSessionId(timestamp = Date.now()) {
  if (timestamp !== lastStamp) { lastStamp = timestamp; seq = 0; }
  seq += 1;
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(seq));
  let hex = '';
  for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0');
  let suffix = '';
  const rnd = crypto.randomBytes(14);
  for (const byte of rnd) suffix += BASE62[byte % 62];
  return `ses_${hex}${suffix}`;
}

// --- Tool fingerprint definitions (verbatim from OpenCode v2.0.26 CLI) ---

const FINGERPRINT_TOOLS = ['read', 'shell'];

const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description: 'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
        limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  shell: {
    description: 'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
        timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
        background: { type: 'boolean', description: 'Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use \'&\' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

function fingerprintKey(name) {
  const trimmed = String(name ?? '').trim();
  return FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : '';
}

/** Where a tool's description and parameter schema sit on the Anthropic shape. */
function definitionOf(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
  return { description: tool.description, schema: tool.input_schema };
}

/** Does this tool already carry OpenCode's own definition for `name`? */
function carriesFingerprintDefinition(tool, name) {
  const own = definitionOf(tool);
  if (own === null || own.description === undefined) return false;
  const want = FINGERPRINT_TOOL_DEFINITIONS[name];
  return own.description === want.description && JSON.stringify(own.schema) === JSON.stringify(want.parameters);
}

/** The gate's own declaration in Anthropic tool shape. */
function fingerprintTool(name) {
  const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
  return { name, description, input_schema: parameters };
}

/** `original name -> caller's alias` for every tool the alias pass renamed. */
function aliasesByOriginal(map) {
  return new Map([...map].map(([alias, original]) => [original, alias]));
}

function placeholderNote(names) {
  const list = names.map(n => `\`${n}\``).join(' or ');
  return names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

/** Rename prior-turn calls to a renamed tool in the history we are about to send. */
function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== 'object' || map.size === 0) return;
  const aliases = aliasesByOriginal(map);
  const rename = name => (typeof name === 'string' && aliases.has(name) ? aliases.get(name) : name);

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map(message => {
      if (message === null || typeof message !== 'object') return message;
      if (Array.isArray(message.content)) {
        const content = message.content.map(block => block?.type === 'tool_use' && aliases.has(block.name)
          ? { ...block, name: aliases.get(block.name) }
          : block);
        return { ...message, content };
      }
      if (!Array.isArray(message.tool_calls)) return message;
      return {
        ...message,
        tool_calls: message.tool_calls.map(call => aliases.has(call?.function?.name)
          ? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } }
          : call),
      };
    });
  }
}

/**
 * Satisfy the v2 free-tier fingerprint gate on `body.tools`.
 *
 * - `read` & `shell` must be declared with exact OpenCode definitions
 * - the caller's own tools (including `Read`/`Bash` casing variants) are preserved,
 *   renamed to an alias so they don't collide with the gate's exact name
 * - `tool_choice: 'none'` is stripped — it 403s on the free lane
 * - prior history calls to renamed tools are aliased to match
 * - a system/system-note tells the model the injected tools are placeholders
 */
export function applyFingerprint(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.tools)) return body;

  const renames = new Map(); // callerName -> aliasName
  const injected = [];
  const seen = new Set();    // fingerprint tools already handled (exact or renamed)

  for (let i = 0; i < body.tools.length; i++) {
    const tool = body.tools[i];
    const name = fingerprintKey(tool?.name) || fingerprintKey(tool?.function?.name);
    if (name === '') continue; // not a fingerprint tool — leave alone
    seen.add(name);

    if (carriesFingerprintDefinition(tool, name)) continue; // caller already has exact def

    // Caller's tool collides by name — rename it to an alias
    const alias = `${name}_client${i}`;
    renames.set(name, alias);
    if (tool.function) tool.function.name = alias;
    else tool.name = alias;
  }

  // Inject the gate's own declarations (Anthropic tool shape) for any
  // fingerprint tool that isn't already carrying the exact OpenCode definition.
  // A colliding caller tool was renamed above, so the gate's exact def must still
  // be injected under the original name.
  for (const name of FINGERPRINT_TOOLS) {
    if (!seen.has(name) || renames.has(name)) {
      injected.push(fingerprintTool(name));
    }
  }

  body.tools = [...injected, ...body.tools];

  // Strip tool_choice: 'none' — causes 403 on free lane
  if (body.tool_choice && typeof body.tool_choice === 'object' && body.tool_choice !== null) {
    delete body.tool_choice;
  }
  if (body.tool_choice === 'none') {
    delete body.tool_choice;
  }

  // Alias history calls that named the renamed tools
  aliasHistoryToolCalls(body, renames);

  // Note to the model that injected tools are placeholders
  const injectedNames = injected.map(t => t.name);
  if (injectedNames.length > 0) {
    const note = placeholderNote(injectedNames);
    if (typeof body.system === 'string' && body.system !== '') {
      body.system = `${body.system}\n\n${note}`;
    } else if (Array.isArray(body.system)) {
      body.system = [{ type: 'text', text: note }, ...body.system];
    } else {
      body.system = note;
    }
  }

  return body;
}

// --- Header synthesis ---

const CLIENT_UA = 'opencode/latest/2.0.26/cli';

/** Headers the free lane fingerprints a genuine client by. */
export function gatewayHeaders(session, { stream = false, accept } = {}) {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer public',
    'user-agent': CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-project': 'global',
    accept: accept ?? (stream ? 'text/event-stream' : '*/*'),
  };
}

// --- Models endpoint (for /v1/models) ---
// The free lane serves ~85 models. Claude Code only cares about opus/sonnet/haiku.
// We surface the free tier of the models dsh maps to the three slots.
export const FREE_MODELS = [
  'deepseek-v4.1-flash-free',
  'kimi-k3',
  'glm-5.3-flash-free',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-lightning-free',
  'claude-fable-5',
  'claude-opus-5',
  'claude-haiku-5-5',
  'claude-opus-5-5',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'deepseek-3.5-lightning-free',
];
