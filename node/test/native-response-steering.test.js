import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { NativeResponseSteering } from '../src/native-response-steering.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { attachWebSocketProxy } from '../src/proxy.js';
import { codexGatewayOptions } from '../src/codex-compatibility.js';

const opener = { type: 'response.create', model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'private prompt' }] };
const created = (id) => ({ type: 'response.created', response: { id, status: 'in_progress' } });
const terminal = (id, cost = 0.1, type = 'response.completed') => ({
  type, response: { id, status: type === 'response.incomplete' ? 'incomplete' : 'completed',
    ...(type === 'response.incomplete' ? { incomplete_details: { reason: 'steered' } } : {}),
    output: [], usage: { input_tokens: 10, output_tokens: 2, price_cost_usd: cost } }
});
const steer = { type: 'response.steer', previous_response_id: 'resp_original', input: [{ role: 'user', content: 'private steer' }] };
const accepted = { type: 'response.steer.accepted', steer: { previous_response_id: 'resp_original', id: 'steer_private' } };

function fixture(t, share = false) {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 7) });
  const upstream = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(upstream.id, { capDollars: 100 });
  const key = store.configureApiKey('steering-key');
  const calls = { reserves: [], releases: [], settlements: [], pins: [] };
  const req = { url: '/backend-api/codex/responses', headers: { 'thread-id': 'thread-synthetic' },
    proxyAuth: share ? { kind: 'share_session', shareSessionId: 'share_1', scopeId: 'default', upstreamId: upstream.id } : key,
    sharingStore: {
      reserveSession: (_session, id) => { calls.reserves.push(id); return true; },
      releaseReservation: (id) => { calls.releases.push(id); return true; }
    } };
  let denied = false;
  const lane = new NativeResponseSteering({
    store, req, authorize: () => denied, admit: () => true,
    settle: (turn) => { calls.settlements.push(turn); },
    pin: (response) => calls.pins.push(response.id)
  });
  t.after(() => { lane.close(); store.sqlite.close(); });
  return { store, upstream: store.get(upstream.id), req, lane, calls, deny: () => { denied = true; } };
}

test('steering successors get independent attempts, reservations and keyed delivery receipts', async (t) => {
  const { store, upstream, lane, calls } = fixture(t, true);
  lane.dispatch(opener, upstream);
  await lane.deliver(lane.event(created('resp_original'), upstream), created('resp_original'), async () => {});
  lane.dispatch(steer, upstream);
  assert.equal(lane.event(accepted, upstream), null);
  const done = terminal('resp_original', 0.1, 'response.incomplete');
  await lane.deliver(lane.event(done, upstream), done, async () => {});
  assert.throws(() => lane.dispatch(opener, upstream), { code: 'duplicate_turn' });
  const next = created('resp_successor');
  const successor = lane.event(next, upstream);
  assert.ok(successor.lease);
  assert.equal(store.nativeTurnReceipt(successor.identity.key).status, 'in_progress');
  await lane.deliver(successor, next, async () => {});
  const final = terminal('resp_successor', 0.2);
  await lane.deliver(lane.event(final, upstream), final, async () => {});
  assert.equal(calls.reserves.length, 2);
  assert.notEqual(calls.reserves[0], calls.reserves[1]);
  assert.equal(calls.settlements.length, 2);
  assert.deepEqual(calls.settlements.map(({ usage }) => usage.upstreamCostMicros), [100000, 200000]);
  assert.equal(store.nativeTurnReceipt(successor.identity.key).status, 'succeeded');
  assert.equal(store.nativeTurnReceipt(successor.identity.key).pendingWrite, false);
  assert.equal(JSON.stringify(store.load().nativeTurnReceipts).includes('private'), false);
  assert.equal(JSON.stringify(store.load().nativeTurnReceipts).includes('resp_successor'), false);
});

test('steer failure is a control refusal and does not terminate or reserve a second request', (t) => {
  const { lane, upstream, calls } = fixture(t, true);
  lane.dispatch(opener, upstream);
  lane.event(created('resp_original'), upstream);
  lane.dispatch({ ...steer, extra_provider_owned: true }, upstream);
  lane.event({ type: 'response.steer.failed', steer: { previous_response_id: 'resp_original' }, error: { code: 'invalid_input', message: 'private provider text' } }, upstream);
  assert.ok(lane.current);
  lane.event(terminal('resp_original'), upstream);
  assert.equal(calls.reserves.length, 1);
  assert.equal(calls.settlements.length, 1);
  assert.throws(() => lane.event(created('resp_unsolicited'), upstream), { code: 'unexpected_native_successor' });
});

