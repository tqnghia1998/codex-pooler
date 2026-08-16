import {
  OPENAI_PRICE_ROWS,
  OPENAI_PRICING_EFFECTIVE_AT,
  OPENAI_PRICING_VERSION
} from './openai-pricing-snapshot.js';

// OpenAI bills a separate long-context bucket once input exceeds this many tokens.
const LONG_CONTEXT_INPUT_TOKEN_THRESHOLD = 272_000;

const OPENAI_PRICES = OPENAI_PRICE_ROWS.map(({ model, input, cachedInput, cacheWrite, output, tier, bucket }) => (
  price(model, [input, cachedInput, cacheWrite, output], OPENAI_PRICING_VERSION, tier, OPENAI_PRICING_EFFECTIVE_AT, bucket)
));

const ANTHROPIC_PRICES = [
  ['claude-opus-5', 5, 25, 6.25, 0.5], ['claude-opus-4-8', 5, 25, 6.25, 0.5], ['claude-opus-4-7', 5, 25, 6.25, 0.5], ['claude-opus-4-6', 5, 25, 6.25, 0.5], ['claude-opus-4-5', 5, 25, 6.25, 0.5],
  ['claude-opus-4-1', 15, 75, 18.75, 1.5], ['claude-opus-4', 15, 75, 18.75, 1.5],
  ['claude-sonnet-4-6', 3, 15, 3.75, 0.3], ['claude-sonnet-4-5', 3, 15, 3.75, 0.3], ['claude-sonnet-4', 3, 15, 3.75, 0.3],
  ['claude-haiku-4-5', 1, 5, 1.25, 0.1], ['claude-haiku-3-5', 0.8, 4, 1, 0.08],
  ['claude-3-7-sonnet', 3, 15, 3.75, 0.3], ['claude-3-5-sonnet', 3, 15, 3.75, 0.3], ['claude-3-opus', 15, 75, 18.75, 1.5], ['claude-3-sonnet', 3, 15, null, null]
].map(([model, input, output, cacheWrite, cachedInput]) => price(model, [input, cachedInput, cacheWrite, output], 'anthropic-list-2026-05-27'));

const PRICES = [
  ...OPENAI_PRICES,
  ...ANTHROPIC_PRICES,
  price('claude-sonnet-5', [2, 0.2, 2.5, 10], 'anthropic-list-2026-05-27-intro', 'standard', '2026-01-01T00:00:00Z'),
  price('claude-sonnet-5', [3, 0.3, 3.75, 15], 'anthropic-list-2026-05-27-standard', 'standard', '2026-09-01T00:00:00Z')
];

function price(model, [input, cachedInput, cacheWrite, output], priceVersion, tier = 'standard', effectiveAt = '2026-01-01T00:00:00Z', bucket = 'default') {
  return { model, input, cachedInput, cacheWrite, output, priceVersion, tier, effectiveAt, bucket };
}

export function extractUsage(body) {
  const usage = usageObject(body);
  if (!usage) return null;
  const input = integer(first(usage, ['input_tokens'], ['prompt_tokens']));
  const output = integer(first(usage, ['output_tokens'], ['completion_tokens']));
  const cached = integer(first(usage, ['cached_input_tokens'], ['cache_read_input_tokens'], ['input_tokens_details', 'cached_tokens'], ['prompt_tokens_details', 'cached_tokens']));
  const cacheWrite = integer(first(usage, ['cache_write_tokens'], ['cache_creation_input_tokens'], ['input_tokens_details', 'cache_write_tokens'], ['prompt_tokens_details', 'cache_write_tokens']));
  const reasoning = integer(first(usage, ['output_tokens_details', 'reasoning_tokens'], ['reasoning_tokens']));
  const total = integer(usage.total_tokens);
  if ([input, output, cached, cacheWrite, reasoning, total].some((value) => value === false)) return null;
  if ([input, output, cached, cacheWrite].every((value) => value === undefined) && upstreamCostMicros(usage) === undefined) return null;
  const anthropic = Object.hasOwn(usage, 'cache_read_input_tokens') || Object.hasOwn(usage, 'cache_creation_input_tokens');
  const inputTokens = input === undefined ? undefined : input + (anthropic ? (cached || 0) + (cacheWrite || 0) : 0);
  if (inputTokens !== undefined && (cached || 0) + (cacheWrite || 0) > inputTokens) return null;
  // The served model is what gets billed, so it has to survive stream merging: the usage object is all settlement sees.
  const model = string(body?.model ?? body?.response?.model ?? body?.message?.model);
  return {
    ...(model === null ? {} : { model }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(total === undefined ? {} : { totalTokens: total }),
    serviceTier: string(body?.service_tier ?? body?.response?.service_tier ?? usage.service_tier),
    ...(upstreamCostMicros(usage) === undefined ? {} : { upstreamCostMicros: upstreamCostMicros(usage) })
  };
}

export function mergeUsage(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  return {
    ...previous,
    ...next,
    cachedInputTokens: next.cachedInputTokens ?? previous.cachedInputTokens ?? 0,
    cacheWriteTokens: next.cacheWriteTokens ?? previous.cacheWriteTokens ?? 0,
    serviceTier: next.serviceTier ?? previous.serviceTier ?? null
  };
}

export function priceUsage(models, usage, startedAt = new Date().toISOString(), requestedTier = null) {
  if (!completeUsage(usage)) return null;
  const timestamp = Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) return null;
  const tier = canonicalTier(usage.serviceTier || requestedTier);
  const bucket = usage.inputTokens > LONG_CONTEXT_INPUT_TOKEN_THRESHOLD ? 'long_context' : 'default';
  const snapshot = resolvePrice(models, tier, timestamp, bucket);
  if (!snapshot) return null;
  const cached = Math.min(usage.cachedInputTokens || 0, usage.inputTokens);
  const cacheWrite = usage.cacheWriteTokens || 0;
  if (cacheWrite > 0 && snapshot.cacheWrite === null) return null;
  const standardInput = Math.max(usage.inputTokens - cached - cacheWrite, 0);
  const cost = standardInput * snapshot.input + cached * (snapshot.cachedInput || 0) + cacheWrite * (snapshot.cacheWrite || 0) + usage.outputTokens * snapshot.output;
  const settledCostMicros = Math.round(cost);
  if (!Number.isSafeInteger(settledCostMicros) || settledCostMicros < 0) return null;
  return { settledCostMicros, costSource: 'pricing_snapshot', model: snapshot.model, priceVersion: snapshot.priceVersion };
}

