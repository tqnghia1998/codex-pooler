import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { adaptChatRequest, adaptResponsesRequest } from '../src/openai-adapters.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { consumeNativeSse, createNativeSseState, NATIVE_SSE_EVENT_BYTES, NATIVE_SSE_TERMINAL_BYTES } from '../src/native-sse.js';
import { attachWebSocketProxy, inspectInitialSseEvent, projectPublicWebSocketFrame, proxyRequest } from '../src/proxy.js';
import WebSocket, { WebSocketServer } from 'ws';

const base = { model: 'gpt-5.6-sol', input: 'synthetic' };
const call = { id: 'call_1', function: { name: 'lookup', arguments: '{}' } };
const sse = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

function fixture(t) {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 1) });
  t.after(() => store.sqlite.close());
  return store;
}

test('preserves Chat instructions and Responses assistant text before replayed calls', () => {
  const chat = adaptChatRequest({ model: base.model, instructions: 'top', messages: [
    { role: 'developer', content: 'developer' }, { role: 'user', content: 'user' }
  ] });
  assert.equal(chat.instructions, 'top\ndeveloper');
  for (const content of ['assistant', [{ type: 'output_text', text: 'assistant' }]]) {
    const payload = adaptResponsesRequest({ ...base, input: [{ role: 'assistant', content, phase: 'commentary', tool_calls: [call] }] });
    assert.deepEqual(payload.input.map(({ type }) => type), ['message', 'function_call']);
    assert.equal(payload.input[0].content[0].text, 'assistant');
    assert.equal(payload.input[0].phase, 'commentary');
    assert.deepEqual(projectPublicWebSocketFrame(payload).input, payload.input);
  }
  for (const content of [undefined, null, '', []]) {
    assert.equal(adaptResponsesRequest({ ...base, input: [{ role: 'assistant', content, tool_calls: [call] }] }).input.length, 1);
  }
});

test('validates instructions before lifting and reports indexed strict root errors', () => {
  for (const instructions of [42, true, [], {}]) {
    assert.throws(() => adaptResponsesRequest({ ...base, instructions, input: [{ role: 'system', content: 'lifted' }] }), { param: 'instructions' });
    assert.throws(() => adaptChatRequest({ model: base.model, instructions, messages: [{ role: 'user', content: 'user' }] }), { param: 'instructions' });
  }
  for (const parameters of [undefined, null, true, 7, 'schema', [], { type: 'string' }]) {
    const fn = { type: 'function', name: 'lookup', strict: true, parameters };
    assert.throws(() => adaptResponsesRequest({ ...base, tools: [{ type: 'web_search' }, fn] }),
      { code: 'invalid_function_parameters', param: 'tools.1.parameters' });
    assert.throws(() => adaptResponsesRequest({ ...base, tools: [{ type: 'namespace', name: 'ns', description: 'namespace', tools: [fn] }] }),
      { code: 'invalid_function_parameters', param: 'tools.0.tools.0.parameters' });
  }
  assert.throws(() => adaptResponsesRequest({ ...base, input: [{ role: 'tool', tool_call_id: 'call_1' }] }));
});

