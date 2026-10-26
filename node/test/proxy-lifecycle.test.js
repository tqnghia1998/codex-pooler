import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { Store } from '../src/store.js';
import { handleCompatibilityRequest } from '../src/compatibility.js';
import { attachWebSocketProxy, proxyRawRequest, proxyRequest } from '../src/proxy.js';

function response() {
  return Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, chunks: [],
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    write(chunk, callback) { this.chunks.push(chunk); callback?.(); return true; },
    end(chunk) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; this.emit('finish'); this.emit('close'); },
    destroy() { this.destroyed = true; this.emit('close'); }
  });
}
function fixture(t, refresh = false) {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 8) });
  const upstream = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
    access_token: 'synthetic', ...(refresh ? { refresh_token: 'synthetic-refresh' } : {})
  } }) });
  store.setCap(upstream.id, { capDollars: 100 });
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/audio/transcriptions',
    headers: {}, proxyAuth: store.configureApiKey('test'), disablePacing: true });
  t.after(() => store.sqlite.close());
  return { store, upstream, req, res: response() };
}
async function audio(req) {
  const form = new FormData();
  form.append('model', 'gpt-4o-transcribe');
  form.append('file', new Blob(['synthetic audio']), 'audio.wav');
  const prepared = new Request('http://localhost', { method: 'POST', body: form });
  req.headers['content-type'] = prepared.headers.get('content-type');
  return Buffer.from(await prepared.arrayBuffer());
}
function assertNeutral(f) {
  assert.ok(Object.values(f.store.get(f.upstream.id).circuits || {}).every(c => c.failures === 0));
  assert.ok(!f.store.get(f.upstream.id).lastSuccessfulAt);
}
function assertReleased(f) {
  assert.equal(f.req.listenerCount('aborted'), 0);
  assert.equal(f.res.listenerCount('close'), 0);
}

test('compatibility body collection cancels on disconnect before the idle deadline', async t => {
  const f = fixture(t);
  let cancelled = 0;
  const error = await handleCompatibilityRequest({ ...f, path: f.req.url, body: await audio(f.req),
    upstreamDeadlines: { bodyIdleMs: 100 }, fetchImpl: async () => {
      setImmediate(() => f.res.destroy());
      return new Response(new ReadableStream({ cancel() { cancelled++; } }));
    } }).catch(error => error);
  assert.equal(error.upstreamFailureKind, 'cancelled');
  assert.equal(cancelled, 1);
  assertNeutral(f);
  assertReleased(f);
});

test('repeated compatibility cancellation before headers cannot open the provider circuit', async t => {
  const f = fixture(t);
  const body = await audio(f.req);
  for (let index = 0; index < 4; index++) {
    f.res = response();
    const error = await handleCompatibilityRequest({ ...f, path: f.req.url, body,
      fetchImpl: async (_url, options) => {
        setImmediate(() => f.res.destroy());
        return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      } }).catch(error => error);
    assert.equal(error.upstreamFailureKind, 'cancelled');
    assertNeutral(f);
    assertReleased(f);
  }
  f.res = response();
  await handleCompatibilityRequest({ ...f, path: f.req.url, body, fetchImpl: async () => Response.json({ text: 'healthy' }) });
  assert.equal(f.res.statusCode, 200);
  assertReleased(f);
});

test('compatibility cannot dispatch an already disconnected request', async t => {
  const f = fixture(t);
  f.res.destroy();
  let calls = 0;
  await assert.rejects(handleCompatibilityRequest({ ...f, path: f.req.url, body: await audio(f.req),
    fetchImpl: async () => { calls++; return Response.json({ text: 'unexpected' }); } }), { upstreamFailureKind: 'cancelled' });
  assert.equal(calls, 0);
  assertNeutral(f);
  assertReleased(f);
});

test('a genuine compatibility body timeout still records provider failure and releases listeners', async t => {
  const f = fixture(t);
  let cancelled = 0;
  await assert.rejects(handleCompatibilityRequest({ ...f, path: f.req.url, body: await audio(f.req),
    upstreamDeadlines: { bodyIdleMs: 10 }, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled++; } })) }), { name: 'TimeoutError' });
  assert.equal(cancelled, 1);
  assert.equal(Object.values(f.store.get(f.upstream.id).circuits)[0].failures, 1);
  assertReleased(f);
});

test('image cancellation retains complete observed cost without a provider penalty', async t => {
  const f = fixture(t);
  f.req.url = '/v1/images/generations';
  await assert.rejects(handleCompatibilityRequest({ ...f, path: f.req.url,
    body: Buffer.from(JSON.stringify({ model: 'gpt-image-1', prompt: 'synthetic' })),
    modelCatalog: { imageModel: async () => 'gpt-5.6-sol' }, fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.usage","usage":{"price_cost_usd":0.25}}\n\n'));
        setImmediate(() => f.res.destroy());
      }
    }), { headers: { 'content-type': 'text/event-stream' } }) }), { upstreamFailureKind: 'cancelled' });
  assert.equal(f.store.get(f.upstream.id).spending.spentCostMicros, 250_000);
  assertNeutral(f);
  assertReleased(f);
});

