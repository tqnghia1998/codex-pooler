import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_SOURCE_URL = 'https://icoretech.github.io/openai-json-pricing/pricing.json';
const DEFAULT_EFFECTIVE_AT = '2026-01-01T00:00:00Z';
const DEFAULT_MODELS = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const REQUIRED_TIER_MAP = Object.freeze({ standard: 'standard', flex: 'flex', fast: 'priority' });
const OPTIONAL_TIER_MAP = Object.freeze({ ultrafast: 'ultrafast' });
const BUCKETS = ['default', 'short_context', 'long_context'];
const TARGET = fileURLToPath(new URL('../src/openai-pricing-snapshot.js', import.meta.url));

export function buildOpenAiPricingSnapshot(payload, {
  sourceUrl = DEFAULT_SOURCE_URL,
  effectiveAt = DEFAULT_EFFECTIVE_AT,
  models = DEFAULT_MODELS
} = {}) {
  if (!plainObject(payload) || !plainObject(payload.models) || !validDate(payload.generated_at)) {
    throw new Error('Pricing feed must include generated_at and models');
  }
  const schemaVersion = payload.schema_version ?? 1;
  if (![1, 2].includes(schemaVersion)) throw new Error('Unsupported pricing schema version');
  if (!validDate(effectiveAt)) throw new Error('effectiveAt must be an ISO-8601 datetime');
  const modelIds = [...new Set(models.map(cleanString).filter(Boolean))];
  if (!modelIds.length) throw new Error('At least one model is required');
  const rows = [];
  for (const modelId of modelIds) {
    const model = payload.models[modelId];
    if (!plainObject(model) || model.model !== modelId || model.pricing_type !== 'per_1m_tokens' || !plainObject(model.prices)) {
      throw new Error(`Pricing feed is missing a compatible ${modelId} entry`);
    }
    for (const [sourceTier, tier] of Object.entries(REQUIRED_TIER_MAP)) {
      rows.push(...tierRows(model, modelId, sourceTier, tier, schemaVersion));
    }
    for (const [sourceTier, tier] of Object.entries(OPTIONAL_TIER_MAP)) {
      if (model.prices[sourceTier] === undefined) continue;
      rows.push(...tierRows(model, modelId, sourceTier, tier, schemaVersion));
    }
  }
  const generatedAt = new Date(payload.generated_at).toISOString();
  const version = `openai-${generatedAt.slice(0, 10)}`;
  return renderSnapshot({ sourceUrl, generatedAt, effectiveAt: new Date(effectiveAt).toISOString(), version, modelIds, rows });
}

function tierRows(model, modelId, sourceTier, tier, schemaVersion) {
  const prices = model.prices[sourceTier];
  if (!plainObject(prices)) throw new Error(`Pricing feed is missing ${modelId} ${tier}`);
  const contextRule = schemaVersion === 1
    ? { status: 'legacy', longContextInputTokensGt: 272_000 }
    : parseContextRule(model.context_pricing, sourceTier, modelId, prices);
  if (!plainObject(prices.default) && !plainObject(prices.short_context)) {
    throw new Error(`Pricing feed is missing ${modelId} ${tier} lower-context price`);
  }
  if (schemaVersion === 1 && !plainObject(prices.long_context)) {
    throw new Error(`Pricing feed is missing ${modelId} ${tier} long_context`);
  }
  return BUCKETS.filter((bucket) => prices[bucket] !== undefined)
    .map((bucket) => priceRow(modelId, tier, bucket, prices[bucket], contextRule));
}

function parseContextRule(contextPricing, tier, modelId, prices) {
  if (!exactKeys(contextPricing, ['version', 'tiers']) || contextPricing.version !== 1 || !plainObject(contextPricing.tiers)) {
    throw new Error(`Pricing feed is missing ${modelId} context pricing rules`);
  }
  const rule = contextPricing.tiers[tier];
  if (!plainObject(rule)) throw new Error(`Pricing feed is missing ${modelId} ${tier} context pricing rule`);
  const provenance = rule.provenance;
  const validProvenance = exactKeys(provenance, ['locator', 'evidence_sha256'])
    && cleanString(provenance.locator) && Buffer.byteLength(provenance.locator) <= 256
    && typeof provenance.evidence_sha256 === 'string' && /^[0-9a-f]{64}$/.test(provenance.evidence_sha256);
  if (!validProvenance) throw new Error(`Pricing feed has invalid ${modelId} ${tier} context pricing provenance`);
  if (rule.status === 'known' && exactKeys(rule, ['status', 'long_context_input_tokens_gt', 'provenance'])
    && Number.isSafeInteger(rule.long_context_input_tokens_gt) && rule.long_context_input_tokens_gt > 0) {
    return { status: 'known', longContextInputTokensGt: rule.long_context_input_tokens_gt };
  }
  if (rule.status === 'uniform' && exactKeys(rule, ['status', 'provenance']) && prices.long_context === undefined) {
    return { status: 'uniform' };
  }
  if (rule.status === 'unknown' && exactKeys(rule, ['status', 'reason', 'observed_rules', 'provenance'])
    && ['missing_source', 'unsupported_source', 'conflicting_source'].includes(rule.reason)
    && validObservations(rule.observed_rules)
    && (rule.reason !== 'missing_source' || rule.observed_rules.length === 0)) {
    return { status: 'unknown', reason: rule.reason };
  }
  throw new Error(`Pricing feed has invalid ${modelId} ${tier} context pricing rule`);
}

