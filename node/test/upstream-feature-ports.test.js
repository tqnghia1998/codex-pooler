import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { adaptResponsesRequest, validateToolOutputImages } from '../src/openai-adapters.js';
import { attachWebSocketProxy, projectProxyRequest, projectPublicWebSocketFrame } from '../src/proxy.js';
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

test('prices Sol ultrafast with cache writes and the exact long-context bucket', () => {
  assert.equal(priceUsage(['gpt-6.1-sol'], { inputTokens: 1_000, outputTokens: 100, serviceTier: 'ultrafast' }).settledCostMicros, 18_000);
  assert.equal(priceUsage(['gpt-6.1-sol-20260929'], {
    inputTokens: 1_000, cachedInputTokens: 100, cacheWriteTokens: 100, outputTokens: 100, serviceTier: 'ultrafast'
  }).settledCostMicros, 17_160);
  assert.equal(priceUsage(['gpt-6.1-sol'], {
    inputTokens: 272_001, cachedInputTokens: 100, cacheWriteTokens: 100, outputTokens: 100, serviceTier: 'ultrafast'
  }).settledCostMicros, 6_535_344);
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 1_000, outputTokens: 100, serviceTier: 'ultrafast' }), null);
});

export const catalogRow = {
  slug: 'gpt-contract', display_name: 'Contract', supported_reasoning_levels: [{ effort: 'high', description: 'High' }],
  shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0, support_verbosity: true,
  truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
  base_instructions: 'legacy', model_messages: { instructions_template: 'template' }
};

test('mirrors the qualified Codex decoder window and tolerated blind spots', () => {
  assert.deepEqual(CODEX_CATALOG_VERIFIED_RANGE, ['0.154.0', '0.162.0']);
  for (const version of ['0.154.0-alpha.1', '0.160.1', '0.162.0', '0.162.0-alpha.1']) {
    assert.equal(codexCatalogRepresentation(`codex_cli_rs/${version}`), 'decode_checked');
  }
  assert.equal(codexCatalogRepresentation('My/host/0.162.0 (Linux; aarch64)'), 'decode_checked');
  assert.equal(codexCatalogRepresentation('codex_cli_rs/0.162.1'), 'instructions_template');
  assert.equal(codexCatalogRepresentation('codex_cli_rs/0.147.0'), 'verbatim');
  assert.equal(codexCatalogRepresentation('other/0.162.0'), 'verbatim');
  assert.equal(codexCatalogDecodable(catalogRow), true);
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
  assert.equal(projectCodexCatalog(catalog, 'codex_cli_rs/0.163.0').nativeModels.length, 2);
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
