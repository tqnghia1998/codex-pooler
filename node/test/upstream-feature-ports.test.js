import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { adaptResponsesRequest, validateToolOutputImages } from '../src/openai-adapters.js';
import { attachWebSocketProxy, NATIVE_WEBSOCKET_MESSAGE_LIMIT, projectProxyRequest, projectPublicWebSocketFrame } from '../src/proxy.js';
import { failedIncompleteResponse, quotaIncompleteReason } from '../src/openai-streaming.js';
import { classifySseEvent } from '../src/upstream-outcomes.js';
import { beginNativeTurn, nativeEventWritten, nativeTurnIdentity } from '../src/native-turn-recovery.js';
import { nativeWebSocketRetryAfter } from '../src/native-websocket-policy.js';
import { gatewayRequestKind } from '../src/gateway-dispatch.js';
import { priceUsage } from '../src/pricing.js';
import { CODEX_CATALOG_VERIFIED_RANGE, codexCatalogDecodable, codexCatalogRepresentation, projectCodexCatalog } from '../src/codex-catalog-contract.js';

const update = { type: 'configuration_update', reasoning: { effort: 'provider-future-effort' } };
const base = { model: 'gpt-5.6-sol', input: 'hi' };
const fn = { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} }, async: true };

test('preserves ordered reasoning updates, instruction messages and async declarations/replay', () => {
  const input = [update, { role: 'developer', content: 'keep order' }, update,
    { type: 'function_call', name: 'lookup', call_id: 'call_1', arguments: '{}', async: false },
    { type: 'custom_tool_call', name: 'custom', call_id: 'call_2', input: 'x', async: true }];
  const payload = adaptResponsesRequest({ ...base, input, tools: [fn, { type: 'custom', name: 'custom', async: false }] });
  assert.equal(payload.instructions, undefined);
  assert.deepEqual(payload.input.map((item) => item.type), ['configuration_update', 'message', 'configuration_update', 'function_call', 'custom_tool_call']);
  assert.deepEqual(payload.input[0], update);
  assert.equal(payload.input[3].async, false);
  assert.equal(projectProxyRequest({ upstreamType: 'codex', sourcePath: '/v1/responses', payload }).body.tools[0].async, true);
  assert.deepEqual(projectPublicWebSocketFrame(payload).input, payload.input);
});

test('reports indexed, typed reasoning update and async validation errors', () => {
  for (const [item, code, param] of [
    [{ type: 'configuration_update' }, 'missing_required_parameter', 'input[0].reasoning'],
    [{ type: 'configuration_update', reasoning: null }, 'invalid_type', 'input[0].reasoning'],
    [{ type: 'configuration_update', reasoning: {} }, 'missing_required_parameter', 'input[0].reasoning.effort'],
    [{ type: 'configuration_update', reasoning: { effort: 1 } }, 'invalid_type', 'input[0].reasoning.effort'],
    [{ ...update, id: 'x' }, 'unknown_parameter', 'input[0].id'],
    [{ ...update, reasoning: { effort: 'high', summary: 'auto' } }, 'unknown_parameter', 'input[0].reasoning.summary'],
    [{ type: 'function_call', async: null }, 'invalid_type', 'input[0].async']
  ]) assert.throws(() => adaptResponsesRequest({ ...base, input: [item] }), { code, param });
  assert.throws(() => adaptResponsesRequest({ ...base, tools: [{ ...fn, async: null }] }), { code: 'invalid_type', param: 'tools[0].async' });
  assert.throws(() => adaptResponsesRequest({ ...base, tools: [{ type: 'namespace', name: 'ns', description: 'ns', tools: [fn], async: true }] }),
    { code: 'unknown_parameter', param: 'tools[0].async' });
  assert.throws(() => adaptResponsesRequest({ ...base, tools: [{ type: 'namespace', name: 'ns', description: 'ns', tools: [{ ...fn, async: 'yes' }] }] }),
    { code: 'invalid_type', param: 'tools[0].tools[0].async' });
});

