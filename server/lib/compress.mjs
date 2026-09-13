// switchXprovider — token saver: compress tool_result content before upstream.
//
// Claude Code requests carry huge tool outputs (git diff, grep, ls, error
// dumps) inside user-message tool_result blocks. On quota-metered free tiers
// those input tokens are the scarce resource. This walks the request body and
// shrinks ONLY tool_result text, leaving system prompts, user text, tool_use
// blocks, and images untouched:
//
//   1. collapse runs of 3+ blank lines to one, strip leading/trailing blanks
//   2. blocks over `threshold` chars: keep head 70% / tail 30%, replace the
//      middle with a marker so the model knows data was elided (better than
//      silent loss). Skipped when the marker would cost more than it saves.
//
// Everything is deterministic — the same input always produces the same
// bytes, so prompt-cache prefixes stay valid across requests.
//
// Safety contract: compressBody never throws and never grows the body.
// Malformed shapes fall through to zero-op passthrough.

// Head/tail split when eliding. 70/30 matches how code is usually read:
// imports and signatures up top, the tail matters, the middle is bulk.
const HEAD_SHARE = 0.7;

const ELIDE_MARKER = '[switchx elided';

// Collapse 3+ consecutive blank-ish lines to one. Blank-ish = line with only
// whitespace. No outer trim — below-threshold blocks must stay byte-identical
// (predictable, and prompt-cache prefixes only ever change when there were
// real blank-line runs to collapse). Deterministic, idempotent.
function collapseBlankLines(text) {
  if (typeof text !== 'string' || text.length < 3) return text;
  return text.replace(/(?:[ \t]*\n){3,}/g, '\n\n');
}

// Compress a single text string. Returns the new text, or null if nothing
// changed (caller counts savedChars only on real changes).
function compressText(text, threshold) {
  let out = collapseBlankLines(text);
  const marker = `${ELIDE_MARKER} ${out.length - threshold} chars] ...`;
  if (out.length > threshold && out.length - marker.length > 0) {
    // Only elide when the result is strictly smaller than what we started
    // with — a barely-over block must not grow (marker overhead > savings).
    const headLen = Math.max(1, Math.floor((threshold * HEAD_SHARE)));
    const tailLen = Math.max(1, Math.floor(threshold * (1 - HEAD_SHARE)));
    const elided = `${out.slice(0, headLen)}\n\n... ${marker}\n\n${out.slice(out.length - tailLen)}`;
    if (elided.length < text.length) out = elided;
  }
  return out === text ? null : out;
}

// Compress one tool_result's content: array of blocks (text blocks replaced
// in place) or a plain string. Other block types (images, etc.) untouched.
// Returns chars saved.
function compressToolResultContent(content, threshold) {
  let saved = 0;
  if (typeof content === 'string') {
    const out = compressText(content, threshold);
    if (out != null) {
      saved = content.length - out.length;
      content = out; // eslint-disable-line no-param-reassign — caller reassigns below
      return { content, saved };
    }
    return { content, saved };
  }
  if (!Array.isArray(content)) return { content, saved };
  for (let i = 0; i < content.length; i++) {
    const b = content[i];
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
      const out = compressText(b.text, threshold);
      if (out != null) {
        saved += b.text.length - out.length;
        b.text = out;
      }
    }
  }
  return { content, saved };
}

// Compress an Anthropic Messages request body. `comp` is cfg.compression
// ({ enabled, threshold }). Returns { body, savedChars } — body is the same
// object mutated in place when compression applies, or untouched otherwise.
export function compressBody(body, comp) {
  try {
    if (!comp || comp.enabled === false) return { body, savedChars: 0 };
    const threshold = Number.isFinite(comp.threshold) && comp.threshold >= 1000
      ? Math.floor(comp.threshold)
      : 12_000;
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
      return { body, savedChars: 0 };
    }
    let saved = 0;
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object' || msg.role !== 'user') continue;
      const blocks = msg.content;
      if (typeof blocks === 'string') continue; // plain user text — not ours
      if (!Array.isArray(blocks)) continue;
      for (const blk of blocks) {
        if (!blk || typeof blk !== 'object' || blk.type !== 'tool_result') continue;
        const r = compressToolResultContent(blk.content, threshold);
        if (r.saved > 0) {
          blk.content = r.content;
          saved += r.saved;
        }
      }
    }
    return { body, savedChars: saved };
  } catch {
    // Safety contract: never throw, never lose the request.
    return { body, savedChars: 0 };
  }
}
