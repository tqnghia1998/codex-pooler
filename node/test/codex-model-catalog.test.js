import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexModelCatalog, MODEL_LISTING_TTL_MS } from '../src/codex-model-catalog.js';
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

test('cold handshake discovery is bounded and continues through the shared cache', { timeout: 3_000 }, async () => {
  const { dir, store } = fixture();
  const catalog = new CodexModelCatalog(store, { handshakeWaitMs: 10 });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await pending;
    return modelsResponse([{ slug: 'gpt-handshake' }]);
  };
  try {
    const [first, second] = await Promise.all([
      catalog.forHandshake('default', { fetchImpl }),
      catalog.forHandshake('default', { fetchImpl })
    ]);
    assert.equal(first.status.source, 'static');
    assert.equal(first.etag, second.etag);
    assert.equal(calls, 1);
    release();
    const refreshed = await catalog.resolve('default', { fetchImpl });
    assert.equal(calls, 1);
    assert.notEqual(refreshed.etag, first.etag);
    assert.equal(refreshed.publicModels.some(({ id }) => id === 'gpt-handshake'), true);
  } finally {
    release();
    await catalog.resolve('default', { fetchImpl });
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale handshake catalogs fall back after the discovery budget and survive provider failure', { timeout: 3_000 }, async () => {
  const { dir, store } = fixture();
  let now = Date.now();
  const catalog = new CodexModelCatalog(store, { now: () => now, freshTtlMs: 100, handshakeWaitMs: 10 });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => { await pending; throw new Error('synthetic outage'); };
  try {
    const initial = await catalog.resolve('default', { fetchImpl: async () => modelsResponse([{ slug: 'gpt-cached' }]) });
    now += 200;
    const stale = await catalog.forHandshake('default', { fetchImpl });
    assert.equal(stale.etag, initial.etag);
    assert.equal(stale.status.freshness, 'stale');
    release();
    await catalog.resolve('default', { fetchImpl });
    assert.equal(catalog.snapshot('default').etag, initial.etag);
  } finally {
    release();
    await catalog.resolve('default', { fetchImpl });
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handshakes prefer a completed live refresh over a fresh cached context window', async () => {
  const { dir, store } = fixture();
  const catalog = new CodexModelCatalog(store);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return modelsResponse([{ slug: 'gpt-6-sol', context_window: calls === 1 ? 272_000 : 400_000 }]);
  };
  try {
    const initial = await catalog.resolve('default', { fetchImpl });
    const refreshed = await catalog.forHandshake('default', { fetchImpl });
    assert.equal(calls, 2);
    assert.equal(initial.publicModels.find(({ id }) => id === 'gpt-6-sol').context_window, 272_000);
    assert.equal(refreshed.publicModels.find(({ id }) => id === 'gpt-6-sol').context_window, 400_000);
    assert.notEqual(refreshed.etag, initial.etag);
  } finally {
    await Promise.all(catalog.inflight.values());
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit refresh retains the last live context on failure and respects retry backoff', async () => {
  const { dir, store } = fixture();
  let now = 1_000;
  let calls = 0;
  const catalog = new CodexModelCatalog(store, { now: () => now, failureSuppressionMs: 50 });
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1 || calls === 3) {
      return modelsResponse([{ slug: 'gpt-6-sol', context_window: calls === 1 ? 272_000 : 400_000 }]);
    }
    throw new Error('offline');
  };
  try {
    await catalog.resolve('default', { fetchImpl });
    const failed = await catalog.resolve('default', { fetchImpl, refresh: true });
    assert.equal(calls, 2);
    assert.equal(failed.publicModels.find(({ id }) => id === 'gpt-6-sol').context_window, 272_000);
    assert.equal(failed.status.lastFailureClass, 'transport');
    await catalog.resolve('default', { fetchImpl, refresh: true });
    assert.equal(calls, 2);
    now += 51;
    const recovered = await catalog.resolve('default', { fetchImpl, refresh: true });
    assert.equal(calls, 3);
    assert.equal(recovered.publicModels.find(({ id }) => id === 'gpt-6-sol').context_window, 400_000);
    assert.equal(recovered.status.lastFailureClass, null);
  } finally {
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unavailable live token limits use static defaults without replacing valid live limits', async () => {
  for (const unavailable of [undefined, null, 0, -1, '272000', 1.5]) {
    const { dir, store } = fixture();
    const catalog = new CodexModelCatalog(store);
    try {
      const result = await catalog.resolve('default', { fetchImpl: async () => modelsResponse([
        { slug: 'gpt-6-sol', context_window: unavailable, max_output_tokens: unavailable },
        { slug: 'gpt-6.1-sol', context_window: 272_000, max_output_tokens: 32_000 }
      ]) });
      const fallback = result.publicModels.find(({ id }) => id === 'gpt-6-sol');
      assert.equal(fallback.context_window, 1_050_000);
      assert.equal(fallback.max_output_tokens, 128_000);
      const live = result.publicModels.find(({ id }) => id === 'gpt-6.1-sol');
      assert.equal(live.context_window, 272_000);
      assert.equal(live.max_output_tokens, 32_000);
    } finally {
      store.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('successful live metadata outranks richer cached metadata after another account fails', async () => {
  const { dir, store, upstreams } = fixture(2);
  const catalog = new CodexModelCatalog(store);
  const ids = upstreams.map(({ id }) => id);
  const findModel = (result) => result.publicModels.find(({ id }) => id === 'gpt-6-sol');
  try {
    await catalog.resolve('default', { fetchImpl: async () => modelsResponse([
      { slug: 'gpt-6-sol', context_window: 400_000, description: 'richer cached metadata' }
    ]) });
    const result = await catalog.resolve('default', {
      refresh: true,
      fetchImpl: async (_url, options) => {
        if (options.headers['chatgpt-account-id'] === 'acct-0') throw new Error('offline');
        return modelsResponse([{ slug: 'gpt-6-sol', context_window: 272_000 }]);
      }
    });
    assert.equal(findModel(result).context_window, 272_000);
    assert.equal(findModel(catalog.scopedAccountsCatalog(ids)).context_window, 272_000);
    assert.equal(findModel(catalog.scopedAccountCatalog(ids[0])).context_window, 400_000);
    assert.equal(result.status.source, 'mixed');
    assert.equal(result.status.freshAccountCount, 1);
    assert.equal(catalog.scopedAccountCatalog(ids[0]).status.freshness, 'stale');
  } finally {
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('valid discovered limits from another account take precedence over static defaults', async () => {
  const { dir, store } = fixture(2);
  const catalog = new CodexModelCatalog(store);
  try {
    const result = await catalog.resolve('default', {
      fetchImpl: async (_url, options) => modelsResponse([
        options.headers['chatgpt-account-id'] === 'acct-0'
          ? { slug: 'gpt-6-sol', description: 'richer metadata without any token limits'.repeat(5) }
          : { slug: 'gpt-6-sol', context_window: 272_000, max_input_tokens: 258_400, max_output_tokens: 32_000 }
      ])
    });
    for (const models of [result.publicModels, result.nativeModels]) {
      const row = models.find(({ id }) => id === 'gpt-6-sol');
      assert.equal(row.context_window, 272_000);
      assert.equal(row.max_input_tokens, 258_400);
      assert.equal(row.max_output_tokens, 32_000);
    }
    assert.equal(result.nativeModels.find(({ id }) => id === 'gpt-6-sol').description, 'richer metadata without any token limits'.repeat(5));
  } finally {
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregation refreshes its ranking when a richer cached catalog expires', async () => {
  const { dir, store, upstreams } = fixture(2);
  let now = 1_000;
  const catalog = new CodexModelCatalog(store, { now: () => now, freshTtlMs: 100 });
  const ids = upstreams.map(({ id }) => id);
  try {
    await catalog.discoverAccount(ids[0], { fetchImpl: async () => modelsResponse([
      { slug: 'gpt-6-sol', context_window: 400_000, description: 'richer older catalog' }
    ]) });
    now += 50;
    await catalog.discoverAccount(ids[1], { fetchImpl: async () => modelsResponse([
      { slug: 'gpt-6-sol', context_window: 272_000 }
    ]) });
    const initial = catalog.snapshot();
    const scoped = catalog.scopedAccountsCatalog(ids);
    assert.equal(initial.publicModels.find(({ id }) => id === 'gpt-6-sol').context_window, 400_000);
    now += 51;
    for (const result of [catalog.snapshot(), catalog.scopedAccountsCatalog(ids)]) {
      assert.equal(result.publicModels.find(({ id }) => id === 'gpt-6-sol').context_window, 272_000);
      assert.notEqual(result.etag, initial.etag);
      assert.notEqual(result.etag, scoped.etag);
    }
  } finally {
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coalesces explicit live refreshes even when an existing catalog is fresh', async () => {
  const { dir, store } = fixture();
  const catalog = new CodexModelCatalog(store);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await pending;
    return modelsResponse([{ slug: 'gpt-6-sol', context_window: 272_000 }]);
  };
  try {
    await catalog.resolve('default', { fetchImpl: async () => modelsResponse([
      { slug: 'gpt-6-sol', context_window: 400_000 }
    ]) });
    const requests = Array.from({ length: 10 }, () => catalog.resolve('default', { fetchImpl, refresh: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const results = await Promise.all(requests);
    assert.equal(calls, 1);
    assert.ok(results.every(({ publicModels }) => publicModels.find(({ id }) => id === 'gpt-6-sol').context_window === 272_000));
  } finally {
    release();
    await Promise.all(catalog.inflight.values());
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared handshake discovery limits concurrency and excludes accounts outside the scope', { timeout: 3_000 }, async () => {
  const { dir, store, upstreams } = fixture(7);
  store.createScope({ id: 'private' });
  const foreign = store.create(codexInput('foreign@example.com'), { scopeId: 'private' });
  store.setCap(foreign.id, { capDollars: 100 });
  const catalog = new CodexModelCatalog(store, { handshakeWaitMs: 10 });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let peak = 0;
  const accounts = [];
  const fetchImpl = async (_url, options) => {
    accounts.push(options.headers['chatgpt-account-id']);
    peak = Math.max(peak, ++active);
    await pending;
    active -= 1;
    return modelsResponse([{ slug: 'gpt-shared' }]);
  };
  try {
    const upstreamIds = [...upstreams.map(({ id }) => id), foreign.id, upstreams[0].id];
    const fallback = await catalog.forHandshake('default', { upstreamIds, fetchImpl });
    assert.equal(fallback.status.source, 'static');
    assert.equal(accounts.length, 3);
    release();
    await catalog.resolve('default', { fetchImpl });
    assert.equal(accounts.length, 7);
    assert.equal(peak, 3);
    assert.equal(catalog.entries.has(foreign.id), false);
    assert.equal(await catalog.forHandshake('default', { upstreamIds: [foreign.id], fetchImpl }), null);
  } finally {
    release();
    await catalog.resolve('default', { fetchImpl });
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handshake snapshots preserve selected-account isolation and credential invalidation', async () => {
  const { dir, store, upstreams } = fixture(2);
  const catalog = new CodexModelCatalog(store);
  const fetchImpl = async (_url, options) => modelsResponse([
    { slug: options.headers['chatgpt-account-id'] === 'acct-0' ? 'gpt-selected' : 'gpt-other' }
  ]);
  try {
    await catalog.resolve('default', { fetchImpl });
    const upstreamIds = [upstreams[0].id];
    const selected = await catalog.forHandshake('default', { upstreamIds, fetchImpl });
    assert.equal(selected.publicModels.some(({ id }) => id === 'gpt-selected'), true);
    assert.equal(selected.publicModels.some(({ id }) => id === 'gpt-other'), false);
    store.update(upstreams[0].id, codexInput('catalog-0@example.com', 'acct-replaced'));
    const replaced = await catalog.forHandshake('default', {
      upstreamIds, fetchImpl: async () => modelsResponse([{ slug: 'gpt-replaced' }])
    });
    assert.equal(replaced.publicModels.some(({ id }) => id === 'gpt-selected'), false);
    assert.equal(replaced.publicModels.some(({ id }) => id === 'gpt-replaced'), true);
    store.remove(upstreams[0].id);
    assert.equal(await catalog.forHandshake('default', { upstreamIds, fetchImpl }), null);
    assert.equal(catalog.entries.has(upstreams[0].id), false);
  } finally {
    await Promise.all(catalog.inflight.values());
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('listing cache revalidates after one hour without changing internal freshness', async () => {
  const { dir, store, upstreams } = fixture();
  let now = 1_000;
  let calls = 0;
  const catalog = new CodexModelCatalog(store, { now: () => now });
  const fetchImpl = async () => {
    calls += 1;
    return modelsResponse([{ slug: 'gpt-6-sol', context_window: calls === 1 ? 272_000 : 400_000 }]);
  };
  try {
    const options = { fetchImpl, cacheTtlMs: MODEL_LISTING_TTL_MS };
    const first = await catalog.resolve('default', options);
    now += 5 * 60_000 + 1;
    assert.equal(catalog.snapshot('default').status.freshness, 'stale');
    const cached = await catalog.resolve('default', options);
    assert.equal(calls, 1);
    assert.equal(cached.status.freshness, 'fresh');
    assert.equal(cached.publicEtag, first.publicEtag);
    assert.equal(catalog.supports(upstreams[0].id, 'gpt-6-sol'), true);

    await catalog.resolve('default', { fetchImpl: async () => { throw new Error('offline'); }, refresh: true });
    assert.equal((await catalog.resolve('default', options)).publicEtag, first.publicEtag);
    assert.equal(calls, 1);

    now = 1_000 + MODEL_LISTING_TTL_MS;
    const refreshed = await catalog.resolve('default', options);
    assert.equal(calls, 2);
    assert.equal(refreshed.publicModels.find(({ id }) => id === 'gpt-6-sol').context_window, 400_000);
    assert.notEqual(refreshed.publicEtag, first.publicEtag);
  } finally {
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reuses aggregated model snapshots until catalog or scope policy changes', async () => {
  const { dir, store, upstreams } = fixture();
  const catalog = new CodexModelCatalog(store);
  try {
    await catalog.resolve('default', { fetchImpl: async () => modelsResponse([{ slug: 'gpt-live' }]) });
    const first = catalog.snapshot('default');
    const second = catalog.snapshot('default');
    assert.equal(second.nativeModels, first.nativeModels);
    assert.notEqual(second.status, first.status);

    catalog.markUnsupported(upstreams[0].id, 'gpt-live');
    const unsupported = catalog.snapshot('default');
    assert.notEqual(unsupported.nativeModels, first.nativeModels);
    assert.equal(unsupported.publicModels.some(({ id }) => id === 'gpt-live'), false);

    store.updateScope('default', { models: ['gpt-5.6-sol'] });
    const restricted = catalog.snapshot('default');
    assert.notEqual(restricted.nativeModels, unsupported.nativeModels);
    assert.deepEqual(restricted.publicModels.map(({ id }) => id), ['gpt-5.6-sol']);
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
    assert.equal(await catalog.imageModel(upstreams[0].id, { fetchImpl: async () => { throw new Error('offline'); } }), 'gpt-6-astra');
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
