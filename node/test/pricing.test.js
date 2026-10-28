import test from 'node:test';
import assert from 'node:assert/strict';
import { cheapestPricedModel, extractUsage, isPricedModel, mergeUsage, priceUsage, requestCacheWriteTtl, resolvePrice, upstreamCostMicros } from '../src/pricing.js';
import { OPENAI_PRICING_VERSION } from '../src/openai-pricing-snapshot.js';

test('selects the cheapest priced model and preserves provider order as fallback', () => {
  assert.equal(cheapestPricedModel(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra']), 'gpt-5.6-luna');
  assert.equal(cheapestPricedModel(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5']), 'claude-sonnet-5');
  assert.equal(cheapestPricedModel(['unknown-first', 'unknown-second']), 'unknown-first');
  assert.equal(cheapestPricedModel([]), null);
});

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

test('keeps requested priority when Codex echoes default, but respects other served tiers', () => {
  const usage = { inputTokens: 1_000, outputTokens: 100, serviceTier: 'default' };
  assert.equal(priceUsage(['gpt-6-sol'], usage, undefined, 'priority').settledCostMicros, 6_000);
  assert.equal(priceUsage(['gpt-6-sol'], usage, undefined, 'default').settledCostMicros, 3_000);
  assert.equal(priceUsage(['gpt-6-sol'], { ...usage, serviceTier: 'flex' }, undefined, 'priority').settledCostMicros, 1_500);
  assert.equal(priceUsage(['gpt-6-sol'], { ...usage, serviceTier: null }, undefined, 'priority').settledCostMicros, 6_000);
});

test('accepts only plain decimal provider-reported cost', () => {
  assert.equal(upstreamCostMicros({ price_cost_usd: '0.5' }), 500_000);
  assert.equal(upstreamCostMicros({ price_cost_usd: 0.5 }), 500_000);
  for (const value of ['', ' ', '1e5', 'abc', [], true, -1, null, undefined]) {
    assert.equal(upstreamCostMicros({ price_cost_usd: value }), undefined, `rejects ${JSON.stringify(value)}`);
  }
});

test('selects context prices from one generation and leaves unknown rules unpriced', () => {
  const row = (bucket, priceVersion, effectiveAt, contextRule) => ({
    model: 'gpt-test', tier: 'standard', bucket, input: 1, output: 1,
    cachedInput: 0.1, cacheWrite: 1.25, priceVersion, effectiveAt, contextRule
  });
  const old = [row('default', 'old', '2026-01-01T00:00:00Z', { status: 'legacy', longContextInputTokensGt: 272_000 }),
    row('long_context', 'old', '2026-01-01T00:00:00Z', { status: 'legacy', longContextInputTokensGt: 272_000 })];
  const currentRule = { status: 'known', longContextInputTokensGt: 100 };
  const current = [row('short_context', 'current', '2026-10-01T00:00:00Z', currentRule),
    row('long_context', 'current', '2026-10-01T00:00:00Z', currentRule)];
  const prices = [...old, ...current];
  assert.equal(resolvePrice('gpt-test', 'standard', Date.parse('2026-10-02'), 100, prices).bucket, 'short_context');
  assert.equal(resolvePrice('gpt-test', 'standard', Date.parse('2026-10-02'), 101, prices).bucket, 'long_context');
  assert.equal(resolvePrice('gpt-test', 'standard', Date.parse('2026-09-01'), 101, prices).priceVersion, 'old');
  assert.equal(resolvePrice('gpt-test', 'standard', Date.parse('2026-10-02'), 101,
    [...old, row('default', 'current', '2026-10-01T00:00:00Z', { status: 'unknown', reason: 'missing_source' })]), null);
});

test('merges partial stream usage and resolves dated model pricing by suffix', () => {
  const usage = mergeUsage(
    extractUsage({ response: { usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 200 } } } }),
    extractUsage({ response: { usage: { output_tokens: 100, price_cost_usd: '0.005' } } })
  );
  assert.deepEqual(usage, { inputTokens: 1_000, cachedInputTokens: 200, cacheWriteTokens: 0, outputTokens: 100, serviceTier: null, upstreamCostMicros: 5_000 });

  // The feed prices cache writes only per TTL (30m/12h). Writes use the TTL the
  // request asked for (30m unless a breakpoint asked for 12h), never going free.
  const writes = { inputTokens: 1_000, cachedInputTokens: 200, cacheWriteTokens: 100, outputTokens: 50, serviceTier: 'priority' };
  assert.deepEqual(priceUsage(['gpt-5.6-sol-20260801'], writes), {
    settledCostMicros: 8_760,
    costSource: 'pricing_snapshot',
    model: 'gpt-5.6-sol',
    priceVersion: OPENAI_PRICING_VERSION
  });
  assert.equal(priceUsage(['gpt-5.6-sol'], writes, undefined, null, { cacheWriteTtl: '12h' }).settledCostMicros, 9_760);
  assert.equal(priceUsage(['gpt-5.6-sol'], writes, undefined, null, { cacheWriteTtl: '1w' }), null);
  assert.deepEqual(priceUsage(['gpt-5.6-sol-20260801'], { inputTokens: 1_000, cachedInputTokens: 200, cacheWriteTokens: 0, outputTokens: 50, serviceTier: 'priority' }), {
    settledCostMicros: 8_560,
    costSource: 'pricing_snapshot',
    model: 'gpt-5.6-sol',
    priceVersion: OPENAI_PRICING_VERSION
  });
  assert.deepEqual(priceUsage(['gpt-5.6-sol'], { inputTokens: 272_001, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }), {
    settledCostMicros: 2_176_008,
    costSource: 'pricing_snapshot',
    model: 'gpt-5.6-sol',
    priceVersion: OPENAI_PRICING_VERSION
  });
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 272_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }).settledCostMicros, 1_088_000);
  assert.equal(priceUsage(['claude-sonnet-5-20260101'], { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }, '2026-08-31T23:59:59Z').settledCostMicros, 1_200);
  assert.equal(priceUsage(['claude-sonnet-5-20260101'], { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }, '2026-09-01T00:00:00Z').settledCostMicros, 1_800);
  assert.deepEqual(priceUsage(['claude-sonnet-5-5'], { inputTokens: 1_000, cachedInputTokens: 100, cacheWriteTokens: 100, outputTokens: 100 }, '2026-09-29T00:00:00Z'), {
    settledCostMicros: 2_870,
    costSource: 'pricing_snapshot',
    model: 'claude-sonnet-5-5',
    priceVersion: 'anthropic-list-2026-09-28'
  });
  assert.equal(priceUsage(['claude-sonnet-5-5-20260928'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }, '2026-09-29T00:00:00Z').settledCostMicros, 3_000);
  assert.equal(priceUsage(['claude-3-sonnet'], { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 1, outputTokens: 100 }), null);
  // A missing cached-input rate leaves cost unavailable only when cached input is billable.
  assert.equal(priceUsage(['claude-3-sonnet'], { inputTokens: 100, cachedInputTokens: 10, cacheWriteTokens: 0, outputTokens: 100 }), null);
  assert.equal(priceUsage(['claude-3-sonnet'], { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }).settledCostMicros, 1_800);
  // A model priced only at standard rates still bills on a priority request instead of escaping the spending cap.
  assert.equal(priceUsage(['claude-sonnet-4-6'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100, serviceTier: 'priority' }).settledCostMicros, 4_500);
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, serviceTier: 'priority' }).settledCostMicros, 8_000);
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, serviceTier: 'flex' }).settledCostMicros, 2_000);
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, serviceTier: 'ultrafast' }), null);
  assert.equal(priceUsage(['gpt-6-sol'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100, serviceTier: 'priority' }).settledCostMicros, 6_000);
  assert.equal(priceUsage(['gpt-6.1-sol'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }).settledCostMicros, 3_000);
  assert.equal(priceUsage(['gpt-6.1-sol-20260929'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100, serviceTier: 'priority' }).settledCostMicros, 6_000);
  assert.equal(priceUsage(['gpt-6.1-sol'], { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100, serviceTier: 'ultrafast' }).settledCostMicros, 18_000);
  assert.equal(priceUsage(['gpt-6-luna'], { inputTokens: 1_000, cachedInputTokens: 100, cacheWriteTokens: 0, outputTokens: 100 }).settledCostMicros, 141);
  assert.equal(priceUsage(['gpt-6-astra'], { inputTokens: 1_000, cachedInputTokens: 100, cacheWriteTokens: 0, outputTokens: 100 }).settledCostMicros, 14_100);
  // 800 input × $10 + 100 cached × $1 + 100 writes × $12.50 (30m) + 100 output × $50, per million.
  assert.equal(priceUsage(['gpt-6-astra'], { inputTokens: 1_000, cachedInputTokens: 100, cacheWriteTokens: 100, outputTokens: 100 }).settledCostMicros, 14_350);
  assert.equal(priceUsage(['claude-fable-5-1'], { inputTokens: 1_000, cachedInputTokens: 100, cacheWriteTokens: 100, outputTokens: 100 }).settledCostMicros, 14_275);
  assert.equal(priceUsage(['claude-opus-5-5'], { inputTokens: 1_000, cachedInputTokens: 100, cacheWriteTokens: 100, outputTokens: 100 }).settledCostMicros, 5_720);
  assert.equal(extractUsage({ usage: { input_tokens: 1_000, output_tokens: 100, price_cost_usd: null } }).upstreamCostMicros, undefined);
  assert.equal(extractUsage({ usage: { input_tokens: 100, cached_input_tokens: 100, cache_write_tokens: 100, output_tokens: 1 } }), null);
  assert.equal(priceUsage(['gpt-5.6-sol'], { inputTokens: 100, cachedInputTokens: 100, cacheWriteTokens: 100, outputTokens: 1 }), null);
});

