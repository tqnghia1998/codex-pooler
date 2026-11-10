import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { attachWebSocketProxy } from '../src/proxy.js';
import { customToolNamespaces } from '../src/openai-adapters.js';
import { createPublicResponsesState, normalizePublicResponsesEvent, restoreCustomToolCallNamespaces } from '../src/openai-streaming.js';

const fn = name => ({ type: 'function', name, parameters: { type: 'object', properties: {} } });
const custom = name => ({ type: 'custom', name, format: { type: 'text' } });
const ns = (name, tools) => ({ type: 'namespace', name, description: name, tools });
const tools = [ns('catalog', [fn('lookup'), custom('patch')])];
const calls = [
  { type: 'function_call', name: 'lookup', arguments: '{}', id: 'fc_1', call_id: 'call_1', status: 'completed' },
  { type: 'custom_tool_call', name: 'patch', input: 'synthetic', id: 'ctc_1', call_id: 'call_2', status: 'completed' }
];
const output = calls.flatMap((call, index) => [
  call, { ...call, id: call.id + '_null', call_id: call.call_id + '_null', namespace: null },
  { ...call, id: call.id + '_explicit', call_id: call.call_id + '_explicit', namespace: 'provider' },
  { ...call, id: call.id + '_empty', call_id: call.call_id + '_empty', namespace: '' }
]);
const expected = output.map(item => ({ ...item, namespace: item.namespace ?? 'catalog' }));
const terminal = items => ({ type: 'response.completed', response: { id: 'resp_namespace', object: 'response', status: 'completed', output: items, usage: { input_tokens: 1, output_tokens: 1, price_cost_usd: 0.1 } } });
const events = items => [
  { type: 'response.created', response: { id: 'resp_namespace', output: [] } },
  ...items.flatMap((item, index) => [
    { type: 'response.output_item.added', output_index: index, item },
    { type: 'response.output_item.done', output_index: index, item }
  ]), terminal(items)
];
const encode = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const decode = body => body.split(/\r?\n\r?\n/).flatMap(block => {
  const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
  return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
});

test('namespace inference counts functions and custom declarations together, independent of order', () => {
  assert.deepEqual(customToolNamespaces(tools), { lookup: 'catalog', patch: 'catalog' });
  for (const declare of [fn, custom]) for (const duplicate of [fn, custom]) {
    for (const layout of [
      [declare('same'), ns('a', [duplicate('same')])],
      [ns('a', [declare('same')]), duplicate('same')],
      [ns('a', [declare('same')]), ns('b', [duplicate('same')])],
      [ns('b', [duplicate('same')]), ns('a', [declare('same')])],
      [ns('a', [declare('same'), duplicate('same')])],
      [ns('a', [declare('same')]), ns('b', [duplicate('same')]), ns('c', [declare('same')])]
    ]) assert.deepEqual(customToolNamespaces(layout), {});
  }
});

test('collected and nested outputs restore only absent/null function/custom namespaces', () => {
  const namespaces = customToolNamespaces(tools);
  assert.equal(restoreCustomToolCallNamespaces({ output: [{ type: 'function_call', id: 'missing-name' }] }, { undefined: 'wrong' }).output[0].namespace, undefined);
  const value = { response: terminal(output).response, item: { ...calls[0] } };
  const restored = restoreCustomToolCallNamespaces(structuredClone(value), namespaces);
  assert.deepEqual(restored.response.output, expected);
  assert.equal(restored.item.namespace, 'catalog');
  for (const name of ['unknown', 'toString', 'constructor', '__proto__']) {
    const item = { ...calls[0], name };
    assert.equal(restoreCustomToolCallNamespaces({ output: [item] }, namespaces).output[0].namespace, undefined);
  }
  assert.equal(restoreCustomToolCallNamespaces({ output: [{ ...calls[0], name: '__proto__' }] }, customToolNamespaces([ns('safe', [fn('__proto__')])])).output[0].namespace, 'safe');
});

test('live events, backfilled terminals and WebSocket normalization share namespace restoration', () => {
  for (const websocket of [false, true]) {
    const state = createPublicResponsesState(customToolNamespaces(tools), { websocket });
    for (const event of events(output)) {
      const result = normalizePublicResponsesEvent(event, state).map(value => decode(value)[0]);
      for (const projected of result) {
        if (projected.item) assert.equal(projected.item.namespace, expected[projected.output_index].namespace);
        if (projected.type === 'response.completed') assert.deepEqual(projected.response.output, expected);
      }
    }
    const backfilled = createPublicResponsesState(customToolNamespaces(tools), { websocket });
    for (const event of events(output).filter(event => event.type !== 'response.completed')) normalizePublicResponsesEvent(event, backfilled);
    const last = normalizePublicResponsesEvent(terminal([]), backfilled).map(value => decode(value)[0]).at(-1);
    assert.deepEqual(last.response.output, expected);
  }
});

for (const mode of ['json', 'collected-sse', 'sse', 'websocket']) {
  test(`public Responses ${mode} restores namespace through the gateway`, { timeout: 5000 }, async t => {
    const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
    const upstream = store.create({ type: 'codex', accessToken: 'synthetic' }); store.setCap(upstream.id, { capDollars: 100 });
    const server = createServer(createApp({ store, apiKey: 'key', fetchImpl: async url => {
      if (new URL(url).pathname.endsWith('/models')) return Response.json({ models: [] });
      return mode === 'json' ? Response.json(terminal(output).response)
        : new Response(events(output).map(encode).join(''), { headers: { 'content-type': 'text/event-stream' } });
    } }));
    const target = mode === 'websocket' ? new WebSocketServer({ port: 0, host: '127.0.0.1' }) : null;
    if (target) await once(target, 'listening');
    target?.on('connection', socket => socket.once('message', () => events(output).forEach(event => socket.send(JSON.stringify(event)))));
    const relay = target ? attachWebSocketProxy(server, { store, apiKey: 'key', fetchImpl: async () => Response.json({ models: [] }), websocketUrl: () => `ws://127.0.0.1:${target.address().port}` }) : null;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let client;
    t.after(async () => {
      client?.terminate(); relay?.clients.forEach(socket => socket.terminate()); target?.clients.forEach(socket => socket.terminate());
      if (relay) await new Promise(resolve => relay.close(resolve));
      if (target) await new Promise(resolve => target.close(resolve));
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.sqlite.close();
    });
    const payload = { model: 'gpt-5.6-sol', input: 'synthetic', tools, stream: mode === 'sse' };
    if (target) {
      client = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/responses`, { headers: { authorization: 'Bearer key' } });
      const completed = new Promise((resolve, reject) => {
        client.on('message', data => { const event = JSON.parse(data); if (event.type === 'response.completed') resolve(event.response); if (['error', 'response.failed'].includes(event.type)) reject(new Error(JSON.stringify(event))); });
        client.on('error', reject);
      });
      await once(client, 'open'); client.send(JSON.stringify({ ...payload, type: 'response.create' }));
      assert.deepEqual((await completed).output, expected);
    } else {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer key', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      assert.equal(response.status, 200);
      const body = mode === 'sse' ? decode(await response.text()).findLast(event => event.type === 'response.completed')?.response : await response.json();
      assert.deepEqual(body.output, expected);
    }
  });
}