test('stale and duplicate circuit probes cannot change replacement probe authority', (t) => {
  const store = fixture(t);
  const upstream = store.create({ type: 'compass', projectId: 'synthetic', projectKey: 'synthetic' });
  const scope = { model: 'synthetic', routeClass: 'proxy_http' };
  const now = Date.now();
  for (let index = 0; index < 3; index += 1) {
    store.settleUpstreamAttempt(upstream.id, store.beginUpstreamAttempt(upstream.id, scope, now), { class: 'transient' }, now);
  }
  const old = store.beginUpstreamAttempt(upstream.id, scope, now + 60_000);
  const replacement = store.beginUpstreamAttempt(upstream.id, scope, now + 120_000);
  assert.notEqual(old.circuitGeneration, replacement.circuitGeneration);
  for (const outcome of ['success', 'neutral', 'transient']) {
    store.settleUpstreamAttempt(upstream.id, old, { class: outcome }, now + 120_001);
    assert.equal(Object.values(store.get(upstream.id).circuits)[0].status, 'half_open');
    assert.equal(store.beginUpstreamAttempt(upstream.id, scope, now + 120_002), null);
  }
  store.settleUpstreamAttempt(upstream.id, replacement, { class: 'success' }, now + 120_003);
  store.settleUpstreamAttempt(upstream.id, replacement, { class: 'transient' }, now + 120_004);
  assert.equal(Object.values(store.get(upstream.id).circuits)[0].status, 'closed');
  const success = store.beginUpstreamAttempt(upstream.id, scope, now + 120_005);
  const failure = store.beginUpstreamAttempt(upstream.id, scope, now + 120_005);
  store.settleUpstreamAttempt(upstream.id, success, { class: 'success' }, now + 120_006);
  store.settleUpstreamAttempt(upstream.id, failure, { class: 'transient' }, now + 120_007);
  assert.equal(Object.values(store.get(upstream.id).circuits)[0].failures, 1);
  for (let index = 0; index < 2; index += 1) {
    store.settleUpstreamAttempt(upstream.id, store.beginUpstreamAttempt(upstream.id, scope, now + 120_008), { class: 'transient' }, now + 120_008);
  }
  const neutral = store.beginUpstreamAttempt(upstream.id, scope, now + 180_008);
  store.settleUpstreamAttempt(upstream.id, neutral, { class: 'neutral' }, now + 180_009);
  const next = store.beginUpstreamAttempt(upstream.id, scope, now + 180_010);
  store.settleUpstreamAttempt(upstream.id, neutral, { class: 'transient' }, now + 180_011);
  assert.equal(Object.values(store.get(upstream.id).circuits)[0].generation, next.circuitGeneration);
  assert.equal(Object.values(store.get(upstream.id).circuits)[0].status, 'half_open');
});

test('evicted circuit rows cannot recycle an old probe generation', (t) => {
  const store = fixture(t);
  const account = store.create({ type: 'compass', projectId: 'synthetic', projectKey: 'synthetic' });
  const now = Date.now();
  const fail = (scope, time) => store.settleUpstreamAttempt(account.id, store.beginUpstreamAttempt(account.id, scope, time), { class: 'transient' }, time);
  const scope = { model: 'original' };
  for (let index = 0; index < 3; index += 1) fail(scope, now);
  const old = store.beginUpstreamAttempt(account.id, scope, now + 60_000);
  store.settleUpstreamAttempt(account.id, old, { class: 'success' }, now + 60_001);
  for (let index = 0; index < 101; index += 1) fail({ model: `other-${index}` }, now + 60_002 + index);
  const before = JSON.stringify(store.get(account.id).circuits);
  store.settleUpstreamAttempt(account.id, old, { class: 'transient' }, now + 61_000);
  assert.equal(JSON.stringify(store.get(account.id).circuits), before);
  assert.equal(Object.keys(store.get(account.id).circuits).length, 100);
});

