import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';
import {
  advisoryQuotaClientFromEnv,
  createAdvisoryQuotaClient,
  refreshAccountAdvisoryQuotas,
  refreshAllAdvisoryQuotas
} from '../src/advisory-quota.js';
import { providerIssue } from '../src/provider-availability.js';

test('delayed quota environment uses the fixed Loop endpoint and dedicated token', async () => {
  let request;
  const client = advisoryQuotaClientFromEnv({
    POOL_AI_QUOTA_SERVICE_TOKEN: 'dedicated-token',
    POOL_AI_QUOTA_BASE_URL: 'https://ignored.example',
    LOOP_API_BASE_URL: 'https://also-ignored.example',
    LOOP_SERVICE_TOKEN: 'legacy-token'
  }, {
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return new Response(JSON.stringify({ success: true, result: { data: [] } }), { status: 200 });
    }
  });

  await client.query('owner@example.com', ['claude']);

  assert.equal(request.url.origin, 'https://loop.shopee.io');
  assert.equal(request.options.headers.authorization, 'Bearer dedicated-token');
  assert.equal(advisoryQuotaClientFromEnv({ LOOP_SERVICE_TOKEN: 'legacy-token' }).enabled, false);
});

test('delayed quota client reads monthly Claude and AIS observations', async () => {
  const values = new Map([
    ['claude.usage_usd', 7],
    ['claude.cap_usd', 20],
    ['claude.balance_usd', 12.5],
    ['ais.usage_usd', 5],
    ['ais.cap_usd', 30],
    ['ais.balance_usd', 24]
  ]);
  const requests = [];
  const client = createAdvisoryQuotaClient({
    serviceToken: 'server-only-token',
    delayMs: 3_600_000,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      const dataKey = new URL(url).searchParams.get('data_key');
      return new Response(JSON.stringify({
        success: true,
        result: { data: [{ numeric_value: values.get(dataKey) }] }
      }), { status: 200 });
    }
  });

  const observations = await client.query('OWNER@EXAMPLE.COM', ['claude', 'ais']);

  assert.equal(requests.length, 6);
  assert.equal(requests[0].options.headers.authorization, 'Bearer server-only-token');
  assert.equal(requests[0].url.searchParams.get('user_email'), 'owner@example.com');
  assert.equal(observations[0].remainingDollars, 12.5);
  assert.equal(observations[1].remainingDollars, 24);
  assert.equal(observations[0].delaySeconds, 3600);
  assert.equal(Date.parse(observations[0].reportedAt) - Date.parse(observations[0].dataThroughAt), 3_600_000);
});

test('delayed quota client falls back to Claude cap minus usage when Loop has no balance', async () => {
  const client = createAdvisoryQuotaClient({
    serviceToken: 'server-only-token',
    fetchImpl: async (url) => {
      const dataKey = new URL(url).searchParams.get('data_key');
      const value = new Map([
        ['claude.usage_usd', 7],
        ['claude.cap_usd', 20]
      ]).get(dataKey);
      return new Response(JSON.stringify({
        success: true,
        result: { data: value === undefined ? [] : [{ numeric_value: value }] }
      }), { status: 200 });
    }
  });

  const [observation] = await client.query('owner@example.com', ['claude']);

  assert.equal(observation.remainingDollars, 13);
  assert.equal(observation.limitDollars, 20);
  assert.equal(observation.usageDollars, 7);
});

