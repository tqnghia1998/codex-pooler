import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const API_KEY = 'error-key';

function configuredStore(dir) {
  const store = new Store(dir);
  const codex = store.create({ type: 'codex', accessToken: 'codex-error-token' });
  store.setCap(codex.id, { capDollars: 100 });
  const compass = store.create({ type: 'compass', projectId: 'error-project', projectKey: 'compass-error-key' });
  store.setCap(compass.id, { capDollars: 100 });
  return store;
}

async function runningServer(store, fetchImpl) {
  const server = createServer(createApp({ store, fetchImpl, apiKey: API_KEY }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function post(base, path, payload, headers = {}) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });
  return { response, body: await response.json() };
}

async function close(server, dir) {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}

test('normalizes parser, transport, and timeout failures without leaking details', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-errors-'));
  let mode = 'transport';
  const fetchImpl = async () => {
    const error = new Error('secret-provider-host.internal token=secret');
    if (mode === 'timeout') error.name = 'TimeoutError';
    throw error;
  };
  const { server, base } = await runningServer(configuredStore(dir), fetchImpl);
  try {
    const malformedResponse = await fetch(base + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: '{not-json' });
    assert.equal(malformedResponse.status, 400);
    const malformed = await malformedResponse.text();
    assert.equal(malformed, 'Bad Request');

    const transport = await post(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'hi' }, { 'x-upstream-type': 'codex' });
    assert.equal(transport.response.status, 502);
    assert.deepEqual(transport.body, { error: { type: 'server_error', code: 'upstream_error', message: 'Upstream request failed', param: null } });

    mode = 'timeout';
    const timeout = await post(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'hi' }, { 'x-upstream-type': 'codex' });
    assert.equal(timeout.response.status, 502);
    assert.deepEqual(timeout.body, { error: { type: 'server_error', code: 'upstream_error', message: 'Upstream request failed', param: null } });
    assert.equal(JSON.stringify([malformed, transport.body, timeout.body]).includes('secret'), false);
  } finally {
    await close(server, dir);
  }
});

test('redacts every provider error except valid Anthropic Messages 4xx envelopes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-provider-errors-'));
  let mode = 'codex-400';
  const fetchImpl = async () => {
    const secret = { error: { type: 'invalid_request_error', code: 'provider_secret', message: 'sensitive provider detail token=secret' } };
    if (mode === 'codex-500') return new Response(JSON.stringify(secret), { status: 500, headers: { 'content-type': 'application/json' } });
    if (mode === 'anthropic-valid') return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'safe Anthropic client detail' } }), {
      status: 400,
      headers: {
        'content-type': 'application/json',
        'anthropic-ratelimit-requests-limit': '10',
        'anthropic-ratelimit-input-tokens-remaining': '20',
        'request-id': 'anthropic-request',
        'retry-after': '2'
      }
    });
    const status = Number(mode.slice(-3)) || 400;
    return new Response(JSON.stringify(secret), { status, headers: { 'content-type': 'application/json' } });
  };
  const { server, base } = await runningServer(configuredStore(dir), fetchImpl);
  try {
    for (const [nextMode, path, type, expectedStatus] of [
      ['codex-400', '/v1/responses', 'codex', 502],
      ['codex-500', '/v1/responses', 'codex', 502],
      ['compass-400', '/v1/chat/completions', 'compass', 502],
      ['codex-401', '/v1/responses', 'codex', 502]
    ]) {
      mode = nextMode;
      const payload = path.includes('chat')
        ? { model: 'claude-fable-5', messages: [{ role: 'user', content: 'hi' }] }
        : { model: 'gpt-5.6-sol', input: 'hi' };
      const result = await post(base, path, payload, { 'x-upstream-type': type });
      assert.equal(result.response.status, expectedStatus, nextMode);
      assert.equal(result.body.error.type, 'server_error', nextMode);
      assert.equal(result.body.error.code, 'upstream_error', nextMode);
      assert.equal(result.body.error.message, 'Upstream request failed', nextMode);
      assert.equal(JSON.stringify(result.body).includes('secret'), false, nextMode);
    }

    mode = 'anthropic-valid';
    const anthropic = await post(base, '/v1/messages', { model: 'claude-fable-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }, { 'x-upstream-type': 'compass', 'anthropic-version': '2023-06-01' });
    assert.equal(anthropic.response.status, 400);
    assert.deepEqual(anthropic.body, { type: 'error', error: { type: 'invalid_request_error', message: 'safe Anthropic client detail' } });
    assert.equal(anthropic.response.headers.get('anthropic-ratelimit-requests-limit'), '10');
    assert.equal(anthropic.response.headers.get('anthropic-ratelimit-input-tokens-remaining'), '20');
    assert.equal(anthropic.response.headers.get('request-id'), 'anthropic-request');
    assert.equal(anthropic.response.headers.get('retry-after'), '2');
  } finally {
    await close(server, dir);
  }
});

test('redacts raw backend provider errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-raw-errors-'));
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'raw provider secret' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  const { server, base } = await runningServer(configuredStore(dir), fetchImpl);
  try {
    const result = await post(base, '/backend-api/files', { file_name: 'x', file_size: 1 });
    assert.equal(result.response.status, 502);
    assert.deepEqual(result.body, { error: { type: 'server_error', code: 'upstream_error', message: 'Upstream request failed', param: null } });
  } finally {
    await close(server, dir);
  }
});