function validObservations(values) {
  if (!Array.isArray(values)) return false;
  const rows = values.map((value) => JSON.stringify(value));
  if (new Set(rows).size !== rows.length) return false;
  if (!values.every((value) => exactKeys(value, ['bucket', 'operator', 'input_tokens'])
    && ['short_context', 'long_context'].includes(value.bucket)
    && ['lt', 'lte', 'gt', 'gte'].includes(value.operator)
    && Number.isSafeInteger(value.input_tokens) && value.input_tokens > 0)) return false;
  return values.every((value, index) => {
    if (index === 0) return true;
    const previous = values[index - 1];
    return previous.bucket < value.bucket || previous.bucket === value.bucket && (
      previous.operator < value.operator || previous.operator === value.operator && previous.input_tokens <= value.input_tokens
    );
  });
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function priceRow(model, tier, bucket, values, contextRule) {
  if (!plainObject(values)) throw new Error(`Pricing feed is missing ${model} ${tier} ${bucket}`);
  const row = {
    model,
    tier,
    bucket,
    input: priceNumber(values.input, `${model} ${tier} ${bucket} input`),
    cachedInput: values.cached_input == null ? null : priceNumber(values.cached_input, `${model} ${tier} ${bucket} cached_input`),
    cacheWrite: priceNumber(values.cache_write, `${model} ${tier} ${bucket} cache_write`),
    output: priceNumber(values.output, `${model} ${tier} ${bucket} output`),
    contextRule
  };
  return row;
}

function renderSnapshot({ sourceUrl, generatedAt, effectiveAt, version, modelIds, rows }) {
  const rowText = rows
    .sort((left, right) => left.model.localeCompare(right.model) || left.tier.localeCompare(right.tier) || left.bucket.localeCompare(right.bucket))
    .map((row) => `  Object.freeze(${JSON.stringify(row)})`)
    .join(',\n');
  return `// Generated by \`npm run pricing:refresh\`. Do not edit by hand.
export const OPENAI_PRICING_SOURCE_URL = ${JSON.stringify(sourceUrl)};
export const OPENAI_PRICING_GENERATED_AT = ${JSON.stringify(generatedAt)};
export const OPENAI_PRICING_EFFECTIVE_AT = ${JSON.stringify(effectiveAt)};
export const OPENAI_PRICING_VERSION = ${JSON.stringify(version)};

export const OPENAI_MODEL_IDS = Object.freeze(${JSON.stringify(modelIds, null, 2)});

export const OPENAI_PRICE_ROWS = Object.freeze([
${rowText}
]);
`;
}

function priceNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

async function main() {
  const args = new Map(process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.split('=');
    return [key, rest.join('=')];
  }));
  const sourceUrl = args.get('--source') || DEFAULT_SOURCE_URL;
  const effectiveAt = args.get('--effective-at') || DEFAULT_EFFECTIVE_AT;
  const modelArg = args.get('--models');
  const models = modelArg ? modelArg.split(',') : DEFAULT_MODELS;
  const payload = sourceUrl.startsWith('file:')
    ? JSON.parse(await readFile(fileURLToPath(sourceUrl), 'utf8'))
    : await fetch(sourceUrl).then(async (response) => {
      if (!response.ok) throw new Error(`Pricing fetch failed with HTTP ${response.status}`);
      return response.json();
    });
  await writeFile(TARGET, buildOpenAiPricingSnapshot(payload, {
    sourceUrl: sourceUrl.startsWith('file:') ? DEFAULT_SOURCE_URL : sourceUrl,
    effectiveAt,
    models
  }));
  process.stdout.write(`Updated ${TARGET}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