function usageObject(body) {
  const usage = body?.usage || body?.message?.usage || body?.response?.usage;
  return usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : null;
}

// totalTokens is reporting only: providers disagree on whether it counts cache tokens, and a mismatch there
// must not discard priced input/output tokens, which would let the request escape the spending cap.
function completeUsage(usage) {
  return usage && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0 && (usage.cachedInputTokens || 0) + (usage.cacheWriteTokens || 0) <= usage.inputTokens;
}

function resolvePrice(models, tier, timestamp, bucket) {
  const candidates = modelCandidates(Array.isArray(models) ? models : [models]);
  for (const candidate of candidates) {
    const dated = PRICES.filter((snapshot) => snapshot.model === candidate && Date.parse(snapshot.effectiveAt) <= timestamp);
    if (tier === 'ultrafast') {
      const exact = dated.filter((snapshot) => snapshot.tier === tier && snapshot.bucket === bucket);
      if (exact.length) return exact.sort((left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt))[0];
      continue;
    }
    // A known model priced only at standard rates (no priority tier, no long-context bucket: all Anthropic entries)
    // bills at those rates instead of going unpriced, which would let the request escape the spending cap.
    const snapshots = preferred(preferred(dated, 'tier', tier, 'standard'), 'bucket', bucket, 'default');
    if (snapshots.length) return snapshots.sort((left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt))[0];
  }
  return null;
}

function preferred(snapshots, key, wanted, fallback) {
  const matching = snapshots.filter((snapshot) => snapshot[key] === wanted);
  return matching.length ? matching : snapshots.filter((snapshot) => snapshot[key] === fallback);
}

function modelCandidates(models) {
  const candidates = [];
  for (const value of models) {
    const model = string(value)?.toLowerCase();
    if (!model) continue;
    candidates.push(model);
    const parts = model.split('-').filter(Boolean);
    let arbitrary = 0;
    for (let index = parts.length - 1; index > 0; index -= 1) {
      if (!/^(?:v)?\d+(?:[._]\d+)*$/i.test(parts[index])) arbitrary += 1;
      if (arbitrary > 1) break;
      candidates.push(parts.slice(0, index).join('-'));
    }
  }
  return [...new Set(candidates)];
}

// Provider-reported cost is upstream-controlled input: accept only plain non-negative decimal numbers.
export function upstreamCostMicros(usage) {
  const value = usage?.price_cost_usd;
  if (typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) {
    const micros = Math.round(Number(value) * 1_000_000);
    return Number.isSafeInteger(micros) ? micros : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const micros = Math.round(value * 1_000_000);
    return Number.isSafeInteger(micros) ? micros : undefined;
  }
  return undefined;
}

function first(object, ...paths) {
  for (const path of paths) {
    let value = object;
    for (const key of path) value = value?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function integer(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : false;
}

function string(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canonicalTier(value) {
  const tier = string(value)?.toLowerCase();
  if (tier === 'fast' || tier === 'priority') return 'priority';
  if (tier === 'flex') return 'flex';
  if (tier === 'ultrafast') return 'ultrafast';
  return 'standard';
}
