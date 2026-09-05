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
import { CLAUDE_OAUTH_PROFILE_URL, CLAUDE_OAUTH_USAGE_URL } from '../src/providers.js';
import { refreshUpstreamQuota } from '../src/upstream-quota-refresh.js';

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

test('hydrates Claude OAuth profile metadata on create and manual refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-profile-api-'));
  const store = new Store(dir);
  const profileCalls = [];
  const usageCalls = [];
  const { server, base } = await runningServer(store, {
    apiKey: 'claude-profile-key',
    fetchImpl: async (url, options) => {
      if (url === CLAUDE_OAUTH_USAGE_URL) {
        usageCalls.push({ url, options });
        return new Response(JSON.stringify({
          five_hour: { utilization: usageCalls.length === 1 ? 48 : 63, resets_at: '2026-09-04T05:00:00Z' },
          seven_day: { utilization: 64, resets_at: '2026-09-10T05:00:00Z' }
        }), { status: 200 });
      }
      profileCalls.push({ url, options });
      return new Response(JSON.stringify({
        account: { ...(profileCalls.length === 1 ? { uuid: 'profile-account' } : {}), email: 'profile@example.com' },
        organization: { uuid: 'profile-org', name: 'Profile Org' }
      }), { status: 200 });
    }
  });
  try {
    const created = await request(base, '/api/upstreams', {
      method: 'POST',
      body: JSON.stringify({ type: 'claude', accessToken: 'sk-ant-oat-profile-create' })
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.data.upstream.email, 'profile@example.com');
    assert.equal(created.data.upstream.accountId, 'profile-account');
    assert.equal(created.data.upstream.name === 'imported-account', false);
    assert.equal(created.data.upstream.quota.remainingPercent, 52);
    assert.equal(created.data.upstream.quota.windows[1].remainingPercent, 36);
    assert.equal(profileCalls[0].url, CLAUDE_OAUTH_PROFILE_URL);
    assert.equal(profileCalls[0].options.headers.authorization, 'Bearer sk-ant-oat-profile-create');
    assert.equal(usageCalls[0].url, CLAUDE_OAUTH_USAGE_URL);
    assert.equal(usageCalls[0].options.headers.authorization, 'Bearer sk-ant-oat-profile-create');
    assert.equal(usageCalls[0].options.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(usageCalls[0].options.headers['user-agent'], 'claude-code/2.1.260');

    const automatic = await request(base, '/api/upstreams/refresh-quota?force=false', { method: 'POST' });
    assert.equal(automatic.response.status, 200);
    assert.equal(automatic.data.results[0].status, 'refreshed');
    assert.equal(usageCalls.length, 2);

    const existing = store.create({ type: 'claude', accessToken: 'sk-ant-oat-profile-existing', accountId: 'existing-account' });
    const refreshed = await request(base, `/api/upstreams/${existing.id}/refresh-profile`, { method: 'POST' });
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.data.upstream.email, 'profile@example.com');
    assert.equal(refreshed.data.upstream.accountId, 'existing-account');
    assert.equal(profileCalls.length, 2);

    const quota = await request(base, `/api/upstreams/${created.data.upstream.id}/refresh-quota`, { method: 'POST' });
    assert.equal(quota.response.status, 200);
    assert.equal(quota.data.upstream.quota.remainingPercent, 37);
    assert.equal(usageCalls.length, 3);
    assert.equal(profileCalls.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to Claude Messages quota headers when OAuth usage scope is insufficient', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-quota-probe-'));
  const messagesUrl = 'https://api.anthropic.com/v1/messages?beta=true';
  const calls = [];
  const { server, base } = await runningServer(new Store(dir), {
    apiKey: 'claude-quota-probe-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === CLAUDE_OAUTH_PROFILE_URL) {
        return new Response(JSON.stringify({ account: { email: 'probe@example.com' } }), { status: 200 });
      }
      if (url === CLAUDE_OAUTH_USAGE_URL) {
        return new Response(JSON.stringify({
          type: 'error',
          error: {
            type: 'permission_error',
            details: { required_scopes: ['user:profile'], error_code: 'oauth_scope_insufficient' }
          }
        }), { status: 403 });
      }
      if (url === messagesUrl) {
        const probeBody = JSON.parse(options.body);
        if (probeBody.diagnostics) {
          return new Response(JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'diagnostics: Extra inputs are not permitted.' }
          }), { status: 400 });
        }
        return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }), {
          status: 429,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.30',
            'anthropic-ratelimit-unified-5h-reset': '1800000000',
            'anthropic-ratelimit-unified-7d-utilization': '0.45',
            'anthropic-ratelimit-unified-7d-reset': '1800600000',
            'anthropic-ratelimit-unified-representative-claim': 'five_hour'
          }
        });
      }
      return new Response('{}', { status: 404 });
    }
  });
  try {
    const created = await request(base, '/api/upstreams', {
      method: 'POST',
      body: JSON.stringify({ type: 'claude', accessToken: 'sk-ant-oat-quota-probe' })
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.data.upstream.quota.source, 'claude_oauth_headers');
    assert.equal(created.data.upstream.quota.remainingPercent, 70);
    assert.equal(created.data.upstream.quota.windows[1].remainingPercent, 55);
    const probe = calls.find(({ url }) => url === messagesUrl);
    assert.ok(probe);
    assert.equal(probe.options.headers.authorization, 'Bearer sk-ant-oat-quota-probe');
    assert.match(probe.options.headers['anthropic-beta'], /claude-code-20250219/);
    assert.match(probe.options.headers['anthropic-beta'], /oauth-2025-04-20/);
    assert.equal(probe.options.headers['x-app'], 'cli');
    const probeBody = JSON.parse(probe.options.body);
    assert.equal(probeBody.model, 'claude-sonnet-4-6');
    assert.equal(probeBody.max_tokens, 1);
    assert.equal(probeBody.messages[0].role, 'user');
    assert.equal(probeBody.messages[0].content.at(-1).text, '.');
    assert.equal(probeBody.diagnostics, undefined);
    assert.match(probeBody.metadata.user_id, /"device_id":"[a-f0-9]{64}"/);
    assert.match(probeBody.system[0].text, /^x-anthropic-billing-header:/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns Claude quota Retry-After details for a manual rate-limited refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-quota-retry-after-'));
  const store = new Store(dir);
  const created = store.create({ type: 'claude', accessToken: 'sk-ant-oat-quota-retry-after', metadata: { auth_kind: 'oauth' } });
  const { server, base } = await runningServer(store, {
    apiKey: 'claude-quota-retry-after-key',
    fetchImpl: async (url) => {
      if (url === CLAUDE_OAUTH_PROFILE_URL) return new Response('{}', { status: 403 });
      if (url === CLAUDE_OAUTH_USAGE_URL) return new Response(JSON.stringify({
        error: { details: { required_scopes: ['user:profile'], error_code: 'oauth_scope_insufficient' } }
      }), { status: 403 });
      return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited' } }), {
        status: 429,
        headers: { 'retry-after': '600' }
      });
    }
  });
  try {
    const refreshed = await request(base, `/api/upstreams/${created.id}/refresh-quota`, { method: 'POST' });
    assert.equal(refreshed.response.status, 429);
    assert.equal(refreshed.data.error.code, 'claude_quota_rate_limited');
    assert.match(refreshed.data.error.message, /Retry-After: 10 minutes/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preserves Retry-After from the direct Claude usage endpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-usage-retry-after-'));
  const store = new Store(dir);
  const created = store.create({ type: 'claude', accessToken: 'sk-ant-oat-direct-usage-retry-after', accountId: 'direct-usage-account', metadata: { auth_kind: 'oauth' } });
  let usageCalls = 0;
  const { server, base } = await runningServer(store, {
    apiKey: 'claude-direct-usage-retry-after-key',
    fetchImpl: async (url) => {
      if (url !== CLAUDE_OAUTH_USAGE_URL) return new Response('{}', { status: 200 });
      usageCalls += 1;
      return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited' } }), { status: 429, headers: { 'retry-after': '1641' } });
    }
  });
  try {
    const refreshed = await request(base, `/api/upstreams/${created.id}/refresh-quota`, { method: 'POST' });
    assert.equal(refreshed.response.status, 429);
    assert.match(refreshed.data.error.message, /Retry-After: 27 minutes 21 seconds/);
    const blocked = await request(base, `/api/upstreams/${created.id}/refresh-quota`, { method: 'POST' });
    assert.equal(blocked.response.status, 429);
    assert.match(blocked.data.error.message, /Retry-After: 27 minutes 21 seconds/);
    assert.equal(usageCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coalesces concurrent quota refreshes for one upstream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-quota-coalesce-'));
  const store = new Store(dir);
  const created = store.create({ type: 'claude', accessToken: 'sk-ant-oat-quota-coalesce', metadata: { auth_kind: 'oauth' } });
  let calls = 0;
  let release;
  const fetchImpl = async (url) => {
    assert.equal(url, CLAUDE_OAUTH_USAGE_URL);
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return new Response(JSON.stringify({ five_hour: { utilization: 20, resets_at: '2026-09-04T05:00:00Z' } }), { status: 200 });
  };
  try {
    const first = refreshUpstreamQuota(store, created.id, { fetchImpl });
    const second = refreshUpstreamQuota(store, created.id, { fetchImpl, notify: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.quota.remainingPercent, 80);
    assert.equal(secondResult.quota.remainingPercent, 80);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shows a local retry estimate when Claude omits Retry-After', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-quota-retry-estimate-'));
  const store = new Store(dir);
  const created = store.create({ type: 'claude', accessToken: 'sk-ant-oat-quota-retry-estimate', metadata: { auth_kind: 'oauth' } });
  const { server, base } = await runningServer(store, {
    apiKey: 'claude-quota-retry-estimate-key',
    fetchImpl: async (url) => {
      if (url === CLAUDE_OAUTH_PROFILE_URL) return new Response('{}', { status: 403 });
      if (url === CLAUDE_OAUTH_USAGE_URL) return new Response(JSON.stringify({
        error: { details: { required_scopes: ['user:profile'], error_code: 'oauth_scope_insufficient' } }
      }), { status: 403 });
      return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited' } }), { status: 429 });
    }
  });
  try {
    const refreshed = await request(base, `/api/upstreams/${created.id}/refresh-quota`, { method: 'POST' });
    assert.equal(refreshed.response.status, 429);
    assert.match(refreshed.data.error.message, /Retry-After not provided; local retry estimate: 10 minutes/);
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

test('automatically refreshes legacy Claude OAuth records without auth metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-legacy-claude-poll-'));
  try {
    const store = new Store(dir);
    const created = store.create({ type: 'claude', accessToken: 'sk-ant-oat-legacy', accountId: 'legacy-account' });
    const saved = store.load().upstreams.find((upstream) => upstream.id === created.id);
    delete saved.metadata.auth_kind;
    saved.accessTokenExpiresAt = null;
    store.save(store.load());
    await refreshAllQuotas(store, {
      fetchImpl: async (url) => {
        assert.equal(url, CLAUDE_OAUTH_USAGE_URL);
        return new Response(JSON.stringify({ five_hour: { utilization: 25, resets_at: '2026-09-04T05:00:00Z' } }), { status: 200 });
      }
    });
    const upstream = store.getPublic(created.id);
    assert.equal(upstream.email, null);
    assert.equal(upstream.quota.remainingPercent, 75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshes all quotas in sequential batches of ten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-batched-poll-'));
  try {
    const store = new Store(dir);
    for (let index = 0; index < 21; index += 1) store.create({ type: 'codex', accessToken: `token-${index}`, accountId: `acc-${index}` });
    let active = 0;
    let peak = 0;
    let completed = 0;
    let changes = 0;
    store.onUpstreamsChange(() => { changes += 1; });
    await refreshAllQuotas(store, {
      fetchImpl: async () => {
        assert.equal(completed, Math.floor(completed / 10) * 10, 'the next batch starts only after the previous batch completes');
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        completed += 1;
        return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 2_592_000 } } }), { status: 200 });
      }
    });
    assert.equal(peak, 10);
    assert.equal(completed, 21);
    assert.equal(changes, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshes only selected upstream quota ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-selected-quota-'));
  try {
    const store = new Store(dir);
    const first = store.create({ type: 'codex', accessToken: 'selected-token-1', accountId: 'selected-account-1' });
    store.create({ type: 'codex', accessToken: 'selected-token-2', accountId: 'selected-account-2' });
    const calls = [];
    const results = await refreshAllQuotas(store, {
      ids: [first.id],
      fetchImpl: async (_url, options) => {
        calls.push(options.headers.authorization);
        return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 2_592_000 } } }), { status: 200 });
      }
    });
    assert.equal(results.length, 1);
    assert.deepEqual(calls, ['Bearer selected-token-1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('continues bulk quota refresh after an upstream failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-bulk-quota-api-'));
  const store = new Store(dir);
  for (let index = 0; index < 11; index += 1) store.create({ type: 'codex', accessToken: `token-${index}` });
  let calls = 0;
  const { server, base } = await runningServer(store, {
    fetchImpl: async (_url, { headers }) => {
      calls += 1;
      if (headers.authorization === 'Bearer token-0') throw new Error('unavailable');
      return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 2_592_000 } } }), { status: 200 });
    }
  });
  try {
    const refreshed = await request(base, '/api/upstreams/refresh-quota', { method: 'POST', body: '{}' });
    assert.equal(refreshed.response.status, 200);
    assert.deepEqual(refreshed.data.results.map(({ status }) => status), ['failed', ...Array(10).fill('refreshed')]);
    assert.equal(calls, 11);
    assert.equal(store.list().slice(1).every(({ quota }) => quota.remainingPercent === 90), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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

test('scheduled quota refresh recovers readiness after an initial failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-readiness-recovery-'));
  const store = new Store(dir);
  store.create({ type: 'codex', accessToken: 'poll-token' });
  let quotaCalls = 0;
  const fetchImpl = async (url) => {
    if (!String(url).includes('/usage')) return new Response('{}', { status: 500 });
    quotaCalls += 1;
    if (quotaCalls === 1) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 2_592_000 } }
    }), { status: 200 });
  };
  const server = start(0, { store, apiKey: 'poll-key', fetchImpl, pollIntervalMs: 20 });
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const deadline = Date.now() + 1_000;
    let readiness;
    while (Date.now() < deadline) {
      readiness = await fetch(`http://127.0.0.1:${port}/readyz`).then((response) => response.json());
      if (quotaCalls >= 2 && readiness.checks.quotaRefresh === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(quotaCalls >= 2);
    assert.equal(readiness.checks.quotaRefresh, 'ready');
  } finally {
    await new Promise((resolve) => server.close(resolve));
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

test('accepts only Claude Enterprise OAuth credentials through management APIs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-oauth-only-'));
  const store = new Store(dir);
  const existing = store.create({ type: 'claude', accessToken: 'sk-ant-oat-existing', metadata: { auth_kind: 'oauth' } });
  const { server, base } = await runningServer(store, { apiKey: 'claude-oauth-only-key' });
  try {
    const apiKeyCreate = await request(base, '/api/upstreams', {
      method: 'POST',
      body: JSON.stringify({ type: 'claude', projectKey: 'sk-ant-api-key' })
    });
    assert.equal(apiKeyCreate.response.status, 400);
    assert.equal(apiKeyCreate.data.error.code, 'claude_oauth_required');

    const apiKeyJsonCreate = await request(base, '/api/upstreams', {
      method: 'POST',
      body: JSON.stringify({ type: 'claude', authJson: JSON.stringify({ projectKey: 'sk-ant-api-key' }) })
    });
    assert.equal(apiKeyJsonCreate.response.status, 400);
    assert.equal(apiKeyJsonCreate.data.error.code, 'claude_oauth_required');

    const apiKeyAccessTokenCreate = await request(base, '/api/upstreams', {
      method: 'POST',
      body: JSON.stringify({ type: 'claude', accessToken: 'sk-ant-api-key' })
    });
    assert.equal(apiKeyAccessTokenCreate.response.status, 400);
    assert.equal(apiKeyAccessTokenCreate.data.error.code, 'claude_oauth_required');

    const apiKeyMetadataCreate = await request(base, '/api/upstreams', {
      method: 'POST',
      body: JSON.stringify({ type: 'claude', accessToken: 'opaque-key', metadata: { auth_kind: 'claude_api_key' } })
    });
    assert.equal(apiKeyMetadataCreate.response.status, 400);
    assert.equal(apiKeyMetadataCreate.data.error.code, 'claude_oauth_required');

    const apiKeyReplace = await request(base, `/api/upstreams/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ projectKey: 'sk-ant-api-key' })
    });
    assert.equal(apiKeyReplace.response.status, 400);
    assert.equal(apiKeyReplace.data.error.code, 'claude_oauth_required');
    assert.equal(store.credentials(existing.id).accessToken, 'sk-ant-oat-existing');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not route legacy Claude API-key records or query their OAuth quota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-legacy-block-'));
  const writer = new Store(dir, { allowLegacyClaudeApiKey: true });
  const legacy = writer.create({ type: 'claude', projectKey: 'sk-ant-api-legacy' });
  writer.sqlite.close();
  const store = new Store(dir);
  let upstreamCalls = 0;
  const { server, base } = await runningServer(store, {
    apiKey: 'claude-legacy-block-key',
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response('{}', { status: 200 });
    }
  });
  try {
    const inference = await request(base, '/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer claude-legacy-block-key', 'x-upstream-id': legacy.id },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(inference.response.status, 503);
    assert.equal(inference.data.error.code, 'no_eligible_backend');

    const quota = await request(base, `/api/upstreams/${legacy.id}/refresh-quota`, { method: 'POST' });
    assert.equal(quota.response.status, 200);
    assert.equal(quota.data.skipped, 'claude_api_key');
    assert.equal(upstreamCalls, 0);
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
    assert.equal(created.data.upstream.quota.remainingPercent, 75);
    const id = created.data.upstream.id;
    const credentials = await request(base, `/api/upstreams/${id}/credentials`);
    assert.deepEqual(credentials.data.credentials, {
      project_id: 'p',
      project_key: 'secret'
    });
    const list = await request(base, '/api/upstreams');
    assert.equal(list.data.upstreams.length, 1);
    const show = await request(base, `/api/upstreams/${id}`);
    assert.equal(show.data.upstream.id, id);
    const patched = await request(base, `/api/upstreams/${id}`, { method: 'PATCH', body: JSON.stringify({ projectId: 'project-patched' }) });
    assert.equal(patched.data.upstream.name, 'project-patched');
    assert.equal(patched.data.upstream.quota.remainingPercent, 75);
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

test('tests Codex and Compass connections through the shared proxy path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-connection-test-'));
  const store = new Store(dir);
  const codex = store.create({
    type: 'codex',
    accessToken: 'codex-connection-token',
    accountId: 'codex-connection-account'
  });
  const compass = store.create({
    type: 'compass',
    projectId: 'compass-connection-project',
    projectKey: 'compass-connection-key'
  });
  const calls = [];
  const { server, base } = await runningServer(store, {
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      calls.push({ path, options });
      if (path === '/backend-api/codex/models') {
        return new Response(JSON.stringify({
          models: [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-luna' }]
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === '/backend-api/codex/responses') {
        return new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"response-test","status":"completed","model":"gpt-5.6-luna","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The current time is now."}]}],"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        );
      }
      if (path === '/compass-api/v1/messages') {
        return new Response(JSON.stringify({
          id: 'message-test',
          type: 'message',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'The current time is now.' }],
          usage: { input_tokens: 5, output_tokens: 6 }
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected provider request: ${path}`);
    }
  });
  try {
    let result = await request(base, `/api/upstreams/${codex.id}/test-connection`, {
      method: 'POST',
      body: '{}'
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.connection.type, 'codex');
    assert.equal(result.data.connection.endpoint, '/v1/responses');
    assert.equal(result.data.connection.model, 'gpt-5.6-luna');
    assert.equal(result.data.connection.answer, 'The current time is now.');

    const codexRequest = calls.find(({ path }) => path === '/backend-api/codex/responses');
    const codexBody = JSON.parse(codexRequest.options.body);
    assert.equal(codexBody.model, 'gpt-5.6-luna');
    assert.equal(codexBody.max_output_tokens, 64);
    assert.equal(codexBody.input[0].content[0].text, 'What is the current time?');
    assert.equal(codexRequest.options.headers.authorization, 'Bearer codex-connection-token');

    result = await request(base, `/api/upstreams/${compass.id}/test-connection`, {
      method: 'POST',
      body: '{}'
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.connection.type, 'compass');
    assert.equal(result.data.connection.endpoint, '/v1/messages');
    assert.equal(result.data.connection.model, 'claude-sonnet-5');
    assert.equal(result.data.connection.answer, 'The current time is now.');

    const compassRequest = calls.find(({ path }) => path === '/compass-api/v1/messages');
    assert.deepEqual(JSON.parse(compassRequest.options.body), {
      model: 'claude-sonnet-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'What is the current time?' }],
      stream: false
    });
    assert.equal(compassRequest.options.headers.authorization, 'Bearer compass-connection-key');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps saved replacement credentials but clears stale quota when their refresh fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-replacement-quota-'));
  const store = new Store(dir);
  let failRefresh = false;
  const { server, base } = await runningServer(store, {
    compassGatewayToken: 'gateway-token',
    fetchImpl: async () => {
      if (failRefresh) throw new Error('provider unavailable');
      return new Response(JSON.stringify({
        retcode: 0,
        data: { project: { budget_type: 'recurring', quota_detail: { applied_balance: 100, balance: 75 } } }
      }), { status: 200 });
    }
  });
  try {
    const created = await request(base, '/api/upstreams', {
      method: 'POST',
      body: JSON.stringify({ type: 'compass', projectId: 'first-project', projectKey: 'first-key' })
    });
    assert.equal(created.data.upstream.quota.remainingPercent, 75);

    failRefresh = true;
    const replaced = await request(base, `/api/upstreams/${created.data.upstream.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ projectId: 'second-project', projectKey: 'second-key' })
    });
    assert.equal(replaced.response.status, 200);
    assert.equal(replaced.data.upstream.name, 'second-project');
    assert.equal(replaced.data.upstream.quota, null);
    assert.equal(store.credentials(created.data.upstream.id).projectKey, 'second-key');
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
