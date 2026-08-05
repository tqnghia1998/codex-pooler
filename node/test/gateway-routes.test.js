import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { attachWebSocketProxy } from '../src/proxy.js';
import { Store } from '../src/store.js';

const API_KEY = 'client-key';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function codex({ email = 'routes@example.com', accountId = 'acct-routes' } = {}) {
  return {
    type: 'codex',
    authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
      id_token: jwt({ email })
    }})
  };
}

function configuredStore(dir, { compass = false } = {}) {
  const store = new Store(dir);
  const codexUpstream = store.create(codex());
  store.setCap(codexUpstream.id, { capDollars: 100 });
  let compassUpstream;
  if (compass) {
    compassUpstream = store.create({ type: 'compass', projectId: 'project-routes', projectKey: 'compass-secret' });
    store.setCap(compassUpstream.id, { capDollars: 100 });
  }
  return { store, codexUpstream, compassUpstream };
}

async function start(store, fetchImpl, apiKey = API_KEY) {
  const server = createServer(createApp({ store, fetchImpl, apiKey }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function gatewayFetch(base, path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: { authorization: `Bearer ${API_KEY}`, ...(options.headers || {}) }
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('merges Codex and Compass model discovery with the required Codex client version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-models-'));
  const { store } = configuredStore(dir, { compass: true });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://chatgpt.com')) {
      return new Response(JSON.stringify({ models: [{ slug: 'shared-model' }, { slug: 'gpt-5.6-sol', input_modalities: ['text', 'image'] }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ id: 'shared-model', owned_by: 'compass' }, { id: 'claude-fable-5' }] }), { status: 200 });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const response = await gatewayFetch(base, '/v1/models');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.data.map((model) => model.id), ['shared-model', 'gpt-5.6-sol', 'claude-fable-5']);
    assert.equal(body.data[0].object, 'model');
    assert.equal(new URL(calls.find((url) => url.startsWith('https://chatgpt.com'))).searchParams.get('client_version'), '0.146.1');
    assert.equal(new URL(calls.find((url) => url.startsWith('https://compass.llm.shopee.io'))).pathname, '/compass-api/v1/models');
    assert.equal(response.headers.get('etag'), null);
    const cached = await gatewayFetch(base, '/v1/models');
    assert.equal(cached.status, 200);
    assert.equal(calls.length, 2);

    const backend = await gatewayFetch(base, '/backend-api/codex/models');
    const firstEtag = backend.headers.get('etag');
    assert.match(firstEtag, /^W\/"cp-models-v1-[a-f0-9]{64}"$/);
    assert.deepEqual((await backend.json()).models.map((model) => model.id), ['shared-model', 'gpt-5.6-sol', 'claude-fable-5']);
    const alias = await gatewayFetch(base, '/backend-api/codex/v1/models');
    assert.equal(alias.headers.get('etag'), firstEtag);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coalesces simultaneous model-catalog refreshes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-model-single-flight-'));
  const { store } = configuredStore(dir);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }] }), { status: 200 });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const [first, second] = await Promise.all([
      gatewayFetch(base, '/v1/models'),
      gatewayFetch(base, '/v1/models')
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls, 1);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns an empty model list when at least one provider succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-empty-models-'));
  const { store } = configuredStore(dir, { compass: true });
  const fetchImpl = async (url) => url.startsWith('https://chatgpt.com')
    ? new Response(JSON.stringify({ models: [] }), { status: 200 })
    : new Response('{}', { status: 500 });
  const { server, base } = await start(store, fetchImpl);
  try {
    const response = await gatewayFetch(base, '/v1/models');
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, []);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns a model result on partial provider failure and 502 when all providers fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-model-errors-'));
  const { store } = configuredStore(dir, { compass: true });
  let compassFails = true;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === '/backend-api/codex/responses') {
      return new Response('data: {"type":"response.completed","response":{"id":"resp-no-catalog","output":[]}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.startsWith('https://chatgpt.com')) return new Response('{}', { status: 500 });
    return compassFails
      ? new Response('{}', { status: 500 })
      : new Response(JSON.stringify({ data: [{ id: 'claude-fable-5' }] }), { status: 200 });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    let response = await gatewayFetch(base, '/v1/models');
    assert.equal(response.status, 502);
    assert.deepEqual((await response.json()).error, { type: 'server_error', code: 'upstream_error', message: 'Upstream request failed', param: null });
    compassFails = false;
    response = await gatewayFetch(base, '/v1/models');
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map((model) => model.id), ['claude-fable-5']);

    const backend = await gatewayFetch(base, '/backend-api/codex/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: [], stream: true })
    });
    await backend.text();
    assert.equal(backend.status, 200);
    assert.match(backend.headers.get('x-models-etag'), /^W\/"cp-models-v1-[a-f0-9]{64}"$/);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns authenticated OpenAI-shaped errors for explicit unsupported routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-unsupported-routes-'));
  const { store } = configuredStore(dir);
  const { server, base } = await start(store, async () => { throw new Error('must not dispatch'); });
  try {
    const routes = [
      ['POST', '/v1/images/variations'],
      ['POST', '/v1/embeddings'],
      ['POST', '/v1/batches'],
      ['POST', '/v1/moderations'],
      ['POST', '/v1/fine_tuning/jobs'],
      ['GET', '/v1/responses/resp_fixture'],
      ['POST', '/v1/responses/resp_fixture/cancel'],
      ['DELETE', '/v1/responses/resp_fixture']
    ];
    for (const [method, path] of routes) {
      const response = await gatewayFetch(base, path, { method });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), {
        error: {
          type: 'invalid_request_error', code: 'unsupported_endpoint',
          message: 'Unsupported OpenAI /v1 endpoint', param: null
        }
      });
    }
    const unauthenticated = await fetch(base + '/v1/embeddings', { method: 'POST' });
    assert.equal(unauthenticated.status, 401);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maps compact and native backend media routes while preserving request bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-raw-routes-'));
  const { store } = configuredStore(dir);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' } });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const compact = await gatewayFetch(base, '/backend-api/codex/v1/responses/compact', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'compact', max_output_tokens: 128, temperature: 0.2, top_p: 0.9, reasoning: { effort: 'ultra' } })
    });
    assert.equal(compact.status, 200);
    assert.equal(JSON.parse(calls[0].body).input, 'compact');
    assert.equal(JSON.parse(calls[0].body).reasoning.effort, 'max');
    assert.equal(JSON.parse(calls[0].body).max_output_tokens, 128);
    assert.equal(JSON.parse(calls[0].body).temperature, 0.2);
    assert.equal(JSON.parse(calls[0].body).top_p, 0.9);
    assert.equal(compact.headers.get('x-request-id'), 'request-1');

    const bytes = Buffer.from([0, 1, 2, 255]);
    const raw = await gatewayFetch(base, '/backend-api/transcribe', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes
    });
    assert.equal(raw.status, 200);
    assert.equal(new URL(calls[0].url).pathname, '/backend-api/codex/responses/compact');
    assert.equal(new URL(calls[1].url).pathname, '/backend-api/transcribe');
    assert.equal(calls[1].headers['content-type'], 'application/octet-stream');
    assert.deepEqual(Buffer.from(calls[1].body), bytes);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retries compact without provider-rejected optional fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compact-fallback-'));
  const { store } = configuredStore(dir);
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) return new Response('{"detail":"Unsupported parameter: max_output_tokens"}', { status: 400 });
    return new Response(JSON.stringify({ object: 'response.compaction' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const response = await gatewayFetch(base, '/backend-api/codex/responses/compact', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'compact', max_output_tokens: 128, temperature: 0.2 })
    });
    assert.equal(response.status, 200);
    assert.equal(bodies[0].max_output_tokens, 128);
    assert.equal('reasoning' in bodies[0], false);
    assert.equal('reasoning' in bodies[1], false);
    assert.equal('max_output_tokens' in bodies[1], false);
    assert.equal('temperature' in bodies[1], false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('implements the complete public file create, upload, finalize, list, and retrieve flow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-files-'));
  const { store } = configuredStore(dir);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    if (path === '/backend-api/files') {
      assert.deepEqual(JSON.parse(options.body), { file_name: 'notes.txt', file_size: 11, use_case: 'codex' });
      return new Response(JSON.stringify({ file_id: 'file-1', upload_url: 'https://upload.oaiusercontent.com/file-1', expires_at: 2_000_000_000 }), { status: 200 });
    }
    if (url === 'https://upload.oaiusercontent.com/file-1') {
      assert.equal(options.method, 'PUT');
      assert.equal(options.headers['content-type'], 'text/plain');
      assert.equal(options.headers['x-ms-blob-type'], 'BlockBlob');
      assert.equal(Buffer.from(options.body).toString(), 'hello world');
      return new Response('', { status: 200 });
    }
    assert.equal(path, '/backend-api/files/file-1/uploaded');
    return new Response(JSON.stringify({ status: 'success', download_url: 'https://download.test/file-1' }), { status: 200 });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'notes.txt');
    const created = await gatewayFetch(base, '/v1/files', { method: 'POST', body: form });
    const file = await created.json();
    assert.equal(created.status, 200);
    assert.deepEqual(file, {
      id: 'file-1', object: 'file', bytes: 11, created_at: file.created_at,
      filename: 'notes.txt', purpose: 'user_data', status: 'uploaded', expires_at: 2_000_000_000
    });

    const list = await gatewayFetch(base, '/v1/files');
    assert.deepEqual((await list.json()).data, [file]);
    const show = await gatewayFetch(base, '/v1/files/file-1');
    assert.deepEqual(await show.json(), file);
    const content = await gatewayFetch(base, '/v1/files/file-1/content');
    assert.equal(content.status, 404);
    assert.equal((await content.json()).error.code, 'unsupported_endpoint');
    const removed = await gatewayFetch(base, '/v1/files/file-1', { method: 'DELETE' });
    assert.equal(removed.status, 404);
    assert.equal(calls.length, 3);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not persist files when upload finalization is incomplete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-file-finalize-error-'));
  const { store } = configuredStore(dir);
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/backend-api/files') return new Response(JSON.stringify({ file_id: 'file-bad', upload_url: 'https://upload.oaiusercontent.com/file-bad' }), { status: 200 });
    if (url === 'https://upload.oaiusercontent.com/file-bad') return new Response('', { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
    const response = await gatewayFetch(base, '/v1/files', { method: 'POST', body: form });
    assert.equal(response.status, 502);
    assert.equal(store.listFiles().length, 0);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects unsafe provider upload URLs before fetching them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-file-ssrf-'));
  const { store } = configuredStore(dir);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ file_id: 'file-ssrf', upload_url: 'https://[::1]/target' }), { status: 200 });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', new Blob(['x']), 'x.txt');
    const response = await gatewayFetch(base, '/v1/files', { method: 'POST', body: form });
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes public transcription multipart fields and response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-audio-'));
  const { store } = configuredStore(dir);
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(new URL(url).pathname, '/backend-api/transcribe');
    const form = await new Request('http://upstream', { method: 'POST', body: options.body }).formData();
    assert.equal(form.get('file').name, 'audio.wav');
    assert.equal(await form.get('file').text(), 'wave-bytes');
    assert.equal(form.get('prompt'), 'Shopee');
    assert.deepEqual(form.getAll('keywords[]'), ['alpha', 'beta']);
    assert.deepEqual(form.getAll('languages[]'), ['en', 'vi']);
    assert.equal(form.get('model'), 'gpt-4o-transcribe');
    assert.equal(form.has('response_format'), false);
    return new Response(JSON.stringify({ text: 'hello', languages: ['en'], duration: 1.2 }), { status: 200 });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const form = new FormData();
    form.append('model', 'gpt-transcribe');
    form.append('file', new Blob(['wave-bytes'], { type: 'audio/wav' }), 'secret-name.wav');
    form.append('prompt', 'Shopee');
    form.append('keywords[]', 'alpha');
    form.append('keywords[]', 'beta');
    form.append('languages[]', 'en');
    form.append('languages[]', 'vi');
    form.append('response_format', 'json');
    const response = await gatewayFetch(base, '/v1/audio/transcriptions', { method: 'POST', body: form });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'hello', duration: 1.2 });

    const invalid = new FormData();
    invalid.append('model', 'whisper-1');
    invalid.append('file', new Blob(['x']), 'x.wav');
    const rejected = await gatewayFetch(base, '/v1/audio/transcriptions', { method: 'POST', body: invalid });
    assert.equal(rejected.status, 404);
    assert.equal(calls, 1);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('translates public image generations and edits through Responses SSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-images-'));
  const { store } = configuredStore(dir);
  const responseBodies = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/backend-api/codex/models') {
      return new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', input_modalities: ['text', 'image'] }] }), { status: 200 });
    }
    assert.equal(path, '/backend-api/codex/responses');
    responseBodies.push(JSON.parse(options.body));
    return new Response([
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"B64_IMAGE","revised_prompt":"better"}}',
      'data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"B64_IMAGE","revised_prompt":"better"}],"tool_usage":{"image_gen":{"input_tokens":7,"output_tokens":13}}}}',
      'data: [DONE]', ''
    ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { server, base } = await start(store, fetchImpl);
  try {
    const generation = await gatewayFetch(base, '/v1/images/generations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: 'a cat', size: '1024x1024', quality: 'low', n: 1 })
    });
    const generated = await generation.json();
    assert.equal(generation.status, 200);
    assert.deepEqual(generated.data, [{ b64_json: 'B64_IMAGE', revised_prompt: 'better' }]);
    assert.deepEqual(generated.usage, { input_tokens: 7, output_tokens: 13, total_tokens: 20 });
    assert.equal(responseBodies[0].model, 'gpt-5.6-sol');
    assert.deepEqual(responseBodies[0].input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a cat' }] }]);
    assert.deepEqual(responseBodies[0].tools, [{ type: 'image_generation', model: 'gpt-image-1', size: '1024x1024', quality: 'low' }]);

    const edit = new FormData();
    edit.append('model', 'gpt-image-1');
    edit.append('prompt', 'make blue');
    edit.append('image', new Blob([Buffer.from([1, 2, 3])], { type: 'image/png' }), 'private.png');
    edit.append('mask', new Blob([Buffer.from([4, 5])], { type: 'image/png' }), 'mask.png');
    const edited = await gatewayFetch(base, '/v1/images/edits', { method: 'POST', body: edit });
    assert.equal(edited.status, 200);
    const content = responseBodies[1].input[0].content;
    assert.match(content[0].text, /transparent mask/);
    assert.equal(content[1].image_url, 'data:image/png;base64,AQID');
    assert.equal(content[2].image_url, 'data:image/png;base64,BAU=');

    const invalid = await gatewayFetch(base, '/v1/images/generations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: 'bad', size: '2048x2048' })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.param, 'size');
    assert.equal(responseBodies.length, 2);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redacts public image provider 5xx errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-image-errors-'));
  const { store } = configuredStore(dir);
  const fetchImpl = async (url) => new URL(url).pathname === '/backend-api/codex/models'
    ? new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', input_modalities: ['image'] }] }), { status: 200 })
    : new Response(JSON.stringify({ secret: 'provider-internal-secret' }), { status: 500 });
  const { server, base } = await start(store, fetchImpl);
  try {
    const response = await gatewayFetch(base, '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-1-mini', prompt: 'x' }) });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(JSON.stringify(body).includes('provider-internal-secret'), false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('projects provider-controlled invalid image SSE failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-image-sse-errors-'));
  const { store } = configuredStore(dir);
  const fetchImpl = async (url) => new URL(url).pathname === '/backend-api/codex/models'
    ? new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', input_modalities: ['image'] }] }), { status: 200 })
    : new Response('data: {"type":"response.output_item.done","item":{"type":"image_generation_call","status":"failed","error":{"type":"invalid_request_error","code":"provider_secret","message":"private provider message","param":"secret"}}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const { server, base } = await start(store, fetchImpl);
  try {
    const response = await gatewayFetch(base, '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-1-mini', prompt: 'x' }) });
    assert.equal(response.status, 400);
    assert.deepEqual((await response.json()).error, { type: 'invalid_request_error', code: 'provider_secret', message: 'private provider message', param: 'secret' });
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshes and retries a rejected upstream WebSocket handshake', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-refresh-'));
  const store = new Store(dir);
  const input = codex();
  const authJson = JSON.parse(input.authJson);
  authJson.tokens.refresh_token = 'refresh-token';
  input.authJson = JSON.stringify(authJson);
  const upstream = store.create(input);
  store.setCap(upstream.id, { capDollars: 100 });

  const upstreamAuth = [];
  const targetServer = createServer();
  const targetWs = new WebSocketServer({ noServer: true });
  targetWs.on('connection', (socket) => socket.on('message', () => socket.send(JSON.stringify({ type: 'response.output_text.delta', model: 'gpt-5.6-sol', delta: 'ok' }))));
  targetServer.on('upgrade', (request, socket, head) => {
    upstreamAuth.push(request.headers.authorization);
    if (request.headers.authorization !== 'Bearer rotated-token') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    targetWs.handleUpgrade(request, socket, head, (client) => targetWs.emit('connection', client, request));
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));

  const fetchImpl = async (url) => {
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    return new Response(JSON.stringify({ access_token: 'rotated-token', expires_in: 3600 }), { status: 200 });
  };
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl }));
  const relay = attachWebSocketProxy(gateway, {
    store, apiKey: API_KEY, fetchImpl,
    websocketUrl: () => `ws://127.0.0.1:${targetServer.address().port}`
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const message = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      client.once('open', () => client.send('{"type":"response.create","model":"gpt-5.6-sol","input":"retry-me"}'));
      client.once('message', (data) => { resolve(data.toString()); client.close(); });
      client.once('error', reject);
    });
    assert.equal(JSON.parse(message).model, 'gpt-5.6-sol');
    assert.equal(upstreamAuth.length, 2);
    assert.match(upstreamAuth[0], /^Bearer header\./);
    assert.equal(upstreamAuth[1], 'Bearer rotated-token');
    assert.equal(store.credentials(upstream.id).accessToken, 'rotated-token');
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => targetWs.close(resolve));
    await close(targetServer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reuses a public Responses WebSocket across completed turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-turns-'));
  const { store } = configuredStore(dir);
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => socket.on('message', (data) => {
    const request = JSON.parse(data);
    socket.send(JSON.stringify({ type: 'response.completed', response: { id: request.input[0].content[0].text, status: 'completed', output: [] } }));
  }));
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'first' })));
      client.on('message', (data) => {
        received.push(JSON.parse(data));
        if (received.length === 1) client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'second' }));
        else { client.close(); resolve(received); }
      });
      client.once('error', reject);
    });
    assert.deepEqual(messages.map((message) => [message.response.id, message.sequence_number]), [['first', 0], ['second', 0]]);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails over a public WebSocket turn before output and settles its terminal usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-failover-'));
  const store = new Store(dir);
  const first = store.create(codex({ email: 'first-ws@example.com', accountId: 'first-ws' }));
  const second = store.create(codex({ email: 'second-ws@example.com', accountId: 'second-ws' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const firstToken = store.credentials(first.id).accessToken;
  const upstreamAuth = [];
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket, request) => {
    upstreamAuth.push(request.headers.authorization);
    socket.on('message', (data) => {
      if (request.headers.authorization === `Bearer ${firstToken}`) return socket.send(JSON.stringify({ type: 'response.failed', error: { code: 'rate_limit_exceeded', message: 'provider-secret' } }));
      const input = JSON.parse(data).input[0].content[0].text;
      socket.send(JSON.stringify({ type: 'response.completed', response: { id: `ws-${input}`, status: 'completed', output: [], ...(input === 'fallback' ? { usage: { input_tokens: 1, output_tokens: 1 } } : {}) } }));
    });
  });
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const apiKeyId = store.authenticateApiKey(API_KEY).id;
  try {
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}`, 'x-codex-session-id': 'ws-failover-session' } });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'fallback' })));
      client.on('message', (data) => {
        received.push(JSON.parse(data));
        if (received.length === 1) client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'next' }));
        else { client.close(); resolve(received); }
      });
      client.once('error', reject);
    });
    assert.deepEqual(messages.map((message) => message.response.id), ['ws-fallback', 'ws-next']);
    assert.equal(upstreamAuth.length, 2);
    assert.equal(store.sessionUpstream('ws-failover-session', undefined, apiKeyId), second.id);
    assert.equal(store.getPublic(first.id).spending.spentDollars, 0);
    assert.deepEqual(Object.values(store.get(second.id).spending.settlements).map(({ settledCostMicros, costSource }) => ({ settledCostMicros, costSource })), [{ settledCostMicros: 35, costSource: 'pricing_snapshot' }]);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovers a reusable public WebSocket after a post-output interruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-recover-'));
  const { store } = configuredStore(dir);
  let connections = 0;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket) => {
    connections += 1;
    socket.once('message', () => {
      if (connections === 1) {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'interrupted', status: 'in_progress' } }));
        setTimeout(() => socket.close(1011, 'interrupted'), 5);
      } else socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'recovered', status: 'completed', output: [] } }));
    });
  });
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, websocketUrl: () => `ws://127.0.0.1:${target.address().port}`, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const messages = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      const received = [];
      client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'first' })));
      client.on('message', (data) => {
        const message = JSON.parse(data);
        received.push(message);
        if (message.type === 'error') client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'second' }));
        if (message.response?.id === 'recovered') { client.close(); resolve(received); }
      });
      client.once('error', reject);
    });
    assert.deepEqual(messages.map((message) => message.type), ['response.created', 'error', 'response.completed']);
    assert.equal(connections, 2);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('closes oversized public WebSocket frames with code 1009', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-frame-limit-'));
  const { store } = configuredStore(dir);
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, { store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const code = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      client.once('open', () => client.send(Buffer.alloc(2 * 1024 * 1024 + 1)));
      client.once('close', resolve);
      client.once('error', () => {});
    });
    assert.equal(code, 1009);
  } finally {
    relay.close();
    await close(gateway);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relays Responses websocket frames, required upstream headers, and rejects bad API keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-ws-'));
  const { store } = configuredStore(dir);
  let targetHeaders;
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  target.on('connection', (socket, request) => {
    targetHeaders = request.headers;
    socket.on('message', (data) => {
      let frame;
      try { frame = JSON.parse(data); } catch { return socket.send(data); }
      if (frame.generate === true) socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'public-ws', status: 'completed', output: [] } }));
      else socket.send(data);
    });
  });
  await new Promise((resolve) => target.once('listening', resolve));
  const gateway = createServer(createApp({ store, apiKey: API_KEY, fetchImpl: async () => new Response('{}') }));
  const relay = attachWebSocketProxy(gateway, {
    store, apiKey: API_KEY,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
    fetchImpl: async () => new Response('{}')
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    let publicModelsEtag;
    const message = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      client.once('upgrade', (response) => { publicModelsEtag = response.headers['x-models-etag']; });
      client.once('open', () => client.send('{"type":"response.create","model":"gpt-5.6-sol","input":"hello"}'));
      client.once('message', (data) => { resolve(data.toString()); client.close(); });
      client.once('error', reject);
    });
    assert.deepEqual(JSON.parse(message), { type: 'response.completed', response: { id: 'public-ws', status: 'completed', output: [] }, sequence_number: 0 });
    assert.equal(publicModelsEtag, undefined);
    assert.equal(targetHeaders['openai-beta'], 'responses_websockets=2026-02-06');
    assert.match(targetHeaders.authorization, /^Bearer header\./);
    assert.equal(targetHeaders['chatgpt-account-id'], 'acct-routes');

    const models = await gatewayFetch(`http://127.0.0.1:${gateway.address().port}`, '/backend-api/codex/models');
    const expectedModelsEtag = models.headers.get('etag');
    await models.text();
    let backendModelsEtag;
    const backendMessage = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/backend-api/codex/responses`, { headers: { authorization: `Bearer ${API_KEY}` } });
      client.once('upgrade', (response) => { backendModelsEtag = response.headers['x-models-etag']; });
      client.once('open', () => client.send('backend-frame'));
      client.once('message', (data) => { resolve(data.toString()); client.close(); });
      client.once('error', reject);
    });
    assert.equal(backendMessage, 'backend-frame');
    assert.equal(backendModelsEtag, expectedModelsEtag);

    const status = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: 'Bearer wrong' } });
      client.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      client.once('error', reject);
    });
    assert.equal(status, 401);
  } finally {
    relay.close();
    await close(gateway);
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