test('reads the cache-write TTL a request asked for', () => {
  assert.equal(requestCacheWriteTtl({ input: 'hi' }), '30m');
  assert.equal(requestCacheWriteTtl(null), '30m');
  assert.equal(requestCacheWriteTtl({ prompt_cache_options: { mode: 'explicit', ttl: '30m' }, input: [{ role: 'user', content: [{ type: 'input_text', text: 'a', prompt_cache_breakpoint: { mode: 'explicit', ttl: '30m' } }] }] }), '30m');
  // Mixed TTLs settle at the longer rate: usage is aggregate, so this is an upper bound.
  assert.equal(requestCacheWriteTtl({ input: [
    { role: 'user', content: [{ type: 'input_text', text: 'a', prompt_cache_breakpoint: { mode: 'explicit', ttl: '30m' } }] },
    { role: 'user', content: [{ type: 'input_text', text: 'b', prompt_cache_breakpoint: { mode: 'explicit', ttl: '12h' } }] }
  ] }), '12h');
  assert.equal(requestCacheWriteTtl({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a', prompt_cache_breakpoint: { mode: 'explicit', ttl: '12h' } }] }] }), '12h');
});

test('prices Claude Haiku 5.5 with its 100K long-context bucket', () => {
  // ≤100K: $0.10 input, $0.01 cache read, $0.125 5m write, $0.50 output per million.
  assert.equal(priceUsage(['claude-haiku-5-5'], { inputTokens: 10_000, cachedInputTokens: 1_000, cacheWriteTokens: 1_000, outputTokens: 1_000 }).settledCostMicros, 1_435);
  // >100K: $0.50 input, $0.05 cache read, $0.625 5m write, $2.50 output per million.
  assert.equal(priceUsage(['claude-haiku-5-5'], { inputTokens: 100_001, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000 }).settledCostMicros, 52_501);
});

test('reports whether a model has any snapshot price', () => {
  for (const model of ['gpt-6-astra', 'GPT-6.1-Sol-20260929', 'claude-opus-5-5[1m]', 'claude-haiku-5-5', 'claude-sonnet-5-5-20260928']) assert.equal(isPricedModel(model), true, model);
  for (const model of ['kimi-k3', 'glm-5.3-flash', 'gpt-5.5', 'azure/gpt-6-astra', '', null]) assert.equal(isPricedModel(model), false, String(model));
});
