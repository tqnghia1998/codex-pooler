import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexModelCatalog } from '../src/codex-model-catalog.js';
import { Store } from '../src/store.js';
import { upstreamPacerForStore } from '../src/upstream-pacer.js';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function codexInput(email, accountId = email) {
  return {
    type: 'codex',
    authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
      id_token: jwt({ email }),
      account_id: accountId
    }})
  };
}

function fixture(count = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-catalog-'));
  const store = new Store(dir);
  const upstreams = Array.from({ length: count }, (_, index) => {
    const upstream = store.create(codexInput(`catalog-${index}@example.com`, `acct-${index}`));
    store.setCap(upstream.id, { capDollars: 100 });
    return upstream;
  });
  return { dir, store, upstreams };
}

function modelsResponse(models) {
  return new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('coalesces concurrent discovery and serves fresh cache hits', async () => {
  const { dir, store, upstreams } = fixture();
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const catalog = new CodexModelCatalog(store);
  const fetchImpl = async () => {
    calls += 1;
    await pending;
    return modelsResponse([{ slug: 'gpt-live' }]);
  };
  try {
    const requests = Array.from({ length: 10 }, () => catalog.resolve('default', { fetchImpl }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const results = await Promise.all(requests);
    assert.equal(calls, 1);
    assert.ok(results.every(({ publicModels }) => publicModels.some(({ id }) => id === 'gpt-live')));
    await catalog.resolve('default', { fetchImpl });
    assert.equal(calls, 1);
    assert.equal(catalog.supports(upstreams[0].id, 'gpt-live'), true);
    assert.equal(catalog.supports(upstreams[0].id, 'gpt-missing'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps last-known-good catalogs stale on failure and suppresses repeated retries', async () => {
  const { dir, store } = fixture();
  let now = 1_000;
  let calls = 0;
  const catalog = new CodexModelCatalog(store, {
    now: () => now,
    freshTtlMs: 100,
    failureSuppressionMs: 50
  });
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return modelsResponse([{ slug: 'gpt-stale' }]);
    throw new Error('offline');
  };
  try {
    await catalog.resolve('default', { fetchImpl });
    now += 101;
    let result = await catalog.resolve('default', { fetchImpl });
    assert.equal(calls, 2);
    assert.ok(result.publicModels.some(({ id }) => id === 'gpt-stale'));
    assert.equal(result.status.freshness, 'stale');
    result = await catalog.resolve('default', { fetchImpl });
    assert.equal(calls, 2);
    assert.ok(result.publicModels.some(({ id }) => id === 'gpt-stale'));
    assert.equal(result.status.lastFailureClass, 'transport');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uses static cold fallback for malformed, oversized, and failed discovery', async () => {
  const cases = [
    { fetchImpl: async () => new Response('{') },
    { fetchImpl: async () => modelsResponse(Array.from({ length: 513 }, (_, index) => ({ slug: `gpt-${index}` }))) },
    { fetchImpl: async () => new Response(JSON.stringify({ models: [{ slug: 'gpt-too-large', description: 'x'.repeat(100) }] })), catalogOptions: { maxResponseBytes: 64 } },
    { fetchImpl: async () => { throw new Error('offline'); } }
  ];
  for (const { fetchImpl, catalogOptions } of cases) {
    const { dir, store } = fixture();
    try {
      const catalog = new CodexModelCatalog(store, catalogOptions);
      const result = await catalog.resolve('default', { fetchImpl });
      assert.ok(result.publicModels.some(({ id }) => id === 'gpt-5.6-sol'));
      assert.equal(result.status.source, 'static');
      assert.equal(result.status.accountCount, 0);
      assert.equal(result.status.attemptedAccountCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('accepts authoritative empty catalogs and ignores malformed rows and sensitive metadata', async () => {
  const { dir, store, upstreams } = fixture(2);
  const accountByHeader = new Map(upstreams.map((upstream) => [upstream.accountId, upstream.id]));
  const catalog = new CodexModelCatalog(store);
  const fetchImpl = async (_url, options) => {
    const account = options.headers['chatgpt-account-id'];
    if (account === 'acct-0') return modelsResponse([]);
    return modelsResponse([
      null,
      { slug: '../invalid' },
      {
        slug: 'gpt-safe',
        input_modalities: ['text', 'image'],
        max_output_tokens: 12_345,
        nested: { stable: true, access_token: 'drop', refreshToken: 'drop', clientSecret: 'drop' },
        cookie: 'drop'
      }
    ]);
  };
  try {
    const result = await catalog.resolve('default', { fetchImpl });
    assert.equal(catalog.supports(accountByHeader.get('acct-0'), 'gpt-safe'), false);
    assert.equal(catalog.supports(accountByHeader.get('acct-1'), 'gpt-safe'), true);
    const row = result.nativeModels.find(({ id }) => id === 'gpt-safe');
    assert.deepEqual(row.input_modalities, ['text', 'image']);
    assert.equal(row.max_output_tokens, 12_345);
    assert.deepEqual(row.nested, { stable: true });
    assert.equal(row.cookie, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requires exact discovered ultrafast service-tier advertisements', async () => {
  const { dir, store, upstreams } = fixture(2);
  const catalog = new CodexModelCatalog(store);
  const fetchImpl = async (_url, options) => options.headers['chatgpt-account-id'] === 'acct-0'
    ? modelsResponse([{ slug: 'gpt-fast', service_tiers: [{ id: 'ultrafast' }] }])
    : modelsResponse([{ slug: 'gpt-fast', additional_speed_tiers: ['priority'] }]);
  try {
    await catalog.resolve('default', { fetchImpl });
    assert.equal(catalog.supportsServiceTier(upstreams[0].id, 'gpt-fast', 'ultrafast'), true);
    assert.equal(catalog.supportsServiceTier(upstreams[1].id, 'gpt-fast', 'ultrafast'), false);
    assert.equal(catalog.supportsServiceTier(upstreams[0].id, 'gpt-fast', 'priority'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fences stale discovery after token replacement and prunes deleted accounts', async () => {
  const { dir, store, upstreams } = fixture();
  const upstreamId = upstreams[0].id;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const catalog = new CodexModelCatalog(store);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      await pending;
      return modelsResponse([{ slug: 'gpt-stale-token' }]);
    }
    return modelsResponse([{ slug: 'gpt-new-token' }]);
  };
  try {
    const stale = catalog.discoverAccount(upstreamId, { fetchImpl });
    await new Promise((resolve) => setImmediate(resolve));
    store.update(upstreamId, codexInput('catalog-0@example.com', 'acct-0'));
    const fresh = catalog.discoverAccount(upstreamId, { fetchImpl });
    release();
    await Promise.all([stale, fresh]);
    assert.equal(catalog.supports(upstreamId, 'gpt-stale-token'), false);
    assert.equal(catalog.supports(upstreamId, 'gpt-new-token'), true);
    store.remove(upstreamId);
    assert.equal(catalog.supports(upstreamId, 'gpt-new-token'), null);
    assert.equal(catalog.status('default').accountCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregates heterogeneous accounts deterministically and filters routing by capability', async () => {
  const { dir, store, upstreams } = fixture(2);
  const catalog = new CodexModelCatalog(store);
  const fetchImpl = async (_url, options) => options.headers['chatgpt-account-id'] === 'acct-0'
    ? modelsResponse([{ slug: 'gpt-a-only' }, { slug: 'gpt-shared', context_window: 10 }])
    : modelsResponse([{ slug: 'gpt-b-only' }, { slug: 'gpt-shared', context_window: 20 }]);
  try {
    const first = await catalog.resolve('default', { fetchImpl });
    catalog.invalidate();
    const second = await catalog.resolve('default', { fetchImpl });
    assert.equal(first.etag, second.etag);
    assert.deepEqual(first.publicModels.slice(-3).map(({ id }) => id), ['gpt-a-only', 'gpt-b-only', 'gpt-shared']);
    const plan = store.candidatePlan({
      scopeId: 'default',
      model: 'gpt-a-only',
      preferredType: 'codex',
      modelSupport: (upstreamId, model) => catalog.supports(upstreamId, model)
    });
    assert.deepEqual(plan.map(({ id }) => id), [upstreams[0].id]);
    store.update(upstreams[0].id, { routing: { models: ['gpt-other'] } });
    assert.equal(store.candidatePlan({
      scopeId: 'default',
      model: 'gpt-a-only',
      preferredType: 'codex',
      modelSupport: (upstreamId, model) => catalog.supports(upstreamId, model)
    }).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selects image host models from the chosen account and falls back only when unknown', async () => {
  const { dir, store, upstreams } = fixture(2);
  const catalog = new CodexModelCatalog(store);
  const fetchImpl = async (_url, options) => options.headers['chatgpt-account-id'] === 'acct-0'
    ? modelsResponse([{ slug: 'gpt-text' }, { slug: 'gpt-image-host', input_modalities: ['text', 'image'] }])
    : modelsResponse([]);
  try {
    assert.equal(await catalog.imageModel(upstreams[0].id, { fetchImpl }), 'gpt-image-host');
    assert.equal(await catalog.imageModel(upstreams[1].id, { fetchImpl }), null);
    catalog.invalidate(upstreams[0].id);
    assert.equal(await catalog.imageModel(upstreams[0].id, { fetchImpl: async () => { throw new Error('offline'); } }), 'gpt-5.6-sol');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uses a selected-account model when image capability metadata is missing', async () => {
  const { dir, store, upstreams } = fixture();
  const catalog = new CodexModelCatalog(store);
  try {
    assert.equal(await catalog.imageModel(upstreams[0].id, {
      fetchImpl: async () => modelsResponse([{ slug: 'gpt-account-host' }])
    }), 'gpt-account-host');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removes authoritative model-not-found rows until discovery refreshes them', async () => {
  const { dir, store, upstreams } = fixture();
  let calls = 0;
  const catalog = new CodexModelCatalog(store);
  const fetchImpl = async () => {
    calls += 1;
    return modelsResponse([{ slug: 'gpt-retry-model' }]);
  };
  try {
    await catalog.resolve('default', { fetchImpl });
    catalog.markUnsupported(upstreams[0].id, 'gpt-retry-model');
    assert.equal(catalog.supports(upstreams[0].id, 'gpt-retry-model'), false);
    assert.equal(catalog.snapshot('default').publicModels.some(({ id }) => id === 'gpt-retry-model'), false);
    await catalog.resolve('default', { fetchImpl });
    assert.equal(calls, 2);
    assert.equal(catalog.supports(upstreams[0].id, 'gpt-retry-model'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not publish a failed in-flight discovery after account deletion', async () => {
  const { dir, store, upstreams } = fixture();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const catalog = new CodexModelCatalog(store);
  try {
    const discovery = catalog.discoverAccount(upstreams[0].id, {
      fetchImpl: async () => {
        await pending;
        throw new Error('offline');
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
    store.remove(upstreams[0].id);
    release();
    await discovery;
    assert.equal(catalog.status('default').accountCount, 0);
    assert.equal(catalog.entries.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not cache local pacing pressure as a model-discovery failure', async () => {
  const { dir, store, upstreams } = fixture();
  store.update(upstreams[0].id, {
    pacing: { enabled: true, minStartIntervalMs: 1_000, maxQueueDepth: 1, maxQueueAgeMs: 5_000 }
  });
  const pacer = upstreamPacerForStore(store);
  const catalog = new CodexModelCatalog(store);
  let calls = 0;
  try {
    await pacer.acquire(upstreams[0].id);
    const queued = pacer.acquire(upstreams[0].id);
    const result = await catalog.resolve('default', {
      fetchImpl: async () => {
        calls += 1;
        return modelsResponse([{ slug: 'gpt-should-not-start' }]);
      }
    });
    assert.equal(calls, 0);
    assert.equal(result.status.lastFailureAt, null);
    assert.equal(result.status.lastFailureClass, null);
    store.update(upstreams[0].id, { pacing: { enabled: false } });
    await queued;
  } finally {
    pacer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
