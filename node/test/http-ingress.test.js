import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { gzipSync, deflateSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const API_KEY = 'ingress-key';
const ZSTD_BODY = Buffer.from('KLUv/SAmMQEAeyJtb2RlbCI6ImdwdC01LjYtc29sIiwiaW5wdXQiOiJ6c3RkIn0=', 'base64');

function configuredStore(dir) {
  const store = new Store(dir);
  const upstream = store.create({ type: 'codex', accessToken: 'ingress-token' });
  store.setCap(upstream.id, { capDollars: 100 });
  return store;
}

async function runningServer(store, fetchImpl, ingress) {
  const server = createServer(createApp({ store, fetchImpl, apiKey: API_KEY, ingress }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function compressedRequest(base, encoding, body, path = '/backend-api/codex/responses') {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', 'content-encoding': encoding },
    body
  });
  return { response, body: await response.json() };
}

async function close(server, dir) {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}

test('decodes gzip, deflate, and zstd proxy JSON before dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compression-'));
  const received = [];
  const fetchImpl = async (_url, options) => {
    received.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: 'resp-compressed', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { server, base } = await runningServer(configuredStore(dir), fetchImpl);
  try {
    const gzipPayload = { model: 'gpt-5.6-sol', input: 'gzip' };
    const deflatePayload = { model: 'gpt-5.6-sol', input: 'deflate' };
    for (const [encoding, bytes] of [
      ['gzip', gzipSync(JSON.stringify(gzipPayload))],
      ['deflate', deflateSync(JSON.stringify(deflatePayload))],
      ['zstd', ZSTD_BODY]
    ]) {
      const result = await compressedRequest(base, encoding, bytes);
      assert.equal(result.response.status, 200, encoding);
    }
    assert.deepEqual(received.map((payload) => payload.input), ['gzip', 'deflate', 'zstd']);
  } finally {
    await close(server, dir);
  }
});

test('accepts a valid Zstd frame with an eight-byte content-size field', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-zstd-fcs-'));
  let calls = 0;
  const { server, base } = await runningServer(configuredStore(dir), async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: 'empty-zstd', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const emptyFrame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
    const result = await compressedRequest(base, 'zstd', emptyFrame);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.id, 'empty-zstd');
    assert.ok(calls >= 1);
  } finally {
    await close(server, dir);
  }
});

test('returns bounded and sanitized compressed-body errors', async () => {
  const cases = [
    {
      name: 'unsupported encoding', ingress: {}, encoding: 'br', bytes: Buffer.from('secret'),
      status: 415, code: 'unsupported_content_encoding'
    },
    {
      name: 'compressed limit', ingress: { maxCompressedBodyBytes: 4 }, encoding: 'gzip', bytes: gzipSync('{}'),
      status: 413, code: 'compressed_request_too_large'
    },
    {
      name: 'decompressed limit', ingress: { maxDecompressedBodyBytes: 32, maxDecompressionRatio: 1_000 }, encoding: 'gzip', bytes: gzipSync(JSON.stringify({ model: 'gpt', input: 'a'.repeat(100) })),
      status: 413, code: 'decompressed_request_too_large'
    },
    {
      name: 'ratio limit', ingress: { maxDecompressedBodyBytes: 10_000, maxDecompressionRatio: 2 }, encoding: 'gzip', bytes: gzipSync(JSON.stringify({ model: 'gpt', input: 'a'.repeat(1_000) })),
      status: 413, code: 'decompression_ratio_exceeded'
    },
    {
      name: 'invalid compressed body', ingress: {}, encoding: 'gzip', bytes: Buffer.from('provider secret, not gzip'),
      status: 400, code: 'invalid_request'
    },
    {
      name: 'decompression timeout', ingress: { decompressionTimeoutMs: 0 }, encoding: 'gzip', bytes: gzipSync('{}'),
      status: 408, code: 'request_decompression_timeout'
    }
  ];

  for (const fixture of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compression-error-'));
    let calls = 0;
    const { server, base } = await runningServer(configuredStore(dir), async () => { calls += 1; return new Response('{}'); }, fixture.ingress);
    try {
      const result = await compressedRequest(base, fixture.encoding, fixture.bytes);
      assert.equal(result.response.status, fixture.status, fixture.name);
      assert.equal(result.body.error.type, 'invalid_request_error', fixture.name);
      assert.equal(result.body.error.code, fixture.code, fixture.name);
      assert.equal(JSON.stringify(result.body).includes('secret'), false, fixture.name);
      assert.equal(calls, 0, fixture.name);
    } finally {
      await close(server, dir);
    }
  }
});

