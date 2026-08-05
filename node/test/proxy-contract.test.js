import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

// This is the public contract extracted from the Elixir router/controllers. It is
// deliberately test data: each gap names the phase that must remove it.
export const ELIXIR_PROXY_CONTRACT = Object.freeze([
  route('GET', '/healthz', 'public', '200 JSON health', 'verified'),
  route('GET', '/readyz', 'public', '200 JSON readiness', 'verified'),
  route('GET', '/v1/models', 'bearer', 'scoped policy-filtered model list', 'verified'),
  route('GET', '/v1/usage', 'bearer', '200 scoped accounting usage; query filters are 400 unsupported_parameter', 'verified'),
  route('POST', '/v1/responses', 'bearer', 'OpenAI Responses HTTP/SSE', 'verified'),
  route('GET', '/v1/responses', 'bearer', 'WebSocket only; non-upgrade is 400 websocket_upgrade_required', 'verified'),
  route('POST', '/v1/responses/compact', 'bearer', '404 unsupported_endpoint', 'verified'),
  route('POST', '/v1/chat/completions', 'bearer', 'OpenAI Chat HTTP/SSE', 'verified'),
  route('POST', '/v1/messages', 'bearer_or_x_api_key', 'Compass Anthropic Messages', 'verified'),
  route('GET', '/v1/files', 'bearer', 'scoped file list', 'verified'),
  route('POST', '/v1/files', 'bearer', 'scoped upload/create/finalize lifecycle', 'verified'),
  route('GET', '/v1/files/:file_id', 'bearer', 'scoped file metadata', 'verified'),
  route('GET', '/v1/files/:file_id/content', 'bearer', '404 unsupported_endpoint', 'verified'),
  route('DELETE', '/v1/files/:file_id', 'bearer', '404 unsupported_endpoint', 'verified'),
  route('POST', '/v1/audio/transcriptions', 'bearer', 'multipart transcription', 'verified'),
  route('POST', '/v1/images/generations', 'bearer', 'validated image generation', 'verified'),
  route('POST', '/v1/images/edits', 'bearer', 'validated image edit', 'verified'),
  route('POST', '/v1/images/variations', 'bearer', '404 unsupported_endpoint', 'verified'),
  route('POST', '/v1/embeddings', 'bearer', '404 unsupported_endpoint', 'verified'),
  route('POST', '/v1/batches', 'bearer', '404 unsupported_endpoint', 'verified'),
  route('POST', '/v1/moderations', 'bearer', '404 unsupported_endpoint', 'verified'),
  route('POST', '/v1/fine_tuning/jobs', 'bearer', '404 unsupported_endpoint', 'verified'),
  route('GET|DELETE', '/v1/responses/:response_id', 'bearer', '404 unsupported_endpoint', 'verified'),
  route('POST', '/v1/responses/:response_id/cancel', 'bearer', '404 unsupported_endpoint', 'verified'),
  route('GET', '/backend-api/codex/models', 'bearer', 'scoped policy-filtered catalog with deterministic ETag', 'verified'),
  route('GET', '/backend-api/codex/v1/models', 'bearer', 'scoped policy-filtered catalog with deterministic ETag', 'verified'),
  route('POST', '/backend-api/codex/responses', 'bearer', 'native Codex Responses', 'verified'),
  route('GET', '/backend-api/codex/responses', 'bearer', 'native Codex Responses WebSocket', 'verified'),
  route('POST', '/backend-api/codex/v1/responses', 'bearer', 'native Codex Responses', 'verified'),
  route('GET', '/backend-api/codex/v1/responses', 'bearer', 'native Codex Responses WebSocket', 'verified'),
  route('POST', '/backend-api/codex/responses/compact', 'bearer', 'native compact', 'verified'),
  route('POST', '/backend-api/codex/v1/responses/compact', 'bearer', 'native compact', 'verified'),
  route('POST', '/backend-api/codex/v1/chat/completions', 'bearer', 'native Chat compatibility', 'verified'),
  route('POST', '/backend-api/codex/images/generations', 'bearer', 'native image generation', 'verified'),
  route('POST', '/backend-api/codex/images/edits', 'bearer', 'native image edit', 'verified'),
  route('POST', '/backend-api/transcribe', 'bearer', 'native transcription', 'verified'),
  route('POST', '/backend-api/files', 'bearer', 'native file create', 'verified'),
  route('POST', '/backend-api/files/:file_id/uploaded', 'bearer', 'native file finalization', 'verified'),
  route('GET', '/api/codex/usage', 'bearer', 'Codex account usage', 'verified'),
  route('GET', '/wham/usage', 'bearer', 'Codex account usage', 'verified'),
  route('GET', '/backend-api/wham/usage', 'bearer', 'Codex account usage', 'verified')
]);

export const KNOWN_PARITY_GAPS = Object.freeze([

]);

function route(method, path, auth, behavior, state, gapId = null) {
  return Object.freeze({ method, path, auth, behavior, state, gapId });
}

function gap(id, summary) {
  return Object.freeze({ id, summary });
}

function startApp() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-contract-'));
  const store = new Store(dir);
  const server = createServer(createApp({ store, apiKey: 'contract-key' }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    store,
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((done) => server.close(done));
      rmSync(dir, { recursive: true, force: true });
    }
  })));
}

function authorized(options = {}) {
  return { ...options, headers: { authorization: 'Bearer contract-key', ...(options.headers || {}) } };
}

test('the extracted contract covers every public and native proxy route and assigns each gap an owner', () => {
  const keys = ELIXIR_PROXY_CONTRACT.map(({ method, path }) => `${method} ${path}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate route contract entry');
  assert.ok(ELIXIR_PROXY_CONTRACT.some(({ path }) => path === '/v1/messages'));
  assert.ok(ELIXIR_PROXY_CONTRACT.some(({ path }) => path === '/v1/files/:file_id/content'));
  assert.ok(ELIXIR_PROXY_CONTRACT.some(({ path }) => path === '/backend-api/codex/v1/responses'));
  const owners = new Set(KNOWN_PARITY_GAPS.map(({ id }) => id));
  for (const item of ELIXIR_PROXY_CONTRACT.filter(({ state }) => state === 'gap')) {
    assert.ok(owners.has(item.gapId), `${item.method} ${item.path} has no implementation phase`);
  }
});

test('executes the currently matched public auth and unsupported-route contract', async (t) => {
  const app = await startApp();
  t.after(app.close);

  let response = await fetch(`${app.base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });

  response = await fetch(`${app.base}/v1/embeddings`, { method: 'POST' });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');

  app.store.saveFile({ id: 'file-contract', object: 'file', bytes: 0, created_at: 0, filename: 'contract.txt', purpose: 'user_data', status: 'uploaded', expires_at: 1 });
  for (const [method, path] of [
    ['POST', '/v1/responses/compact'],
    ['POST', '/v1/embeddings'],
    ['POST', '/v1/images/variations'],
    ['GET', '/v1/files/file-contract/content'],
    ['DELETE', '/v1/files/file-contract']
  ]) {
    response = await fetch(`${app.base}${path}`, authorized({ method }));
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), {
      error: {
        type: 'invalid_request_error', code: 'unsupported_endpoint',
        message: 'Unsupported OpenAI /v1 endpoint', param: null
      }
    });
  }
});

for (const item of KNOWN_PARITY_GAPS) {
  test.todo(`parity gap [${item.id}]: ${item.summary}`);
}
