import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-accounting-'));
  return { dir, store: new Store(dir) };
}

function codexInput() {
  const token = `header.${Buffer.from(JSON.stringify({ email: 'accounting@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'accounting' } })).toString('base64url')}.signature`;
  return { type: 'codex', authJson: JSON.stringify({ tokens: { access_token: token, id_token: token } }) };
}

test('persists reserved requests, retryable attempts, and final settlement', () => {
  const { dir, store } = tempStore();
  try {
    const key = store.configureApiKey('accounting-key');
    const upstream = store.create(codexInput());
    store.setCap(upstream.id, { capDollars: 100 });
    const request = store.reserveGatewayRequest({ scopeId: key.scopeId, apiKeyId: key.id, endpoint: '/v1/responses', model: 'gpt-5.6-sol' });
    const first = store.beginGatewayAttempt(request.id, upstream.id);
    store.retryGatewayAttempt(request.id, first.id, { responseStatusCode: 503, errorCode: 'upstream_retryable_response' });
    const second = store.beginGatewayAttempt(request.id, upstream.id);
    store.finalizeGatewayRequest({ requestId: request.id, attemptId: second.id, status: 'succeeded', responseStatusCode: 200, usage: { inputTokens: 2, outputTokens: 1 }, settledCostMicros: 1200, costSource: 'pricing_snapshot' });

    const reopened = new Store(dir);
    assert.deepEqual(reopened.gatewayAttempts(request.id).map(({ attemptNumber, status, retryable }) => ({ attemptNumber, status, retryable })), [
      { attemptNumber: 1, status: 'retryable_failed', retryable: true },
      { attemptNumber: 2, status: 'succeeded', retryable: false }
    ]);
    assert.equal(reopened.gatewayRequest(request.id).status, 'succeeded');
    assert.equal(reopened.gatewayRequest(request.id).retryCount, 1);
    assert.equal(reopened.gatewayUsage(key.scopeId, key.id).request_count, 1);
    assert.doesNotMatch(readFileSync(join(dir, 'db.json'), 'utf8'), /raw prompt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reserves authenticated public Responses and Chat requests before dispatch', async () => {
  const { dir, store } = tempStore();
  const key = store.configureApiKey('accounting-key');
  const upstream = store.create(codexInput());
  store.setCap(upstream.id, { capDollars: 100 });
  let upstreamCalls = 0;
  const server = createServer(createApp({
    store,
    apiKey: 'accounting-key',
    fetchImpl: async () => {
      const request = store.load().gatewayRequests[upstreamCalls++];
      assert.equal(request.status, 'in_progress');
      assert.equal(store.gatewayAttempts(request.id).length, 1);
      return new Response(JSON.stringify({ id: 'resp-accounting', model: 'gpt-5.6-sol', output: [] }), { headers: { 'content-type': 'application/json' } });
    }
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [path, body] of [
      ['/v1/responses', { model: 'gpt-5.6-sol', input: 'raw prompt' }],
      ['/v1/chat/completions', { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'raw prompt' }] }]
    ]) {
      const response = await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer accounting-key', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
    }
    const records = [store.gatewayRequest(store.load().gatewayRequests[0].id), store.gatewayRequest(store.load().gatewayRequests[1].id)];
    assert.deepEqual(records.map(({ endpoint, apiKeyId, status }) => ({ endpoint, apiKeyId, status })), [
      { endpoint: '/v1/responses', apiKeyId: key.id, status: 'succeeded' },
      { endpoint: '/v1/chat/completions', apiKeyId: key.id, status: 'succeeded' }
    ]);
    assert.equal(records.every((record) => store.gatewayAttempts(record.id).length === 1), true);
    assert.doesNotMatch(readFileSync(join(dir, 'db.json'), 'utf8'), /raw prompt/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