test('bounds repeated steering controls and ignores malformed or duplicate acceptances', (t) => {
  const { lane, upstream } = fixture(t);
  lane.dispatch(opener, upstream);
  lane.event(created('resp_original'), upstream);
  assert.throws(() => lane.dispatch({ ...steer, previous_response_id: 'bad' }, upstream), { code: 'invalid_request' });
  for (let index = 0; index < 128; index += 1) lane.dispatch(steer, upstream);
  assert.throws(() => lane.dispatch(steer, upstream), { code: 'steering_queue_full' });
  lane.event({ type: 'response.steer.accepted', steer: { previous_response_id: 'resp_original' } }, upstream);
  assert.equal(lane.accepted, false);
  lane.event(accepted, upstream);
  assert.equal(lane.accepted, true);
  lane.accepted = false;
  lane.event(accepted, upstream);
  assert.equal(lane.accepted, false);
});

test('personal-share successors reserve against the selected key and original session', (t) => {
  const { lane, upstream, req } = fixture(t, true);
  req.proxyAuth = { ...req.proxyAuth, kind: 'personal_share', personalKeyId: 'personal_1' };
  const reservations = [];
  req.sharingStore.reserveSession = (id, attempt, options) => { reservations.push({ id, attempt, options }); return true; };
  lane.dispatch(opener, upstream);
  lane.event(created('resp_original'), upstream);
  lane.dispatch(steer, upstream);
  lane.event(accepted, upstream);
  lane.event(terminal('resp_original'), upstream);
  lane.event(created('resp_successor'), upstream);
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every(({ id, options }) => id === 'share_1' && options.keyId === 'personal_1'));
  assert.notEqual(reservations[0].attempt, reservations[1].attempt);
});

test('late accepted steering admits a successor only while authority and credential generation remain valid', (t) => {
  for (const mode of ['revoked', 'replaced', 'exhausted']) {
    const { lane, upstream, store, calls, deny } = fixture(t, true);
    lane.dispatch(opener, upstream);
    lane.event(created('resp_original'), upstream);
    lane.event(terminal('resp_original'), upstream);
    lane.dispatch(steer, upstream);
    lane.event(accepted, upstream);
    if (mode === 'revoked') deny();
    if (mode === 'replaced') store.update(upstream.id, { accessToken: 'replacement' });
    if (mode === 'exhausted') lane.req.sharingStore.reserveSession = () => false;
    assert.throws(() => lane.event(created('resp_successor'), upstream));
    assert.equal(calls.settlements.length, 1);
    assert.equal(lane.current, null);
  }
});

test('revoked authority cannot submit steering controls while a turn is active', (t) => {
  const { lane, upstream, calls, deny } = fixture(t, true);
  lane.dispatch(opener, upstream);
  lane.event(created('resp_original'), upstream);
  deny();
  assert.throws(() => lane.dispatch(steer, upstream), { code: 'access_denied' });
  assert.equal(lane.pending.size, 0);
  assert.equal(calls.reserves.length, 1);
});

test('delivery durability is fenced before visible bytes and failed writes never mark success', async (t) => {
  const { lane, upstream, store } = fixture(t);
  lane.dispatch(opener, upstream);
  lane.event(created('resp_original'), upstream);
  lane.dispatch(steer, upstream);
  lane.event(accepted, upstream);
  lane.event(terminal('resp_original'), upstream);
  const next = created('resp_successor');
  const turn = lane.event(next, upstream);
  const order = [];
  store.setDurabilityBarrier(async () => { order.push('flush'); });
  await lane.deliver(turn, next, async () => { order.push('write'); });
  assert.deepEqual(order, ['flush', 'write', 'flush']);
  await assert.rejects(lane.deliver(turn, terminal('resp_successor'), async () => { throw new Error('write failed'); }));
  lane.close();
  assert.equal(store.nativeTurnReceipt(turn.identity.key).status, 'interrupted');
  assert.equal(store.nativeTurnReceipt(turn.identity.key).pendingWrite, true);
});

test('failed terminal delivery interrupts its receipt even after the successor is opened', async (t) => {
  const { lane, upstream, store } = fixture(t);
  lane.dispatch(opener, upstream);
  lane.event(created('resp_original'), upstream);
  lane.dispatch(steer, upstream);
  lane.event(accepted, upstream);
  lane.event(terminal('resp_original'), upstream);
  const first = lane.event(created('resp_successor'), upstream);
  lane.dispatch({ ...steer, previous_response_id: 'resp_successor' }, upstream);
  lane.event({ ...accepted, steer: { id: 'steer_second', previous_response_id: 'resp_successor' } }, upstream);
  const done = terminal('resp_successor');
  lane.event(done, upstream);
  lane.event(created('resp_last'), upstream);
  await assert.rejects(lane.deliver(first, done, async () => { throw new Error('downstream closed'); }));
  lane.close();
  assert.equal(store.nativeTurnReceipt(first.identity.key).status, 'interrupted');
  assert.equal(Object.values(store.load().nativeTurnReceipts).every(({ status }) => status === 'interrupted'), true);
});

