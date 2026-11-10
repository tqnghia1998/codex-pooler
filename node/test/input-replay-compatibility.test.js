import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { attachWebSocketProxy } from '../src/proxy.js';
import { AdapterError, adaptResponsesRequest } from '../src/openai-adapters.js';

const call = { type: 'function_call', call_id: 'call_replay', name: 'lookup', arguments: '{}', namespace: null, status: 'completed' };
const compaction = { type: 'compaction', id: null, encrypted_content: 'synthetic-cipher', internal_chat_message_metadata_passthrough: { turn_id: 'synthetic-turn' } };
const toolOutput = { type: 'function_call_output', call_id: call.call_id, output: 'synthetic-result', name: 'lookup', namespace: 'catalog', id: null, caller: null, status: 'completed' };
const normalizedToolOutput = { type: 'function_call_output', call_id: call.call_id, output: 'synthetic-result', name: 'lookup', namespace: 'catalog' };
const desktopOutput = { type: 'function_call_output', name: 'create_thread', namespace: 'codex_app', output: 'synthetic-desktop-result' };
const input = [compaction, call, toolOutput, { role: 'user', content: 'hi' }, desktopOutput, { ...desktopOutput, call_id: null }];
const payload = { model: 'gpt-5.6-luna', input };
const completed = { type: 'response.completed', response: { id: 'resp_replay', object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, price_cost_usd: 0.1 } } };

// This file is also run through QuotaHub with candidate gateway resolution.
test('normalizes nullable replay fields without mutating history or losing semantic fields', () => {
  const original = structuredClone(payload);
  const result = adaptResponsesRequest(payload);
  assert.deepEqual(payload, original);
  assert.deepEqual(result.input[0], { type: 'compaction', encrypted_content: compaction.encrypted_content });
  assert.deepEqual(result.input[1], { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments });
  assert.deepEqual(result.input[2], normalizedToolOutput);
  assert.deepEqual(result.input[4], desktopOutput);
  assert.deepEqual(result.input[5], desktopOutput);
  const explicit = adaptResponsesRequest({ ...payload, input: [{ ...call, namespace: 'catalog' }, { ...compaction, id: 'cmp_1' }] }).input;
  assert.equal(explicit[0].namespace, 'catalog');
  assert.deepEqual(explicit[1], { ...compaction, id: 'cmp_1' });
});

test('desktop named outputs without call IDs do not borrow an adjacent function call ID', () => {
  for (const output of [desktopOutput, { ...desktopOutput, call_id: null }, { ...desktopOutput, name: call.name, namespace: null }]) {
    const request = { ...payload, input: [call, output] };
    const original = structuredClone(request);
    const result = adaptResponsesRequest(request).input[1];
    assert.equal(Object.hasOwn(result, 'call_id'), false);
    assert.equal(result.name, output.name);
    assert.equal(result.namespace, output.namespace ?? undefined);
    assert.equal(result.output, output.output);
    assert.deepEqual(request, original);
  }
});

test('function output call ID is optional independently of its name or preceding input', () => {
  for (const callId of [undefined, null, 'call_explicit']) {
    const output = { type: 'function_call_output', output: 'synthetic-result', ...(callId !== undefined ? { call_id: callId } : {}) };
    const expected = callId == null ? { type: 'function_call_output', output: output.output } : output;
    assert.deepEqual(adaptResponsesRequest({ ...payload, input: [output] }).input, [expected]);
  }
});

test('function output replay preserves names, namespaces, caller and structured results', () => {
  for (const status of ['in_progress', 'completed', 'incomplete', null]) {
    const output = { ...toolOutput, status, id: 'out_1', caller: { type: 'program', caller_id: 'program_1' }, created_by: 'actor_1', output: [{ type: 'input_text', text: 'synthetic' }] };
    const { status: ignored, ...expected } = output;
    assert.deepEqual(adaptResponsesRequest({ ...payload, input: [output] }).input, [expected]);
  }
  const output = { ...toolOutput, namespace: null, name: null, created_by: null };
  assert.deepEqual(adaptResponsesRequest({ ...payload, input: [output] }).input, [{ type: 'function_call_output', call_id: call.call_id, output: toolOutput.output }]);
});

