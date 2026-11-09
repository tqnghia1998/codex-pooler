import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable, PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { terminalRuntimeAuthDenial } from '../src/runtime-auth.js';
import { validatedUploadHeaders } from '../src/compatibility.js';
import { classifyHttpResponse } from '../src/upstream-outcomes.js';
import { readRequestBody } from '../src/http-ingress.js';
import { IMAGE_PRICING } from '../src/image-pricing.js';
import { beginNativeHttpRequest } from '../src/native-http-fence.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
const payload = { model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'synthetic' }], stream: true };
const wire = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function fixture(t, fetchImpl, options = {}) {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 7) });
  const upstream = store.create({ type: 'codex', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' });
  store.setCap(upstream.id, { capDollars: 100 });
  const server = createServer(createApp({ store, apiKey: 'key', fetchImpl, ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.sqlite.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = payload, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { authorization: 'Bearer key', ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body instanceof FormData ? body : JSON.stringify(body)
  });
  return { store, upstream, post };
}

const terminalCodes = ['runtime_assertion_invalid', 'runtime_instance_paused', 'runtime_instance_revoked', 'invalid_agent_instance_assertion'];
test('bounded canonical runtime identity classifier distinguishes terminal and repairable failures', () => {
  for (const status of [401, 403]) for (const code of terminalCodes) {
    const body = { error: { code } };
    const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
    for (const response of [{ status, headers: new Headers({ 'x-error-json': encoded }) }, { statusCode: status, headers: { 'x-error-json': encoded } }]) {
      assert.equal(terminalRuntimeAuthDenial(response), true);
      assert.equal(classifyHttpResponse(response).class, 'neutral');
    }
    assert.equal(terminalRuntimeAuthDenial({ status }, Buffer.from(JSON.stringify(body))), true);
    for (const bad of [encoded + '\n', encoded.replace(/=+$/, '') + '!', 'A'.repeat(8193), Buffer.from(JSON.stringify({ code })).toString('base64')]) {
      assert.equal(terminalRuntimeAuthDenial({ status, headers: { 'x-error-json': bad } }), false);
    }
  }
  for (const code of ['invalid_token', 'token_expired', 'runtime_verification_unavailable', 'unknown']) {
    assert.equal(terminalRuntimeAuthDenial({ status: 401 }, { error: { code } }), false);
  }
  assert.equal(terminalRuntimeAuthDenial({ status: 200 }, { error: { code: terminalCodes[0] } }), false);
});

test('upload header normalization rejects identity, framing, duplicates and malformed values', () => {
  assert.deepEqual(validatedUploadHeaders(null), {});
  assert.deepEqual({ ...validatedUploadHeaders({ 'Content-Type': 'custom/type', 'x-storage-token': 'signed' }) }, { 'content-type': 'custom/type', 'x-storage-token': 'signed' });
  for (const invalid of [[], 'bad', 1, { Authorization: 'secret' }, { HOST: 'evil' }, { 'content-length': '2' }, { Cookie: 'secret' },
    { Connection: 'x-storage-token' }, { 'X-Test': 'a', 'x-test': 'b' }, { 'bad name': 'a' }, { 'x-test': 'a\r\nb' }, { 'x-test': 1 }, { 'x-test': 'é' }]) {
    assert.equal(validatedUploadHeaders(invalid), null);
  }
});

test('public file upload sends signed storage headers, overrides defaults, and rejects bad headers before PUT/finalize', async t => {
  let headers = { 'Content-Type': 'application/custom', 'X-Ms-Blob-Type': 'CustomBlob', 'x-storage-token': 'synthetic-signature' };
  let puts = 0, finalized = 0;
  const f = await fixture(t, async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/backend-api/files') return json({ file_id: 'file-1', upload_url: 'https://upload.oaiusercontent.com/file-1', upload_headers: headers });
    if (options.method === 'PUT') {
      puts++;
      assert.equal(options.headers['content-type'], 'application/custom');
      assert.equal(options.headers['x-ms-blob-type'], 'CustomBlob');
      assert.equal(options.headers['x-storage-token'], 'synthetic-signature');
      assert.equal(options.headers.authorization, undefined);
      return new Response('');
    }
    finalized++;
    return json({ status: 'success', download_url: 'https://download.oaiusercontent.com/file-1' });
  });
  const form = () => { const data = new FormData(); data.set('purpose', 'user_data'); data.set('file', new Blob(['hello']), 'notes.txt'); return data; };
  assert.equal((await f.post('/v1/files', form())).status, 200);
  headers = { authorization: 'must-never-send' };
  assert.equal((await f.post('/v1/files', form())).status, 502);
  assert.equal(puts, 1); assert.equal(finalized, 1);
});

for (const path of ['/backend-api/transcribe', '/backend-api/codex/responses', '/v1/responses', '/backend-api/codex/responses/compact', '/v1/audio/transcriptions']) {
  test(`runtime denial skips credential refresh for ${path}`, async t => {
    let refreshes = 0;
    const f = await fixture(t, async url => {
      if (String(url).includes('oauth')) { refreshes++; return json({ access_token: 'replacement' }); }
      return json({ error: { code: 'runtime_instance_revoked' } }, 401);
    });
    let body = payload;
    if (path === '/v1/audio/transcriptions') {
      body = new FormData(); body.set('model', 'gpt-4o-transcribe'); body.set('file', new Blob(['audio']), 'audio.wav');
    }
    const response = await f.post(path, body);
    assert.equal(response.status, 502);
    await response.text();
    assert.equal(refreshes, 0);
    assert.notEqual(f.store.get(f.upstream.id).tokenRefresh?.status, 'reauth_required');
  });
}

test('header-only runtime denials skip refresh and do not quarantine an account', async t => {
  let refreshes = 0;
  const f = await fixture(t, async url => {
    if (String(url).includes('oauth')) { refreshes++; throw new Error('must not refresh'); }
    return json({ error: { code: 'invalid_token' } }, 401, { 'x-error-json': Buffer.from(JSON.stringify({ error: { code: 'runtime_instance_paused' } })).toString('base64') });
  });
  assert.equal((await f.post('/v1/responses', { ...payload, stream: false })).status, 502);
  assert.equal(refreshes, 0);
  assert.notEqual(f.store.get(f.upstream.id).health?.status, 'reauth_required');
});

test('GPT Image 2.6 generations and edits preserve model, quality, dimensions and provider cost', async t => {
  const bodies = [];
  const f = await fixture(t, async (url, options) => {
    if (new URL(url).pathname.endsWith('/models')) return json({ models: [{ slug: payload.model, input_modalities: ['text', 'image'] }] });
    bodies.push(JSON.parse(options.body));
    return new Response(wire({ type: 'response.completed', response: { output: [{ type: 'image_generation_call', result: png }], usage: { price_cost_usd: 0.25 } } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  for (const model of Object.keys(IMAGE_PRICING)) {
    const response = await f.post('/v1/images/generations', { model, prompt: 'synthetic', quality: 'max', size: '2048x1024' });
    assert.equal(response.status, 200); assert.equal((await response.json()).data[0].b64_json, png);
    const edit = new FormData(); edit.set('model', model); edit.set('prompt', 'edit'); edit.set('quality', 'xhigh'); edit.set('image', new Blob(['input']), 'image.png');
    assert.equal((await f.post('/v1/images/edits', edit)).status, 200);
    assert.equal(bodies.at(-1).tools[0].model, model);
    const invalid = await f.post('/v1/images/generations', { model, prompt: 'synthetic', size: '2049x1024' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(IMAGE_PRICING[model], { textInput: 5, cachedTextInput: 1.25, imageInput: 8, cachedImageInput: 2, imageOutput: 30 });
  }
  assert.equal(Object.values(f.store.get(f.upstream.id).spending.settlements).reduce((total, item) => total + item.settledCostMicros, 0), 1_000_000);
});

test('slow plain, multipart and compressed reads have independent decode budgets', async () => {
  for (const encoding of ['', 'gzip']) {
    const data = encoding ? gzipSync('synthetic') : Buffer.from('synthetic');
    const req = new PassThrough(); req.headers = encoding ? { 'content-encoding': 'gzip', 'content-type': 'application/json' } : { 'content-type': 'multipart/form-data' };
    const promise = readRequestBody(req, { bodyReadTimeoutMs: 1000, decompressionTimeoutMs: 20 });
    req.write(data.subarray(0, 1));
    await new Promise(resolve => setTimeout(resolve, 60));
    req.end(data.subarray(1));
    assert.equal((await promise).toString(), 'synthetic');
  }
  const req = new PassThrough(); req.headers = {};
  const promise = readRequestBody(req, { bodyReadTimeoutMs: 10, decompressionTimeoutMs: 1000 });
  req.write('a');
  await assert.rejects(promise, { code: 'request_body_read_timeout' }); req.end();
  const compressed = Readable.from([gzipSync('synthetic')]); compressed.headers = { 'content-encoding': 'gzip', 'content-type': 'application/json' };
  await assert.rejects(readRequestBody(compressed, { bodyReadTimeoutMs: 1000, decompressionTimeoutMs: 0 }), { code: 'request_decompression_timeout' });
});

test('native exact HTTP duplicate is fenced before and after visible output; changed continuation remains admitted', async t => {
  let controller, calls = 0;
  let opened; const started = new Promise(resolve => { opened = resolve; });
  const f = await fixture(t, async () => {
    calls++;
    if (calls > 1) return json({ id: 'resample', output: [] });
    return new Response(new ReadableStream({ start(value) { controller = value; opened(); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const headers = { 'thread-id': 'thread-1' };
  const first = f.post('/backend-api/codex/responses', payload, headers);
  await started;
  const duplicate = await f.post('/backend-api/codex/v1/responses', payload, headers);
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error.code, 'duplicate_turn');
  controller.enqueue(Buffer.from(wire({ type: 'response.output_text.delta', delta: 'visible' })));
  const response = await first; const reader = response.body.getReader(); await reader.read();
  assert.equal((await f.post('/backend-api/codex/responses', payload, headers)).status, 409);
  assert.equal(calls, 1);
  const grown = { ...payload, input: [...payload.input, { role: 'assistant', content: 'visible' }] };
  assert.equal((await f.post('/backend-api/codex/responses', grown, headers)).status, 200);
  controller.enqueue(Buffer.from(wire({ type: 'response.completed', response: { id: 'first', output: [], usage: { input_tokens: 1, output_tokens: 1 } } })));
  controller.close(); while (!(await reader.read()).done) {}
  assert.equal((await f.post('/backend-api/codex/responses', payload, headers)).status, 200);
  assert.equal(calls, 3);
});

test('native HTTP fences isolate scopes, principals, threads and compaction and release idempotently', t => {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 1) }); t.after(() => store.sqlite.close());
  const req = { headers: { 'thread-id': 'one' }, proxyAuth: { scopeId: 'a', id: 'principal' } };
  const begin = (r = req, path = '/backend-api/codex/responses') => beginNativeHttpRequest(store, r, path, payload);
  const release = begin(); assert.throws(begin, { code: 'duplicate_turn' });
  for (const r of [{ ...req, proxyAuth: { scopeId: 'b', id: 'principal' } }, { ...req, proxyAuth: { scopeId: 'a', id: 'another' } }, { ...req, headers: { 'thread-id': 'two' } }]) begin(r)();
  begin(req, '/backend-api/codex/responses/compact')();
  release(); release(); const newer = begin(); release(); assert.throws(begin, { code: 'duplicate_turn' }); newer();
});

test('native HTTP fence releases failed dispatches and rejects capacity without evicting a live request', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('synthetic failure'); });
  for (let index = 0; index < 2; index++) assert.equal((await f.post('/backend-api/codex/responses')).status, 502);
  assert.equal(calls, 2);
  const req = { headers: {}, proxyAuth: { id: 'capacity' } };
  const leases = [];
  for (let index = 0; index < 4096; index++) leases.push(beginNativeHttpRequest(f.store, req, '/backend-api/codex/responses', { index }));
  assert.throws(() => beginNativeHttpRequest(f.store, req, '/backend-api/codex/responses', { index: 4096 }), { code: 'native_request_capacity' });
  assert.throws(() => beginNativeHttpRequest(f.store, req, '/backend-api/codex/responses', { index: 0 }), { code: 'duplicate_turn' });
  leases.forEach(release => release());
});


test('native HTTP retry changing secondary window/session metadata cannot bypass a live thread fence', t => {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 9) });
  t.after(() => store.sqlite.close());
  const request = { headers: { 'thread-id': 'thread', 'session-id': 'session-1', 'x-codex-window-id': 'window-1' }, proxyAuth: { id: 'principal' } };
  const release = beginNativeHttpRequest(store, request, '/backend-api/codex/responses', payload);
  try {
    for (const secondary of [
      { 'session-id': 'session-2' }, { 'x-codex-window-id': 'window-2' },
      { 'x-codex-turn-metadata': '{"attempt":2}' }, { 'x-codex-window-id': undefined }
    ]) assert.throws(() => beginNativeHttpRequest(store, { ...request, headers: { ...request.headers, ...secondary } }, '/backend-api/codex/responses', payload), { code: 'duplicate_turn' });
    const independent = beginNativeHttpRequest(store, { ...request, headers: { ...request.headers, 'thread-id': 'other-thread' } }, '/backend-api/codex/responses', payload);
    independent();
  } finally { release(); }
});
