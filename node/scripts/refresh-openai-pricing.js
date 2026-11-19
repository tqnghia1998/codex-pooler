import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_SOURCE_URL = 'https://icoretech.github.io/openai-json-pricing/pricing.json';
const DEFAULT_EFFECTIVE_AT = '2026-01-01T00:00:00Z';
const DEFAULT_MODELS = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra-law', 'gpt-6-rosalind', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6.2-astra', 'gpt-6.2-sol'];
// These reviewed specialist models publish only standard-tier prices.
const STANDARD_ONLY_MODELS = new Set(['gpt-6-astra-law', 'gpt-6-rosalind']);
const REQUIRED_TIER_MAP = Object.freeze({ standard: 'standard', fast: 'priority' });
const OPTIONAL_TIER_MAP = Object.freeze({ flex: 'flex', ultrafast: 'ultrafast' });
const CACHE_WRITE_DURATIONS = ['30m', '12h'];
const BUCKETS = ['default', 'short_context', 'long_context'];
const TARGET = fileURLToPath(new URL('../src/openai-pricing-snapshot.js', import.meta.url));

export function buildOpenAiPricingSnapshot(payload, {
  sourceUrl = DEFAULT_SOURCE_URL,
  effectiveAt = DEFAULT_EFFECTIVE_AT,
  models = DEFAULT_MODELS,
  previousRows = [],
  onlyModels = null
} = {}) {
  if (!plainObject(payload) || !plainObject(payload.models) || !validDate(payload.generated_at)) {
    throw new Error('Pricing feed must include generated_at and models');
  }
  const schemaVersion = payload.schema_version ?? 1;
  if (![1, 2].includes(schemaVersion)) throw new Error('Unsupported pricing schema version');
  if (!validDate(effectiveAt)) throw new Error('effectiveAt must be an ISO-8601 datetime');
  const modelIds = [...new Set(models.map(cleanString).filter(Boolean))];
  if (!modelIds.length) throw new Error('At least one model is required');
  const selected = onlyModels === null ? null : new Set(onlyModels.map(cleanString));
  if (selected && (!selected.size || [...selected].some((id) => !modelIds.includes(id)))) {
    throw new Error('Only-models must name one or more models in the snapshot catalog');
  }
  const effectiveStart = new Date(effectiveAt).toISOString();
  const rows = [];
  for (const modelId of modelIds) {
    if (selected && !selected.has(modelId)) {
      const existing = previousRows.filter((row) => row.model === modelId);
      if (!existing.length) throw new Error(`No existing pricing rows for ${modelId}`);
      rows.push(...existing);
      continue;
    }
    const model = payload.models[modelId];
    if (!plainObject(model) || model.model !== modelId || model.pricing_type !== 'per_1m_tokens' || !plainObject(model.prices)) {
      throw new Error(`Pricing feed is missing a compatible ${modelId} entry`);
    }
    for (const [sourceTier, tier] of Object.entries(REQUIRED_TIER_MAP)) {
      if (sourceTier === 'fast' && STANDARD_ONLY_MODELS.has(modelId) && model.prices.fast === undefined) continue;
      rows.push(...tierRows(model, modelId, sourceTier, tier, schemaVersion));
    }
    for (const [sourceTier, tier] of Object.entries(OPTIONAL_TIER_MAP)) {
      if (sourceTier === 'ultrafast' && (model.prices.ultrafast_promotion !== undefined || model.prices.ultrafast_list !== undefined)) {
        rows.push(...scheduledUltrafastRows(model, modelId, schemaVersion, effectiveStart));
        continue;
      }
      if (model.prices[sourceTier] === undefined) {
        // A feed that stops listing a tier must not reprice it at the
        // standard fallback: keep the last imported rows, as upstream keeps
        // its immutable snapshots.
        rows.push(...previousRows.filter((row) => row.model === modelId && row.tier === tier).map((row) => ({ ...row })));
        continue;
      }
      rows.push(...tierRows(model, modelId, sourceTier, tier, schemaVersion));
    }
  }
  const generatedAt = new Date(payload.generated_at).toISOString();
  const version = `openai-${generatedAt.slice(0, 10)}`;
  return renderSnapshot({ sourceUrl, generatedAt, effectiveAt: effectiveStart, version, modelIds, rows });
}

function scheduledUltrafastRows(model, modelId, schemaVersion, effectiveAt) {
  const applicability = model.pricing_applicability;
  const promotion = applicability?.tiers?.ultrafast_promotion;
  const list = applicability?.tiers?.ultrafast_list;
  if (schemaVersion !== 2 || model.prices.ultrafast !== undefined || applicability?.version !== 1
    || ![promotion, list].every((rule) => rule?.status === 'supported' && rule.mode === 'effective')
    || promotion.effective_at !== null || list.effective_until !== null
    || !validDate(list.effective_at) || !validDate(promotion.effective_until)
    || Date.parse(list.effective_at) !== Date.parse(promotion.effective_until)) {
    throw new Error(`Pricing feed has invalid ${modelId} ultrafast pricing schedule`);
  }
  const cutoff = new Date(list.effective_at).toISOString();
  return [
    ...tierRows(model, modelId, 'ultrafast_promotion', 'ultrafast', schemaVersion).map((row) => ({ ...row, effectiveUntil: cutoff })),
    ...tierRows(model, modelId, 'ultrafast_list', 'ultrafast', schemaVersion).map((row) => ({
      ...row, effectiveAt: effectiveAt > cutoff ? effectiveAt : cutoff
    }))
  ];
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
    // Duration-specific write rates are kept for reference only: aggregate
    // usage does not report the TTL, so writes stay unpriced without a
    // duration-neutral rate.
    cacheWrite: values.cache_write === undefined ? null : priceNumber(values.cache_write, `${model} ${tier} ${bucket} cache_write`),
    output: priceNumber(values.output, `${model} ${tier} ${bucket} output`),
    contextRule
  };
  const durationRates = Object.fromEntries(CACHE_WRITE_DURATIONS
    .filter((duration) => values[`cache_write_${duration}`] !== undefined)
    .map((duration) => [duration, priceNumber(values[`cache_write_${duration}`], `${model} ${tier} ${bucket} cache_write_${duration}`)]));
  if (Object.keys(durationRates).length) row.cacheWriteRates = durationRates;
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
  const { OPENAI_PRICE_ROWS: previousRows } = await import('../src/openai-pricing-snapshot.js');
  const payload = sourceUrl.startsWith('file:')
    ? JSON.parse(await readFile(fileURLToPath(sourceUrl), 'utf8'))
    : await fetch(sourceUrl).then(async (response) => {
      if (!response.ok) throw new Error(`Pricing fetch failed with HTTP ${response.status}`);
      return response.json();
    });
  await writeFile(TARGET, buildOpenAiPricingSnapshot(payload, {
    sourceUrl: sourceUrl.startsWith('file:') ? DEFAULT_SOURCE_URL : sourceUrl,
    effectiveAt,
    models,
    previousRows,
    onlyModels: args.get('--only-models')?.split(',') ?? null
  }));
  process.stdout.write(`Updated ${TARGET}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