test('rejects only declared SVG data URLs in direct typed tool output parts', () => {
  for (const type of ['function_call_output', 'custom_tool_call_output']) {
    for (const image_url of ['data:image/svg+xml;base64,PHN2Zy8+', ' DATA:IMAGE/SVG+XML,<svg/> ']) {
      const payload = { ...base, input: [{ type, call_id: 'call_1', output: [{ type: 'input_image', image_url }] }] };
      assert.throws(() => adaptResponsesRequest(payload), { code: 'unsupported_input_image_format' });
      assert.throws(() => projectProxyRequest({ upstreamType: 'codex', sourcePath: '/v1/responses', originalPath: '/backend-api/codex/responses', payload }),
        { code: 'unsupported_input_image_format' });
    }
    for (const output of [
      'data:image/svg+xml,<svg/>', { type: 'input_image', image_url: 'data:image/svg+xml,<svg/>' },
      [{ type: 'input_text', text: 'data:image/svg+xml,<svg/>' }],
      [{ nested: { type: 'input_image', image_url: 'data:image/svg+xml,<svg/>' } }],
      [{ type: 'input_image', image_url: 'sediment://image' }],
      [{ type: 'input_image', image_url: 'https://example.com/a.svg' }],
      [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }]
    ]) {
      const input = [{ type, call_id: 'call_1', output }];
      assert.doesNotThrow(() => validateToolOutputImages(input));
      assert.doesNotThrow(() => adaptResponsesRequest({ ...base, input }));
    }
  }
});

test('Decisions routes are unsupported for every method without matching neighboring prefixes', () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal(gatewayRequestKind(method, '/v1/decisions'), 'unsupported');
    assert.equal(gatewayRequestKind(method, '/v1/decisions/d_1/events'), 'unsupported');
  }
  assert.equal(gatewayRequestKind('POST', '/v1/decisions-other'), null);
});

test('prices Sol ultrafast cached input and the exact long-context bucket, pricing cache writes at the requested TTL rate', () => {
  assert.equal(priceUsage(['gpt-6.1-sol'], { inputTokens: 1_000, outputTokens: 100, serviceTier: 'ultrafast' }).settledCostMicros, 18_000);
  assert.equal(priceUsage(['gpt-6.1-sol-20260929'], {
    inputTokens: 1_000, cachedInputTokens: 100, cacheWriteTokens: 0, outputTokens: 100, serviceTier: 'ultrafast'
  }).settledCostMicros, 16_860);
  assert.equal(priceUsage(['gpt-6.1-sol'], {
    inputTokens: 272_001, cachedInputTokens: 100, cacheWriteTokens: 0, outputTokens: 100, serviceTier: 'ultrafast'
  }).settledCostMicros, 6_534_744);
  assert.equal(priceUsage(['gpt-6.1-sol'], {
    inputTokens: 1_000, cachedInputTokens: 100, cacheWriteTokens: 100, outputTokens: 100, serviceTier: 'ultrafast'
  }).settledCostMicros, 17_160);
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 1_000, outputTokens: 100, serviceTier: 'ultrafast' }), null);
});

export const catalogRow = {
  slug: 'gpt-contract', display_name: 'Contract', supported_reasoning_levels: [{ effort: 'high', description: 'High' }],
  shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0, support_verbosity: true,
  truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
  base_instructions: 'legacy', model_messages: { instructions_template: 'template' }
};

