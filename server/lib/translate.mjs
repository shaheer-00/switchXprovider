// switchXprovider — Anthropic ⇄ OpenAI protocol translation.
//
// The proxy speaks Anthropic Messages format with Claude Code. Providers in
// the OpenAI ecosystem (Google AI Studio, NVIDIA NIM, Groq, Together, …)
// expose /chat/completions instead. This module translates:
//
//   anthropicToOpenAI(body)     request:  system/messages/tools/params
//   openAIToAnthropic(json)     response: content blocks, tool_use, usage
//   openaiToAnthropicStream()   response: SSE chunk stream → Anthropic event
//                               stream (or buffered JSON → Anthropic JSON —
//                               the transform auto-detects by first byte)
//
// Tool calls are fully translated in both directions — Claude Code cannot
// function without them.

import { Transform } from 'node:stream';

/* ---------- request: Anthropic Messages → OpenAI chat/completions ---------- */

// Flatten an Anthropic system field (string or block array) to plain text.
const systemText = (sys) => {
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) return sys.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
  return '';
};

// Anthropic content is a string or a block array. OpenAI wants either a
// plain string or an array of typed parts. Images become image_url data URIs.
function openAIContent(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const b of blocks) {
    if (b?.type === 'text') parts.push({ type: 'text', text: b.text || '' });
    else if (b?.type === 'image' && b.source?.type === 'base64') {
      parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    }
    // tool_use / tool_result are handled by the message splitter, not here
  }
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

// Extract just the text out of a tool_result's content (string or blocks).
const toolResultText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
  return '';
};

// One Anthropic message can mix text + tool_use (assistant) or text +
// tool_result (user) in a single block array. OpenAI needs these as separate
// messages — text/tool_calls on the assistant, one role:'tool' message per
// tool_call_id. This splitter walks the blocks and emits the right sequence.
function splitMessage(m, out) {
  const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
  if (m.role === 'assistant') {
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
    const calls = blocks.filter((b) => b?.type === 'tool_use');
    if (calls.length) {
      const msg = { role: 'assistant', content: text || null, tool_calls: calls.map((c) => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      })) };
      out.push(msg);
    } else if (text) {
      out.push({ role: 'assistant', content: text });
    }
  } else if (m.role === 'user') {
    // tool_results must become standalone role:'tool' messages; other content
    // (text/images) becomes a normal user message.
    const results = blocks.filter((b) => b?.type === 'tool_result');
    const rest = blocks.filter((b) => b?.type !== 'tool_result');
    if (rest.length) out.push({ role: 'user', content: openAIContent(rest) });
    for (const r of results) out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: toolResultText(r.content) });
    if (!blocks.length) out.push({ role: 'user', content: '' });
  } else {
    out.push({ role: m.role, content: openAIContent(blocks) });
  }
}

export function anthropicToOpenAI(b) {
  const out = { model: b.model };
  if (b.max_tokens != null) out.max_tokens = b.max_tokens;
  if (b.temperature != null) out.temperature = b.temperature;
  if (b.top_p != null) out.top_p = b.top_p;
  if (Array.isArray(b.stop_sequences) && b.stop_sequences.length) out.stop = b.stop_sequences;

  const msgs = [];
  if (b.system) msgs.push({ role: 'system', content: systemText(b.system) });
  for (const m of b.messages || []) splitMessage(m, msgs);
  out.messages = msgs;

  if (Array.isArray(b.tools) && b.tools.length) {
    out.tools = b.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object' } },
    }));
  }
  if (b.tool_choice) {
    if (b.tool_choice.type === 'any') out.tool_choice = 'required';
    else if (b.tool_choice.type === 'tool') out.tool_choice = { type: 'function', function: { name: b.tool_choice.name } };
    else out.tool_choice = 'auto';
  }
  if (b.stream) {
    out.stream = true;
    // final chunk then carries usage — we need it for the Anthropic message_delta
    out.stream_options = { include_usage: true };
  }
  return out;
}

/* ---------- response: OpenAI chat/completions → Anthropic Messages ---------- */

const safeParse = (s) => {
  try { return JSON.parse(s); } catch { return {}; }
};

const mapFinish = (fr) =>
  fr === 'length' ? 'max_tokens'
    : (fr === 'tool_calls' || fr === 'function_call') ? 'tool_use'
    : 'end_turn';

