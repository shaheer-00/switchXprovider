#!/usr/bin/env node
// Mock Anthropic-compatible provider for tests.
// Usage: node mock.mjs <port> <mode>
//   ok       — 200 on /v1/messages, echoes received model + auth; 200 on /v1/models
//   fail500  — 500 on /v1/messages (provider trouble)
//   ratelimit — 429 on /v1/messages (quota/usage window)
//   badreq   — 400 on /v1/messages (request error, must NOT trigger failover)
//   keyonly  — 401 unless x-api-key present (anthropic-style provider)
//   beareronly — 401 unless Authorization: Bearer present (openrouter-style provider)
//   openai   — OpenAI-protocol provider: /chat/completions only (JSON + SSE
//              with tool calls + usage), everything else 404. Verifies the
//              proxy's Anthropic→OpenAI translation.
//   modelfail — 400 "model not available" for models starting with "dead-"
//              (a gateway with a broken model channel), 200 otherwise.
//   rambler  — "thinks out loud" before the answer: /v1/messages returns a
//              wall of reasoning prose ending in the actual JSON report.
//              Verifies the analyze handler's JSON extraction.
//   prose    — returns prose only, no JSON anywhere: verifies the analyze
//              handler rotates slots and finally falls back to raw text.

import http from 'node:http';

const [, , portArg, mode = 'ok'] = process.argv;
const port = parseInt(portArg, 10);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (mode === 'openai') {
      // OpenAI-protocol provider: /chat/completions + /v1/models (health
      // probes GET the models list), everything else 404.
      if (req.method === 'GET' && req.url.includes('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'openai-model-x', object: 'model' }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Not found: ${req.url}` } }));
        return;
      }
      const json = JSON.parse(body || '{}');
      const gotBearer = /^Bearer /.test(req.headers['authorization'] || '');
      if (!gotBearer) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key.', type: 'authentication_error', code: 'invalid_api_key' } }));
        return;
      }
      if (json.stream) {
        // SSE: text deltas, then a tool call, then usage in the final chunk.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: json.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello ' }, finish_reason: null }] });
        chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: json.model, choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }] });
        chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: json.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"' } }] }, finish_reason: null }] });
        chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: json.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'SF"}' } }] }, finish_reason: null }] });
        chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: json.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        chunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: json.model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: json.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'mock openai reply',
            tool_calls: [{ id: 'call_mock1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
        receivedAuth: req.headers['authorization'],
      }));
      return;
    }

    if (req.url.includes('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      // 'ok' returns a realistic mixed list so /api/providers/fetch-models
      // can be tested end-to-end (claude slots + non-claude names + versions).
      res.end(JSON.stringify({ data: [
        { id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }, { id: 'claude-haiku-4-5-20251001' },
        { id: 'good-sonnet' }, { id: 'good-opus' }, { id: 'bearer-sonnet' },
        { id: 'kira-sonnet-v4' }, { id: 'glm-5.2' },
      ] }));
      return;
    }
    if (!req.url.includes('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    const auth = req.headers['x-api-key'] || req.headers['authorization'] || '';
    const json = JSON.parse(body || '{}');

    // gateway with a dead model channel: 400 (client-error class → the proxy
    // passes it through without failover) for dead-* models only
    if (mode === 'modelfail' && /^dead-/.test(json.model || '')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'bad_request', message: 'The requested model is not available.' } }));
      return;
    }

    // small model that ignores "JSON only" and narrates its reasoning first
    if (mode === 'rambler' || mode === 'prose') {
      const report = mode === 'rambler' ? `\n\n{"headline":"test-proj dominates with 2100 tokens","insights":["glm-5.3 leads model usage"],"stats":[{"label":"Tokens","value":"2.1K"}],"charts":[{"type":"bar","title":"Projects","points":[{"label":"test-proj","value":2100}]}]}` : '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_rambler',
        type: 'message',
        role: 'assistant',
        model: json.model,
        content: [{ type: 'text', text: `Let me think about this. The user wants JSON. I should list the data: projects, models, providers. The top project is test-proj with 2100 tokens. glm-5.3 leads models. Now I will produce the report carefully, checking the shape requirements first. Here goes:${report}` }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
      return;
    }

    if (mode === 'ok' && json.stream) {
      // SSE with realistic usage events: message_start carries input tokens,
      // message_delta carries the final cumulative output count.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: json.model, usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 3 } } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } })}\n\n`);
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
      return;
    }

    const payload = JSON.stringify({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: json.model,
      content: [{ type: 'text', text: `mock:${mode}` }],
      receivedAuth: auth,
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    if (mode === 'fail500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mock internal error' } }));
      return;
    }
    if (mode === 'ratelimit') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'mock rate limit' } }));
      return;
    }
    if (mode === 'badreq') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'mock bad request' } }));
      return;
    }
    if (mode === 'keyonly' && !req.headers['x-api-key']) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'missing x-api-key' } }));
      return;
    }
    if (mode === 'beareronly' && !/^Bearer /.test(req.headers['authorization'] || '')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'missing bearer token' } }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock ${mode} on ${port}`);
});
