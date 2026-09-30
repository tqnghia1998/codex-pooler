import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

test('serves scoped settled gateway usage and rejects usage filters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-usage-'));
  const store = new Store(dir);
  const key = store.configureApiKey('usage-key');
  const upstream = store.create({ type: 'compass', projectId: 'usage-project', projectKey: 'project-key' });
  store.setQuota(upstream.id, { limitUnits: 120, remainingUnits: 108, windowSeconds: 18_000 });
  store.recordGatewayUsage({ scopeId: key.scopeId, apiKeyId: key.id, attemptId: 'attempt-1', usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, totalTokens: 10 }, settledCostMicros: 3450000 });
  store.recordGatewayUsage({ scopeId: key.scopeId, apiKeyId: key.id, attemptId: 'attempt-2', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, settledCostMicros: 550000 });
  store.recordGatewayUsage({ scopeId: key.scopeId, apiKeyId: key.id, attemptId: 'attempt-2', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, settledCostMicros: 550000 });
  assert.equal(store.load().gatewayUsage.length, 1);
  const server = createServer(createApp({ store, apiKey: 'usage-key' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const usage = await fetch(`${base}/v1/usage`, { headers: { authorization: 'Bearer usage-key' } });
    assert.deepEqual(await usage.json(), { request_count: 2, total_tokens: 13, cached_input_tokens: 2, total_cost_usd: 4, total_cost_status: 'priced', limits: [], upstream_limits: [{ limit_type: 'credits', limit_window: '5h', max_value: 120, current_value: 12, remaining_value: 108, model_filter: null, source: 'upstream_usage' }] });
    const filtered = await fetch(`${base}/v1/usage?start_time=1`, { headers: { authorization: 'Bearer usage-key' } });
    assert.equal((await filtered.json()).error.code, 'unsupported_parameter');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