export function openAIToAnthropic(json) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  else if (Array.isArray(msg.content)) {
    for (const p of msg.content) if (p?.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
  }
  for (const tc of msg.tool_calls || []) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: safeParse(tc.function?.arguments || '{}') });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: 'msg_' + (json.id || String(Date.now())),
    type: 'message',
    role: 'assistant',
    model: json.model || '',
    content,
    stop_reason: mapFinish(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens || 0,
      output_tokens: json.usage?.completion_tokens || 0,
    },
  };
}

/* ---------- streaming: OpenAI SSE chunks → Anthropic event stream ---------- */

// A Transform that consumes the OpenAI response body and emits an
// Anthropic-shaped body. Auto-detects SSE (starts with 'data:') vs plain JSON
// (starts with '{') on the first meaningful byte — JSON is buffered whole and
// translated on flush, so downstream (usageTap, Claude Code) only ever sees
// Anthropic wire format.
export function openaiToAnthropicStream(model) {
  let mode = null; // 'sse' | 'json' — set on first non-whitespace byte
  let buf = '';

  let started = false;
  let blockIdx = -1;
  let openBlock = null; // 'text' | 'tool'
  // OpenAI tool_call index → { blockIndex, id, name, started }
  const tools = new Map();
  let finishReason = null;
  let usage = null;
  const msgId = 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // A per-transform-call output buffer: Node's Transform callback may fire
  // exactly once per chunk, so every emit below appends here and transform()
  // flushes it in a single cb at the end.
  let pending = '';
  const ev = (obj) => { pending += `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`; };

  const startMessage = (inputTokens) => {
    if (started) return;
    started = true;
    ev({
      type: 'message_start',
      message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } },
    });
  };

  const openTextBlock = () => {
    if (openBlock === 'text') return;
    closeBlock();
    openBlock = 'text';
    ev({ type: 'content_block_start', index: ++blockIdx, content_block: { type: 'text', text: '' } });
  };

  const openToolBlock = (idx, id, name) => {
    if (openBlock === 'tool' && tools.get(idx)?.started) return;
    closeBlock();
    openBlock = 'tool';
    tools.set(idx, { ...(tools.get(idx) || {}), started: true });
    ev({ type: 'content_block_start', index: ++blockIdx, content_block: { type: 'tool_use', id, name, input: {} } });
  };

  const closeBlock = () => {
    if (openBlock == null) return;
    ev({ type: 'content_block_stop', index: blockIdx });
    openBlock = null;
  };

  const handleChunk = (j) => {
    const choice = j?.choices?.[0];
    const delta = choice?.delta || {};
    if (!started) startMessage(j.usage?.prompt_tokens || 0);
    if (typeof delta.content === 'string' && delta.content) {
      openTextBlock();
      ev({ type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: delta.content } });
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      const acc = tools.get(idx) || {};
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name = tc.function.name;
      tools.set(idx, acc);
      // The first fragment usually carries id + name together — open the
      // block as soon as we know both.
      if (acc.id && acc.name) {
        openToolBlock(idx, acc.id, acc.name);
        // Some providers replay the name on later fragments — ignore those.
        const argFragment = tc.function?.arguments;
        if (typeof argFragment === 'string' && argFragment) {
          ev({ type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: argFragment } });
        }
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (j.usage) usage = j.usage;
  };

  const finish = () => {
    closeBlock();
    ev({
      type: 'message_delta',
      delta: { stop_reason: mapFinish(finishReason), stop_sequence: null },
      usage: { output_tokens: usage?.completion_tokens || 0 },
    });
    ev({ type: 'message_stop' });
  };

  return new Transform({
    transform(chunk, _enc, cb) {
      pending = '';
      const text = chunk.toString('utf8');
      if (mode === null) {
        const first = text.slice(text.search(/\S/));
        if (first.startsWith('{')) mode = 'json';
        else mode = 'sse';
      }
      if (mode === 'json') { buf += text; cb(); return; }

      // SSE mode: split into lines, feed each data: payload through the machine
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue; // comments, keepalives, events
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try { handleChunk(JSON.parse(d)); } catch { /* partial line */ }
      }
      cb(null, pending);
    },
    flush(cb) {
      if (mode === 'json') {
        try {
          const j = JSON.parse(buf);
          const msg = openAIToAnthropic(j);
          cb(null, JSON.stringify(msg));
        } catch {
          cb(null, buf); // not JSON after all — pass through
        }
        return;
      }
      pending = '';
      // trailing data without newline
      const d = buf.replace(/^data:/, '').trim();
      if (d && d !== '[DONE]') { try { handleChunk(JSON.parse(d)); } catch { /* ignore */ } }
      buf = '';
      finish();
      cb(null, pending);
    },
  });
}