test('mirrors the qualified Codex decoder window and tolerated blind spots', () => {
  assert.deepEqual(CODEX_CATALOG_VERIFIED_RANGE, ['0.154.0', '0.172.0']);
  for (const version of ['0.154.0-alpha.1', '0.160.1', '0.162.0', '0.162.0-alpha.1', '0.162.1', '0.162.2', '0.163.0', '0.163.1', '0.164.0', '0.165.0', '0.166.0', '0.166.1', '0.167.0', '0.167.1', '0.170.0', '0.171.0', '0.172.0-alpha.1', '0.172.0']) {
    assert.equal(codexCatalogRepresentation(`codex_cli_rs/${version}`), 'decode_checked');
  }
  assert.equal(codexCatalogRepresentation('My/host/0.162.0 (Linux; aarch64)'), 'decode_checked');
  assert.equal(codexCatalogRepresentation('codex_cli_rs/0.172.0'), 'decode_checked');
  assert.equal(codexCatalogRepresentation('codex_cli_rs/0.172.1'), 'instructions_template');
  const malformed = { ...catalogRow, shell_type: 'unknown-shell' };
  assert.equal(projectCodexCatalog({ nativeModels: [catalogRow, malformed] }, 'codex_cli_rs/0.172.0').nativeModels.length, 1);
  assert.equal(projectCodexCatalog({ nativeModels: [catalogRow, malformed] }, 'codex_cli_rs/0.172.1').nativeModels.length, 2);
  // Codex 0.171.0 and 0.172.0 add optional multi_agent_tools_in_code_mode and daybreak fields.
  const withNewOptionalFields = { ...catalogRow, multi_agent_tools_in_code_mode: true, daybreak: { enabled: true } };
  assert.equal(codexCatalogDecodable(withNewOptionalFields), true);
  assert.deepEqual(projectCodexCatalog({ nativeModels: [withNewOptionalFields] }, 'codex_cli_rs/0.172.0').nativeModels[0].daybreak, { enabled: true });
  assert.equal(projectCodexCatalog({ nativeModels: [withNewOptionalFields] }, 'codex_cli_rs/0.172.0').nativeModels[0].multi_agent_tools_in_code_mode, true);
  assert.equal(codexCatalogRepresentation('codex_cli_rs/0.147.0'), 'verbatim');
  assert.equal(codexCatalogRepresentation('other/0.162.0'), 'verbatim');
  assert.equal(codexCatalogDecodable(catalogRow), true);
  // Codex 0.164 adds an optional permission-prefix field that the decoder ignores.
  for (const approved of [null, 'git', 7, false, {}]) {
    assert.equal(codexCatalogDecodable({ ...catalogRow, model_messages: { ...catalogRow.model_messages, permissions: { approved_prefixes: approved } } }), true);
  }
  // 0.165 adds optional permission templates and Memento tool messages inside
  // nested fields that this bounded compatibility projection leaves unjudged.
  assert.equal(codexCatalogDecodable({ ...catalogRow, model_messages: {
    ...catalogRow.model_messages,
    permissions: { writable_root: 'Root: {{ roots }}.', writable_roots: null },
    tools: { history: {}, notes: {}, context_management: {} }
  } }), true);
  for (const broken of [
    { ...catalogRow, shell_type: 'future' }, { ...catalogRow, supported_in_api: null },
    { ...catalogRow, input_modalities: ['video'] }, { ...catalogRow, service_tiers: [null] },
    { ...catalogRow, model_messages: {}, base_instructions: null }, { ...catalogRow, priority: 2147483648 }
  ]) assert.equal(codexCatalogDecodable(broken), false);
  assert.equal(codexCatalogDecodable({ ...catalogRow, context_window: -9223372036854775808 }), false);
  assert.equal(codexCatalogDecodable({ ...catalogRow, context_window: 9223372036854775000 }), true);
  assert.equal(codexCatalogDecodable({ ...catalogRow, shell_type: { unified_exec: null }, model_messages: ['template'], unknown: true,
    supports_reasoning_effort_updates: 'not judged', default_reasoning_level: 'future' }), true);
});

