import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { proxyRequest, inspectInitialSseEvent } from '../src/proxy.js';
import { Store } from '../src/store.js';
import { fetchWithHeaderDeadline } from '../src/upstream-deadlines.js';
import { decodeClaudeResponse } from '../src/upstream-response.js';
import { captureClaudeThinkingReplayResponse } from '../src/claude-thinking-replay.js';

const encode = (text) => new TextEncoder().encode(text);
function fixture(t, type = 'compass') {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 3) });
  t.after(() => store.sqlite.close());
  const upstream = store.create(type === 'compass'
    ? { type, projectId: 'test', projectKey: 'test', quotaSource: 'ais' }
    : type === 'claude' ? { type, accessToken: 'sk-ant-oat01-test', baseUrl: 'https://claude.invalid', metadata: { skip_account_profile: true } }
      : { type, authJson: JSON.stringify({ tokens: { access_token: 'test' } }) });
  store.setCap(upstream.id, { capDollars: 100 });
  const req = Object.assign(new EventEmitter(), { headers: { authorization: 'Bearer test' }, disablePacing: true });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, chunks: [],
    writeHead(status) { this.statusCode = status; this.headersSent = true; return this; },
    write(chunk, callback) { this.chunks.push(chunk); callback?.(); return true; },
    end(chunk) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; this.emit('finish'); this.emit('close'); }
  });
  const call = (fetchImpl, options = {}) => proxyRequest({ req, res, store, apiKey: 'test',
    path: '/v1/messages', payload: { model: 'claude-sonnet-4-6', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
    fetchImpl, upstreamDeadlines: { headersMs: 100, bodyIdleMs: 20 }, ...options });
  return { store, upstream, req, res, call };
}

test('an already aborted header request never calls the transport', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  let calls = 0;
  await assert.rejects(fetchWithHeaderDeadline(async () => { calls++; return new Response('{}'); },
    'https://example.invalid', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('an SSE probe timeout cancels both branches and the underlying source', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(inspectInitialSseEvent(response, { bodyIdleMs: 10 }), { name: 'TimeoutError' });
  assert.equal(cancelled, true);
});

for (const phase of ['first byte', 'compressed body']) {
  test(`Claude ${phase} obeys body idle deadlines and cancels its source`, async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { if (phase === 'compressed body') controller.enqueue(gzipSync('{}').subarray(0, 4)); },
      cancel() { cancelled = true; }
    }), { headers: { 'content-encoding': 'gzip' } });
    await assert.rejects(decodeClaudeResponse(response, { upstreamDeadlines: { bodyIdleMs: 10 } }), { name: 'TimeoutError' });
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
  });
}

test('oversized compressed Claude bodies cancel their source', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(gzipSync('x'.repeat(100))); },
    cancel() { cancelled = true; }
  }), { headers: { 'content-encoding': 'gzip' } });
  await assert.rejects(decodeClaudeResponse(response, { maxBytes: 8 }), /too large/);
  assert.equal(cancelled, true);
});

test('already closed clients cannot dispatch even with pacing disabled', async (t) => {
  const f = fixture(t);
  f.res.destroyed = true;
  let calls = 0;
  await assert.rejects(f.call(async () => { calls++; return new Response('{}'); }));
  assert.equal(calls, 0);
  assert.ok(!f.store.get(f.upstream.id).lastSuccessfulAt);
});

test('oversized cloned error bodies cannot deadlock sibling consumption', { timeout: 1000 }, async (t) => {
  const f = fixture(t);
  let cancelled = false;
  await f.call(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encode('x'.repeat(1024 * 1024 + 1))); },
    cancel() { cancelled = true; }
  }), { status: 403 }));
  assert.equal(f.res.statusCode, 502);
  assert.equal(cancelled, true);
  assert.equal(f.req.listenerCount('aborted'), 0);
  assert.equal(f.res.listenerCount('close'), 0);
});

for (const phase of ['SSE inspection', 'JSON collection']) {
  test(`client close during ${phase} cancels upstream without another dispatch`, async (t) => {
    const f = fixture(t);
    let cancelled = false;
    let calls = 0;
    await assert.rejects(f.call(async () => {
      calls++;
      setImmediate(() => { f.res.destroyed = true; f.res.emit('close'); });
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
        headers: { 'content-type': phase === 'SSE inspection' ? 'text/event-stream' : 'application/json' }
      });
    }));
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.ok(!f.store.get(f.upstream.id).lastSuccessfulAt);
    assert.equal(f.req.listenerCount('aborted'), 0);
    assert.equal(f.res.listenerCount('close'), 0);
  });
}

test('malformed SSE after visible output releases the source', async (t) => {
  const f = fixture(t);
  let cancelled = false;
  let step = 0;
  await f.call(async () => new Response(new ReadableStream({
    pull(controller) {
      if (step++ === 0) controller.enqueue(encode('data: {"type":"message_start","message":{"id":"test"}}\n\n'));
      else if (step === 2) controller.enqueue(encode('data: ' + 'x'.repeat(8 * 1024 * 1024 + 1)));
    },
    cancel() { cancelled = true; }
  }), { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(cancelled, true);
  assert.ok(!f.store.get(f.upstream.id).lastSuccessfulAt);
});


test('Claude replay inspection times out independently and never waits for its tee sibling', { timeout: 1000 }, async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const result = await captureClaudeThinkingReplayResponse({ key: 'stalled-test' }, response, { bodyIdleMs: 10 });
  assert.equal(result, false);
  assert.equal(cancelled, false, 'inspection must leave the main response branch usable');
  await response.body.cancel();
  assert.equal(cancelled, true);
});

test('Claude plain response decoding releases the reader on complete collection', async () => {
  const response = new Response('{"id":"test"}');
  const decoded = await decodeClaudeResponse(response);
  assert.deepEqual(await decoded.json(), { id: 'test' });
  assert.equal(response.body.locked, false);
});


for (const contentType of ['application/json', 'text/event-stream']) {
  test(`client cancellation closes a real upstream HTTP connection during ${contentType}`, async (t) => {
    const f = fixture(t);
    let disconnected;
    const closed = new Promise((resolve) => { disconnected = resolve; });
    const server = createServer(async (req, res) => {
      for await (const _ of req) {}
      res.once('close', disconnected);
      res.writeHead(200, { 'content-type': contentType });
      res.flushHeaders();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const target = `http://127.0.0.1:${server.address().port}/`;
    await assert.rejects(f.call(async (_url, options) => {
      const response = await fetch(target, options);
      setImmediate(() => { f.res.destroyed = true; f.res.emit('close'); });
      return response;
    }, { upstreamDeadlines: { headersMs: 1000, bodyIdleMs: 1000 } }));
    await closed;
    assert.ok(!f.store.get(f.upstream.id).lastSuccessfulAt);
    assert.equal(f.store.get(f.upstream.id).health, undefined);
  });
}
