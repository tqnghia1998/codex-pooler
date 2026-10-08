import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../src/server.js';
import { attachWebSocketProxy, projectProxyRequest, projectPublicWebSocketFrame } from '../src/proxy.js';
import { Store } from '../src/store.js';
import { splitSseBlocks, decodeSseBlock } from '../src/openai-streaming.js';

const tool = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' };
const usage = { input_tokens: 1, output_tokens: 1, price_cost_usd: 0.1 };
const eventsFor = (valid) => [
  { type: 'response.output_item.added', output_index: 0, item: { ...tool, arguments: '' } },
  ...(valid ? [{ type: 'response.output_item.done', output_index: 0, item: tool }] : []),
  { type: 'response.completed', response: { id: valid ? 'resp_valid' : 'resp_invalid', status: 'completed', output: [], usage } }
];
const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

function fixture(t) {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 9) });
  const upstream = store.create({ type: 'codex', accessToken: 'synthetic-token' });
  store.setCap(upstream.id, { capDollars: 100 });
  const key = store.configureApiKey('ports-key');
  t.after(() => store.sqlite.close());
  return { store, upstream, key };
}

async function serve(t, store, fetchImpl) {
  const server = createServer(createApp({ store, apiKey: 'ports-key', fetchImpl }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function post(base, body, path = '/v1/responses') {
  return fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer ports-key', 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('SSE repairs terminal tool output and never settles a malformed tool success', async (t) => {
  const { store, upstream, key } = fixture(t);
  let valid = false;
  let calls = 0;
  const app = await serve(t, store, async () => {
    calls += 1;
    return new Response(sse(eventsFor(valid)), { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await post(app.base, { model: 'gpt-5.6-sol', input: 'hi', stream: true });
  const terminal = splitSseBlocks(await response.text()).map(decodeSseBlock).filter((block) => block.kind === 'event').at(-1).event;
  assert.equal(terminal.type, 'response.failed');
  assert.equal(calls, 1);
  assert.equal(store.get(upstream.id).spending.spentCredits, 0);
  assert.equal(store.gatewayUsage(key.scopeId, key.id).request_count, 0);
  assert.equal(store.load().gatewayRequests.at(-1).lastErrorCode, 'incomplete_tool_item');
  assert.equal(store.responseUpstream('resp_invalid', key.scopeId, key.id), null);
  valid = true;
  const success = await post(app.base, { model: 'gpt-5.6-sol', input: 'hi', stream: true });
  const completed = splitSseBlocks(await success.text()).map(decodeSseBlock).filter((block) => block.kind === 'event').at(-1).event;
  assert.equal(completed.type, 'response.completed');
  assert.deepEqual(completed.response.output, [tool]);
  assert.equal(store.get(upstream.id).spending.spentCredits, 2.5);
  assert.equal(store.gatewayUsage(key.scopeId, key.id).request_count, 1);
  assert.equal(store.responseUpstream('resp_valid', key.scopeId, key.id), upstream.id);
});

test('public WebSocket repairs output, fences malformed success, and permits the next turn', async (t) => {
  const { store, upstream, key } = fixture(t);
  let turns = 0;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => target.once('listening', resolve));
  target.on('connection', (socket) => socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    assert.equal('metadata' in frame, false);
    turns += 1;
    for (const event of eventsFor(turns > 1)) socket.send(JSON.stringify(event));
  }));
  const app = await serve(t, store, async () => new Response('{}'));
  const relay = attachWebSocketProxy(app.server, { store, apiKey: 'ports-key', websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  t.after(async () => { relay.close(); for (const socket of target.clients) socket.terminate(); await new Promise((resolve) => target.close(resolve)); });
  const client = new WebSocket(app.base.replace('http:', 'ws:') + '/v1/responses', { headers: { authorization: 'Bearer ports-key' } });
  t.after(() => client.terminate());
  const terminals = await new Promise((resolve, reject) => {
    const received = [];
    const timer = setTimeout(() => { client.terminate(); reject(new Error('WebSocket terminal timeout')); }, 5000);
    const send = () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'hi', metadata: { tag: 'local-only' } }));
    client.once('open', send);
    client.on('error', reject);
    client.on('message', (data) => {
      const event = JSON.parse(data.toString());
      if (!['response.completed', 'response.failed'].includes(event.type)) return;
      received.push(event);
      if (received.length === 1) send();
      else { clearTimeout(timer); client.close(); resolve(received); }
    });
  });
  assert.deepEqual(terminals.map((event) => event.type), ['response.failed', 'response.completed']);
  assert.deepEqual(terminals[1].response.output, [tool]);
  assert.equal(turns, 2);
  assert.equal(store.get(upstream.id).spending.spentCredits, 2.5);
  assert.equal(store.gatewayUsage(key.scopeId, key.id).request_count, 1);
  assert.equal(store.load().gatewayRequests.at(-1).lastErrorCode, 'incomplete_tool_item');
  assert.equal(store.responseUpstream('resp_invalid', key.scopeId, key.id), null);
  assert.equal(store.responseUpstream('resp_valid', key.scopeId, key.id), upstream.id);
});

test('Codex metadata is local bookkeeping on HTTP and both WebSocket projections', async (t) => {
  const { store } = fixture(t);
  const frames = [];
  const app = await serve(t, store, async (_url, options) => {
    frames.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: 'resp_ok', output: [] }));
  });
  for (const path of ['/v1/responses', '/backend-api/codex/responses']) {
    const response = await post(app.base, { model: 'gpt-5.6-sol', input: 'hi', metadata: { tag: 'local-only' } }, path);
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(frames.every((frame) => !Object.hasOwn(frame, 'metadata')), true);
  const payload = { model: 'gpt-5.6-sol', input: 'hi', metadata: { tag: 'local-only' } };
  assert.equal('metadata' in projectPublicWebSocketFrame(payload), false);
  assert.deepEqual(projectProxyRequest({ upstreamType: 'compass', sourcePath: '/v1/responses', payload }).body.metadata, payload.metadata);
});

test('validation refusals retain safe codes and paths over HTTP, without replay or provider text', async (t) => {
  const { store } = fixture(t);
  let calls = 0;
  const app = await serve(t, store, async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'unknown_parameter', param: 'tools[0].old_key', message: 'private input' } }), { status: 400 });
  });
  const response = await post(app.base, { model: 'gpt-5.6-sol', input: 'hi' });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'unknown_parameter');
  assert.equal(body.error.param, 'tools[0].old_key');
  assert.equal(JSON.stringify(body).includes('private'), false);
  assert.equal(calls, 1);
});

test('Agents and vault routes use authenticated explicit unsupported envelopes at any depth', async (t) => {
  const { store } = fixture(t);
  const app = await serve(t, store, async () => { throw new Error('Unexpected provider request'); });
  for (const [method, path] of [['GET', '/v1/agents'], ['PATCH', '/v1/agents/sessions/session/events'], ['DELETE', '/v1/vaults/vault']]) {
    const unauthenticated = await fetch(app.base + path, { method });
    assert.equal(unauthenticated.status, 401);
    const response = await fetch(app.base + path, { method, headers: { authorization: 'Bearer ports-key' } });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'unsupported_endpoint');
    assert.match(body.error.message, /beta Agents API/);
  }
});