test('native catalog projections filter undecodable rows and bind ETags to the served representation', () => {
  const catalog = { nativeModels: [catalogRow, { ...catalogRow, slug: 'gpt-broken', shell_type: 'future' }], etag: 'original', publicModels: [] };
  const checked = projectCodexCatalog(catalog, 'codex_cli_rs/0.162.0');
  assert.equal(checked.nativeModels.length, 1);
  assert.equal('base_instructions' in checked.nativeModels[0], false);
  assert.notEqual(checked.etag, catalog.etag);
  assert.equal(projectCodexCatalog(catalog, 'codex_cli_rs/0.162.0-alpha.1').etag, checked.etag);
  assert.equal(projectCodexCatalog(catalog, 'codex_cli_rs/0.163.0').nativeModels.length, 1);
  assert.equal(projectCodexCatalog(catalog, 'codex_cli_rs/0.147.0'), catalog);
  assert.equal(catalog.nativeModels[0].base_instructions, 'legacy');
});

test('native catalog GET, HTTP response and WebSocket handshake use the same representation ETag', async (t) => {
  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
  const account = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(account.id, { capDollars: 100 });
  const fetchImpl = async (url) => new URL(url).pathname.endsWith('/models')
    ? new Response(JSON.stringify({ models: [catalogRow, { ...catalogRow, slug: 'gpt-broken', shell_type: 'future' }] }))
    : new Response(JSON.stringify({ id: 'resp_http', output: [] }), { headers: { 'content-type': 'application/json' } });
  const server = createServer(createApp({ store, apiKey: 'key', fetchImpl }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'key', fetchImpl, websocketUrl: () => 'ws://127.0.0.1:1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer key', 'user-agent': 'codex_cli_rs/0.162.0', 'content-type': 'application/json' };
  t.after(async () => { relay.close(); await new Promise((resolve) => server.close(resolve)); store.sqlite.close(); });
  const models = await fetch(`${url}/backend-api/codex/models?client_version=0.147.0`, { headers });
  const etag = models.headers.get('etag');
  assert.equal(models.headers.get('vary'), 'User-Agent');
  const body = await models.json();
  assert.deepEqual(body.models.map(({ slug }) => slug), ['gpt-contract']);
  assert.equal('base_instructions' in body.models[0], false);
  const response = await fetch(`${url}/backend-api/codex/responses`, { method: 'POST', headers,
    body: JSON.stringify({ model: 'gpt-contract', input: [] }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-models-etag'), etag);
  await response.arrayBuffer();
  const handshake = await new Promise((resolve, reject) => {
    const client = new WebSocket(`${url.replace('http:', 'ws:')}/backend-api/codex/responses`, { headers });
    let value;
    client.once('upgrade', (reply) => { value = reply.headers['x-models-etag']; });
    client.once('open', () => client.close());
    client.once('close', () => resolve(value));
    client.once('error', reject);
  });
  assert.equal(handshake, etag);
});

test('Decisions HTTP routes authenticate before returning unsupported envelopes', async (t) => {
  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
  const server = createServer(createApp({ store, apiKey: 'key', fetchImpl: async () => { throw new Error('must not dispatch'); } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.sqlite.close(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/decisions/d_1/events`;
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal((await fetch(url, { method })).status, 401);
    const response = await fetch(url, { method, headers: { authorization: 'Bearer key' } });
    assert.equal(response.status, 404);
    if (method !== 'HEAD') {
      const body = await response.json();
      assert.equal(body.error.code, 'unsupported_endpoint');
      assert.match(body.error.message, /Decisions API/);
    }
  }
});

test('HTTP and public WebSocket forward ordered updates and async tools without hiding provider refusals', { timeout: 5000 }, async (t) => {
  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
  const account = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(account.id, { capDollars: 100 });
  const input = [{ role: 'user', content: 'hi' }, update, { role: 'developer', content: 'ordered' }, update];
  const request = { ...base, input, tools: [fn], stream: false };
  const sent = [];
  const refusal = { type: 'error', error: { code: 'invalid_parameter', param: 'input[1].reasoning.effort', message: 'private provider refusal' } };
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => target.once('listening', resolve));
  target.on('connection', (socket) => socket.on('message', (bytes) => {
    const frame = JSON.parse(bytes.toString());
    sent.push(frame);
    socket.send(JSON.stringify(refusal));
  }));
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname.endsWith('/models')) return new Response('{}');
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify(refusal), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  const server = createServer(createApp({ store, apiKey: 'key', fetchImpl }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'key', fetchImpl,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}` });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    relay.close();
    for (const socket of target.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => target.close(resolve));
    store.sqlite.close();
  });
  const response = await fetch(`${url}/v1/responses`, { method: 'POST',
    headers: { authorization: 'Bearer key', 'content-type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(response.status, 400);
  const http = await response.json();
  assert.equal(http.error.code, 'invalid_parameter');
  assert.doesNotMatch(JSON.stringify(http), /private provider/);
  const websocket = await new Promise((resolve, reject) => {
    const client = new WebSocket(`${url.replace('http:', 'ws:')}/v1/responses`, { headers: { authorization: 'Bearer key' } });
    let result;
    client.once('open', () => client.send(JSON.stringify({ type: 'response.create', ...request })));
    client.on('message', (bytes) => { result = JSON.parse(bytes.toString()); client.close(); });
    client.once('close', () => resolve(result));
    client.once('error', reject);
  });
  assert.equal(websocket.error.code, 'invalid_parameter');
  assert.doesNotMatch(JSON.stringify(websocket), /private provider/);
  assert.equal(sent.length, 2);
  for (const frame of sent) {
    assert.deepEqual(frame.input.map(({ type }) => type), ['message', 'configuration_update', 'message', 'configuration_update']);
    assert.equal(frame.tools[0].async, true);
    assert.deepEqual(frame.input[1], update);
  }
});

test('public WebSocket settles terminals received immediately before provider close', { timeout: 5000 }, async (t) => {
  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
  const account = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(account.id, { capDollars: 100 });
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => target.once('listening', resolve));
  target.on('connection', (socket) => socket.on('message', () => {
    socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_immediate', status: 'in_progress' } }));
    socket.send(JSON.stringify({ type: 'response.completed', response: {
      id: 'resp_immediate', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, price_cost_usd: 0.1 }
    } }));
    socket.close(1000);
  }));
  const server = createServer(createApp({ store, apiKey: 'key' }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'key',
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/responses`, { headers: { authorization: 'Bearer key' } });
  t.after(async () => {
    client.terminate(); relay.close();
    for (const socket of target.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => target.close(resolve));
    store.sqlite.close();
  });
  const events = [];
  await new Promise((resolve, reject) => {
    client.once('open', () => client.send(JSON.stringify({ type: 'response.create', ...base })));
    client.once('error', reject);
    client.on('message', (bytes) => {
      const event = JSON.parse(bytes.toString());
      events.push(event);
      if (event.type === 'response.completed') client.close();
    });
    client.once('close', resolve);
  });
  assert.ok(events.some(({ type }) => type === 'response.completed'));
  assert.equal(store.get(account.id).spending.spentCredits, 2.5);
});

test('buffered Chat builds assistant content strictly from message output_text parts', async (t) => {
  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
  const account = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(account.id, { capDollars: 100 });
  const output = [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'internal summary' }],
      content: [{ type: 'reasoning_text', text: 'hidden chain of thought' }]
    },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      content: [
        { type: 'refusal', text: 'should not leak' },
        { type: 'output_text', text: 'Visible ' },
        { type: 'output_text', text: 'answer.' }
      ]
    },
    { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"ok"}' }
  ];
  let mode = 'json';
  const fetchImpl = async (url) => {
    if (new URL(url).pathname.endsWith('/models')) return new Response('{}');
    if (mode === 'json') {
      return new Response(JSON.stringify({ id: 'resp_json', model: 'gpt-5.6-sol', status: 'completed', output }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    const sse = [
      ...output.map((item) => `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`),
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_sse', model: 'gpt-5.6-sol', status: 'completed', output } })}\n\n`
    ].join('');
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  };
  const server = createServer(createApp({ store, apiKey: 'key', fetchImpl }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.sqlite.close(); });
  for (const nextMode of ['json', 'sse']) {
    mode = nextMode;
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'Visible answer.');
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.tool_calls[0].id, 'call_1');
  }
});

test('refuses Responses background_options and image explicitly on HTTP and public WebSocket', async (t) => {
  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
  const account = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(account.id, { capDollars: 100 });
  let dispatched = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname.endsWith('/models')) return new Response('{}');
    dispatched += 1;
    return new Response('{}');
  };
  const server = createServer(createApp({ store, apiKey: 'key', fetchImpl }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'key', fetchImpl, websocketUrl: () => 'ws://127.0.0.1:1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { relay.close(); await new Promise((resolve) => server.close(resolve)); store.sqlite.close(); });
  for (const [param, extra] of [
    ['background_options', { background_options: { completion_window: '2h' } }],
    ['image', { image: { context_compression: 'auto' } }]
  ]) {
    assert.throws(() => adaptResponsesRequest({ ...base, ...extra }), { code: 'unsupported_parameter', param });
    for (const stream of [false, true]) {
      const response = await fetch(`${url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, stream, ...extra })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, 'unsupported_parameter');
      assert.equal(body.error.param, param);
    }
    const wsError = await new Promise((resolve, reject) => {
      const client = new WebSocket(`${url.replace('http:', 'ws:')}/v1/responses`, { headers: { authorization: 'Bearer key' } });
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', ...base, ...extra })));
      client.once('message', (bytes) => { client.close(); resolve(JSON.parse(bytes.toString())); });
      client.once('error', reject);
    });
    assert.equal(wsError.status, 400);
    assert.equal(wsError.error.code, 'unsupported_parameter');
    assert.equal(wsError.error.param, param);
  }
  assert.equal(dispatched, 0);
});

test('validates replayed image_generation_call items and strips synthetic stream fallback IDs', () => {
  const valid = {
    type: 'image_generation_call',
    id: 'ig_abc123',
    status: 'completed',
    action: 'generate',
    background: 'transparent',
    output_format: 'png',
    quality: 'high',
    size: '1024x1024',
    revised_prompt: 'a canary prompt',
    result: 'iVBORw0KGgo=',
    encrypted_content: 'enc_blob',
    internal_chat_message_metadata_passthrough: { source: 'provider' }
  };
  assert.deepEqual(adaptResponsesRequest({ ...base, input: [valid] }).input[0], valid);
  const nullable = {
    type: 'image_generation_call',
    id: null,
    status: null,
    action: null,
    background: null,
    output_format: null,
    quality: null,
    size: null,
    revised_prompt: '',
    result: 'iVBORw0KGgo=',
    encrypted_content: null,
    internal_chat_message_metadata_passthrough: null
  };
  assert.deepEqual(adaptResponsesRequest({ ...base, input: [nullable] }).input[0], nullable);
  for (const fallbackId of ['image_generation_call', 'image_generation_call_0', 'image_generation_call_12']) {
    const adapted = adaptResponsesRequest({ ...base, input: [{ type: 'image_generation_call', id: fallbackId, result: 'iVBORw0KGgo=' }] });
    assert.equal('id' in adapted.input[0], false);
    assert.equal(adapted.input[0].result, 'iVBORw0KGgo=');
  }
  for (const invalidItem of [
    { type: 'image_generation_call', id: 'ig_1' },
    { type: 'image_generation_call', id: 'ig_1', result: '   ' },
    { type: 'image_generation_call', id: '   ', result: 'iVBORw0KGgo=' },
    { type: 'image_generation_call', status: '', result: 'iVBORw0KGgo=' },
    { type: 'image_generation_call', encrypted_content: ' ', result: 'iVBORw0KGgo=' },
    { type: 'image_generation_call', quality: 3, result: 'iVBORw0KGgo=' },
    { type: 'image_generation_call', internal_chat_message_metadata_passthrough: 'bad', result: 'iVBORw0KGgo=' },
    { type: 'image_generation_call', extra_field: true, result: 'iVBORw0KGgo=' }
  ]) {
    assert.throws(() => adaptResponsesRequest({ ...base, input: [invalidItem] }), { param: 'input' });
  }
});

test('advertises the 128 MiB native WebSocket message limit and fences recovery markers by bound', async (t) => {
  assert.equal(NATIVE_WEBSOCKET_MESSAGE_LIMIT, 134_217_728);
  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
  const account = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(account.id, { capDollars: 100 });
  const fetchImpl = async () => new Response('{}');
  const server = createServer(createApp({ store, apiKey: 'key', fetchImpl }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'key', fetchImpl, websocketUrl: () => 'ws://127.0.0.1:1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}`;
  t.after(async () => { relay.close(); await new Promise((resolve) => server.close(resolve)); store.sqlite.close(); });
  const readUpgradeHeaders = (path) => new Promise((resolve, reject) => {
    const client = new WebSocket(`${url}${path}`, { headers: { authorization: 'Bearer key' } });
    let headers;
    client.once('upgrade', (reply) => { headers = reply.headers; });
    client.once('open', () => client.close());
    client.once('close', () => resolve(headers));
    client.once('error', reject);
  });
  for (const path of ['/backend-api/codex/responses', '/backend-api/codex/v1/responses']) {
    const headers = await readUpgradeHeaders(path);
    assert.equal(headers['x-codex-websocket-max-message-bytes'], String(134_217_728));
  }
  const publicHeaders = await readUpgradeHeaders('/v1/responses');
  assert.equal('x-codex-websocket-max-message-bytes' in publicHeaders, false);
  // A marker recorded under the legacy 16 MiB bound does not grant recovery under 128 MiB.
  store.recordNativeWebsocketSizeRecovery('legacy-key', { messageBytes: 16_777_217, limitBytes: 16_777_216 });
  assert.equal(store.nativeWebsocketSizeRecovery('legacy-key'), false);
  assert.equal(store.nativeWebsocketSizeRecovery('legacy-key', Date.now(), { limitBytes: 16_777_216 }), true);
  // A lower ingress maxDecompressedBodyBytes caps the advertised header.
  const cappedServer = createServer(createApp({ store, apiKey: 'key', fetchImpl }));
  const cappedRelay = attachWebSocketProxy(cappedServer, {
    store, apiKey: 'key', fetchImpl,
    ingress: { maxDecompressedBodyBytes: 64 * 1024 * 1024 },
    websocketUrl: () => 'ws://127.0.0.1:1'
  });
  await new Promise((resolve) => cappedServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => { cappedRelay.close(); await new Promise((resolve) => cappedServer.close(resolve)); });
  const cappedHeaders = await new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${cappedServer.address().port}/backend-api/codex/responses`, { headers: { authorization: 'Bearer key' } });
    let headers;
    client.once('upgrade', (reply) => { headers = reply.headers; });
    client.once('open', () => client.close());
    client.once('close', () => resolve(headers));
    client.once('error', reject);
  });
  assert.equal(cappedHeaders['x-codex-websocket-max-message-bytes'], String(64 * 1024 * 1024));
});

test('classifies api_key_spend_limit_exceeded as terminal quota and relays scoped native 429 codes', async (t) => {
  const incomplete = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'api_key_spend_limit_exceeded' } } };
  const failed = { type: 'response.failed', response: { status: 'failed', error: { code: 'api_key_spend_limit_exceeded', message: 'private' } } };
  assert.equal(quotaIncompleteReason(incomplete), 'api_key_spend_limit_exceeded');
  assert.equal(failedIncompleteResponse(incomplete), true);
  assert.equal(classifySseEvent(incomplete).class, 'quota');
  assert.equal(classifySseEvent(failed).class, 'quota');
  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
  const account = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(account.id, { capDollars: 100 });
  const req = { headers: { 'thread-id': 'thread-1', 'x-codex-turn-metadata': JSON.stringify({ turn_id: 'turn-1', request_kind: 'compaction' }) }, proxyAuth: { id: 'key-1', scopeId: 'default' } };
  const payload = { model: 'gpt-5.6-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] };
  const identity = nativeTurnIdentity(store, req, payload);
  const lease = beginNativeTurn(store, identity, payload, store.get(account.id));
  nativeEventWritten(lease, incomplete);
  assert.equal(store.nativeTurnReceipt(identity.key).status, 'failed');
  assert.throws(() => beginNativeTurn(store, identity, payload, store.get(account.id)), { code: 'duplicate_turn' });

  const fetchImpl = async (url) => new URL(url).pathname.endsWith('/models')
    ? new Response('{}')
    : new Response(JSON.stringify({
      error: { type: 'rate_limit_error', code: 'api_key_spend_limit_exceeded', message: 'secret provider detail', resets_in_seconds: 120 }
    }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } });
  const server = createServer(createApp({ store, apiKey: 'key', fetchImpl }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.sqlite.close(); });

  const nativeResp = await fetch(`${url}/backend-api/codex/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: [] })
  });
  assert.equal(nativeResp.status, 429);
  const nativeBody = await nativeResp.json();
  assert.equal(nativeBody.error.code, 'api_key_spend_limit_exceeded');
  assert.equal(nativeBody.error.resets_in_seconds, 120);
  assert.doesNotMatch(JSON.stringify(nativeBody), /secret provider/);

  store.clearUpstreamCooldown(account.id);
  const publicResp = await fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' })
  });
  assert.equal(publicResp.status, 429);
  const publicBody = await publicResp.json();
  assert.equal(publicBody.error.code, 'upstream_rate_limited');
});

