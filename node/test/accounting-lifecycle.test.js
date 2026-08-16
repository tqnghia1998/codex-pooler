import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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

test('aggregates successful requests without retaining lifecycle history', () => {
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
    assert.equal(reopened.gatewayAttempts(request.id).length, 0);
    assert.equal(reopened.gatewayRequest(request.id), null);
    assert.equal(reopened.gatewayUsage(key.scopeId, key.id).request_count, 1);
    assert.doesNotMatch(store.sqlite.prepare('SELECT group_concat(value) AS result FROM records').get().result || '', /raw prompt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persists terminal failures with their retry diagnostics', () => {
  const { dir, store } = tempStore();
  try {
    const key = store.configureApiKey('accounting-key');
    const upstream = store.create(codexInput());
    const request = store.reserveGatewayRequest({ scopeId: key.scopeId, apiKeyId: key.id, endpoint: '/v1/responses' });
    const first = store.beginGatewayAttempt(request.id, upstream.id);
    store.retryGatewayAttempt(request.id, first.id, { responseStatusCode: 503, errorCode: 'upstream_retryable_response' });
    const second = store.beginGatewayAttempt(request.id, upstream.id);
    store.finalizeGatewayRequest({ requestId: request.id, attemptId: second.id, status: 'failed', responseStatusCode: 502, errorCode: 'upstream_failed' });

    const reopened = new Store(dir);
    assert.equal(reopened.gatewayRequest(request.id).status, 'failed');
    assert.deepEqual(reopened.gatewayAttempts(request.id).map(({ status, errorCode }) => ({ status, errorCode })), [
      { status: 'retryable_failed', errorCode: 'upstream_retryable_response' },
      { status: 'failed', errorCode: 'upstream_failed' }
    ]);
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
      const request = store.load().gatewayRequests.find((item) => item.status === 'in_progress');
      upstreamCalls += 1;
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
    assert.equal(upstreamCalls, 2);
    assert.equal(store.load().gatewayRequests.length, 0);
    assert.equal(store.gatewayUsage(key.scopeId, key.id).request_count, 2);
    assert.doesNotMatch(store.sqlite.prepare('SELECT group_concat(value) AS result FROM records').get().result || '', /raw prompt/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('records real failed proxy phase timings without retaining account identity', async () => {
  const { dir, store } = tempStore();
  const upstream = store.create({ type: 'compass', projectId: 'diagnostic-project', projectKey: 'diagnostic-secret' });
  store.setCap(upstream.id, { capDollars: 100 });
  const server = createServer(createApp({
    store,
    apiKey: 'accounting-key',
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      throw Object.assign(new Error('sensitive.example failed'), { code: 'ENOTFOUND' });
    },
    logger: { warn() {} }
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer accounting-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'private prompt' })
    });
    assert.equal(response.status, 502);
    const failure = store.gatewayDiagnostics().failures[0];
    assert.equal(failure.errorCode, 'upstream_request_failed');
    assert.equal(failure.attempts[0].errorCode, 'upstream_transport_failed');
    assert.ok(Number.isInteger(failure.attempts[0].timings.credentialPreparationMs));
    assert.ok(Number.isInteger(failure.attempts[0].timings.connectionMs));
    assert.ok(Number.isInteger(failure.attempts[0].timings.terminalCompletionMs));
    const persisted = store.sqlite.prepare(`
      SELECT group_concat(value) AS result
      FROM records
      WHERE collection IN ('gatewayRequests', 'gatewayAttempts')
    `).get().result || '';
    for (const secret of [upstream.id, 'diagnostic-project', 'diagnostic-secret', 'sensitive.example', 'private prompt']) {
      assert.equal(persisted.includes(secret), false);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