test('rejects an oversized Zstd window before invoking the decoder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-zstd-window-'));
  let calls = 0;
  const { server, base } = await runningServer(configuredStore(dir), async () => { calls += 1; return new Response('{}'); });
  try {
    const oversizedWindow = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x88]); // 128 MiB window, no payload.
    for (const bytes of [oversizedWindow, Buffer.concat([ZSTD_BODY, oversizedWindow])]) {
      const result = await compressedRequest(base, 'zstd', bytes);
      assert.equal(result.response.status, 413);
      assert.deepEqual(result.body.error, { type: 'invalid_request_error', code: 'decompressed_request_too_large', message: 'decompressed request body is too large', param: null });
    }
    assert.equal(calls, 0);
  } finally {
    await close(server, dir);
  }
});

test('rejects compressed non-JSON media and JSON values that are not objects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compression-shape-'));
  const { server, base } = await runningServer(configuredStore(dir), async () => { throw new Error('must not dispatch'); });
  try {
    for (const [contentType, payload, status, code] of [
      ['text/plain', gzipSync('plain'), 415, 'unsupported_media_type'],
      ['application/json', gzipSync('[]'), 400, 'invalid_request'],
      ['application/json', gzipSync('{not-json'), 400, 'invalid_request']
    ]) {
      const response = await fetch(base + '/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': contentType, 'content-encoding': 'gzip' }, body: payload
      });
      assert.equal(response.status, status, contentType);
      if (contentType === 'application/json') assert.equal(await response.text(), 'Bad Request');
      else assert.equal((await response.json()).error.code, code, contentType);
    }
  } finally {
    await close(server, dir);
  }
});

test('accepts the decompressed boundary and rejects the next byte', async () => {
  const exact = JSON.stringify({ model: 'gpt-5.6-sol', input: 'a'.repeat(64) });
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compression-boundary-'));
  let proxyCalls = 0;
  const { server, base } = await runningServer(configuredStore(dir), async (url) => {
    if (new URL(url).pathname === '/backend-api/codex/responses') proxyCalls += 1;
    return new Response(JSON.stringify({ id: 'boundary', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, { maxDecompressedBodyBytes: Buffer.byteLength(exact), maxDecompressionRatio: 1_000 });
  try {
    const accepted = await compressedRequest(base, 'gzip', gzipSync(exact));
    assert.equal(accepted.response.status, 200);
    const rejected = await compressedRequest(base, 'gzip', gzipSync(JSON.stringify({ model: 'gpt-5.6-sol', input: 'a'.repeat(65) })));
    assert.equal(rejected.response.status, 413);
    assert.equal(rejected.body.error.code, 'decompressed_request_too_large');
    assert.equal(proxyCalls, 1);
  } finally {
    await close(server, dir);
  }
});

test('times out a slow compressed-body read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compression-read-timeout-'));
  const { server, base } = await runningServer(configuredStore(dir), async () => { throw new Error('must not dispatch'); }, { decompressionTimeoutMs: 20 });
  try {
    const url = new URL(base);
    const compressed = gzipSync(JSON.stringify({ model: 'gpt-5.6-sol', input: 'slow' }));
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: url.hostname, port: url.port, path: '/v1/responses', method: 'POST', headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', 'content-encoding': 'gzip', connection: 'close' } }, (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { data += chunk; });
        response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
      });
      req.once('error', reject);
      req.write(compressed.subarray(0, 1));
      setTimeout(() => req.end(compressed.subarray(1)), 80);
    });
    assert.equal(result.status, 408);
    assert.deepEqual(result.body.error, { type: 'invalid_request_error', code: 'request_decompression_timeout', message: 'request body decompression timed out', param: null });
  } finally {
    await close(server, dir);
  }
});

test('authenticates compressed proxy requests before reading their bodies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compression-auth-'));
  const { server, base } = await runningServer(configuredStore(dir), async () => { throw new Error('must not dispatch'); }, { maxCompressedBodyBytes: 1 });
  try {
    const response = await fetch(base + '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gzipSync('{not-json')
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.type, 'authentication_error');
  } finally {
    await close(server, dir);
  }
});
