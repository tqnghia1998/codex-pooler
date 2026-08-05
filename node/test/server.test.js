import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, refreshAllQuotas, start } from '../src/server.js';
import { Store } from '../src/store.js';

async function runningServer(store, options = {}) {
  const server = createServer(createApp({ store, ...options }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function statusWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/healthz', headers: { host } }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}

test('automatically refreshes Codex quotas for all stored upstreams', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-poll-'));
  try {
    const store = new Store(dir);
    const created = store.create({ type: 'codex', name: 'Poll test', accessToken: 'token' });
    await refreshAllQuotas(store, {
      fetchImpl: async () => new Response(JSON.stringify({
        spend_control: { individual_limit: {
          limit: '32500', remaining: '30667.5', used_percent: 6, remaining_percent: 94,
          reset_at: 1_788_220_800
        }}
      }), { status: 200 })
    });
    const quota = store.getPublic(created.id).quota;
    assert.equal(quota.remainingPercent, 94);
    assert.equal(quota.remainingDollars, 1226.7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshes quotas with bounded concurrency', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-bounded-poll-'));
  try {
    const store = new Store(dir);
    for (let index = 0; index < 4; index += 1) store.create({ type: 'codex', accessToken: `token-${index}` });
    let active = 0;
    let peak = 0;
    await refreshAllQuotas(store, {
      fetchImpl: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 2_592_000 } } }), { status: 200 });
      }
    });
    assert.equal(peak, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start refreshes quota immediately, repeats on the configured interval, and stops cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-start-poll-'));
  const store = new Store(dir);
  store.create({ type: 'codex', accessToken: 'poll-token' });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 2_592_000 } } }), { status: 200 });
  };
  const server = start(0, { store, apiKey: 'poll-key', fetchImpl, pollIntervalMs: 10 });
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const deadline = Date.now() + 1_000;
    while (calls < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(calls >= 2);
    assert.equal(store.list()[0].quota.remainingPercent, 90);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const afterClose = calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, afterClose);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('streams upstream changes after the initial ready event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-upstream-events-'));
  const store = new Store(dir);
  const upstream = store.create({ type: 'compass', projectId: 'events-project', projectKey: 'secret' });
  const { server, base } = await runningServer(store);
  try {
    const events = await new Promise((resolve, reject) => {
      const req = httpRequest(`${base}/api/upstreams/events`, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (!body.includes('event: ready')) return;
          store.setCap(upstream.id, { capDollars: 100 });
          if (body.includes('event: upstreams')) {
            req.destroy();
            resolve(body);
          }
        });
      });
      req.once('error', reject);
      req.end();
    });
    assert.match(events, /event: ready/);
    assert.match(events, /event: upstreams/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('streams upstream changes when a request settlement updates spending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-settlement-events-'));
  const store = new Store(dir);
  const upstream = store.create({ type: 'compass', projectId: 'settlement-events', projectKey: 'secret' });
  store.setCap(upstream.id, { capDollars: 1 });
  const apiKey = store.configureApiKey('settlement-events-key');
  const request = store.reserveGatewayRequest({ apiKeyId: apiKey.id, endpoint: '/v1/responses' });
  const attempt = store.beginGatewayAttempt(request.id, upstream.id);
  const { server, base } = await runningServer(store);
  try {
    let finalized = false;
    const events = await new Promise((resolve, reject) => {
      const req = httpRequest(`${base}/api/upstreams/events`, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.includes('event: ready') && !finalized) {
            finalized = true;
            store.finalizeGatewayRequest({ requestId: request.id, attemptId: attempt.id, status: 'succeeded', usage: { totalTokens: 1 }, settledCostMicros: 1, costSource: 'upstream_reported' });
          }
          if (body.includes('event: upstreams')) {
            req.destroy();
            resolve(body);
          }
        });
      });
      req.once('error', reject);
      req.end();
    });
    assert.match(events, /event: upstreams/);
    assert.equal(store.getPublic(upstream.id).spending.spentCostMicros, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serves unauthenticated health checks but protects usage with the single API key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-health-'));
  const store = new Store(dir);
  const upstream = store.create({ type: 'compass', projectId: 'health-project', projectKey: 'secret' });
  store.setCap(upstream.id, { capDollars: 100 });
  const server = createServer(createApp({ store, apiKey: 'health-key' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal(await statusWithHost(server.address().port, 'attacker.example'), 403);
    const badOrigin = await fetch(base + '/api/upstreams', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ type: 'compass', projectId: 'blocked', projectKey: 'blocked' })
    });
    assert.equal(badOrigin.status, 403);
    const crossPortOrigin = await fetch(base + '/api/upstreams', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:65535' },
      body: JSON.stringify({ type: 'compass', projectId: 'blocked-cross-port', projectKey: 'blocked' })
    });
    assert.equal(crossPortOrigin.status, 403);
    const rejected = await fetch(base + '/v1/usage');
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('www-authenticate'), 'Bearer');
    const usage = await fetch(base + '/v1/usage', { headers: { authorization: 'Bearer health-key' } });
    assert.equal(usage.status, 200);
    const body = await usage.json();
    assert.deepEqual(body, { request_count: 0, total_tokens: 0, cached_input_tokens: 0, total_cost_usd: 0, total_cost_status: 'unpriced', limits: [], upstream_limits: [] });
    const filtered = await fetch(base + '/v1/usage?start_time=1', { headers: { authorization: 'Bearer health-key' } });
    assert.equal(filtered.status, 400);
    assert.equal((await filtered.json()).error.code, 'unsupported_parameter');
    assert.throws(() => start(0, { store, apiKey: '' }), /CODEX_POOLER_API_KEY is required/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns client errors for invalid management request bodies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-body-errors-'));
  const { server, base } = await runningServer(new Store(dir));
  try {
    const invalid = await request(base, '/api/upstreams', { method: 'POST', body: '{' });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.data.error.code, 'invalid_request');

    const invalidUpstream = await request(base, '/api/upstreams', { method: 'POST', body: JSON.stringify({ type: 'invalid' }) });
    assert.equal(invalidUpstream.response.status, 400);
    assert.equal(invalidUpstream.data.error.code, 'invalid_request');

    const oversized = await request(base, '/api/upstreams', { method: 'POST', body: JSON.stringify({ value: 'x'.repeat(2 * 1024 * 1024) }) });
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.data.error.code, 'request_too_large');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serves the CRUD, priced usage, cap, and eligibility API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-http-'));
  const providerFetch = async () => new Response(JSON.stringify({ retcode: 0, data: { project: { budget_type: 'recurring', quota_detail: { applied_balance: 100, balance: 75 } } } }), { status: 200 });
  const { server, base } = await runningServer(new Store(dir), { fetchImpl: providerFetch, compassGatewayToken: 'gateway-token' });
  try {
    const created = await request(base, '/api/upstreams', {
      method: 'POST',
      body: JSON.stringify({ type: 'compass', name: 'HTTP test', projectId: 'p', projectKey: 'secret' })
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.data.upstream.name, 'p');
    assert.equal(created.data.upstream.baseUrl, undefined);
    const id = created.data.upstream.id;
    const list = await request(base, '/api/upstreams');
    assert.equal(list.data.upstreams.length, 1);
    const show = await request(base, `/api/upstreams/${id}`);
    assert.equal(show.data.upstream.id, id);
    const patched = await request(base, `/api/upstreams/${id}`, { method: 'PATCH', body: JSON.stringify({ projectId: 'project-patched' }) });
    assert.equal(patched.data.upstream.name, 'project-patched');
    const refreshed = await request(base, `/api/upstreams/${id}/refresh-quota`, { method: 'POST', body: '{}' });
    assert.equal(refreshed.data.upstream.quota.remainingPercent, 75);

    const cap = await request(base, `/api/upstreams/${id}/cap`, { method: 'PUT', body: JSON.stringify({ capDollars: 100 }) });
    assert.equal(cap.data.upstream.spending.capCredits, 2500);
    const usage = await request(base, `/api/upstreams/${id}/usage`, {
      method: 'POST',
      body: JSON.stringify({ attemptId: 'a', startedAt: new Date(Date.now() + 1).toISOString(), costUsd: '4', costSource: 'pricing_snapshot' })
    });
    assert.equal(usage.data.upstream.spending.spentDollars, 4);
    const spending = await request(base, `/api/upstreams/${id}/spending`);
    assert.equal(spending.data.spending.spentDollars, 4);

    const eligibility = await request(base, '/api/upstreams/eligibility');
    assert.equal(eligibility.response.status, 200);
    assert.equal(eligibility.data.eligible.length, 1);

    const bulk = await request(base, '/api/spending-caps/bulk', {
      method: 'POST',
      body: JSON.stringify({ target: 'all', capDollars: 200 })
    });
    assert.equal(bulk.response.status, 200);
    assert.equal(bulk.data.updated.length, 1);
    assert.equal(bulk.data.updated[0].spending.capDollars, 200);

    const removed = await request(base, `/api/upstreams/${id}`, { method: 'DELETE' });
    assert.equal(removed.response.status, 204);
    const missing = await request(base, `/api/upstreams/${id}`);
    assert.equal(missing.response.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
