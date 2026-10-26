import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAiPricingSnapshot } from '../scripts/refresh-openai-pricing.js';

test('builds a deterministic OpenAI pricing snapshot for selected models and tiers', () => {
  const payload = {
    generated_at: '2026-08-10T18:34:37.635217Z',
    models: {
      'gpt-test': {
        model: 'gpt-test',
        pricing_type: 'per_1m_tokens',
        prices: {
          standard: { default: prices(2), long_context: prices(4) },
          flex: { default: prices(1), long_context: prices(2) },
          fast: { default: prices(4), long_context: prices(8) },
          ultrafast: { default: prices(6), long_context: prices(12) }
        }
      }
    }
  };
  const snapshot = buildOpenAiPricingSnapshot(payload, {
    sourceUrl: 'https://example.test/pricing.json',
    effectiveAt: '2026-01-01T00:00:00Z',
    models: ['gpt-test']
  });
  assert.match(snapshot, /OPENAI_PRICING_VERSION = "openai-2026-08-10"/);
  assert.match(snapshot, /OPENAI_MODEL_IDS = Object\.freeze\(\[\n  "gpt-test"\n\]\)/);
  assert.match(snapshot, /"tier":"flex","bucket":"default","input":1/);
  assert.match(snapshot, /"tier":"priority","bucket":"long_context","input":8/);
  assert.match(snapshot, /"tier":"standard","bucket":"default","input":2/);
  assert.match(snapshot, /"tier":"ultrafast","bucket":"long_context","input":12/);
});

test('rejects incomplete selected-model pricing data', () => {
  assert.throws(() => buildOpenAiPricingSnapshot({
    generated_at: '2026-08-10T18:34:37.635217Z',
    models: {}
  }, { models: ['gpt-test'] }), /missing a compatible gpt-test entry/);
});

test('imports per-tier context rules and allows a same-generation bucket fallback', () => {
  const payload = {
    schema_version: 2, generated_at: '2026-10-12T21:13:32Z',
    models: { 'gpt-test': {
      model: 'gpt-test', pricing_type: 'per_1m_tokens',
      context_pricing: { version: 1, tiers: Object.fromEntries(['standard', 'flex', 'fast'].map((tier) => [tier, {
        status: 'known', long_context_input_tokens_gt: tier === 'fast' ? 100 : 200,
        provenance: { locator: `gpt-test/${tier}/context`, evidence_sha256: '0'.repeat(64) }
      }])) },
      prices: Object.fromEntries(['standard', 'flex', 'fast'].map((tier) => [tier, {
        short_context: prices(1), long_context: prices(2)
      }]))
    } }
  };
  const snapshot = buildOpenAiPricingSnapshot(payload, { models: ['gpt-test'] });
  assert.match(snapshot, /"tier":"priority","bucket":"long_context"[^\n]*"longContextInputTokensGt":100/);
  assert.match(snapshot, /"tier":"standard","bucket":"short_context"[^\n]*"longContextInputTokensGt":200/);
  delete payload.models['gpt-test'].prices.fast.long_context;
  assert.doesNotMatch(buildOpenAiPricingSnapshot(payload, { models: ['gpt-test'] }), /"tier":"priority","bucket":"long_context"/);
  delete payload.models['gpt-test'].context_pricing.tiers.fast;
  assert.throws(() => buildOpenAiPricingSnapshot(payload, { models: ['gpt-test'] }), /missing gpt-test fast context pricing rule/);
});

test('keeps an omitted cached-input rate unavailable instead of free', () => {
  const omitted = prices(2);
  delete omitted.cached_input;
  const snapshot = buildOpenAiPricingSnapshot({
    generated_at: '2026-10-21T00:00:00Z',
    models: { 'gpt-test': { model: 'gpt-test', pricing_type: 'per_1m_tokens', prices: { standard: { default: omitted, long_context: prices(4) }, flex: { default: prices(1), long_context: prices(2) }, fast: { default: prices(4), long_context: prices(8) } } } }
  }, { models: ['gpt-test'] });
  assert.match(snapshot, /"tier":"standard","bucket":"default","input":2,"cachedInput":null,/);
  assert.match(snapshot, /"tier":"flex","bucket":"default","input":1,"cachedInput":0\.1,/);
  assert.throws(() => buildOpenAiPricingSnapshot({
    generated_at: '2026-10-21T00:00:00Z',
    models: { 'gpt-test': { model: 'gpt-test', pricing_type: 'per_1m_tokens', prices: { standard: { default: { ...prices(2), cached_input: -1 }, long_context: prices(4) }, flex: { default: prices(1), long_context: prices(2) }, fast: { default: prices(4), long_context: prices(8) } } } }
  }, { models: ['gpt-test'] }), /cached_input must be a non-negative number/);
});

function prices(input) {
  return { input, cached_input: input / 10, cache_write: input * 1.25, output: input * 6 };
}

test('imports duration-specific cache-write rates without inventing a generic rate', () => {
  const durationPrices = (input) => ({ input, cached_input: input / 10, cache_write_30m: input * 1.25, cache_write_12h: input * 2.5, output: input * 6 });
  const payload = {
    generated_at: '2026-10-23T16:30:24.279646Z',
    models: { 'gpt-test': { model: 'gpt-test', pricing_type: 'per_1m_tokens', prices: { standard: { default: durationPrices(2), long_context: durationPrices(4) }, fast: { default: durationPrices(4), long_context: durationPrices(8) } } } }
  };
  const previousRows = [{ model: 'gpt-test', tier: 'flex', bucket: 'default', input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 6, contextRule: { status: 'legacy', longContextInputTokensGt: 272000 } }];
  const snapshot = buildOpenAiPricingSnapshot(payload, { models: ['gpt-test'], previousRows });
  assert.match(snapshot, /"tier":"standard","bucket":"default","input":2,"cachedInput":0\.2,"cacheWrite":null,"output":12,.*"cacheWriteRates":\{"30m":2\.5,"12h":5\}/);
  assert.match(snapshot, /"tier":"flex","bucket":"default","input":1,"cachedInput":0\.1,"cacheWrite":1\.25,/);
  assert.equal(buildOpenAiPricingSnapshot(payload, { models: ['gpt-test'] }).includes('"tier":"flex"'), false);
  for (const invalid of [null, true, -1, '1']) {
    const broken = structuredClone(payload);
    broken.models['gpt-test'].prices.standard.default.cache_write_12h = invalid;
    assert.throws(() => buildOpenAiPricingSnapshot(broken, { models: ['gpt-test'] }), /standard default cache_write_12h must be a non-negative number/);
  }
});