test('an empty delayed response remains unknown instead of becoming a zero balance', async () => {
  const client = createAdvisoryQuotaClient({
    serviceToken: 'server-only-token',
    fetchImpl: async () => new Response(JSON.stringify({
      success: true,
      result: { data: [] }
    }), { status: 200 })
  });
  const [observation] = await client.query('owner@example.com', ['claude']);
  const dir = mkdtempSync(join(tmpdir(), 'quotahub-advisory-quota-unknown-'));
  try {
    const store = new Store(dir);
    const claude = store.create({
      type: 'claude',
      accessToken: 'sk-ant-oat-advisory-unknown',
      metadata: { skip_account_profile: true }
    });

    await refreshAccountAdvisoryQuotas({
      store,
      email: 'owner@example.com',
      targets: [{ upstreamId: claude.id, provider: 'claude' }],
      client: { enabled: true, async query() { return [observation]; } }
    });

    assert.equal(observation.found, false);
    assert.equal(observation.remainingDollars, null);
    assert.equal(store.getPublic(claude.id).quota, null);
    assert.equal(providerIssue(store.getPublic(claude.id)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hourly delayed refresh promotes Claude and AIS data into enforceable quota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quotahub-advisory-quota-'));
  try {
    const store = new Store(dir);
    const productStore = new ProductStore(dir);
    const account = productStore.upsertAccount({ email: 'owner@example.com', name: 'Owner' });
    const claude = store.create({
      type: 'claude',
      accessToken: 'sk-ant-oat-advisory',
      metadata: { skip_account_profile: true }
    });
    const ais = store.create({
      type: 'compass',
      quotaSource: 'ais',
      projectId: 'ais-project',
      projectKey: 'ais-key'
    });
    productStore.linkUpstream(account.id, claude.id);
    productStore.linkUpstream(account.id, ais.id);

    const queried = [];
    const results = await refreshAllAdvisoryQuotas(store, productStore, {
      client: {
        enabled: true,
        async query(email, providers) {
          queried.push({ email, providers });
          return providers.map((provider) => ({
            provider,
            found: true,
            quotaMonth: 202609,
            usageDollars: provider === 'claude' ? 4 : 6,
            limitDollars: 20,
            remainingDollars: provider === 'claude' ? 16 : 14,
            reportedAt: '2026-09-18T12:00:00.000Z',
            dataThroughAt: '2026-09-18T11:00:00.000Z',
            delaySeconds: 3600,
            source: 'loop_ai_usage'
          }));
        }
      }
    });

    assert.equal(results[0].status, 'fulfilled');
    assert.deepEqual(queried, [{ email: 'owner@example.com', providers: ['claude', 'ais'] }]);
    assert.equal(store.getPublic(claude.id).quota.remainingDollars, 16);
    assert.equal(store.getPublic(claude.id).quota.remainingPercent, 80);
    assert.equal(store.getPublic(claude.id).advisoryQuota.remainingDollars, 16);
    assert.equal(store.getPublic(ais.id).quota.remainingDollars, 14);
    assert.equal(store.getPublic(ais.id).quota.remainingPercent, 70);
    assert.equal(store.getPublic(ais.id).quotaSource, 'ais');
    assert.equal(store.getPublic(ais.id).advisoryQuota.remainingDollars, 14);
    assert.equal(productStore.providerSummary(account.id, claude.id, store).commitment.actualQuotaDollars, 16);
    assert.equal(productStore.providerSummary(account.id, ais.id, store).commitment.actualQuotaDollars, 14);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an AIS balance without a monthly cap remains available for sharing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quotahub-advisory-quota-ais-balance-'));
  try {
    const store = new Store(dir);
    const productStore = new ProductStore(dir);
    const account = productStore.upsertAccount({ email: 'owner@example.com', name: 'Owner' });
    const ais = store.create({
      type: 'compass',
      quotaSource: 'ais',
      projectId: 'ais-balance-project',
      projectKey: 'ais-balance-key'
    });
    productStore.linkUpstream(account.id, ais.id);
    const client = createAdvisoryQuotaClient({
      serviceToken: 'server-only-token',
      fetchImpl: async (url) => {
        const dataKey = new URL(url).searchParams.get('data_key');
        const value = dataKey === 'ais.balance_usd' ? 24 : null;
        return new Response(JSON.stringify({
          success: true,
          result: { data: value === null ? [] : [{ numeric_value: value }] }
        }), { status: 200 });
      }
    });

    await refreshAccountAdvisoryQuotas({
      store,
      email: 'owner@example.com',
      targets: [{ upstreamId: ais.id, provider: 'ais' }],
      client
    });

    const upstream = store.getPublic(ais.id);
    assert.equal(upstream.quota.remainingDollars, 24);
    assert.equal(upstream.quota.remainingPercent, null);
    assert.equal(providerIssue(upstream), null);
    assert.equal(productStore.providerSummary(account.id, ais.id, store).commitment.actualQuotaDollars, 24);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty delayed observation retains the last enforceable Loop balance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quotahub-advisory-quota-empty-'));
  try {
    const store = new Store(dir);
    const claude = store.create({
      type: 'claude',
      accessToken: 'sk-ant-oat-advisory-empty',
      metadata: { skip_account_profile: true }
    });
    store.setQuota(claude.id, {
      remainingDollars: 0,
      remainingPercent: 0,
      observedAt: '2026-09-18T12:00:00.000Z',
      source: 'loop_ai_usage'
    });

    const result = await refreshAccountAdvisoryQuotas({
      store,
      email: 'owner@example.com',
      targets: [{ upstreamId: claude.id, provider: 'claude' }],
      client: {
        enabled: true,
        async query() {
          return [{
            provider: 'claude',
            found: false,
            quotaMonth: 202609,
            usageDollars: null,
            limitDollars: null,
            remainingDollars: null,
            reportedAt: '2026-09-18T13:00:00.000Z',
            dataThroughAt: '2026-09-18T12:00:00.000Z',
            delaySeconds: 3600,
            source: 'loop_ai_usage'
          }];
        }
      }
    });

    assert.deepEqual(result, { status: 'refreshed', updated: 1 });
    assert.equal(store.getPublic(claude.id).advisoryQuota.found, false);
    assert.equal(store.getPublic(claude.id).quota.remainingDollars, 0);
    assert.equal(store.getPublic(claude.id).quota.remainingPercent, 0);
    assert.equal(store.getPublic(claude.id).quota.source, 'loop_ai_usage');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty delayed observation clears an expired Loop balance after the monthly reset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quotahub-advisory-quota-rollover-'));
  try {
    const store = new Store(dir);
    const claude = store.create({
      type: 'claude',
      accessToken: 'sk-ant-oat-advisory-rollover',
      metadata: { skip_account_profile: true }
    });
    store.setQuota(claude.id, {
      remainingDollars: 0,
      remainingPercent: 0,
      resetAt: '2026-09-01T00:00:00.000Z',
      observedAt: '2026-08-31T23:00:00.000Z',
      source: 'loop_ai_usage'
    });

    await refreshAccountAdvisoryQuotas({
      store,
      email: 'owner@example.com',
      targets: [{ upstreamId: claude.id, provider: 'claude' }],
      client: {
        enabled: true,
        async query() {
          return [{
            provider: 'claude',
            found: false,
            quotaMonth: 202609,
            usageDollars: null,
            limitDollars: null,
            remainingDollars: null,
            reportedAt: '2026-09-18T13:00:00.000Z',
            dataThroughAt: '2026-09-18T12:00:00.000Z',
            delaySeconds: 3600,
            source: 'loop_ai_usage'
          }];
        }
      }
    });

    const upstream = store.getPublic(claude.id);
    assert.equal(upstream.quota, null);
    assert.equal(providerIssue(upstream), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