test('native WebSocket steering stays on its producing socket and settles both turns', { timeout: 5000 }, async (t) => {
  const { store, upstream } = fixture(t);
  let connections = 0;
  const frames = [];
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => target.once('listening', resolve));
  target.on('connection', (socket) => {
    connections += 1;
    socket.on('message', (bytes) => {
      const frame = JSON.parse(bytes.toString());
      frames.push(frame);
      const events = frame.type === 'response.create' ? [created('resp_original')] : [
        accepted, terminal('resp_original', 0.1, 'response.incomplete'),
        created('resp_successor'), terminal('resp_successor', 0.2)
      ];
      for (const event of events) socket.send(JSON.stringify(event));
      if (frame.type === 'response.steer') socket.close(1000);
    });
  });
  const server = createServer(createApp({ store, apiKey: 'steering-key', fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'steering-key',
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    relay.close();
    for (const socket of target.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  });
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/backend-api/codex/v1/responses`, { headers: { authorization: 'Bearer steering-key' } });
  t.after(() => client.terminate());
  const received = await new Promise((resolve, reject) => {
    const events = [];
    client.once('open', () => client.send(JSON.stringify(opener)));
    client.on('error', reject);
    client.on('message', (bytes) => {
      const event = JSON.parse(bytes.toString());
      if (event.type === 'error') { client.close(); reject(new Error(event.error?.message || event.message)); }
      events.push(event);
      if (event.type === 'response.created' && event.response.id === 'resp_original') client.send(JSON.stringify({ ...steer, provider_extra: true }));
      if (event.type === 'response.completed' && event.response.id === 'resp_successor') client.close();
    });
    client.on('close', () => {
      if (!events.some((event) => event.type === 'response.completed' && event.response?.id === 'resp_successor')) reject(new Error('Successor was not delivered'));
      else resolve(events);
    });
  });
  assert.equal(connections, 1);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1], { ...steer, provider_extra: true });
  assert.deepEqual(received.filter((event) => event.type.startsWith('response.')).map((event) => event.type),
    ['response.created', 'response.steer.accepted', 'response.incomplete', 'response.created', 'response.completed']);
  assert.equal(store.get(upstream.id).spending.spentCredits, 7.5);
  const key = store.authenticateApiKey('steering-key');
  assert.equal(store.gatewayUsage(key.scopeId, key.id).request_count, 2);
  const receipts = Object.values(store.load().nativeTurnReceipts);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'succeeded');
});

test('native WebSocket rejects typed SVG outputs before dispatch and admits the next valid turn', { timeout: 5000 }, async (t) => {
  const { store, upstream } = fixture(t);
  let dispatches = 0;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => target.once('listening', resolve));
  target.on('connection', (socket) => socket.on('message', () => {
    dispatches += 1;
    socket.send(JSON.stringify(terminal('resp_valid')));
  }));
  const server = createServer(createApp({ store, apiKey: 'steering-key' }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'steering-key',
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/backend-api/codex/responses`, {
    headers: { authorization: 'Bearer steering-key' }
  });
  t.after(async () => {
    client.terminate(); relay.close();
    for (const socket of target.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  });
  await new Promise((resolve, reject) => {
    client.once('open', () => client.send(JSON.stringify({ ...opener, input: [{
      type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_image', image_url: 'data:image/svg+xml,<svg/>' }]
    }] })));
    client.on('error', reject);
    client.on('message', (bytes) => {
      const event = JSON.parse(bytes.toString());
      if (event.type === 'error') {
        assert.equal(event.error.code, 'unsupported_input_image_format');
        assert.equal(dispatches, 0);
        assert.equal(store.gatewayUsage(store.authenticateApiKey('steering-key').scopeId, store.authenticateApiKey('steering-key').id).request_count, 0);
        client.send(JSON.stringify(opener));
      }
      if (event.type === 'response.completed') client.close();
    });
    client.once('close', resolve);
  });
  assert.equal(dispatches, 1);
  assert.equal(store.get(upstream.id).spending.spentCredits, 2.5);
});

test('native receive queue stays bounded while durability blocks delivery', { timeout: 5000 }, async (t) => {
  const { store } = fixture(t);
  let release;
  let dispatches = 0;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => target.once('listening', resolve));
  target.on('connection', (socket) => socket.on('message', () => {
    dispatches += 1;
    store.setDurabilityBarrier(() => new Promise((resolve) => { release = resolve; }));
    socket.send(JSON.stringify(created('resp_original')));
    for (let index = 0; index < 4; index += 1) {
      socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(32 * 1024) }));
    }
  }));
  const server = createServer(createApp({ store, apiKey: 'steering-key' }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'steering-key',
    codexOptions: codexGatewayOptions({ websocketBackpressureBytes: 64 * 1024 }),
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/backend-api/codex/responses`, {
    headers: { authorization: 'Bearer steering-key' }
  });
  t.after(async () => {
    store.setDurabilityBarrier(null);
    release?.();
    client.terminate(); relay.close();
    for (const socket of target.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  });
  const code = await new Promise((resolve, reject) => {
    client.once('open', () => client.send(JSON.stringify(opener)));
    client.once('error', reject);
    client.once('close', resolve);
  });
  assert.equal(code, 1009);
  assert.equal(dispatches, 1);
});
