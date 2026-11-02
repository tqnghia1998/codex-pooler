import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { attachWebSocketProxy } from '../src/proxy.js';
import { nativeWebSocketRetryAfter, normalizeNativeRetryAfter, portableNativeHistory } from '../src/native-websocket-policy.js';
import { STATIC_MODEL_CATALOG } from '../src/domain.js';
import { priceUsage } from '../src/pricing.js';
import { OPENAI_PRICE_ROWS } from '../src/openai-pricing-snapshot.js';

const call = (name = 'spawn_agent') => ({ type: 'function_call', namespace: 'collaboration', name, status: 'completed', call_id: 'call_replay', arguments: '{}', encrypted_content: 'synthetic-ciphertext' });
const history = (item = call()) => ({ type: 'response.create', model: 'gpt-6.1-sol', input: [
  { type: 'message', role: 'user', content: 'original question' }, item,
  { type: 'function_call_output', call_id: 'call_replay', output: 'client-authored result' },
  { type: 'message', role: 'user', content: 'continue' }
] });
const quotaError = (extra = {}) => ({ type: 'error', status: 429, error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'synthetic refusal' }, ...extra });

async function fixture(t, handler, headers = {}) {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 3) });
  const upstreams = [0, 1].map(i => { const u = store.create({ type: 'codex', accessToken: `synthetic-${i}`, accountId: `synthetic-${i}` }); store.setCap(u.id, { capDollars: 100 }); return u; });
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const requests = [];
  let connections = 0;
  target.on('connection', socket => { const connection = ++connections; socket.on('message', bytes => {
    const payload = JSON.parse(bytes); requests.push({ connection, payload }); handler(socket, payload, connection);
  }); });
  await new Promise(resolve => target.once('listening', resolve));
  const selected = [];
  const fetchImpl = async () => new Response('{}');
  const server = createServer(createApp({ store, apiKey: 'ports-key', fetchImpl }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'ports-key', fetchImpl, websocketUrl: upstream => {
    selected.push(upstream.id); return `ws://127.0.0.1:${target.address().port}`;
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/backend-api/codex/responses`, { headers: { authorization: 'Bearer ports-key', ...(typeof headers === 'function' ? headers(upstreams) : headers) } });
  const messages = [];
  const waiters = [];
  client.on('message', bytes => { const event = JSON.parse(bytes); messages.push(event); for (const w of [...waiters]) if (w.predicate(event)) w.resolve(event); });
  const waitFor = predicate => new Promise((resolve, reject) => {
    const w = { predicate, resolve: event => { clearTimeout(timer); waiters.splice(waiters.indexOf(w), 1); resolve(event); } };
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`Missing frame: ${JSON.stringify(messages)}`)); }, 3000);
    waiters.push(w);
  });
  t.after(async () => { client.terminate(); relay.close(); for (const s of relay.clients) s.terminate(); for (const s of target.clients) s.terminate(); await new Promise(r => server.close(r)); await new Promise(r => target.close(r)); store.sqlite.close(); });
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  return { store, upstreams, client, requests, selected, messages, waitFor, send: payload => client.send(JSON.stringify(payload)) };
}

test('native retry hints accept only bounded integer seconds or canonical HTTP dates', () => {
  for (const [input, expected] of [[' 0017 ', '17'], [0, '0'], ['18446744073709551615', '18446744073709551615'], ['Wed, 21 Oct 2015 07:28:00 GMT', 'Wed, 21 Oct 2015 07:28:00 GMT']]) assert.equal(normalizeNativeRetryAfter(input), expected);
  for (const bad of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, true, {}, [], '18446744073709551616', '1.5', '+1', '\t17', '17\r\nsecret: value', '17\u007f', 'x'.repeat(129), '2026-11-01', 'Mon, 21 Oct 2015 07:28:00 GMT']) assert.equal(normalizeNativeRetryAfter(bad), null);
  assert.equal(nativeWebSocketRetryAfter(quotaError({ headers: { 'Retry-After': '19' }, error: { headers: { 'Retry-After': 'broken' } } })), '19');
  assert.equal(nativeWebSocketRetryAfter({ type: 'response.created', status: 429, headers: { 'retry-after': '5' } }), null);
});

for (const type of ['error', 'response.failed', 'response.incomplete']) {
  test(`native ${type} retains only admitted retry advice and uses it for cooldown`, { timeout: 5000 }, async t => {
    const error = { code: 'rate_limit_exceeded', type: 'rate_limit_error', headers: { 'Retry-After': 'broken', 'x-private': 'synthetic-private' } };
    const event = { type, status_code: 429, headers: { 'Retry-After': '17', 'x-private': 'synthetic-private' }, ...(type === 'error' ? { error } : { response: { error, headers: { 'x-private': 'synthetic-private' } } }) };
    const f = await fixture(t, socket => socket.send(JSON.stringify(event)));
    const received = f.waitFor(e => e.type === type); f.send(history()); const frame = await received;
    assert.equal(frame.headers['retry-after'], '17');
    assert.deepEqual((frame.error || frame.response.error).headers, { 'retry-after': '17' });
    assert.doesNotMatch(JSON.stringify(frame), /synthetic-private|Retry-After/);
    assert.equal(f.store.get(f.selected[0]).health.cooldownSource, 'retry-after');
  });
}

test('nested retry advice wins and invalid/nonterminal hints and nested headers are removed', { timeout: 5000 }, async t => {
  const events = [
    { type: 'response.created', headers: { 'retry-after': '3' }, response: { id: 'resp_test', error: { headers: { 'retry-after': '4', private: 'secret' } } } },
    quotaError({ headers: { 'retry-after': '19' }, error: { type: 'rate_limit_error', headers: { 'retry-after': 7, private: 'secret' } } })
  ];
  const f = await fixture(t, socket => events.forEach(e => socket.send(JSON.stringify(e))));
  const received = f.waitFor(e => e.type === 'error'); f.send(history()); const frame = await received;
  assert.equal(frame.headers['retry-after'], '7');
  assert.equal(f.messages.find(e => e.type === 'response.created').headers['retry-after'], undefined);
  assert.doesNotMatch(JSON.stringify(f.messages), /secret/);
});

for (const lite of [false, true]) for (const name of ['spawn_agent', 'send_message', 'followup_task']) {
  test(`completed ${name} full history moves off exhausted native account (${lite ? 'Lite' : 'Full'})`, { timeout: 5000 }, async t => {
    const f = await fixture(t, (socket, payload, connection) => socket.send(JSON.stringify(connection === 1 ? quotaError() : { type: 'response.completed', response: { id: 'resp_recovered', status: 'completed', output: [] } })), lite ? { 'x-openai-internal-codex-responses-lite': 'true' } : {});
    let received = f.waitFor(e => e.type === 'error'); f.send(history()); await received;
    const replay = history(call(name));
    received = f.waitFor(e => e.type === 'response.completed' || e.type === 'error'); f.send(replay); const frame = await received;
    assert.equal(frame.type, 'response.completed');
    assert.equal(new Set(f.selected).size, 2);
    assert.deepEqual(f.requests.at(-1).payload.input, replay.input);
    assert.equal(f.requests.length, 2);
    assert.ok(f.store.get(f.selected[1]).lastSuccessfulAt);
  });
}

test('portable history retains nested ownership and incomplete collaboration fences', () => {
  assert.equal(portableNativeHistory(history()), true);
  for (const item of [
    { ...call(), status: 'in_progress' }, { ...call(), namespace: 'other' }, { ...call(), name: 'unknown' }, { ...call(), call_id: '' }, { ...call(), arguments: {} },
    { ...call(), extra: { file_id: 'file_owner' } }, { ...call(), extra: { type: 'item_reference', id: 'msg_owner' } },
    { ...call(), extra: { encrypted_content: 'nested-cipher' } }, { ...call(), extra: { previous_response_id: 'resp_owner' } },
    { type: 'compaction_trigger' }
  ]) assert.equal(portableNativeHistory(history(item)), false, JSON.stringify(item));
  assert.equal(portableNativeHistory({ ...history(), previous_response_id: 'resp_owner' }), false);
  assert.equal(portableNativeHistory({ ...history(), conversation: { id: 'owner' } }), false);
  assert.equal(portableNativeHistory(history({ type: 'compaction', encrypted_content: 'portable', extra: { file_id: 'owned' } })), false);
  assert.equal(portableNativeHistory(history({ type: 'compaction', encrypted_content: 'portable' })), true);
});

for (const constraint of ['anchor', 'nested', 'explicit']) {
  test(`native ${constraint} ownership prevents account failover`, { timeout: 5000 }, async t => {
    const f = await fixture(t, socket => socket.send(JSON.stringify(quotaError())), constraint === 'explicit' ? upstreams => ({ 'x-upstream-id': upstreams[0].id }) : {});
    let received = f.waitFor(e => e.type === 'error'); f.send(history()); await received;
    const payload = constraint === 'anchor' ? { ...history(), previous_response_id: 'resp_owned' } : constraint === 'nested' ? history({ ...call(), extra: { file_id: 'file_owned' } }) : history();
    received = f.waitFor(e => e.type === 'error'); f.send(payload); const frame = await received;
    assert.equal(frame.code, 'upstream_unavailable'); assert.equal(f.selected.length, 1); assert.equal(f.requests.length, 1);
  });
}

test('reviewed models are advertised and settle standard/context/cached usage at reviewed prices', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  for (const model of ['gpt-6.1-terra', 'gpt-6-astra-law', 'gpt-6-rosalind']) {
    assert.ok(STATIC_MODEL_CATALOG.some(({ id }) => id === model));
    assert.ok(priceUsage(model, usage));
  }
  assert.equal(priceUsage('gpt-6-astra-law', usage).settledCostMicros, 10_000_000);
  assert.equal(priceUsage('gpt-6-rosalind', usage).settledCostMicros, 30_000_000);
  assert.equal(priceUsage('gpt-6-rosalind', { ...usage, inputTokens: 272_000 }).settledCostMicros, 4_080_000);
  assert.equal(priceUsage('gpt-6-astra-law', { ...usage, cachedInputTokens: 1_000_000 }).settledCostMicros, 1_000_000);
  assert.ok(OPENAI_PRICE_ROWS.some(r => r.model === 'gpt-6.1-terra' && r.tier === 'priority'));
  assert.equal(OPENAI_PRICE_ROWS.some(r => ['gpt-6-astra-law', 'gpt-6-rosalind'].includes(r.model) && r.tier !== 'standard'), false);
});

test('native frames queued during relocation receive a terminal or an explicit refusal', { timeout: 5000 }, async t => {
  const f = await fixture(t, (socket, _payload, connection) => socket.send(JSON.stringify(connection === 1 ? quotaError() : {
    type: 'response.completed', response: { id: 'resp_queued', status: 'completed', output: [] }
  })));
  let received = f.waitFor(e => e.type === 'error'); f.send(history()); await received;
  f.messages.length = 0;
  received = f.waitFor(() => f.messages.filter(e => ['error', 'response.completed'].includes(e.type)).length >= 2);
  f.send(history()); f.send(history()); await received;
  assert.equal(new Set(f.selected).size, 2);
  assert.ok(f.messages.some(e => e.type === 'response.completed'));
  assert.equal(f.messages.filter(e => ['error', 'response.completed'].includes(e.type)).length, 2);
});