test('native terminal write failure preserves receipts and measured usage without marking success', async (t) => {
  const store = fixture(t);
  const account = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(account.id, { capDollars: 100 });
  const done = { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'synthetic' } };
  const terminal = { type: 'response.completed', response: { id: 'resp_failed_write', output: [done.item],
    usage: { input_tokens: 1, output_tokens: 1, price_cost_usd: 0.1 } } };
  const req = new EventEmitter();
  Object.assign(req, { headers: { authorization: 'Bearer key', 'thread-id': 'synthetic-thread' },
    proxyAuth: { scopeId: 'default', id: 'synthetic-key' } });
  const res = new EventEmitter();
  const wires = [];
  Object.assign(res, { writeHead() {}, writableEnded: false, destroyed: false,
    write(wire, callback) {
      if (wire.includes('event: response.completed')) {
        this.destroyed = true;
        this.emit('close');
        callback(new Error('Synthetic delivery failure'));
      } else { wires.push(wire); callback(); }
      return true;
    }, end() { this.writableEnded = true; } });
  const payload = { ...base, input: [{ role: 'user', content: 'synthetic' }], stream: true, client_metadata: {
    'x-codex-turn-metadata': { turn_id: 'synthetic-turn', request_kind: 'turn', agent_name: '/root' }
  } };
  const preamble = { type: 'response.created', response: { id: 'resp_failed_write' } };
  const barriers = [];
  store.setDurabilityBarrier(async () => barriers.push(structuredClone(Object.values(store.load().nativeTurnReceipts)[0])));
  await proxyRequest({ req, res, path: '/backend-api/codex/responses', payload, store, apiKey: 'key',
    fetchImpl: async () => new Response(sse(preamble) + sse(done) + sse(terminal), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(wires.join(''), sse(preamble) + sse(done));
  assert.equal(store.get(account.id).spending.spentCredits, 2.5);
  const receipt = Object.values(store.load().nativeTurnReceipts)[0];
  assert.equal(receipt.status, 'interrupted');
  assert.equal(receipt.pendingWrite, true);
  assert.equal(receipt.poisoned, false);
  assert.equal(receipt.items.length, 1);
  assert.ok(barriers.some((receipt) => receipt.pendingWrite));
  assert.ok(barriers.some((receipt) => !receipt.pendingWrite && receipt.items.length === 1));
});

test('routing profiles are deterministic, scoped and preserve hard eligibility and priority', (t) => {
  const store = fixture(t);
  const accounts = Array.from({ length: 8 }, (_, index) => {
    const account = store.create({ type: 'compass', projectId: `synthetic-${index}`, projectKey: 'synthetic' });
    store.setCap(account.id, { capDollars: 100 });
    return account;
  });
  const ids = (options) => store.candidatePlan({ preferredType: 'compass', ...options }).map(({ id }) => id);
  const options = { strategy: 'cache-locality', requestSeed: 'request', promptCacheKey: 'cache', apiKeyId: 'key' };
  const order = ids(options);
  assert.deepEqual(ids({ ...options, requestSeed: 'other-request' }), order);
  assert.ok(Array.from({ length: 20 }, (_, index) => ids({ ...options, apiKeyId: `key-${index}` }).join()).some((value) => value !== order.join()));
  const rotation = { ...options, strategy: 'deterministic-rotation' };
  assert.deepEqual(ids(rotation), ids({ ...rotation, promptCacheKey: 'other-cache' }));
  store.setRoutingPolicy({ strategy: 'cache-locality' });
  assert.equal(store.routingPolicy().strategy, 'cache-locality');
  store.setPriorityList([accounts[7].id]);
  assert.equal(ids(options)[0], accounts[7].id);
  assert.equal(ids({ ...options, affinityId: accounts[3].id })[0], accounts[3].id);
  assert.deepEqual(ids({ ...options, pinnedId: accounts[2].id }), [accounts[2].id]);
  store.setPriorityList([]);
  const memberRemoved = order[3];
  store.setCap(memberRemoved, { capDollars: 0 });
  assert.deepEqual(ids(options), order.filter((id) => id !== memberRemoved));
  assert.ok(Array.from({ length: 20 }, (_, index) => ids({ ...rotation, requestSeed: `seed-${index}` }).join()).some((value) => value !== ids(rotation).join()));
  store.setCap(accounts[7].id, { capDollars: 0 });
  assert.equal(ids(options).includes(accounts[7].id), false);
  const snapshot = JSON.stringify(store.load());
  store.routingDryRun(options);
  assert.equal(JSON.stringify(store.load()), snapshot);
  assert.doesNotMatch(snapshot, /other-cache|other-request/);
});

test('native SSE exact bounds and fragmented CRLF preserve wire and terminal observation', () => {
  const prefix = 'event: response.output_text.delta\ndata: ';
  const ordinary = prefix + 'x'.repeat(NATIVE_SSE_EVENT_BYTES - Buffer.byteLength(prefix));
  const state = createNativeSseState();
  assert.deepEqual(consumeNativeSse(state, ordinary + '\r'), []);
  assert.deepEqual(consumeNativeSse(state, '\n\r'), []);
  const parts = consumeNativeSse(state, '\n');
  assert.equal(parts[0].kind, 'block');
  assert.equal(parts[0].wire, ordinary + '\r\n\r\n');
  const terminalPrefix = 'event: response.completed\ndata: ';
  const oversized = terminalPrefix + 'x'.repeat(NATIVE_SSE_TERMINAL_BYTES + 1 - terminalPrefix.length);
  const overflow = createNativeSseState();
  const wires = [];
  for (let start = 0; start < oversized.length; start += 1024 * 1024) {
    wires.push(...consumeNativeSse(overflow, oversized.slice(start, start + 1024 * 1024)));
    assert.ok(overflow.bytes <= NATIVE_SSE_TERMINAL_BYTES);
  }
  const terminal = sse({ type: 'response.completed', response: { output: [] } }).replace(/\n/g, '\r\n');
  wires.push(...consumeNativeSse(overflow, `\r\n\r\n${terminal}`));
  assert.equal(wires.filter(({ kind }) => kind === 'block').length, 1);
  assert.equal(wires.map(({ wire }) => wire).join(''), oversized + '\r\n\r\n' + terminal);
});

test('native initial inspection honors terminal order and cumulative preamble admission', async () => {
  const terminal = sse({ type: 'response.completed', response: { output: [] } });
  const bigPreamble = sse({ type: 'response.created', padding: 'x'.repeat(NATIVE_SSE_EVENT_BYTES) });
  const headers = { 'content-type': 'text/event-stream' };
  const ordered = await inspectInitialSseEvent(new Response(terminal + bigPreamble, { headers }), {}, null, { native: true });
  assert.equal(ordered.firstEvent.type, 'response.completed');
  await ordered.response.body.cancel();
  const half = sse({ type: 'response.created', padding: 'x'.repeat(NATIVE_SSE_EVENT_BYTES / 2) });
  const cumulative = await inspectInitialSseEvent(new Response(half + half + sse({ type: 'response.failed',
    response: { error: { code: 'rate_limit_exceeded' } } }), { headers }), {}, null, { native: true });
  assert.equal(cumulative.retryable, false);
  assert.match(await cumulative.response.text(), /native_preamble_limit_exceeded/);
});

test('HTTP routing dry-run forwards seeds and live requests use cache-locality ordering', async (t) => {
  const store = fixture(t);
  for (let index = 0; index < 4; index += 1) {
    const account = store.create({ type: 'codex', accessToken: `synthetic-${index}` });
    store.setCap(account.id, { capDollars: 100 });
  }
  store.setRoutingPolicy({ strategy: 'cache-locality' });
  const planned = [];
  const candidatePlanDetails = store.candidatePlanDetails.bind(store);
  store.candidatePlanDetails = (options) => {
    planned.push(options);
    return candidatePlanDetails(options);
  };
  const calls = [];
  const server = createServer(createApp({ store, apiKey: 'key', fetchImpl: async (_url, options) => {
    calls.push(options.headers.authorization);
    return new Response(JSON.stringify({ id: 'resp_test', output: [] }), { headers: { 'content-type': 'application/json' } });
  } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const post = (path, body, extra = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { authorization: 'Bearer key', 'content-type': 'application/json', ...extra }, body: JSON.stringify(body)
  });
  const dry = await post('/api/routing/dry-run', { strategy: 'cache-locality', requestSeed: 'request',
    promptCacheKey: 'cache', apiKeyId: 'synthetic-key' });
  assert.equal(dry.status, 200);
  await dry.json();
  assert.equal(planned.at(-1).promptCacheKey, 'cache');
  assert.equal(planned.at(-1).apiKeyId, 'synthetic-key');
  for (const seed of ['one', 'two']) {
    const response = await post('/v1/responses', { ...base, prompt_cache_key: 'same-cache' }, { 'x-client-request-id': seed });
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(planned.at(-1).requestSeed, seed);
  }
  assert.equal(calls[0], calls[1]);
});

test('public WebSocket validates before dispatch and gives independent turns fresh routing seeds', async (t) => {
  const store = fixture(t);
  const account = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(account.id, { capDollars: 100 });
  const plans = [];
  const candidatePlanDetails = store.candidatePlanDetails.bind(store);
  store.candidatePlanDetails = (options) => { plans.push(options); return candidatePlanDetails(options); };
  const frames = [];
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => socket.on('message', (data) => {
    frames.push(JSON.parse(data));
    socket.send(JSON.stringify({ type: 'response.completed', response: { id: `resp_${frames.length}`, output: [] } }));
  }));
  await new Promise((resolve) => target.once('listening', resolve));
  const fetchImpl = async () => new Response('{}');
  const server = createServer(createApp({ store, apiKey: 'key', fetchImpl }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'key', fetchImpl,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}` });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/responses`, { headers: { authorization: 'Bearer key' } });
  t.after(async () => {
    socket.terminate();
    relay.close();
    for (const client of target.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  });
  await new Promise((resolve) => socket.once('open', resolve));
  const turn = async (payload) => {
    const message = new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data))));
    socket.send(JSON.stringify({ type: 'response.create', ...payload }));
    return message;
  };
  const invalid = await turn({ ...base, instructions: 42 });
  assert.equal(invalid.error.param, 'instructions');
  assert.equal(frames.length, 0);
  const replay = { ...base, input: [{ role: 'assistant', content: 'assistant', tool_calls: [call] }] };
  await turn(replay);
  const firstSeed = plans.at(-1).requestSeed;
  await turn(replay);
  assert.notEqual(plans.at(-1).requestSeed, firstSeed);
  assert.deepEqual(frames[0].input.map(({ type }) => type), ['message', 'function_call']);
});