test('function output diagnostics identify invalid fields without exposing result values', () => {
  const secret = 'private-tool-result';
  for (const [changes, field] of [[{ call_id: '' }, 'call_id'], [{ call_id: 42 }, 'call_id'], [{ name: 1 }, 'name'], [{ namespace: {} }, 'namespace'], [{ status: secret }, 'status'], [{ caller: { type: secret } }, 'caller'], [{ unsupported: secret }, 'unsupported']]) {
    assert.throws(() => adaptResponsesRequest({ ...payload, input: [{ ...toolOutput, output: secret, ...changes }] }), error => {
      assert.ok(error.message.startsWith('input[0] (function_call_output):'));
      assert.ok(error.message.includes(field));
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});

test('input diagnostics retain original indices and never echo prompt, argument or cipher values', () => {
  const secret = 'private-prompt-argument-cipher';
  for (const [item, field] of [
    [{ type: 'additional_tools', tools: [], content: secret }, 'content'],
    [{ type: 'additional_tools', tools: [] }, 'role'],
    [{ type: 'additional_tools', role: 'developer', tools: secret }, 'tools'],
    [{ ...call, namespace: 42, arguments: secret }, 'namespace'],
    [{ ...call, namespace: '', arguments: secret }, 'namespace'],
    [{ ...call, caller: null, arguments: secret }, 'caller'],
    [{ ...call, status: 'unknown', arguments: secret }, 'status'],
    [{ ...compaction, id: 42, encrypted_content: secret }, 'id'],
    [{ ...compaction, encrypted_content: '' }, 'encrypted_content'],
    [{ ...compaction, encrypted_content: secret, status: 'completed' }, 'status'],
    [{ ...compaction, encrypted_content: secret, internal_chat_message_metadata_passthrough: { turn_id: 'turn', extra: true } }, 'internal_chat_message_metadata_passthrough']
  ]) {
    assert.throws(() => adaptResponsesRequest({ ...payload, input: [{ type: 'reasoning', summary: [] }, { role: 'user', content: secret }, item] }), error => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.param, 'input');
      assert.ok(error.message.startsWith(`input[2] (${item.type}):`));
      assert.ok(error.message.includes(field), error.message);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
  assert.throws(() => adaptResponsesRequest({ ...payload, input: [null] }), /input\[0\] \(item\).*expected an object/);
  assert.throws(() => adaptResponsesRequest({ ...payload, input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'mcp' }] }] }), /input\[0\] \(additional_tools\).*remote MCP/);
});

for (const mode of ['http', 'websocket']) for (const invalid of [false, true]) {
  test(`public ${mode} replay normalizes nullable fields, invalid=${invalid}`, { timeout: 5000 }, async t => {
    const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 8) });
    const upstream = store.create({ type: 'codex', accessToken: 'synthetic' });
    store.setCap(upstream.id, { capDollars: 100 });
    let dispatched = 0;
    const inspect = body => {
      dispatched++;
      assert.equal(body.input[0].encrypted_content, compaction.encrypted_content);
      assert.equal(Object.hasOwn(body.input[0], 'id'), false);
      assert.equal(Object.hasOwn(body.input[1], 'namespace'), false);
      assert.deepEqual(body.input[2], normalizedToolOutput);
      assert.deepEqual(body.input[4], desktopOutput);
      assert.deepEqual(body.input[5], desktopOutput);
    };
    const fetchImpl = async (url, options) => {
      if (new URL(url).pathname.endsWith('/models')) return Response.json({ models: [] });
      inspect(JSON.parse(options.body));
      return Response.json(completed.response);
    };
    const server = createServer(createApp({ store, apiKey: 'key', fetchImpl }));
    const target = mode === 'websocket' ? new WebSocketServer({ port: 0, host: '127.0.0.1' }) : null;
    if (target) await once(target, 'listening');
    target?.on('connection', socket => socket.on('message', data => {
      inspect(JSON.parse(data)); socket.send(JSON.stringify(completed));
    }));
    const relay = target ? attachWebSocketProxy(server, { store, apiKey: 'key', fetchImpl, websocketUrl: () => `ws://127.0.0.1:${target.address().port}` }) : null;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let client;
    t.after(async () => {
      client?.terminate(); relay?.clients.forEach(socket => socket.terminate()); target?.clients.forEach(socket => socket.terminate());
      if (relay) await new Promise(resolve => relay.close(resolve));
      if (target) await new Promise(resolve => target.close(resolve));
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.sqlite.close();
    });
    const body = invalid ? { ...payload, input: [{ type: 'additional_tools', tools: [] }] } : payload;
    let error;
    if (target) {
      client = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/responses`, { headers: { authorization: 'Bearer key' } });
      const result = new Promise((resolve, reject) => {
        client.on('message', data => { const event = JSON.parse(data); if (event.type === 'response.completed') resolve(null); if (event.type === 'error') resolve(event.error || event); if (event.type === 'response.failed') resolve(event.response.error); });
        client.on('error', reject);
      });
      await once(client, 'open'); client.send(JSON.stringify({ ...body, type: 'response.create' }));
      error = await result;
    } else {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer key', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, invalid ? 400 : 200);
      error = (await response.json()).error;
    }
    assert.equal(dispatched, invalid ? 0 : 1);
    if (invalid) assert.match(error.message, /input\[0\] \(additional_tools\).*role must be developer/);
  });
}
