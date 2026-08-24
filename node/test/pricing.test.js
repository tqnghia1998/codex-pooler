import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage, mergeUsage, priceUsage, upstreamCostMicros } from '../src/pricing.js';

test('extracts Codex and Anthropic token/cache usage shapes', () => {
  assert.deepEqual(extractUsage({ usage: {
    input_tokens: 1_000,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 25 },
    service_tier: 'priority'
  }}), { inputTokens: 1_000, cachedInputTokens: 200, cacheWriteTokens: 100, outputTokens: 50, reasoningTokens: 25, serviceTier: 'priority' });

  assert.deepEqual(extractUsage({ message: { usage: {
    input_tokens: 100, cache_read_input_tokens: 10, cache_creation_input_tokens: 50, output_tokens: 20
  }}}), { inputTokens: 160, cachedInputTokens: 10, cacheWriteTokens: 50, outputTokens: 20, serviceTier: null });
});

test('keeps the served model across stream events', () => {
  const merged = mergeUsage(
    extractUsage({ type: 'response.created', response: { model: 'gpt-5.6-terra', usage: { input_tokens: 1_000 } } }),
    extractUsage({ type: 'response.completed', response: { usage: { input_tokens: 1_000, output_tokens: 100 } } })
  );
  assert.equal(merged.model, 'gpt-5.6-terra');
  assert.equal(priceUsage([merged.model], merged).settledCostMicros, 3_200);
});

test('prices usage when a provider total_tokens disagrees with input plus output', () => {
  assert.equal(priceUsage(['gpt-5.6-terra'], { inputTokens: 1_000, outputTokens: 100, totalTokens: 900 }).settledCostMicros, 3_200);
});

test('accepts only plain decimal provider-reported cost', () => {
  assert.equal(upstreamCostMicros({ price_cost_usd: '0.5' }), 500_000);
  assert.equal(upstreamCostMicros({ price_cost_usd: 0.5 }), 500_000);
  for (const value of ['', ' ', '1e5', 'abc', [], true, -1, null, undefined]) {
    assert.equal(upstreamCostMicros({ price_cost_usd: value }), undefined, `rejects ${JSON.stringify(value)}`);
  }
});

test('merges partial stream usage and resolves dated model pricing by suffix', () => {
  const usage = mergeUsage(
    extractUsage({ response: { usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 200 } } } }),
    extractUsage({ response: { usage: { output_tokens: 100, price_cost_usd: '0.005' } } })
  );
  assert.deepEqual(usage, { inputTokens: 1_000, cachedInputTokens: 200, cacheWriteTokens: 0, outputTokens: 100, serviceTier: null, upstreamCostMicros: 5_000 });

  assert.deepEqual(priceUsage(['gpt-5.6-sol-20260801'], { inputTokens: 1_000, cachedInputTokens: 200, cacheWriteTokens: 100, outputTokens: 50, serviceTier: 'priority' }), {
    settledCostMicros: 8_760,
    costSource: 'pricing_snapshot',
    model: 'gpt-5.6-sol',
    priceVersion: 'openai-2026-08-21'
  });
  assert.deepEqual(priceUsage(['gpt-5.6-sol'], { inputTokens: 272_001, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }), {
    settledCostMicros: 2_176_008,
    costSource: 'pricing_snapshot',
    model: 'gpt-5.6-sol',
    priceVersion: 'openai-2026-08-21'
  });
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 272_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }).settledCostMicros, 1_088_000);
  assert.equal(priceUsage(['claude-sonnet-5-20260101'], { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }, '2026-08-31T23:59:59Z').settledCostMicros, 1_200);
  assert.equal(priceUsage(['claude-sonnet-5-20260101'], { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }, '2026-09-01T00:00:00Z').settledCostMicros, 1_800);
  assert.equal(priceUsage(['claude-3-sonnet'], { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 1, outputTokens: 100 }), null);
  // A model priced only at standard rates still bills on a priority request instead of escaping the spending cap.
  assert.equal(priceUsage(['claude-sonnet-4-6'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100, serviceTier: 'priority' }).settledCostMicros, 4_500);
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, serviceTier: 'priority' }).settledCostMicros, 8_000);
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, serviceTier: 'flex' }).settledCostMicros, 2_000);
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, serviceTier: 'ultrafast' }), null);
  assert.equal(extractUsage({ usage: { input_tokens: 1_000, output_tokens: 100, price_cost_usd: null } }).upstreamCostMicros, undefined);
  assert.equal(extractUsage({ usage: { input_tokens: 100, cached_input_tokens: 100, cache_write_tokens: 100, output_tokens: 1 } }), null);
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 100, cachedInputTokens: 100, cacheWriteTokens: 100, outputTokens: 1 }), null);
});
