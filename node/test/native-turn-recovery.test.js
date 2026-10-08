import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { beginNativeTurn, finishNativeTurn, nativeEventWritten, nativeWriteStarted, nativeTurnIdentity, NATIVE_RECOVERY_WINDOW_MS } from '../src/native-turn-recovery.js';

const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'private reasoning' };
const commentary = { type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'private commentary', annotations: [] }], status: 'completed' };
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' };
const result = { type: 'function_call_output', call_id: 'call_1', output: 'private tool output' };
const mail = { type: 'agent_message', author: '/root/worker', recipient: '/root', content: [{ type: 'input_text', text: 'private mail' }] };

function fixture(t) {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 7) });
  t.after(() => store.sqlite.close());
  const upstream = store.get(store.create({ type: 'codex', accessToken: 'token' }).id);
  const req = { headers: { 'thread-id': 'thread-1' }, proxyAuth: { scopeId: 'default', id: 'key-1' } };
  const payload = { model: 'gpt-6-sol', instructions: 'private instructions', input: [{ type: 'message', role: 'user', content: 'private prompt' }], client_metadata: { 'x-codex-turn-metadata': { turn_id: 'turn-1', request_kind: 'turn', agent_name: '/root' } } };
  const identity = (body = payload, request = req) => nativeTurnIdentity(store, request, body);
  const start = (body = payload) => beginNativeTurn(store, identity(body), body, upstream);
  const append = (...items) => ({ ...payload, input: [...payload.input, ...items] });
  const delivered = (lease, item) => { nativeWriteStarted(lease); nativeEventWritten(lease, { type: 'response.output_item.done', item }); };
  return { store, req, payload, upstream, identity, start, append, delivered };
}

test('recovers a serialized partial-answer mailbox prefix but never a final answer', (t) => {
  for (const phase of ['partial_answer', 'final_answer']) {
    const f = fixture(t);
    const item = { ...commentary, phase };
    const lease = f.start();
    f.delivered(lease, item);
    finishNativeTurn(lease);
    const serialized = { ...item, content: item.content.map(({ annotations, ...part }) => part) };
    delete serialized.status;
    if (phase === 'partial_answer') finishNativeTurn(f.start(f.append(serialized, mail)));
    else assert.throws(() => f.start(f.append(serialized, mail)), { code: 'duplicate_turn' });
  }
});

test('fences active and completed duplicates, admits proven exact cuts without completed items', (t) => {
  const f = fixture(t);
  let lease = f.start();
  assert.throws(f.start, { code: 'duplicate_turn' });
  nativeWriteStarted(lease);
  nativeEventWritten(lease, { type: 'response.output_text.delta', delta: 'partial' });
  finishNativeTurn(lease);
  lease = f.start();
  nativeWriteStarted(lease);
  nativeEventWritten(lease, { type: 'response.completed', response: { status: 'completed' } });
  assert.throws(f.start, { code: 'duplicate_turn' });
});

test('recovers exact completed output prefixes and mailbox chains after session affinity disappears', (t) => {
  const f = fixture(t);
  let lease = f.start();
  f.delivered(lease, reasoning);
  finishNativeTurn(lease);
  const next = f.append(reasoning, mail);
  lease = f.start(next);
  f.delivered(lease, commentary);
  finishNativeTurn(lease);
  const serialized = { ...commentary, content: [{ type: 'output_text', text: 'private commentary' }] };
  delete serialized.status;
  const third = { ...next, input: [...next.input, serialized, mail] };
  lease = f.start(third);
  finishNativeTurn(lease);
  assert.ok(f.store.nativeTurnReceipt(f.identity(third).key));
  const rows = JSON.stringify(f.store.sqlite.prepare('SELECT value FROM records WHERE collection = ?').all('nativeTurnReceipts'));
  for (const secret of ['private prompt', 'private mail', 'private reasoning', 'private commentary', 'private instructions', 'thread-1', 'turn-1', 'key-1']) assert.equal(rows.includes(secret), false);
});

test('binds output order, request options, account, credential epoch, mailbox recipient and current history', (t) => {
  const f = fixture(t);
  const lease = f.start();
  f.delivered(lease, reasoning);
  f.delivered(lease, commentary);
  finishNativeTurn(lease);
  const good = f.append(reasoning, commentary, mail);
  for (const invalid of [
    { ...good, instructions: 'changed' },
    f.append(commentary, reasoning, mail),
    f.append({ ...reasoning, encrypted_content: 'changed' }, commentary, mail),
    f.append(reasoning, commentary, { ...mail, recipient: '/root/other' }),
    f.append(reasoning, commentary, { type: 'message', role: 'user', content: 'new boundary' }, mail),
    f.append(reasoning, commentary, mail, reasoning)
  ]) assert.throws(() => f.start(invalid), { code: 'duplicate_turn' });
  assert.throws(() => beginNativeTurn(f.store, f.identity(good), good, { ...f.upstream, nativeRecoveryEpoch: 2 }), { code: 'duplicate_turn' });
  assert.throws(() => beginNativeTurn(f.store, f.identity(good), good, { ...f.upstream, id: 'other' }), { code: 'duplicate_turn' });
  assert.notEqual(f.identity(good, { ...f.req, proxyAuth: { scopeId: 'default', id: 'another-key' } }).key, f.identity(good).key);
  assert.notEqual(f.identity(good, { ...f.req, headers: { 'thread-id': 'another-thread' } }).key, f.identity(good).key);
  finishNativeTurn(f.start(good));
});

