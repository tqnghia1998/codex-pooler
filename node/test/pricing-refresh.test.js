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
          fast: { default: prices(4), long_context: prices(8) }
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
});

test('rejects incomplete selected-model pricing data', () => {
  assert.throws(() => buildOpenAiPricingSnapshot({
    generated_at: '2026-08-10T18:34:37.635217Z',
    models: {}
  }, { models: ['gpt-test'] }), /missing a compatible gpt-test entry/);
});

function prices(input) {
  return { input, cached_input: input / 10, cache_write: input * 1.25, output: input * 6 };
}