for (const route of ['raw', 'compatibility']) {
  for (const refreshFails of [false, true]) {
    test(`${route} OAuth ${refreshFails ? 'failure' : 'retry'} disposes the rejected response before refresh`, async t => {
      const f = fixture(t, true);
      let cancelled = 0;
      let calls = 0;
      const fetchImpl = async url => {
        if (new URL(url).pathname === '/oauth/token') {
          assert.equal(cancelled, 1, 'the rejected body must not survive refresh or renewed admission');
          if (refreshFails) throw new Error('Synthetic refresh failure');
          return Response.json({ access_token: 'synthetic-rotated', expires_in: 3600 });
        }
        if (calls++ === 0) return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 401 });
        return Response.json({ text: 'healthy' });
      };
      if (route === 'raw') {
        f.req.method = 'GET';
        await proxyRawRequest({ ...f, path: '/api/codex/usage', body: Buffer.alloc(0), fetchImpl });
      } else {
        const operation = handleCompatibilityRequest({ ...f, path: f.req.url, body: await audio(f.req), fetchImpl });
        if (refreshFails) await assert.rejects(operation);
        else await operation;
      }
      assert.equal(cancelled, 1);
      assert.equal(calls, refreshFails ? 1 : 2);
      assertReleased(f);
    });
  }
}

for (const refreshFails of [false, true]) {
  test(`persistent WebSocket compaction disposes its rejected HTTP body on refresh ${refreshFails ? 'failure' : 'success'}`, { timeout: 3000 }, async t => {
    const f = fixture(t, true);
    let cancelled = 0;
    let calls = 0;
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const gateway = attachWebSocketProxy(server, { store: f.store, apiKey: 'test', disablePacing: true, fetchImpl: async url => {
      if (new URL(url).pathname === '/oauth/token') {
        assert.equal(cancelled, 1);
        if (refreshFails) throw new Error('Synthetic refresh failure');
        return Response.json({ access_token: 'synthetic-rotated', expires_in: 3600 });
      }
      if (calls++ === 0) return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 401 });
      return Response.json({ id: 'resp_compact', status: 'completed', output: [{ type: 'compaction', encrypted_content: 'synthetic' }] });
    } });
    let client;
    try {
      client = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/responses`, { headers: { authorization: 'Bearer test' } });
      await once(client, 'open');
      const terminal = new Promise((resolve, reject) => {
        client.on('message', data => { const event = JSON.parse(data.toString()); if (['error', 'response.completed'].includes(event.type)) resolve(event); });
        client.on('error', reject);
      });
      client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'synthetic' }, { type: 'compaction_trigger' }] }));
      const event = await terminal;
      assert.equal(event.type, refreshFails ? 'error' : 'response.completed');
      assert.equal(cancelled, 1);
      assert.equal(client.readyState, WebSocket.OPEN);
    } finally {
      client?.terminate();
      for (const socket of gateway.clients) socket.terminate();
      await new Promise(resolve => gateway.close(resolve));
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('compatibility cancellation closes a real provider HTTP connection', { timeout: 3000 }, async t => {
  const f = fixture(t);
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.once('close', disconnected);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await assert.rejects(handleCompatibilityRequest({ ...f, path: f.req.url, body: await audio(f.req),
      fetchImpl: async (_url, options) => {
        const result = await fetch(`http://127.0.0.1:${server.address().port}`, options);
        setImmediate(() => f.res.destroy());
        return result;
      } }), { upstreamFailureKind: 'cancelled' });
    await closed;
    assertNeutral(f);
    assertReleased(f);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const route of ['raw', 'compatibility', 'core']) {
  test(`${route} retains a measured authentication rejection without replay`, async t => {
    const f = fixture(t, true);
    let calls = 0;
    const fetchImpl = async url => {
      assert.notEqual(new URL(url).pathname, '/oauth/token', 'billable work must settle before any replay');
      calls++;
      return Response.json({ error: { type: 'authentication_error' }, usage: { price_cost_usd: 0.25 } }, { status: 401 });
    };
    if (route === 'raw') {
      f.req.method = 'GET';
      await proxyRawRequest({ ...f, path: '/api/codex/usage', body: Buffer.alloc(0), fetchImpl });
    } else if (route === 'core') {
      await proxyRequest({ ...f, path: '/v1/responses', payload: { model: 'gpt-5.6-sol', input: 'synthetic' }, fetchImpl });
    } else {
      await handleCompatibilityRequest({ ...f, path: f.req.url, body: await audio(f.req), fetchImpl });
    }
    assert.equal(calls, 1);
    assert.equal(f.res.statusCode, 502);
    assert.equal(f.store.get(f.upstream.id).spending.spentCostMicros, 250_000);
    assertReleased(f);
  });
}
