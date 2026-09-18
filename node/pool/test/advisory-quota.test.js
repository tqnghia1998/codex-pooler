import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';
import {
  createAdvisoryQuotaClient,
  refreshAllAdvisoryQuotas
} from '../src/advisory-quota.js';

test('delayed quota client reads monthly Claude and AIS observations', async () => {
  const values = new Map([
    ['claude.usage_usd', 7],
    ['claude.cap_usd', 20],
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

  assert.equal(requests.length, 5);
  assert.equal(requests[0].options.headers.authorization, 'Bearer server-only-token');
  assert.equal(requests[0].url.searchParams.get('user_email'), 'owner@example.com');
  assert.equal(observations[0].remainingDollars, 13);
  assert.equal(observations[1].remainingDollars, 24);
  assert.equal(observations[0].delaySeconds, 3600);
  assert.equal(Date.parse(observations[0].reportedAt) - Date.parse(observations[0].dataThroughAt), 3_600_000);
});

test('hourly delayed refresh stores advisory data without setting enforceable quota', async () => {
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
    assert.equal(store.getPublic(claude.id).quota, null);
    assert.equal(store.getPublic(claude.id).advisoryQuota.remainingDollars, 16);
    assert.equal(store.getPublic(ais.id).quota, null);
    assert.equal(store.getPublic(ais.id).advisoryQuota.remainingDollars, 14);
    assert.equal(productStore.providerSummary(account.id, claude.id, store).commitment.actualQuotaDollars, null);
    assert.equal(productStore.providerSummary(account.id, ais.id, store).commitment.actualQuotaDollars, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