test('proves drained tool calls before incoming mail with typed ordered unique results', (t) => {
  const f = fixture(t);
  const lease = f.start();
  f.delivered(lease, call);
  f.delivered(lease, reasoning);
  finishNativeTurn(lease);
  for (const invalid of [
    f.append(call, reasoning, mail),
    f.append(call, reasoning, { ...result, call_id: 'other' }, mail),
    f.append(call, reasoning, { ...result, type: 'custom_tool_call_output' }, mail),
    f.append(call, reasoning, { ...result, name: 'foreign' }, mail),
    f.append(call, reasoning, result, result, mail)
  ]) assert.throws(() => f.start(invalid), { code: 'duplicate_turn' });
  finishNativeTurn(f.start(f.append(call, reasoning, result, mail)));
});

test('permits ordinary tool rounds after successful output without permitting replay', (t) => {
  const f = fixture(t);
  const lease = f.start();
  f.delivered(lease, call);
  finishNativeTurn(lease, 'succeeded');
  assert.throws(f.start, { code: 'duplicate_turn' });
  const next = f.start(f.append(call, result));
  finishNativeTurn(next, 'succeeded');
  assert.throws(() => f.start(f.append(call, result)), { code: 'duplicate_turn' });
});

test('fails closed on ambiguous writes, partial tools, poisoned output and expired recovery evidence', (t) => {
  for (const prepare of [
    (f, lease) => nativeWriteStarted(lease),
    (f, lease) => { nativeWriteStarted(lease); nativeEventWritten(lease, { type: 'response.function_call_arguments.delta', delta: '{}' }); },
    (f, lease) => { nativeWriteStarted(lease); nativeEventWritten(lease, { type: 'future.event' }); },
    (f, lease) => { for (let index = 0; index < 5; index++) f.delivered(lease, reasoning); }
  ]) {
    const f = fixture(t);
    const lease = f.start(); prepare(f, lease); finishNativeTurn(lease);
    assert.throws(f.start, { code: 'duplicate_turn' });
  }
  const f = fixture(t);
  const lease = f.start(); finishNativeTurn(lease);
  const receipt = f.store.nativeTurnReceipt(f.identity().key);
  f.store.saveNativeTurnReceipt(receipt.key, { ...receipt, updatedAt: new Date(Date.now() - NATIVE_RECOVERY_WINDOW_MS - 1).toISOString() });
  assert.throws(f.start, { code: 'duplicate_turn' });
});

test('recovers a proven ended process generation and rejects conflicting metadata', (t) => {
  const f = fixture(t);
  const lease = f.start(); f.delivered(lease, reasoning); finishNativeTurn(lease);
  const receipt = f.store.nativeTurnReceipt(f.identity().key);
  f.store.saveNativeTurnReceipt(receipt.key, { ...receipt, status: 'in_progress', owner: 'ended-process' });
  finishNativeTurn(f.start(f.append(reasoning, mail)));
  const header = { ...f.req, headers: { ...f.req.headers, 'x-codex-turn-metadata': JSON.stringify({ turn_id: 'different' }) } };
  assert.throws(() => f.identity(f.payload, header), { code: 'invalid_turn_metadata' });
  const headerOnly = { ...f.req, headers: { ...f.req.headers, 'x-codex-turn-metadata': JSON.stringify(f.payload.client_metadata['x-codex-turn-metadata']) } };
  assert.equal(f.identity({ ...f.payload, client_metadata: undefined }, headerOnly).key, f.identity().key);
});

test('an unfinished tool after completed reasoning cannot authorize a grown or mailbox retry', (t) => {
  const f = fixture(t);
  const lease = f.start();
  f.delivered(lease, reasoning);
  nativeWriteStarted(lease);
  nativeEventWritten(lease, { type: 'response.output_item.added', item: call });
  finishNativeTurn(lease);
  assert.throws(() => f.start(f.append(reasoning)), { code: 'duplicate_turn' });
  assert.throws(() => f.start(f.append(reasoning, mail)), { code: 'duplicate_turn' });
});
