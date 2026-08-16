const DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_RESET_COOLDOWN_MS = 15 * 60 * 1_000;
const RESET_HEADER_NAMES = [
  'x-ratelimit-reset',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-codex-quota-reset',
  'openai-ratelimit-reset'
];
const TRANSIENT_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'
]);

export function classifyHttpResponse(response, structuredBody = null) {
  const status = Number(response?.status ?? response?.statusCode);
  const structured = structuredError(structuredBody);
  return outcomeForStatus(status, {
    retryAfter: headerValue(response?.headers, 'retry-after'),
    resetAt: resetHeaderValues(response?.headers),
    errorCode: structured.code,
    errorType: structured.type,
    errorParam: structured.param
  });
}

export function classifySseEvent(event) {
  const error = structuredError(event);
  const status = finiteStatus(event?.status ?? event?.status_code ?? error.status);
  if (status) return outcomeForStatus(status, error);
  if (!['error', 'response.failed'].includes(event?.type)) {
    return ['response.completed', 'response.incomplete'].includes(event?.type)
      ? { class: 'success', retryable: false }
      : { class: 'neutral', retryable: false };
  }
  if (quotaCode(error.code, error.type)) {
    return quotaOutcome({ errorCode: error.code || error.type });
  }
  if (credentialCode(error.code, error.type)) {
    return { class: 'credential', retryable: true, errorCode: error.code || error.type };
  }
  if (modelNotFound(error)) {
    return { class: 'caller', retryable: true, modelNotFound: true, errorCode: error.code || error.type };
  }
  if (callerCode(error.code, error.type)) {
    return { class: 'caller', retryable: false, errorCode: error.code || error.type };
  }
  return { class: 'transient', retryable: true, errorCode: error.code || error.type || null };
}

export function classifyTransportError(error, { clientCancelled = false } = {}) {
  if (clientCancelled || error?.upstreamFailureKind === 'cancelled') {
    return { class: 'neutral', retryable: false, transport: 'cancelled' };
  }
  if (error?.upstreamFailureKind === 'timeout' || error?.name === 'TimeoutError') {
    return { class: 'transient', retryable: true, transport: 'timeout' };
  }
  const code = transportCode(error);
  return {
    class: 'transient',
    retryable: true,
    transport: code && TRANSIENT_TRANSPORT_CODES.has(code) ? code : 'transport'
  };
}

export function quotaCooldown(outcome, now = Date.now()) {
  const retryAfterMs = parseRetryAfterMs(outcome?.retryAfter, now);
  if (retryAfterMs !== null) {
    return { cooldownSource: 'retry-after', cooldownMs: retryAfterMs, nextEligibleAt: now + retryAfterMs };
  }
  const resetMs = parseResetCooldownMs(outcome?.resetAt, now);
  if (resetMs !== null) {
    return { cooldownSource: 'reset-derived', cooldownMs: resetMs, nextEligibleAt: now + resetMs };
  }
  return { cooldownSource: 'default', cooldownMs: DEFAULT_QUOTA_COOLDOWN_MS, nextEligibleAt: now + DEFAULT_QUOTA_COOLDOWN_MS };
}

export function parseRetryAfterMs(value, now = Date.now()) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(Math.ceil(seconds * 1_000), MAX_RETRY_AFTER_MS);
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || timestamp < now) return null;
  return Math.min(timestamp - now, MAX_RETRY_AFTER_MS);
}

export function parseResetCooldownMs(value, now = Date.now()) {
  const values = Array.isArray(value) ? value : [value];
  let best = null;
  for (const item of values) {
    const numeric = typeof item === 'number' ? item : typeof item === 'string' && item.trim() ? Number(item) : NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    const timestamp = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
    if (timestamp <= now) continue;
    const delay = Math.min(timestamp - now, MAX_RESET_COOLDOWN_MS);
    if (best === null || delay < best) best = delay;
  }
  return best;
}

function outcomeForStatus(status, metadata = {}) {
  const normalized = {
    ...metadata,
    code: metadata.code ?? metadata.errorCode ?? null,
    type: metadata.type ?? metadata.errorType ?? null,
    param: metadata.param ?? metadata.errorParam ?? null
  };
  if (!Number.isFinite(status)) return { class: 'unknown', retryable: false };
  if (status >= 200 && status < 300) return { class: 'success', retryable: false, status };
  if (status >= 300 && status < 400) return { class: 'neutral', retryable: false, status };
  if (status === 401 || status === 403) return { class: 'credential', retryable: true, status, ...metadata };
  if (status === 402 || status === 429) return quotaOutcome({ status, ...metadata });
  if (status >= 400 && status < 500) {
    return modelNotFound(normalized)
      ? { class: 'caller', retryable: true, modelNotFound: true, status, ...metadata }
      : { class: 'caller', retryable: false, status, ...metadata };
  }
  if (status >= 500 && status < 600) return { class: 'transient', retryable: true, status, ...metadata };
  return { class: 'unknown', retryable: false, status, ...metadata };
}

function quotaOutcome(metadata = {}) {
  return { class: 'quota', retryable: true, ...metadata };
}

function structuredError(value) {
  const candidates = [
    value?.error,
    value?.response?.error,
    value?.status_details?.error,
    value?.response?.status_details?.error,
    value
  ];
  const source = candidates.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)) || {};
  return {
    code: safeField(source.code),
    type: safeField(source.type),
    param: safeField(source.param),
    status: finiteStatus(source.status ?? source.status_code)
  };
}

function modelNotFound(error) {
  return error?.code === 'model_not_found'
    || error?.type === 'model_not_found'
    || error?.type === 'invalid_request_error' && error?.param === 'model';
}

function quotaCode(code, type) {
  return ['rate_limit_exceeded', 'insufficient_quota', 'usage_limit_reached', 'quota_exceeded'].includes(code)
    || ['rate_limit_error', 'insufficient_quota'].includes(type);
}

function credentialCode(code, type) {
  return ['invalid_api_key', 'invalid_token', 'token_expired', 'authentication_error'].includes(code)
    || ['authentication_error', 'permission_error'].includes(type);
}

function callerCode(code, type) {
  return [
    'bad_request',
    'invalid_parameter',
    'invalid_request',
    'unsupported_parameter'
  ].includes(code) || [
    'bad_request_error',
    'invalid_request_error'
  ].includes(type);
}

function resetHeaderValues(headers) {
  return RESET_HEADER_NAMES.map((name) => headerValue(headers, name)).filter(Boolean);
}

function headerValue(headers, name) {
  const value = headers?.get?.(name)
    ?? headers?.[name]
    ?? headers?.[name.toLowerCase()]
    ?? Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
  const normalized = Array.isArray(value) ? value[0] : value;
  return typeof normalized === 'string' && normalized.length <= 1_024 && !/[\x00-\x1f\x7f]/.test(normalized) ? normalized.trim() : null;
}

function transportCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current.code === 'string' && current.code.length <= 64) return current.code;
    current = current.cause;
  }
  return null;
}

function safeField(value) {
  return typeof value === 'string' && value.length <= 128 ? value : null;
}

function finiteStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}
