import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, refreshAllQuotas, start } from '../src/server.js';
import { Store } from '../src/store.js';
import { CodexHostHealth } from '../src/codex-host-health.js';
import { upstreamPacerForStore } from '../src/upstream-pacer.js';
import { Readiness } from '../src/readiness.js';

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

test('serves the Relaydeck favicon', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relaydeck-favicon-'));
  const { server, base } = await runningServer(new Store(dir), { apiKey: 'test-key' });
  try {
    const response = await fetch(`${base}/assets/relaydeck.svg`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    for (let index = 0; index < 4; index += 1) store.create({ type: 'codex', accessToken: `token-${index}`, accountId: `acc-${index}` });
    let active = 0;
    let peak = 0;
    let changes = 0;
    store.onUpstreamsChange(() => { changes += 1; });
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
    assert.equal(changes, 1);
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
    const ready = await fetch(base + '/readyz');
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).status, 'ready');
    assert.equal((await fetch(base + '/readyz', { method: 'POST' })).status, 404);
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

test('serves sanitized pending and degraded readiness states', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-readiness-'));
  const readiness = new Readiness({ storage: 'ready', apiKey: 'ready' });
  const { server, base } = await runningServer(new Store(dir), { apiKey: 'readiness-key', readiness });
  try {
    let response = await fetch(base + '/readyz');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.equal((await response.json()).status, 'pending');
    readiness.set('tokenRecovery', 'degraded');
    readiness.set('quotaRefresh', 'degraded');
    readiness.set('modelCatalog', 'degraded');
    response = await fetch(base + '/readyz');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ready',
      checks: {
        storage: 'ready',
        apiKey: 'ready',
        tokenRecovery: 'degraded',
        quotaRefresh: 'degraded',
        modelCatalog: 'degraded'
      }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serves sanitized gateway diagnostics without persisted identities', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-diagnostics-api-'));
  const store = new Store(dir);
  const key = store.configureApiKey('diagnostics-key');
  const upstream = store.create({ type: 'compass', projectId: 'sensitive-project', projectKey: 'sensitive-token' });
  const requestRecord = store.reserveGatewayRequest({
    scopeId: key.scopeId,
    apiKeyId: key.id,
    endpoint: '/v1/responses',
    model: 'secret-model'
  });
  const attempt = store.beginGatewayAttempt(requestRecord.id, upstream.id);
  store.finalizeGatewayRequest({
    requestId: requestRecord.id,
    attemptId: attempt.id,
    status: 'failed',
    errorCode: 'upstream_transport_failed',
    responseStatusCode: 502,
    exclusionReasons: ['model_not_supported', 'bad token value'],
    timings: { queueWaitMs: 2, connectionMs: 4, hostname: 'sensitive.example' }
  });
  const { server, base } = await runningServer(store, { apiKey: 'diagnostics-key' });
  try {
    const response = await request(base, '/api/diagnostics');
    assert.equal(response.response.status, 200);
    assert.equal(response.data.gateway.retainedFailureCount, 1);
    assert.deepEqual(response.data.gateway.failures[0].exclusionReasons, ['model_not_supported', 'upstream_transport_failed']);
    assert.deepEqual(response.data.gateway.failures[0].attempts[0].timings, { queueWaitMs: 2, connectionMs: 4 });
    const encoded = JSON.stringify(response.data);
    for (const secret of [key.id, upstream.id, 'sensitive-project', 'sensitive-token', 'secret-model', 'sensitive.example']) {
      assert.equal(encoded.includes(secret), false);
    }
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
  const store = new Store(dir);
  const providerFetch = async () => new Response(JSON.stringify({ retcode: 0, data: { project: { budget_type: 'recurring', quota_detail: { applied_balance: 100, balance: 75 } } } }), { status: 200 });
  const { server, base } = await runningServer(store, { fetchImpl: providerFetch, compassGatewayToken: 'gateway-token' });
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

    const admission = store.beginUpstreamAttempt(id, { routeClass: 'test', model: '' });
    store.settleUpstreamAttempt(id, admission, { class: 'quota', retryable: true });
    assert.equal(store.get(id).health.status, 'cooldown');
    const cleared = await request(base, `/api/upstreams/${id}/clear-cooldown`, { method: 'POST', body: '{}' });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.data.upstream.health, null);

    const eligibility = await request(base, '/api/upstreams/eligibility');
    assert.equal(eligibility.response.status, 200);
    assert.equal(eligibility.data.eligible.length, 1);

    const catalog = await request(base, '/api/model-catalog');
    assert.equal(catalog.response.status, 200);
    assert.deepEqual(catalog.data.catalog, {
      source: 'static',
      freshness: 'fallback',
      accountCount: 0,
      attemptedAccountCount: 0,
      freshAccountCount: 0,
      modelCount: 8,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureClass: null
    });

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

test('serves sanitized aggregate Codex host-health diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-host-health-api-'));
  const store = new Store(dir);
  const hostHealth = new CodexHostHealth({ failureThreshold: 2, cooldownMs: 30_000 });
  hostHealth.settleError(
    hostHealth.begin('https://sensitive.example/backend-api/codex/responses').lease,
    Object.assign(new Error('dns'), { code: 'ENOTFOUND' })
  );
  const { server, base } = await runningServer(store, { apiKey: 'host-health-key', codexHostHealth: hostHealth });
  try {
    const response = await request(base, '/api/codex-host-health', {
      headers: { authorization: 'Bearer host-health-key' }
    });
    assert.equal(response.response.status, 200);
    assert.equal(response.data.hostHealth.enabled, true);
    assert.equal(response.data.hostHealth.trackedOriginCount, 1);
    assert.equal(response.data.hostHealth.openOriginCount, 0);
    assert.equal(JSON.stringify(response.data).includes('sensitive.example'), false);
    assert.equal(JSON.stringify(response.data).includes('ENOTFOUND'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serves sanitized pacing diagnostics and accepts pacing configuration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-pacing-api-'));
  const store = new Store(dir);
  const upstream = store.create({
    type: 'compass',
    projectId: 'pacing-api',
    projectKey: 'secret',
    pacing: { enabled: true, minStartIntervalMs: 1_000, maxQueueDepth: 2, maxQueueAgeMs: 5_000 }
  });
  const pacer = upstreamPacerForStore(store);
  await pacer.acquire(upstream.id);
  const queued = pacer.acquire(upstream.id);
  const { server, base } = await runningServer(store);
  try {
    const response = await request(base, '/api/pacing');
    assert.equal(response.response.status, 200);
    assert.equal(response.data.pacing.length, 1);
    assert.deepEqual(Object.keys(response.data.pacing[0]).sort(), ['lastStartAt', 'nextSlotAt', 'queueDepth', 'upstreamId']);
    assert.equal(response.data.pacing[0].queueDepth, 1);
    assert.equal(JSON.stringify(response.data).includes('secret'), false);

    const patched = await request(base, `/api/upstreams/${upstream.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pacing: { enabled: false } })
    });
    assert.equal(patched.data.upstream.pacing.enabled, false);
    await queued;
    assert.deepEqual((await request(base, '/api/pacing')).data.pacing, []);
  } finally {
    pacer.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serves the upstream priority list API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-priority-http-'));
  const { server, base } = await runningServer(new Store(dir));
  const create = async (projectId) => (await request(base, '/api/upstreams', {
    method: 'POST',
    body: JSON.stringify({ type: 'compass', projectId, projectKey: 'secret' })
  })).data.upstream.id;
  const priorities = async () => (await request(base, '/api/upstreams')).data.upstreams.map((upstream) => [upstream.name, upstream.priority]);
  try {
    const first = await create('first');
    const second = await create('second');
    assert.deepEqual(await priorities(), [['first', null], ['second', null]]);

    const listed = await request(base, '/api/upstreams/priority', { method: 'PUT', body: JSON.stringify({ ids: [second, first] }) });
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.data.upstreams.map((upstream) => [upstream.name, upstream.priority]), [['second', 0], ['first', 1]]);
    assert.deepEqual(await priorities(), [['first', 1], ['second', 0]]);

    const partial = await request(base, '/api/upstreams/priority', { method: 'PUT', body: JSON.stringify({ ids: [first] }) });
    assert.deepEqual(partial.data.upstreams.map((upstream) => upstream.name), ['first']);
    assert.deepEqual(await priorities(), [['first', 0], ['second', null]]);

    const cleared = await request(base, '/api/upstreams/priority', { method: 'PUT', body: JSON.stringify({ ids: [] }) });
    assert.equal(cleared.response.status, 200);
    assert.deepEqual(cleared.data.upstreams, []);
    assert.deepEqual(await priorities(), [['first', null], ['second', null]]);

    const unknown = await request(base, '/api/upstreams/priority', { method: 'PUT', body: JSON.stringify({ ids: ['nope'] }) });
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.data.error.code, 'invalid_request');
    assert.match(unknown.data.error.message, /unknown upstream nope/);

    const notArray = await request(base, '/api/upstreams/priority', { method: 'PUT', body: JSON.stringify({ ids: 'first' }) });
    assert.equal(notArray.response.status, 400);
    assert.match(notArray.data.error.message, /ids must be an array/);
    assert.deepEqual(await priorities(), [['first', null], ['second', null]]);

  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serves persisted routing policy and sanitized dry-run diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-routing-http-'));
  const store = new Store(dir);
  const { server, base } = await runningServer(store);
  const now = Date.parse('2026-08-16T08:00:00Z');
  try {
    const create = async (projectId, projectKey) => (await request(base, '/api/upstreams', {
      method: 'POST',
      body: JSON.stringify({ type: 'compass', projectId, projectKey })
    })).data.upstream;
    const first = await create('first', 'sensitive-first');
    const second = await create('second', 'sensitive-second');
    store.setCap(first.id, { capDollars: 10 });
    store.setCap(second.id, { capDollars: 10 });
    store.setQuota(first.id, { remainingPercent: 15, observedAt: new Date(now).toISOString() });
    store.setQuota(second.id, { remainingPercent: 85, observedAt: new Date(now).toISOString() });

    let response = await request(base, '/api/routing');
    assert.equal(response.data.policy.strategy, 'least-recent-success');
    response = await request(base, '/api/routing', {
      method: 'PUT',
      body: JSON.stringify({ strategy: 'most-remaining-quota' })
    });
    assert.equal(response.data.policy.strategy, 'most-remaining-quota');

    response = await request(base, '/api/routing/dry-run', {
      method: 'POST',
      body: JSON.stringify({ preferredType: 'compass', requiredType: 'compass', now })
    });
    assert.equal(response.response.status, 200);
    assert.deepEqual(response.data.routing.candidates.map(({ id }) => id), [second.id, first.id]);
    assert.equal(response.data.routing.candidates[0].quota.status, 'known');
    assert.equal(JSON.stringify(response.data).includes('sensitive-first'), false);

    const invalid = await request(base, '/api/routing', {
      method: 'PUT',
      body: JSON.stringify({ strategy: 'fill-first' })
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.data.error.code, 'invalid_request');

    const invalidDryRun = await request(base, '/api/routing/dry-run', {
      method: 'POST',
      body: JSON.stringify({ preferredType: 'codxe' })
    });
    assert.equal(invalidDryRun.response.status, 400);
    assert.match(invalidDryRun.data.error.message, /preferredType must be codex or compass/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