test('native SSE observes large terminals and discards oversized event suffixes', () => {
  const state = createNativeSseState();
  const ordinary = `event: response.output_text.delta\ndata: ${'x'.repeat(NATIVE_SSE_EVENT_BYTES + 1)}`;
  const first = consumeNativeSse(state, ordinary);
  assert.equal(first[0].kind, 'raw');
  assert.equal(state.buffer, '');
  const terminal = sse({ type: 'response.completed', response: { output: [], padding: 'x'.repeat(NATIVE_SSE_EVENT_BYTES + 1) } });
  const rest = consumeNativeSse(state, `suffix\r\n\r\n${terminal.replace(/\n/g, '\r\n')}`);
  assert.deepEqual(rest.map(({ kind }) => kind), ['raw', 'block']);
  assert.equal(JSON.parse(rest[1].block.split('\ndata: ')[1]).type, 'response.completed');
  const eof = createNativeSseState();
  consumeNativeSse(eof, terminal.slice(0, -2));
  assert.equal(consumeNativeSse(eof, '', { eof: true })[0].kind, 'block');
  const preamble = consumeNativeSse(createNativeSseState(), `event: response.created\ndata: ${'x'.repeat(NATIVE_SSE_EVENT_BYTES + 1)}`);
  assert.equal(preamble[0].kind, 'preamble_overflow');
});

