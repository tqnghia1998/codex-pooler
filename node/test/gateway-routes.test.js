import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { attachWebSocketProxy } from '../src/proxy.js';
import { Store } from '../src/store.js';
import { CodexHostHealth } from '../src/codex-host-health.js';

const API_KEY = 'client-key';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function codex({ email = 'routes@example.com', accountId = 'acct-routes', refreshToken = null } = {}) {
  return {
    type: 'codex',
    authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
      id_token: jwt({ email }),
      ...(refreshToken ? { refresh_token: refreshToken } : {})
    }})
  };
}

function configuredStore(dir, { compass = false } = {}) {
  const store = new Store(dir);
  const codexUpstream = store.create(codex());
  store.setCap(codexUpstream.id, { capDollars: 100 });
  let compassUpstream;
  if (compass) {
    compassUpstream = store.create({ type: 'compass', projectId: 'project-routes', projectKey: 'compass-secret' });
    store.setCap(compassUpstream.id, { capDollars: 100 });
  }
  return { store, codexUpstream, compassUpstream };
}

async function start(store, fetchImpl, apiKey = API_KEY) {
  const server = createServer(createApp({ store, fetchImpl, apiKey }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function gatewayFetch(base, path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: { authorization: `Bearer ${API_KEY}`, ...(options.headers || {}) }
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('discovers and caches Codex models while preserving the static fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-models-'));
  const { store } = configuredStore(dir, { compass: true });
  let calls = 0;
  const { server, base } = await start(store, async (url, options) => {
    calls += 1;
    assert.equal(new URL(url).pathname, '/backend-api/codex/models');
    assert.match(new URL(url).searchParams.get('client_version'), /^\d+\.\d+\.\d+$/);
    assert.match(options.headers.authorization, /^Bearer header\./);
    assert.equal(options.headers['chatgpt-account-id'], 'acct-routes');
    return new Response(JSON.stringify({
      models: [{ slug: 'gpt-new-live', input_modalities: ['text'], token: 'must-not-leak' }]
    }), { status: 200 });
  });
  try {
    const response = await gatewayFetch(base, '/v1/models');
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map((model) => model.id), [
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'glm-5.3-flash', 'kimi-k3',
      'gpt-new-live'
    ]);
    const backend = await gatewayFetch(base, '/backend-api/codex/models');
    assert.match(backend.headers.get('etag'), /^W\/"cp-models-v1-[a-f0-9]{64}"$/);
    const backendBody = await backend.json();
    assert.equal(backendBody.models.find(({ id }) => id === 'gpt-new-live').token, undefined);
    assert.equal(calls, 1);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes a discovered model only to accounts known to support it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-model-routing-'));
  const store = new Store(dir);
  const first = store.create(codex({ email: 'first-model@example.com', accountId: 'acct-model-a' }));
  const second = store.create(codex({ email: 'second-model@example.com', accountId: 'acct-model-b' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const dispatchedAccounts = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    const accountId = options.headers['chatgpt-account-id'];
    if (path === '/backend-api/codex/models') {
      const models = accountId === 'acct-model-a' ? [{ slug: 'gpt-account-a' }] : [{ slug: 'gpt-account-b' }];
      return new Response(JSON.stringify({ models }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(path, '/backend-api/codex/responses');
    dispatchedAccounts.push(accountId);
    return new Response('data: {"type":"response.completed","response":{"id":"resp-model-a","status":"completed","output":[]}}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    assert.equal((await gatewayFetch(base, '/v1/models')).status, 200);
    const response = await gatewayFetch(base, '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-account-a', input: 'hello' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(dispatchedAccounts, ['acct-model-a']);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns authenticated OpenAI-shaped errors for explicit unsupported routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-unsupported-routes-'));
  const { store } = configuredStore(dir);
  const { server, base } = await start(store, async () => { throw new Error('must not dispatch'); });
  try {
    const routes = [
      ['POST', '/v1/images/variations'],
      ['POST', '/v1/embeddings'],
      ['POST', '/v1/batches'],
      ['POST', '/v1/moderations'],
      ['POST', '/v1/fine_tuning/jobs'],
      ['GET', '/v1/responses/resp_fixture'],
      ['POST', '/v1/responses/resp_fixture/cancel'],
      ['DELETE', '/v1/responses/resp_fixture']
    ];
    for (const [method, path] of routes) {
      const response = await gatewayFetch(base, path, { method });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), {
        error: {
          type: 'invalid_request_error', code: 'unsupported_endpoint',
          message: 'Unsupported OpenAI /v1 endpoint', param: null
        }
      });
    }
    const unauthenticated = await fetch(base + '/v1/embeddings', { method: 'POST' });
    assert.equal(unauthenticated.status, 401);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maps compact and native backend media routes while preserving request bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-raw-routes-'));
  const { store } = configuredStore(dir);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' } });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const compact = await gatewayFetch(base, '/backend-api/codex/v1/responses/compact', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'compact', max_output_tokens: 128, temperature: 0.2, top_p: 0.9, reasoning: { effort: 'ultra' } })
    });
    assert.equal(compact.status, 200);
    assert.equal(JSON.parse(calls[0].body).input, 'compact');
    assert.equal(JSON.parse(calls[0].body).reasoning.effort, 'max');
    assert.equal(JSON.parse(calls[0].body).max_output_tokens, 128);
    assert.equal(JSON.parse(calls[0].body).temperature, 0.2);
    assert.equal(JSON.parse(calls[0].body).top_p, 0.9);
    assert.equal(compact.headers.get('x-request-id'), 'request-1');

    const bytes = Buffer.from([0, 1, 2, 255]);
    const raw = await gatewayFetch(base, '/backend-api/transcribe', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes
    });
    assert.equal(raw.status, 200);
    assert.equal(new URL(calls[0].url).pathname, '/backend-api/codex/responses/compact');
    assert.equal(new URL(calls[1].url).pathname, '/backend-api/transcribe');
    assert.equal(calls[1].headers['content-type'], 'application/octet-stream');
    assert.deepEqual(Buffer.from(calls[1].body), bytes);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizes raw Codex quota failures and cools the account immediately', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-raw-failure-'));
  const { store, codexUpstream } = configuredStore(dir);
  const { server, base } = await start(store, async () => new Response('provider-secret', { status: 429, headers: { 'retry-after': '17' } }));
  try {
    const response = await gatewayFetch(base, '/backend-api/wham/usage');
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('retry-after'), '17');
    assert.equal(body.includes('provider-secret'), false);
    const health = store.get(codexUpstream.id).health;
    assert.equal(health.status, 'cooldown');
    assert.equal(health.failureClass, 'quota');
    assert.equal(health.cooldownSource, 'retry-after');
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cools compatibility routes on one quota response and relays Retry-After', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compatibility-cooldown-'));
  const { store, codexUpstream } = configuredStore(dir);
  const { server, base } = await start(store, async () => new Response('private quota body', {
    status: 429,
    headers: { 'retry-after': '23', 'content-type': 'application/json' }
  }));
  try {
    const form = new FormData();
    form.append('model', 'gpt-4o-transcribe');
    form.append('file', new Blob(['audio']), 'audio.wav');
    const response = await gatewayFetch(base, '/v1/audio/transcriptions', { method: 'POST', body: form });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('retry-after'), '23');
    assert.equal((await response.text()).includes('private quota body'), false);
    assert.equal(store.get(codexUpstream.id).health.status, 'cooldown');
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('records malformed successful compatibility responses as transient evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compatibility-malformed-'));
  const { store, codexUpstream } = configuredStore(dir);
  const { server, base } = await start(store, async () => new Response('not-json', {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }));
  try {
    const form = new FormData();
    form.append('model', 'gpt-4o-transcribe');
    form.append('file', new Blob(['audio']), 'audio.wav');
    const response = await gatewayFetch(base, '/v1/audio/transcriptions', { method: 'POST', body: form });
    assert.equal(response.status, 502);
    const circuit = Object.values(store.get(codexUpstream.id).circuits)[0];
    assert.equal(circuit.failureClass, 'transient');
    assert.equal(circuit.failures, 1);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retries one rejected Codex field immediately and promotes it after independent evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compact-fallback-'));
  const { store, codexUpstream } = configuredStore(dir);
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (Object.hasOwn(bodies.at(-1), 'max_output_tokens')) return new Response('{"detail":"Unsupported parameter: max_output_tokens"}', { status: 400 });
    return new Response(JSON.stringify({ object: 'response.compaction' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const response = await gatewayFetch(base, '/backend-api/codex/responses/compact', {
      method: 'POST', headers: { 'content-type': 'application/json', version: 'v'.repeat(128) },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'compact', max_output_tokens: 128, temperature: 0.2 })
    });
    assert.equal(response.status, 200);
    assert.equal(bodies[0].max_output_tokens, 128);
    assert.equal('reasoning' in bodies[0], false);
    assert.equal('reasoning' in bodies[1], false);
    assert.equal('max_output_tokens' in bodies[1], false);
    assert.equal(bodies[1].temperature, 0.2);
    const learned = await gatewayFetch(base, '/backend-api/codex/responses/compact', {
      method: 'POST', headers: { 'content-type': 'application/json', version: 'v'.repeat(128) },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'compact again', max_output_tokens: 256, temperature: 0.4 })
    });
    assert.equal(learned.status, 200);
    assert.equal(bodies.length, 4);
    assert.equal(bodies[2].max_output_tokens, 256);
    assert.equal('max_output_tokens' in bodies[3], false);
    const facts = Object.values(store.get(codexUpstream.id).compatibility.facts);
    assert.equal(facts.some(({ value }) => value.unsupportedFields?.includes('max_output_tokens')), true);

    const promoted = await gatewayFetch(base, '/backend-api/codex/responses/compact', {
      method: 'POST', headers: { 'content-type': 'application/json', version: 'v'.repeat(128) },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'compact promoted', max_output_tokens: 512, temperature: 0.6 })
    });
    assert.equal(promoted.status, 200);
    assert.equal(bodies.length, 5);
    assert.equal(bodies[4].model, 'gpt-5.6-sol');
    assert.equal('max_output_tokens' in bodies[4], false);
    assert.equal(bodies[4].temperature, 0.6);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridges terminal backend compaction triggers through compact JSON and returns Responses SSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compact-trigger-'));
  const { store } = configuredStore(dir);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      id: 'resp-compact-trigger',
      output: [{
        id: 'cmp-1',
        type: 'compaction_summary',
        encrypted_content: 'encrypted-summary',
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
        plaintext: 'must-not-leak'
      }],
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
      raw_compact_detail: 'must-not-leak'
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-codex-turn-state': 'response-turn' } });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const response = await gatewayFetch(base, '/backend-api/codex/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-codex-turn-state': 'request-turn' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        instructions: 'compact this',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'visible history', prompt_cache_breakpoint: { mode: 'explicit' } }] },
          { type: 'compaction_trigger' }
        ],
        stream: true,
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
        parallel_tool_calls: true,
        reasoning: { effort: 'low' },
        service_tier: 'priority',
        promptCacheKey: 'compact-cache',
        text: { format: { type: 'text' } },
        include: ['reasoning.encrypted_content'],
        store: false,
        previous_response_id: 'resp-old'
      })
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(response.headers.get('x-codex-turn-state'), 'response-turn');
    assert.equal(new URL(calls[0].url).pathname, '/backend-api/codex/responses/compact');
    assert.equal(calls[0].headers['x-codex-turn-state'], 'request-turn');
    assert.deepEqual(calls[0].body, {
      model: 'gpt-5.6-sol',
      instructions: 'compact this',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'visible history' }] }],
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
      parallel_tool_calls: true,
      reasoning: { effort: 'low' },
      service_tier: 'priority',
      prompt_cache_key: 'compact-cache',
      text: { format: { type: 'text' } }
    });
    assert.match(body, /event: response\.output_item\.done/);
    assert.match(body, /event: response\.completed/);
    assert.match(body, /"type":"compaction"/);
    assert.match(body, /"encrypted_content":"encrypted-summary"/);
    assert.match(body, /"turn_id":"turn-1"/);
    assert.match(body, /data: \[DONE\]/);
    assert.doesNotMatch(body, /must-not-leak/);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridges V2 backend compaction SSE including an unframed terminal event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-v2-compact-'));
  const { store } = configuredStore(dir);
  const compact = { type: 'compaction', id: 'cmp-v2', encrypted_content: 'encrypted-v2' };
  const completed = { type: 'response.completed', response: { id: 'resp-v2', status: 'completed', output: [compact], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } } };
  const { server, base } = await start(store, async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: compact })}\n\nevent: response.completed\ndata: ${JSON.stringify(completed)}`, { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const response = await gatewayFetch(base, '/backend-api/codex/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-codex-turn-metadata': JSON.stringify({ compaction: { implementation: 'responses_compaction_v2' } }) },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'visible' }] }, { type: 'compaction_trigger' }], stream: true })
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /"encrypted_content":"encrypted-v2"/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects V2 compaction data after its terminal event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-v2-compact-terminal-'));
  const { store } = configuredStore(dir);
  const compact = { type: 'compaction', encrypted_content: 'encrypted-v2' };
  const { server, base } = await start(store, async () => new Response([
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: compact })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-v2', status: 'completed' } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'must-not-accept' })}`
  ].join(''), { headers: { 'content-type': 'text/event-stream' } }));
  try {
    const response = await gatewayFetch(base, '/backend-api/codex/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-codex-turn-metadata': JSON.stringify({ compaction: { implementation: 'responses_compaction_v2' } }) },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'visible' }] }, { type: 'compaction_trigger' }], stream: true })
    });
    assert.equal(response.status, 502);
    assert.match(await response.text(), /invalid_compaction_response/);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridges public compaction triggers across JSON and SSE through ordinary backend Responses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-public-compact-trigger-'));
  const { store } = configuredStore(dir);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      id: 'resp-public-compact',
      output: [{
        type: 'compaction',
        id: null,
        encrypted_content: 'encrypted-public',
        internal_chat_message_metadata_passthrough: { turn_id: 'must-not-leak' },
        summary: 'must-not-leak'
      }],
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 }
    }), { headers: { 'content-type': 'application/json' } });
  };
  const { server, base } = await start(store, fetchImpl);
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'visible' }] },
    { type: 'compaction_trigger' }
  ];
  try {
    const json = await gatewayFetch(base, '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input, stream: false })
    });
    assert.deepEqual(await json.json(), {
      id: 'resp-public-compact',
      object: 'response',
      status: 'completed',
      output: [{ type: 'compaction', id: null, encrypted_content: 'encrypted-public' }],
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 }
    });

    const sse = await gatewayFetch(base, '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input, stream: true })
    });
    assert.match(await sse.text(), /"object":"response"/);
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/backend-api/codex/responses', '/backend-api/codex/responses']);
    assert.deepEqual(calls.map((call) => ({
      lastInput: call.body.input.at(-1),
      stream: Object.hasOwn(call.body, 'stream') ? call.body.stream : 'omitted'
    })), [
      { lastInput: { type: 'compaction_trigger' }, stream: 'omitted' },
      { lastInput: { type: 'compaction_trigger' }, stream: 'omitted' }
    ]);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects blank public compaction output without leaking a later candidate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-public-compact-blank-'));
  const { store } = configuredStore(dir);
  const { server, base } = await start(store, async () => new Response(JSON.stringify({
    output: [
      { type: 'compaction', encrypted_content: '   ' },
      { type: 'compaction_summary', encrypted_content: 'must-not-leak' }
    ]
  }), { headers: { 'content-type': 'application/json' } }));
  try {
    const response = await gatewayFetch(base, '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'visible' }] },
          { type: 'compaction_trigger' }
        ]
      })
    });
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.match(body, /invalid_compaction_response/);
    assert.doesNotMatch(body, /must-not-leak/);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes ultrafast Responses only to exact advertised Codex models', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ultrafast-routing-'));
  const { store, codexUpstream } = configuredStore(dir, { compass: true });
  const dispatched = [];
  const { server, base } = await start(store, async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/backend-api/codex/models') {
      return new Response(JSON.stringify({
        models: [{
          slug: 'gpt-5.6-sol',
          service_tiers: [{ id: 'ultrafast' }]
        }]
      }), { headers: { 'content-type': 'application/json' } });
    }
    dispatched.push({ path, body: JSON.parse(options.body), authorization: options.headers.authorization });
    return new Response('data: {"type":"response.completed","response":{"id":"resp-ultrafast","status":"completed","service_tier":"ultrafast","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  });
  try {
    assert.equal((await gatewayFetch(base, '/v1/models')).status, 200);
    let response = await gatewayFetch(base, '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'fast', service_tier: 'ultrafast' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).service_tier, 'ultrafast');
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].body.service_tier, 'ultrafast');
    assert.match(dispatched[0].authorization, /^Bearer header\./);
    assert.equal(store.getPublic(codexUpstream.id).spending.spentDollars, 0);

    response = await gatewayFetch(base, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'fast' }],
        service_tier: 'ultrafast'
      })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.param, 'service_tier');
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not route ultrafast Responses to unadvertised Codex or Compass accounts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ultrafast-unadvertised-'));
  const { store } = configuredStore(dir, { compass: true });
  let dispatches = 0;
  const { server, base } = await start(store, async (url) => {
    if (new URL(url).pathname === '/backend-api/codex/models') {
      return new Response(JSON.stringify({
        models: [{ slug: 'gpt-5.6-sol', additional_speed_tiers: ['priority'] }]
      }), { headers: { 'content-type': 'application/json' } });
    }
    dispatches += 1;
    return new Response('{}');
  });
  try {
    assert.equal((await gatewayFetch(base, '/v1/models')).status, 200);
    const response = await gatewayFetch(base, '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'fast', service_tier: 'ultrafast' })
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'no_compatible_backend');
    assert.equal(dispatches, 0);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects misplaced or malformed compaction trigger requests before dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compact-trigger-invalid-'));
  const { store } = configuredStore(dir);
  let calls = 0;
  const { server, base } = await start(store, async () => { calls += 1; return new Response('{}'); });
  try {
    const invalidTrigger = await gatewayFetch(base, '/backend-api/codex/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: [{ type: 'compaction_trigger' }, { type: 'message', content: 'later' }], stream: true })
    });
    assert.equal(invalidTrigger.status, 400);
    assert.equal((await invalidTrigger.json()).error.param, 'input');

    const invalidTools = await gatewayFetch(base, '/backend-api/codex/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input: [{ type: 'message', content: 'visible' }, { type: 'compaction_trigger' }],
        stream: true,
        tools: {}
      })
    });
    assert.equal(invalidTools.status, 400);
    assert.deepEqual(await invalidTools.json(), {
      error: { type: 'invalid_request_error', code: 'invalid_request', message: 'tools must be an array', param: 'tools' }
    });
    assert.equal(calls, 0);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('implements the complete public file create, upload, finalize, list, and retrieve flow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-files-'));
  const { store } = configuredStore(dir);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    if (path === '/backend-api/files') {
      assert.deepEqual(JSON.parse(options.body), { file_name: 'notes.txt', file_size: 11, use_case: 'codex' });
      return new Response(JSON.stringify({ file_id: 'file-1', upload_url: 'https://upload.oaiusercontent.com/file-1', expires_at: 2_000_000_000 }), { status: 200 });
    }
    if (url === 'https://upload.oaiusercontent.com/file-1') {
      assert.equal(options.method, 'PUT');
      assert.equal(options.headers['content-type'], 'text/plain');
      assert.equal(options.headers['x-ms-blob-type'], 'BlockBlob');
      assert.equal(Buffer.from(options.body).toString(), 'hello world');
      return new Response('', { status: 200 });
    }
    assert.equal(path, '/backend-api/files/file-1/uploaded');
    return new Response(JSON.stringify({ status: 'success', download_url: 'https://download.test/file-1' }), { status: 200 });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'notes.txt');
    const created = await gatewayFetch(base, '/v1/files', { method: 'POST', body: form });
    const file = await created.json();
    assert.equal(created.status, 200);
    assert.deepEqual(file, {
      id: 'file-1', object: 'file', bytes: 11, created_at: file.created_at,
      filename: 'notes.txt', purpose: 'user_data', status: 'uploaded', expires_at: 2_000_000_000
    });

    const list = await gatewayFetch(base, '/v1/files');
    assert.deepEqual((await list.json()).data, [file]);
    const show = await gatewayFetch(base, '/v1/files/file-1');
    assert.deepEqual(await show.json(), file);
    const content = await gatewayFetch(base, '/v1/files/file-1/content');
    assert.equal(content.status, 404);
    assert.equal((await content.json()).error.code, 'unsupported_endpoint');
    const removed = await gatewayFetch(base, '/v1/files/file-1', { method: 'DELETE' });
    assert.equal(removed.status, 404);
    assert.equal(calls.length, 3);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not persist files when upload finalization is incomplete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-file-finalize-error-'));
  const { store } = configuredStore(dir);
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/backend-api/files') return new Response(JSON.stringify({ file_id: 'file-bad', upload_url: 'https://upload.oaiusercontent.com/file-bad' }), { status: 200 });
    if (url === 'https://upload.oaiusercontent.com/file-bad') return new Response('', { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
    const response = await gatewayFetch(base, '/v1/files', { method: 'POST', body: form });
    assert.equal(response.status, 502);
    assert.equal(store.listFiles().length, 0);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects unsafe provider upload URLs before fetching them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-file-ssrf-'));
  const { store } = configuredStore(dir);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ file_id: 'file-ssrf', upload_url: 'https://[::1]/target' }), { status: 200 });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', new Blob(['x']), 'x.txt');
    const response = await gatewayFetch(base, '/v1/files', { method: 'POST', body: form });
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes public transcription multipart fields and response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-audio-'));
  const { store } = configuredStore(dir);
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(new URL(url).pathname, '/backend-api/transcribe');
    const form = await new Request('http://upstream', { method: 'POST', body: options.body }).formData();
    assert.equal(form.get('file').name, 'audio.wav');
    assert.equal(await form.get('file').text(), 'wave-bytes');
    assert.equal(form.get('prompt'), 'Shopee');
    assert.deepEqual(form.getAll('keywords[]'), ['alpha', 'beta']);
    assert.deepEqual(form.getAll('languages[]'), ['en', 'vi']);
    assert.equal(form.get('model'), 'gpt-4o-transcribe');
    assert.equal(form.has('response_format'), false);
    return new Response(JSON.stringify({ text: 'hello', languages: ['en'], duration: 1.2 }), { status: 200 });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const form = new FormData();
    form.append('model', 'gpt-transcribe');
    form.append('file', new Blob(['wave-bytes'], { type: 'audio/wav' }), 'secret-name.wav');
    form.append('prompt', 'Shopee');
    form.append('keywords[]', 'alpha');
    form.append('keywords[]', 'beta');
    form.append('languages[]', 'en');
    form.append('languages[]', 'vi');
    form.append('response_format', 'json');
    const response = await gatewayFetch(base, '/v1/audio/transcriptions', { method: 'POST', body: form });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'hello', duration: 1.2 });

    const invalid = new FormData();
    invalid.append('model', 'whisper-1');
    invalid.append('file', new Blob(['x']), 'x.wav');
    const rejected = await gatewayFetch(base, '/v1/audio/transcriptions', { method: 'POST', body: invalid });
    assert.equal(rejected.status, 404);
    assert.equal(calls, 1);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('translates public image generations and edits through Responses SSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-images-'));
  const { store } = configuredStore(dir);
  const responseBodies = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/backend-api/codex/models') {
      return new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', input_modalities: ['text', 'image'] }] }), { status: 200 });
    }
    assert.equal(path, '/backend-api/codex/responses');
    responseBodies.push(JSON.parse(options.body));
    return new Response([
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"B64_IMAGE","revised_prompt":"better"}}',
      'data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"B64_IMAGE","revised_prompt":"better"}],"tool_usage":{"image_gen":{"input_tokens":7,"output_tokens":13}}}}',
      'data: [DONE]', ''
    ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const generation = await gatewayFetch(base, '/v1/images/generations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: 'a cat', size: '1024x1024', quality: 'low', n: 1 })
    });
    const generated = await generation.json();
    assert.equal(generation.status, 200);
    assert.deepEqual(generated.data, [{ b64_json: 'B64_IMAGE', revised_prompt: 'better' }]);
    assert.deepEqual(generated.usage, { input_tokens: 7, output_tokens: 13, total_tokens: 20 });
    assert.equal(responseBodies[0].model, 'gpt-5.6-sol');
    assert.deepEqual(responseBodies[0].input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a cat' }] }]);
    assert.deepEqual(responseBodies[0].tools, [{ type: 'image_generation', model: 'gpt-image-1', size: '1024x1024', quality: 'low' }]);

    const edit = new FormData();
    edit.append('model', 'gpt-image-1');
    edit.append('prompt', 'make blue');
    edit.append('image', new Blob([Buffer.from([1, 2, 3])], { type: 'image/png' }), 'private.png');
    edit.append('mask', new Blob([Buffer.from([4, 5])], { type: 'image/png' }), 'mask.png');
    const edited = await gatewayFetch(base, '/v1/images/edits', { method: 'POST', body: edit });
    assert.equal(edited.status, 200);
    const content = responseBodies[1].input[0].content;
    assert.match(content[0].text, /transparent mask/);
    assert.equal(content[1].image_url, 'data:image/png;base64,AQID');
    assert.equal(content[2].image_url, 'data:image/png;base64,BAU=');

    const invalid = await gatewayFetch(base, '/v1/images/generations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: 'bad', size: '2048x2048' })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.param, 'size');
    assert.equal(responseBodies.length, 2);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redacts public image provider 5xx errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-image-errors-'));
  const { store } = configuredStore(dir);
  const fetchImpl = async (url) => new URL(url).pathname === '/backend-api/codex/models'
    ? new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', input_modalities: ['image'] }] }), { status: 200 })
    : new Response(JSON.stringify({ secret: 'provider-internal-secret' }), { status: 500 });
  const { server, base } = await start(store, fetchImpl);
  try {
    const response = await gatewayFetch(base, '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-1-mini', prompt: 'x' }) });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(JSON.stringify(body).includes('provider-internal-secret'), false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projects provider-controlled invalid image SSE failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-image-sse-errors-'));
  const { store } = configuredStore(dir);
  const fetchImpl = async (url) => new URL(url).pathname === '/backend-api/codex/models'
    ? new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', input_modalities: ['image'] }] }), { status: 200 })
    : new Response('data: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"failed","error":{"type":"invalid_request_error","code":"provider_secret","message":"private provider message","param":"secret"}}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const { server, base } = await start(store, fetchImpl);
  try {
    const response = await gatewayFetch(base, '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-1-mini', prompt: 'x' }) });
    assert.equal(response.status, 400);
    assert.deepEqual((await response.json()).error, { type: 'invalid_request_error', code: 'provider_secret', message: 'private provider message', param: 'secret' });
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshes and retries a rejected upstream WebSocket handshake', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-refresh-'));
  const store = new Store(dir);
  const input = codex();
  const authJson = JSON.parse(input.authJson);
  authJson.tokens.refresh_token = 'refresh-token';
  input.authJson = JSON.stringify(authJson);
  const upstream = store.create(input);
  store.setCap(upstream.id, { capDollars: 100 });

  const upstreamAuth = [];
  const targetServer = createServer();
  const targetWs = new WebSocketServer({ noServer: true });
  targetWs.on('connection', (socket) => socket.on('message', () => socket.send(JSON.stringify({ type: 'response.output_text.delta', model: 'gpt-5.6-sol', delta: 'ok' }))));
  targetServer.on('upgrade', (request, socket, head) => {
    upstreamAuth.push(request.headers.authorization);
    if (request.headers.authorization !== 'Bearer rotated-token') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    targetWs.handleUpgrade(request, socket, head, (client) => targetWs.emit('connection', client, request));
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));

  const fetchImpl = async (url) => {
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    return new Response(JSON.stringify({ access_token: 'rotated-token', expires_in: 3600 }), { status: 200 });
  };
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl }));
  const relay = attachWebSocketProxy(gateway, {
    store, apiKey: API_KEY, fetchImpl,
    websocketUrl: () => `ws://127.0.0.1:${targetServer.address().port}`
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const message = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      client.once('open', () => client.send('{"type":"response.create","model":"gpt-5.6-sol","input":"retry-me"}'));
      client.once('message', (data) => { resolve(data.toString()); client.close(); });
      client.once('error', reject);
    });
    assert.equal(JSON.parse(message).model, 'gpt-5.6-sol');
    assert.equal(upstreamAuth.length, 2);
    assert.match(upstreamAuth[0], /^Bearer header\./);
    assert.equal(upstreamAuth[1], 'Bearer rotated-token');
    assert.equal(store.credentials(upstream.id).accessToken, 'rotated-token');
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => targetWs.close(resolve));
    await close(targetServer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovers after a public WebSocket handshake failure without replaying the failed turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-handshake-recovery-'));
  const { store } = configuredStore(dir);
  let upgrades = 0;
  const upstreamInputs = [];
  const targetServer = createServer();
  const targetWs = new WebSocketServer({ noServer: true });
  targetWs.on('connection', (socket) => socket.on('message', (data) => {
    const input = JSON.parse(data).input[0].content[0].text;
    upstreamInputs.push(input);
    socket.send(JSON.stringify({ type: 'response.completed', response: { id: input, status: 'completed', output: [] } }));
  }));
  targetServer.on('upgrade', (request, socket, head) => {
    upgrades += 1;
    if (upgrades === 1) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    targetWs.handleUpgrade(request, socket, head, (client) => targetWs.emit('connection', client, request));
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${targetServer.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'failed-turn' })));
      client.on('message', (data) => {
        const message = JSON.parse(data);
        received.push(message);
        if (message.type === 'error') {
          client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'recovered-turn' }));
        } else {
          client.close();
          resolve(received);
        }
      });
      client.once('error', reject);
    });
    assert.deepEqual(messages.map(({ type }) => type), ['error', 'response.completed']);
    assert.equal(messages[1].response.id, 'recovered-turn');
    assert.equal(upgrades, 2);
    assert.deepEqual(upstreamInputs, ['recovered-turn']);
    assert.equal(store.load().gatewayRequests.some(({ status }) => status === 'in_progress'), false);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => targetWs.close(resolve));
    await close(targetServer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not open an upstream WebSocket after the client closes during credential refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-refresh-cancel-'));
  const store = new Store(dir);
  const upstream = store.create(codex({ refreshToken: 'refresh-after-close' }));
  store.setCap(upstream.id, { capDollars: 100 });
  store.persistCredentials(upstream.id, store.credentials(upstream.id), new Date(Date.now() - 1_000).toISOString());
  let resolveRefresh;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const fetchImpl = async () => new Promise((resolve) => {
    resolveRefresh = resolve;
    markRefreshStarted();
  });
  let upstreamConnections = 0;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', () => { upstreamConnections += 1; });
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
      headers: { authorization: `Bearer ${API_KEY}` }
    });
    await new Promise((resolve, reject) => {
      client.once('open', () => {
        client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'cancel-refresh' }));
        resolve();
      });
      client.once('error', reject);
    });
    await refreshStarted;
    const clientClosed = new Promise((resolve) => client.once('close', resolve));
    client.close();
    await clientClosed;
    resolveRefresh(new Response(JSON.stringify({ access_token: 'rotated-after-close', expires_in: 3600 }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(upstreamConnections, 0);
    assert.equal(store.load().gatewayRequests.some(({ status }) => status === 'in_progress'), false);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reuses a public Responses WebSocket across completed turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-turns-'));
  const { store } = configuredStore(dir);
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => socket.on('message', (data) => {
    const request = JSON.parse(data);
    socket.send(JSON.stringify({ type: 'response.completed', response: { id: request.input[0].content[0].text, status: 'completed', output: [] } }));
  }));
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'first' })));
      client.on('message', (data) => {
        received.push(JSON.parse(data));
        if (received.length === 1) client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'second' }));
        else { client.close(); resolve(received); }
      });
      client.once('error', reject);
    });
    assert.deepEqual(messages.map((message) => [message.response.id, message.sequence_number]), [['first', 0], ['second', 0]]);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paces repeated turns on a reused public Responses WebSocket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-paced-turns-'));
  const { store, codexUpstream } = configuredStore(dir);
  store.update(codexUpstream.id, {
    pacing: { enabled: true, minStartIntervalMs: 40, maxQueueDepth: 4, maxQueueAgeMs: 2_000 }
  });
  const starts = [];
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => socket.on('message', (data) => {
    starts.push(Date.now());
    const request = JSON.parse(data);
    socket.send(JSON.stringify({ type: 'response.completed', response: { id: request.input[0].content[0].text, status: 'completed', output: [] } }));
  }));
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      let received = 0;
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'first' })));
      client.on('message', () => {
        received += 1;
        if (received === 1) client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'second' }));
        else { client.close(); resolve(); }
      });
      client.once('error', reject);
    });
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 30, `turns started only ${starts[1] - starts[0]}ms apart`);
    assert.equal(store.get(codexUpstream.id).health, undefined);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preserves public Responses WebSocket warmups and validates generate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-warmup-'));
  const { store } = configuredStore(dir);
  const upstreamFrames = [];
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => socket.on('message', (data) => {
    const frame = JSON.parse(data);
    upstreamFrames.push(frame);
    socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp-warmup', status: 'completed', output: [] } }));
  }));
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        input: 'warm up',
        generate: false
      })));
      client.on('message', (data) => {
        received.push(JSON.parse(data));
        if (received.length === 1) {
          client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'bad', generate: 'false' }));
        } else {
          client.close();
          resolve(received);
        }
      });
      client.once('error', reject);
    });
    assert.equal(messages[0].type, 'response.completed');
    assert.equal(messages[0].response.id, 'resp-warmup');
    assert.equal(messages[1].type, 'error');
    assert.equal(messages[1].status, 400);
    assert.equal(messages[1].error.param, 'generate');
    assert.equal(upstreamFrames.length, 1);
    assert.equal(upstreamFrames[0].generate, false);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovers WebSocket compatibility immediately and promotes it after independent turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-compatibility-'));
  const { store } = configuredStore(dir);
  const upstreamFrames = [];
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let completed = 0;
  target.on('connection', (socket) => socket.on('message', (data) => {
    const frame = JSON.parse(data);
    upstreamFrames.push(frame);
    if (Object.hasOwn(frame, 'max_output_tokens')) {
      socket.send(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', param: 'max_output_tokens', message: 'Unsupported parameter: max_output_tokens' }
      }));
      return;
    }
    completed += 1;
    socket.send(JSON.stringify({
      type: 'response.completed',
      error: { param: 'temperature', message: 'Unsupported parameter: temperature' },
      response: { id: `ws-compatible-${completed}`, status: 'completed', output: [] }
    }));
  }));
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const turn = () => new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      client.once('open', () => client.send(JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        input: 'compatibility',
        max_output_tokens: 128,
        temperature: 0.2
      })));
      client.once('message', (data) => {
        resolve(JSON.parse(data));
        client.close();
      });
      client.once('error', reject);
    });
    const first = await turn();
    assert.equal(first.response.id, 'ws-compatible-1');
    assert.equal(store.get(store.list()[0].id).compatibility, undefined);

    const second = await turn();
    assert.equal(second.response.id, 'ws-compatible-2');
    const facts = Object.values(store.get(store.list()[0].id).compatibility.facts);
    assert.equal(facts.some(({ value }) => value.unsupportedFields?.includes('max_output_tokens')), true);

    const result = await turn();
    assert.equal(result.type, 'response.completed');
    assert.equal(result.response.id, 'ws-compatible-3');
    assert.equal(upstreamFrames.length, 5);
    assert.equal(upstreamFrames[0].max_output_tokens, 128);
    assert.equal('max_output_tokens' in upstreamFrames[1], false);
    assert.equal(upstreamFrames[2].max_output_tokens, 128);
    assert.equal('max_output_tokens' in upstreamFrames[3], false);
    assert.equal('max_output_tokens' in upstreamFrames[4], false);
    assert.equal(store.load().gatewayRequests.some(({ status }) => status === 'in_progress'), false);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconnects a public Responses WebSocket after the idle upstream closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-idle-reconnect-'));
  const { store } = configuredStore(dir);
  let connections = 0;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => {
    connections += 1;
    socket.once('message', (data) => {
      const input = JSON.parse(data).input[0].content[0].text;
      socket.send(JSON.stringify({ type: 'response.completed', response: { id: input, status: 'completed', output: [] } }), () => socket.terminate());
    });
  });
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'first' })));
      client.on('message', (data) => {
        received.push(JSON.parse(data));
        if (received.length === 1) {
          setTimeout(() => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'second' })), 20);
        } else {
          client.close();
          resolve(received);
        }
      });
      client.once('error', reject);
    });
    assert.deepEqual(messages.map(({ response }) => response.id), ['first', 'second']);
    assert.equal(connections, 2);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridges public WebSocket compaction turns over HTTP and echoes stream IDs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-public-compact-'));
  const { store } = configuredStore(dir);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      id: 'resp-ws-compact',
      output: [{ type: 'compaction_summary', encrypted_content: 'encrypted-ws' }],
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 }
    }), { headers: { 'content-type': 'application/json' } });
  };
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, fetchImpl });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const apiKeyId = store.authenticateApiKey(API_KEY).id;
  try {
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${API_KEY}`, 'x-codex-session-id': 'ws-compact-session' }
      });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        stream_id: 'compact-lane',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'visible' }] },
          { type: 'compaction_trigger' }
        ]
      })));
      client.on('message', (data) => {
        received.push(JSON.parse(data));
        if (received.length === 2) { client.close(); resolve(received); }
      });
      client.once('error', reject);
    });
    assert.deepEqual(messages.map(({ type, stream_id }) => [type, stream_id]), [
      ['response.output_item.done', 'compact-lane'],
      ['response.completed', 'compact-lane']
    ]);
    assert.equal(messages[1].response.object, 'response');
    assert.equal(new URL(calls[0].url).pathname, '/backend-api/codex/responses');
    assert.equal(calls[0].body.input.at(-1).type, 'compaction_trigger');
    assert.equal(Object.hasOwn(calls[0].body, 'stream'), false);
    assert.equal(store.sessionUpstream('ws-compact-session', undefined, apiKeyId), store.list()[0].id);
  } finally {
    relay.close();
    await close(gateway);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projects public WebSocket compaction policy failures without refreshing or penalizing the account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-public-compact-policy-'));
  const store = new Store(dir);
  const upstream = store.create(codex({ refreshToken: 'must-not-refresh' }));
  store.setCap(upstream.id, { capDollars: 100 });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      error: {
        type: 'provider_policy',
        code: 'misalignment_policy_violation',
        message: 'Compaction blocked.',
        param: 'must-not-leak'
      }
    }), { status: 403, headers: { 'content-type': 'application/json' } });
  };
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, fetchImpl });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const message = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      client.once('open', () => client.send(JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'visible' }] },
          { type: 'compaction_trigger' }
        ]
      })));
      client.once('message', (data) => {
        resolve(JSON.parse(data));
        client.close();
      });
      client.once('error', reject);
    });
    assert.deepEqual(message.error, {
      type: 'invalid_request_error',
      code: 'misalignment_policy_violation',
      message: 'Compaction blocked.',
      param: null
    });
    assert.equal(message.status, 403);
    assert.equal(calls, 1);
    assert.equal(store.get(upstream.id).health, undefined);
    assert.equal(store.get(upstream.id).tokenRefresh?.status, undefined);
  } finally {
    relay.close();
    await close(gateway);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects invalid WebSocket stream IDs and recovers on the next turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-stream-id-'));
  const { store } = configuredStore(dir);
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => socket.on('message', () => {
    socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'stream-id-recovered', status: 'completed', output: [] } }));
  }));
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'invalid', stream_id: 'invalid/id' })));
      client.on('message', (data) => {
        const message = JSON.parse(data);
        received.push(message);
        if (message.type === 'error') client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'valid' }));
        else { client.close(); resolve(received); }
      });
      client.once('error', reject);
    });
    assert.equal(messages[0].status, 400);
    assert.equal(messages[0].error.param, 'stream_id');
    assert.equal(Object.hasOwn(messages[0], 'stream_id'), false);
    assert.equal(messages[1].response.id, 'stream-id-recovered');
    assert.equal(Object.hasOwn(messages[1], 'stream_id'), false);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails over a public WebSocket turn before output and settles its terminal usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-failover-'));
  const store = new Store(dir);
  const first = store.create(codex({ email: 'first-ws@example.com', accountId: 'first-ws' }));
  const second = store.create(codex({ email: 'second-ws@example.com', accountId: 'second-ws' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const firstToken = store.credentials(first.id).accessToken;
  const upstreamAuth = [];
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket, request) => {
    upstreamAuth.push(request.headers.authorization);
    socket.on('message', (data) => {
      if (request.headers.authorization === `Bearer ${firstToken}`) return socket.send(JSON.stringify({ type: 'response.failed', error: { code: 'rate_limit_exceeded', message: 'provider-secret' } }));
      const input = JSON.parse(data).input[0].content[0].text;
      socket.send(JSON.stringify({ type: 'response.completed', response: { id: `ws-${input}`, status: 'completed', output: [], ...(input === 'fallback' ? { usage: { input_tokens: 1, output_tokens: 1 } } : {}) } }));
    });
  });
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const apiKeyId = store.authenticateApiKey(API_KEY).id;
  try {
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}`, 'x-codex-session-id': 'ws-failover-session' } });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'fallback' })));
      client.on('message', (data) => {
        received.push(JSON.parse(data));
        if (received.length === 1) client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'next' }));
        else { client.close(); resolve(received); }
      });
      client.once('error', reject);
    });
    assert.deepEqual(messages.map((message) => message.response.id), ['ws-fallback', 'ws-next']);
    assert.equal(upstreamAuth.length, 2);
    assert.equal(store.sessionUpstream('ws-failover-session', undefined, apiKeyId), second.id);
    assert.equal(store.getPublic(first.id).spending.spentDollars, 0);
    assert.deepEqual(Object.values(store.get(second.id).spending.settlements).map(({ settledCostMicros, costSource }) => ({ settledCostMicros, costSource })), [{ settledCostMicros: 24, costSource: 'pricing_snapshot' }]);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opens shared host health on refused public WebSocket connections without penalizing accounts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-host-health-'));
  const store = new Store(dir);
  const upstreams = [
    store.create(codex({ email: 'first-ws-host@example.com', accountId: 'first-ws-host' })),
    store.create(codex({ email: 'second-ws-host@example.com', accountId: 'second-ws-host' }))
  ];
  for (const upstream of upstreams) store.setCap(upstream.id, { capDollars: 100 });

  const closedTarget = createServer();
  await new Promise((resolve) => closedTarget.listen(0, '127.0.0.1', resolve));
  const closedPort = closedTarget.address().port;
  await close(closedTarget);

  const hostHealth = new CodexHostHealth({ failureThreshold: 2, cooldownMs: 30_000 });
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}'), codexHostHealth: hostHealth }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${closedPort}`,
    fetchImpl: async () => new Response('{}'),
    codexHostHealth: hostHealth
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const message = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      client.once('open', () => client.send(JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        input: 'refused'
      })));
      client.once('message', (data) => {
        resolve(JSON.parse(data));
        client.close();
      });
      client.once('error', reject);
    });
    assert.equal(message.type, 'error');
    assert.equal(message.error.code, 'codex_host_unavailable');
    assert.equal(hostHealth.status().openOriginCount, 1);
    for (const upstream of upstreams) assert.equal(store.get(upstream.id).health, undefined);
  } finally {
    relay.close();
    await close(gateway);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalizes a public WebSocket request when a retryable failure has no fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-retry-exhausted-'));
  const { store } = configuredStore(dir);
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => socket.once('message', () => {
    socket.send(JSON.stringify({ type: 'response.failed', error: { code: 'rate_limit_exceeded' } }));
  }));
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const message = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'fail' })));
      client.once('message', (data) => {
        resolve(JSON.parse(data));
        client.close();
      });
      client.once('error', reject);
    });
    assert.equal(message.type, 'response.failed');
    const requests = store.load().gatewayRequests;
    assert.equal(requests.some(({ status }) => status === 'in_progress'), false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, 'failed');
    assert.deepEqual(store.gatewayAttempts(requests[0].id).map(({ status, errorCode }) => ({ status, errorCode })), [
      { status: 'failed', errorCode: 'upstream_response_failed' }
    ]);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projects public WebSocket policy failures without retrying or penalizing the account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-policy-'));
  const { store, codexUpstream } = configuredStore(dir);
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let turns = 0;
  target.on('connection', (socket) => socket.once('message', () => {
    turns += 1;
    socket.send(JSON.stringify({
      type: 'response.failed',
      sequence_number: 8,
      response: {
        id: 'resp-ws-policy',
        status: 'failed',
        error: {
          type: 'provider_policy',
          code: 'misalignment_policy_violation',
          message: 'WebSocket blocked.',
          param: 'drop',
          sibling: 'drop'
        }
      },
      provider_sibling: 'drop'
    }));
  }));
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const message = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      client.once('open', () => client.send(JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.6-sol',
        input: 'blocked'
      })));
      client.once('message', (data) => {
        resolve(JSON.parse(data));
        client.close();
      });
      client.once('error', reject);
    });
    assert.deepEqual(message.response.error, {
      type: 'invalid_request_error',
      code: 'misalignment_policy_violation',
      message: 'WebSocket blocked.'
    });
    assert.equal(JSON.stringify(message).includes('provider_policy'), false);
    assert.equal(turns, 1);
    assert.equal(store.get(codexUpstream.id).health, undefined);
    const [requestRecord] = store.load().gatewayRequests;
    assert.equal(requestRecord.lastErrorCode, 'misalignment_policy_violation');
    assert.equal(store.gatewayAttempts(requestRecord.id).length, 1);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshes authentication independently for each public WebSocket fallback connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-fallback-refresh-'));
  const store = new Store(dir);
  const first = store.create(codex({ email: 'first-refresh@example.com', accountId: 'first-refresh', refreshToken: 'refresh-first' }));
  const second = store.create(codex({ email: 'second-refresh@example.com', accountId: 'second-refresh', refreshToken: 'refresh-second' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const initialTokens = new Map([
    ['first-refresh', store.credentials(first.id).accessToken],
    ['second-refresh', store.credentials(second.id).accessToken]
  ]);
  const refreshedTokens = new Map([
    ['first-refresh', 'rotated-first'],
    ['second-refresh', 'rotated-second']
  ]);
  const upstreamAuth = [];
  const refreshes = [];
  const targetServer = createServer();
  const targetWs = new WebSocketServer({ noServer: true });
  targetWs.on('connection', (socket, request) => socket.once('message', () => {
    if (request.headers['chatgpt-account-id'] === 'first-refresh') {
      socket.send(JSON.stringify({ type: 'response.failed', error: { code: 'rate_limit_exceeded' } }));
    } else {
      socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'refreshed-fallback', status: 'completed', output: [] } }));
    }
  }));
  targetServer.on('upgrade', (request, socket, head) => {
    const accountId = request.headers['chatgpt-account-id'];
    const authorization = request.headers.authorization;
    upstreamAuth.push({ accountId, authorization });
    if (authorization !== `Bearer ${refreshedTokens.get(accountId)}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    targetWs.handleUpgrade(request, socket, head, (client) => targetWs.emit('connection', client, request));
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    const refreshToken = new URLSearchParams(options.body).get('refresh_token');
    refreshes.push(refreshToken);
    return new Response(JSON.stringify({
      access_token: refreshToken === 'refresh-first' ? 'rotated-first' : 'rotated-second',
      expires_in: 3600
    }), { status: 200 });
  };
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${targetServer.address().port}`,
    fetchImpl
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const message = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'refresh-both' })));
      client.on('message', (data) => {
        const event = JSON.parse(data);
        if (event.type === 'response.completed') {
          resolve(event);
          client.close();
        }
      });
      client.once('error', reject);
    });
    assert.equal(message.response.id, 'refreshed-fallback');
    assert.deepEqual(refreshes, ['refresh-first', 'refresh-second']);
    assert.deepEqual(upstreamAuth, [
      { accountId: 'first-refresh', authorization: `Bearer ${initialTokens.get('first-refresh')}` },
      { accountId: 'first-refresh', authorization: 'Bearer rotated-first' },
      { accountId: 'second-refresh', authorization: `Bearer ${initialTokens.get('second-refresh')}` },
      { accountId: 'second-refresh', authorization: 'Bearer rotated-second' }
    ]);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => targetWs.close(resolve));
    await close(targetServer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cools a public WebSocket account after one quota failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-circuit-'));
  const store = new Store(dir);
  const first = store.create(codex({ email: 'first-ws-circuit@example.com', accountId: 'first-ws-circuit' }));
  const second = store.create(codex({ email: 'second-ws-circuit@example.com', accountId: 'second-ws-circuit' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const firstToken = store.credentials(first.id).accessToken;
  const upstreamAuth = [];
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket, request) => {
    upstreamAuth.push(request.headers.authorization);
    socket.on('message', (data) => {
      if (request.headers.authorization === `Bearer ${firstToken}`) {
        socket.send(JSON.stringify({ type: 'response.failed', error: { code: 'rate_limit_exceeded' } }));
        return;
      }
      const input = JSON.parse(data).input[0].content[0].text;
      socket.send(JSON.stringify({ type: 'response.completed', response: { id: `ws-circuit-${input}`, status: 'completed', output: [] } }));
    });
  });
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const responseIds = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'one' })));
      client.on('message', (data) => {
        const message = JSON.parse(data);
        if (message.type !== 'response.completed') return;
        received.push(message.response.id);
        if (received.length < 4) {
          client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: ['one', 'two', 'three', 'four'][received.length] }));
        } else {
          client.close();
          resolve(received);
        }
      });
      client.once('error', reject);
    });
    assert.deepEqual(responseIds, ['ws-circuit-one', 'ws-circuit-two', 'ws-circuit-three', 'ws-circuit-four']);
    assert.equal(upstreamAuth.filter((authorization) => authorization === `Bearer ${firstToken}`).length, 1);
    const health = store.get(first.id).health;
    assert.equal(health.status, 'cooldown');
    assert.equal(health.failureClass, 'quota');
    assert.equal(typeof store.get(second.id).lastSuccessfulAt, 'string');
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovers a reusable public WebSocket after a post-output interruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-recover-'));
  const { store } = configuredStore(dir);
  let connections = 0;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => {
    connections += 1;
    socket.once('message', () => {
      if (connections === 1) {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'interrupted', status: 'in_progress' } }));
        setTimeout(() => socket.close(1011, 'interrupted'), 5);
      } else socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'recovered', status: 'completed', output: [] } }));
    });
  });
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'first' })));
      client.on('message', (data) => {
        const message = JSON.parse(data);
        received.push(message);
        if (message.type === 'error') client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'second' }));
        if (message.response?.id === 'recovered') { client.close(); resolve(received); }
      });
      client.once('error', reject);
    });
    assert.deepEqual(messages.map((message) => message.type), ['response.created', 'error', 'response.completed']);
    assert.equal(connections, 2);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('closes oversized public WebSocket frames with code 1009', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-frame-limit-'));
  const { store } = configuredStore(dir);
  const ingress = { websocketFrameBytes: 2 * 1024 * 1024 };
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}'), ingress }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, fetchImpl: async () => new Response('{}'), ingress });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const code = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      client.once('open', () => client.send(Buffer.alloc(2 * 1024 * 1024 + 1)));
      client.once('close', resolve);
      client.once('error', () => {});
    });
    assert.equal(code, 1009);
  } finally {
    relay.close();
    await close(gateway);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sends configured WebSocket keepalive pings to the Codex upstream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-keepalive-'));
  const { store } = configuredStore(dir);
  let pings = 0;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => socket.on('ping', () => { pings += 1; }));
  await new Promise((resolve) => target.once('listening', resolve));
  const ingress = { websocketKeepAliveMs: 20, websocketIdleMs: 1_000 };
  const gateway = createServer(createApp({ store, apiKey: API_KEY, ingress, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    ingress,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      client.once('open', () => {
        client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'keepalive' }));
        setTimeout(() => client.close(), 90);
      });
      client.once('close', resolve);
      client.once('error', reject);
    });
    assert.ok(pings >= 2, `expected at least two upstream pings, got ${pings}`);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns upstream WebSocket message-too-large as a request error without failover', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-upstream-1009-'));
  const { store } = configuredStore(dir);
  let connections = 0;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => {
    connections += 1;
    socket.once('message', () => socket.close(1009, 'message too big'));
  });
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const error = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'too-big' })));
      client.on('message', (data) => {
        const message = JSON.parse(data);
        if (message.type !== 'error') return;
        client.close();
        resolve(message);
      });
      client.once('error', reject);
    });
    assert.equal(error.error.code, 'request_too_large');
    assert.equal(error.status, 413);
    assert.equal(connections, 1);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relays Responses websocket frames, required upstream headers, and rejects bad API keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-'));
  const { store } = configuredStore(dir);
  let targetHeaders;
  let publicFrame;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('headers', (headers) => headers.push('x-openai-model: gpt-native'));
  target.on('connection', (socket, request) => {
    targetHeaders = request.headers;
    socket.on('message', (data) => {
      let frame;
      try { frame = JSON.parse(data); } catch { return socket.send(data); }
      if (frame.generate === true) {
        publicFrame = frame;
        if (frame.type !== 'response.create') return socket.send(JSON.stringify({ type: 'error', error: { message: "Expected a 'response.create' message as the first websocket event." } }));
        socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'public-ws', status: 'completed', output: [] } }));
      } else if (frame.backend === true) {
        socket.send(JSON.stringify({
          type: 'response.completed',
          headers: { 'openai-model': 'gpt-native', 'x-provider-secret': 'drop' },
          response: {
            id: 'backend-native',
            headers: { 'x-reasoning-included': false, 'x-provider-secret': 'drop' }
          }
        }));
      } else socket.send(data);
    });
  });
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store, apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    let publicModelsEtag;
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      client.once('upgrade', (response) => { publicModelsEtag = response.headers['x-models-etag']; });
      client.once('open', () => client.send('{"type":"response.create","model":"gpt-5.6-sol","input":"hello","stream_id":"lane-1"}'));
      client.once('message', (data) => { resolve(data.toString()); client.close(); });
      client.once('error', reject);
    });
    assert.deepEqual(JSON.parse(messages), { type: 'response.completed', response: { id: 'public-ws', status: 'completed', output: [] }, sequence_number: 0, stream_id: 'lane-1' });
    assert.equal(publicFrame.type, 'response.create');
    assert.equal('stream_id' in publicFrame, false);
    assert.equal(publicModelsEtag, undefined);
    assert.equal(targetHeaders['openai-beta'], 'responses_websockets=2026-02-06');
    assert.match(targetHeaders.authorization, /^Bearer header\./);
    assert.equal(targetHeaders['chatgpt-account-id'], 'acct-routes');

    const models = await gatewayFetch(`http://127.0.0.1:${gateway.address().port}`, '/backend-api/codex/models');
    const expectedModelsEtag = models.headers.get('etag');
    await models.text();
    let backendModelsEtag;
    const backendMessages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/backend-api/codex/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      client.once('upgrade', (response) => { backendModelsEtag = response.headers['x-models-etag']; });
      client.once('open', () => client.send('{"backend":true}'));
      const received = [];
      client.on('message', (data) => {
        received.push(data.toString());
        if (received.length === 2) { resolve(received); client.close(); }
      });
      client.once('error', reject);
    });
    assert.deepEqual(JSON.parse(backendMessages[0]), {
      type: 'codex.response.metadata',
      headers: { 'x-models-etag': expectedModelsEtag, 'openai-model': 'gpt-native' }
    });
    assert.deepEqual(JSON.parse(backendMessages[1]), {
      type: 'response.completed',
      headers: { 'openai-model': 'gpt-native' },
      response: { id: 'backend-native', headers: { 'x-reasoning-included': 'true' } }
    });
    assert.equal(backendModelsEtag, expectedModelsEtag);

    const status = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: 'Bearer wrong' } });
      client.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      client.once('error', reject);
    });
    assert.equal(status, 401);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preserves native WebSocket compaction continuations on the upstream connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-native-ws-compact-continuation-'));
  const { store } = configuredStore(dir);
  const frames = [];
  let connections = 0;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => {
    connections += 1;
    socket.on('message', (data) => {
      const frame = JSON.parse(data);
      frames.push(frame);
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: `native-${frames.length}`, status: 'completed', output: [] }
      }));
    });
  });
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/backend-api/codex/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      let completed = 0;
      client.once('open', () => client.send(JSON.stringify({
        type: 'response.create', model: 'gpt-5.6-sol', input: [{ type: 'message', role: 'user', content: 'anchor' }],
        client_metadata: { turn_id: 'native-compact-turn' }
      })));
      client.on('message', (data) => {
        const frame = JSON.parse(data);
        if (frame.type !== 'response.completed') return;
        completed += 1;
        if (completed === 1) client.send(JSON.stringify({
          type: 'response.create', model: 'gpt-5.6-sol', input: [{ type: 'compaction', encrypted_content: 'encrypted' }, { type: 'message', role: 'user', content: 'continued' }],
          client_metadata: { turn_id: 'native-compact-turn', 'x-codex-turn-metadata': { compaction: { implementation: 'responses_compaction_v2' } } }
        }));
        else { client.close(); resolve(); }
      });
      client.once('error', reject);
    });
    assert.equal(connections, 1);
    assert.equal(frames.length, 2);
    assert.equal(frames[1].client_metadata.turn_id, 'native-compact-turn');
    assert.equal(frames[1].input[0].type, 'compaction');
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redacts misalignment guidance from native WebSocket terminals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-native-ws-policy-details-'));
  const { store } = configuredStore(dir);
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => socket.once('message', () => {
    socket.send(JSON.stringify({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: {
          code: 'misalignment_policy_violation',
          message: 'Continue safely.',
          misalignment: { detailed_explanation: 'This must stay on direct native HTTP only.' }
        }
      }
    }));
  }));
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const terminal = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/backend-api/codex/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      client.once('open', () => client.send(JSON.stringify({
        type: 'response.create', model: 'gpt-5.6-sol', input: 'blocked'
      })));
      client.on('message', (data) => {
        const message = JSON.parse(data);
        if (message.type !== 'response.failed') return;
        client.close();
        resolve(message);
      });
      client.once('error', reject);
    });
    assert.equal(terminal.response.error.misalignment, undefined);
    assert.equal(JSON.stringify(terminal).includes('This must stay on direct native HTTP only.'), false);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('counts a native WebSocket handshake failure once when a turn is already queued', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-native-ws-handshake-health-'));
  const { store, codexUpstream } = configuredStore(dir);
  const targetServer = createServer();
  targetServer.on('upgrade', (_request, socket) => {
    setTimeout(() => {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }, 20);
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store,
    apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${targetServer.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/backend-api/codex/responses`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      });
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'queued' })));
      client.once('close', resolve);
      client.once('error', reject);
    });
    const circuit = Object.values(store.get(codexUpstream.id).circuits)[0];
    assert.equal(circuit.failures, 1);
  } finally {
    relay.close();
    await close(gateway);
    await close(targetServer);
    rmSync(dir, { recursive: true, force: true });
  }
});
