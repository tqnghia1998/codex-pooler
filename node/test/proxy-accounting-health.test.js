import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { proxyRawRequest, proxyRequest } from '../src/proxy.js';

function response() {
  return Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, chunks: [],
    writeHead(status) { this.statusCode = status; this.headersSent = true; return this; },
    write(chunk, callback) { this.chunks.push(chunk); callback?.(); return true; },
    end(chunk) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; this.emit('finish'); this.emit('close'); }
  });
}
function request(key, headers = {}) {
  return Object.assign(new EventEmitter(), { method: 'GET', headers, proxyAuth: key, disablePacing: true });
}
function fixture(t, type = 'codex') {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 8) });
  t.after(() => store.sqlite.close());
  const key = store.configureApiKey('test');
  const upstream = store.create(type === 'codex' ? { type, accessToken: 'synthetic' }
    : { type: 'compass', projectId: 'test', projectKey: 'test', quotaSource: 'ais' });
  store.setCap(upstream.id, { capDollars: 100 });
  return { store, key, upstream };
}

test('repeated successful AIS Chat DONE streams leave the circuit closed', async t => {
  const { store, key, upstream } = fixture(t, 'ais');
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, price_cost_usd: 0.01 } })}\n\ndata: [DONE]\n\n`;
  for (let index = 0; index < 5; index++) {
    const res = response();
    await proxyRequest({ req: request(key), res, store, path: '/v1/chat/completions',
      payload: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], stream: true },
      fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
    assert.equal(res.statusCode, 200);
  }
  assert.ok(Object.values(store.get(upstream.id).circuits).every(c => c.status === 'closed' && c.failures === 0));
  assert.ok(store.get(upstream.id).lastSuccessfulAt);
});

test('cancelled raw Codex JSON body reads release the circuit neutrally', async t => {
  const { store, key, upstream } = fixture(t);
  let cancellations = 0;
  for (let index = 0; index < 4; index++) {
    const res = response();
    await assert.rejects(proxyRawRequest({ req: request(key), res, store, path: '/api/codex/usage', body: Buffer.alloc(0),
      fetchImpl: async () => {
        setImmediate(() => { res.destroyed = true; res.emit('close'); });
        return new Response(new ReadableStream({ cancel() { cancellations++; } }), { headers: { 'content-type': 'application/json' } });
      } }));
  }
  assert.equal(cancellations, 4);
  assert.ok(Object.values(store.get(upstream.id).circuits).every(c => c.status === 'closed' && !c.failures));
  const res = response();
  await proxyRawRequest({ req: request(key), res, store, path: '/api/codex/usage', body: Buffer.alloc(0), fetchImpl: async () => new Response('{}') });
  assert.equal(res.statusCode, 200);
});

test('reported failed-attempt usage survives failover without finalizing the request early', async t => {
  const { store, key, upstream } = fixture(t);
  const second = store.create({ type: 'codex', accessToken: 'synthetic-second' });
  store.setCap(second.id, { capDollars: 100 });
  store.setUpstreamPriority?.([upstream.id, second.id]);
  let calls = 0;
  const res = response();
  await proxyRequest({ req: request(key), res, store, path: '/v1/responses', payload: { model: 'gpt-5.6-sol', input: 'hi' },
    fetchImpl: async () => {
      const failed = calls++ === 0;
      return new Response(JSON.stringify({ id: `resp_${calls}`, status: failed ? 'incomplete' : 'completed', output: [],
        ...(failed ? { incomplete_details: { reason: 'credit_balance_exhausted' } } : {}),
        usage: { input_tokens: 10, output_tokens: 10, price_cost_usd: failed ? 0.25 : 0.10 } }));
    } });
  assert.equal(calls, 2);
  assert.equal(res.statusCode, 200);
  assert.equal(store.list().reduce((sum, row) => sum + (store.get(row.id).spending.spentCostMicros || 0), 0), 350_000);
  assert.equal(store.gatewayUsage(key.scopeId, key.id).total_cost_usd, 0.35);
});