test('carries validated Retry-After on statusless native capacity failure frames', async (t) => {
  assert.equal(nativeWebSocketRetryAfter({
    type: 'error',
    headers: { 'Retry-After': '15' },
    error: { code: 'policy_capacity_unavailable', message: 'busy' }
  }), '15');
  assert.equal(nativeWebSocketRetryAfter({
    type: 'response.failed',
    response: { error: { code: 'server_is_overloaded', headers: { 'retry-after': '45' } } }
  }), '45');
  assert.equal(nativeWebSocketRetryAfter({
    type: 'error',
    status: 503,
    headers: { 'retry-after': '15' },
    error: { code: 'server_is_overloaded' }
  }), null);
  assert.equal(nativeWebSocketRetryAfter({
    type: 'error',
    headers: { 'retry-after': '15' },
    error: { code: 'server_error' }
  }), null);

  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
  const account = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(account.id, { capDollars: 100 });
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => target.once('listening', resolve));
  target.on('connection', (socket) => socket.on('message', () => {
    socket.send(JSON.stringify({
      type: 'response.failed',
      headers: { 'retry-after': '23', 'x-secret': 'drop-me' },
      response: {
        id: 'resp_cap',
        status: 'failed',
        error: { code: 'policy_capacity_unavailable', message: 'overloaded', headers: { 'x-inner': 'drop-me' } }
      }
    }));
  }));
  const server = createServer(createApp({ store, apiKey: 'key' }));
  const relay = attachWebSocketProxy(server, {
    store, apiKey: 'key',
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/backend-api/codex/responses`, { headers: { authorization: 'Bearer key' } });
  t.after(async () => {
    client.terminate(); relay.close();
    for (const socket of target.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => target.close(resolve));
    store.sqlite.close();
  });
  const failedEvent = await new Promise((resolve, reject) => {
    client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: [] })));
    client.on('message', (bytes) => {
      const event = JSON.parse(bytes.toString());
      if (event.type === 'response.failed') { client.close(); resolve(event); }
    });
    client.once('error', reject);
  });
  assert.equal(failedEvent.headers['retry-after'], '23');
  assert.equal('x-secret' in failedEvent.headers, false);
  assert.deepEqual(failedEvent.response.error.headers, { 'retry-after': '23' });
});