test('native SSE first-event inspection recognizes a large terminal without relaxing public limits', async () => {
  const terminal = sse({ type: 'response.completed', response: { output: [], padding: 'x'.repeat(NATIVE_SSE_EVENT_BYTES + 1) } });
  const response = () => new Response(terminal, { headers: { 'content-type': 'text/event-stream' } });
  const native = await inspectInitialSseEvent(response(), {}, null, { native: true });
  assert.equal(native.firstEvent.type, 'response.completed');
  assert.equal(await native.response.text(), terminal);
  const publicResult = await inspectInitialSseEvent(response());
  assert.match(await publicResult.response.text(), /response.failed|error/);
});

test('native HTTP relays oversized ordinary events and settles a large terminal', async (t) => {
  const store = fixture(t);
  const account = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(account.id, { capDollars: 100 });
  const ordinary = sse({ type: 'response.output_text.delta', delta: 'x'.repeat(NATIVE_SSE_EVENT_BYTES + 1) });
  const terminal = sse({ type: 'response.completed', response: { id: 'resp_large', output: [], padding: 'x'.repeat(NATIVE_SSE_EVENT_BYTES + 1),
    usage: { input_tokens: 1, output_tokens: 1, price_cost_usd: 0.1 } } });
  const server = createServer(createApp({ store, apiKey: 'key', fetchImpl: async () =>
    new Response(ordinary + terminal, { headers: { 'content-type': 'text/event-stream' } }) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/backend-api/codex/responses`, {
    method: 'POST', headers: { authorization: 'Bearer key', 'content-type': 'application/json' }, body: JSON.stringify({ ...base, stream: true })
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), ordinary + terminal);
  assert.equal(store.get(account.id).spending.spentCredits, 2.5);
});
