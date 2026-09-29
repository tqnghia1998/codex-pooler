import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const KEY = 'routing-policy-key';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-routing-'));
  const store = new Store(dir);
  store.updateScope('default', { models: ['allowed-model'] });
  const upstream = store.create({
    type: 'compass', projectId: 'project', projectKey: 'project-key',
    routing: { models: ['allowed-model'], tools: false, imageInput: false, reasoning: false, serviceTiers: ['default'] }
  });
  store.setCap(upstream.id, { capDollars: 10 });
  return { dir, store, upstream };
}

test('filters candidates by scope model policy, capabilities, tiers, and known exhausted quota', () => {
  const { dir, store, upstream } = fixture();
  try {
    assert.equal(store.modelAllowed('default', 'allowed-model'), true);
    assert.equal(store.modelAllowed('default', 'other-model'), false);
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model', requirements: { tools: true } }).length, 0);
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model', requirements: { imageInput: true } }).length, 0);
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model', requirements: { reasoning: true } }).length, 0);
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model', requirements: { serviceTier: 'priority' } }).length, 0);
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model', requirements: { serviceTier: 'default' } }).length, 1);
    store.setQuota(upstream.id, { remainingPercent: 0 });
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model' }).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not mistake unknown quota for exhaustion and retries after a quota reset', () => {
  const { dir, store, upstream } = fixture();
  const now = Date.parse('2026-09-29T12:00:00Z');
  const options = { scopeId: 'default', model: 'allowed-model', now };
  try {
    store.setQuota(upstream.id, { remainingPercent: null, observedAt: new Date(now).toISOString() });
    assert.deepEqual(store.candidatePlan(options).map(({ id }) => id), [upstream.id]);
    assert.equal(store.routingDryRun(options).candidates[0].quota.status, 'unknown');

    store.setQuota(upstream.id, {
      source: 'compass_project_api',
      remainingPercent: 0,
      observedAt: new Date(now - 60_000).toISOString(),
      resetAt: new Date(now + 60_000).toISOString()
    });
    assert.deepEqual(store.routingDryRun(options).exclusions.map(({ code }) => code), ['quota_exhausted']);
    assert.deepEqual(store.candidatePlan({ ...options, now: now + 60_000 }).map(({ id }) => id), [upstream.id]);

    store.setQuota(upstream.id, {
      source: 'compass_project_api',
      remainingPercent: 0,
      observedAt: new Date(now - 60 * 60_000).toISOString(),
      resetAt: null
    });
    assert.deepEqual(store.routingDryRun(options).exclusions.map(({ code }) => code), ['quota_exhausted']);

    store.setQuota(upstream.id, {
      source: 'claude_oauth_usage',
      remainingPercent: 0,
      observedAt: new Date(now - 6 * 60_000).toISOString()
    });
    assert.deepEqual(store.candidatePlan(options).map(({ id }) => id), [upstream.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps a Claude upstream with a Loop dollar balance and unknown percentage eligible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-loop-quota-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({
      type: 'claude',
      accessToken: 'sk-ant-oat-loop-balance',
      metadata: { skip_account_profile: true }
    });
    store.setQuota(upstream.id, {
      source: 'loop_ai_usage',
      remainingDollars: 5,
      remainingPercent: null,
      observedAt: new Date().toISOString()
    });
    const plan = store.candidatePlanDetails({
      model: 'claude-opus-5-5',
      routeClass: 'proxy_stream',
      requirements: { streaming: true },
      ignoreSpendingCap: true
    });
    assert.deepEqual(plan.candidates.map(({ id }) => id), [upstream.id]);
    assert.equal(plan.diagnostics.candidates[0].quota.status, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatches again after an exhausted quota window resets', async (t) => {
  const { dir, store, upstream } = fixture();
  let dispatches = 0;
  const server = createServer(createApp({
    store,
    apiKey: KEY,
    fetchImpl: async () => {
      dispatches += 1;
      return new Response(JSON.stringify({ id: 'recovered', output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const now = Date.now();
  const quota = {
    source: 'compass_project_api',
    remainingPercent: 0,
    observedAt: new Date(now).toISOString(),
    resetAt: new Date(now + 60_000).toISOString()
  };
  const request = () => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'allowed-model', input: 'hello' })
  });

  store.setQuota(upstream.id, quota);
  let response = await request();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'no_compatible_backend');
  assert.equal(dispatches, 0);

  store.setQuota(upstream.id, { ...quota, resetAt: new Date(now - 1).toISOString() });
  response = await request();
  assert.equal(response.status, 200);
  assert.equal(dispatches, 1);
});

test('rejects unavailable models before dispatch and reports incompatible candidates', async (t) => {
  const { dir, store } = fixture();
  const server = createServer(createApp({ store, apiKey: KEY, fetchImpl: async () => { throw new Error('must not dispatch'); } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (body) => fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  let response = await request({ model: 'other-model', input: 'hello' });
  assert.equal(response.status, 400);
  assert.deepEqual((await response.json()).error, {
    type: 'invalid_request_error', code: 'invalid_model', message: 'Model other-model is not available', param: 'model'
  });
  response = await request({ model: 'allowed-model', input: 'hello', tools: [{ type: 'function', name: 'lookup', parameters: {} }] });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'no_compatible_backend');

  response = await fetch(`${base}/backend-api/codex/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'allowed-model', input: 'hello' })
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'no_compatible_backend');
});
