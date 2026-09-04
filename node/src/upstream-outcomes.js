import { misalignmentPolicyFailure } from './policy-failures.js';
import { isClaudeOAuthUpstream } from './domain.js';

const DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_RESET_COOLDOWN_MS = 15 * 60 * 1_000;
const RESET_HEADER_NAMES = [
  'x-ratelimit-reset',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-codex-quota-reset',
  'openai-ratelimit-reset',
  'anthropic-ratelimit-unified-reset',
  'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-7d-reset',
  'anthropic-ratelimit-unified-7d_oi-reset'
];
const TRANSIENT_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'
]);
const MAX_REQUEST_SCOPED_ERROR_TEXT = 64 * 1024;
const REQUEST_SCOPED_REGEX_CACHE_LIMIT = 1_024;
const requestScopedRegexCache = new Map();

export function classifyHttpResponse(response, structuredBody = null, { allowMisalignmentPolicy = false, upstreamType = '' } = {}) {
  const status = Number(response?.status ?? response?.statusCode);
  const structured = structuredError(structuredBody);
  const claudeRateLimit = status === 429 && upstreamType === 'claude'
    ? claudeRateLimitDetails(response?.headers)
    : null;
  if (claudeRateLimit && !claudeRateLimit.credentialScoped) {
    if (structured.fastModeCredits) {
      return { class: 'neutral', retryable: false, status, ...structured, errorCode: structured.code || 'fast_mode_credits_required' };
    }
    // CPA treats ordinary model-level Claude 429s as non-credential-scoped:
    // try another eligible account without cooling this credential.
    return {
      class: 'neutral',
      retryable: true,
      status,
      ...structured,
      modelScoped: true,
      retryAfter: claudeRateLimit.retryAfter,
      resetAt: claudeRateLimit.resetAt,
      errorCode: structured.code || structured.type || 'rate_limit_error'
    };
  }
  return outcomeForStatus(status, {
    retryAfter: headerValue(response?.headers, 'retry-after'),
    resetAt: resetHeaderValues(response?.headers),
    errorCode: structured.code,
    errorType: structured.type,
    errorParam: structured.param,
    fastModeCredits: fastModeCreditsRequired(structured.message)
  }, allowMisalignmentPolicy);
}

// CPA permits an auth record to override whether a matching upstream error
// stops the request, fails over, and/or cools the credential. Keep this
// request-scoped: rules are metadata on one Claude credential, not global
// classification policy.
export function applyClaudeRequestScopedAction(outcome, upstream, status, body, claudeConfig = null) {
  const action = claudeRequestScopedAction(upstream, status, body, claudeConfig);
  if (!action || !outcome || upstream?.type !== 'claude') return outcome;
  const cooldown = action.endsWith('-and-cooldown');
  const stop = action.startsWith('stop');
  return {
    ...outcome,
    class: cooldown ? 'quota' : 'neutral',
    retryable: !stop,
    ...(cooldown ? { modelScoped: false } : {}),
    errorCode: outcome.errorCode || (cooldown ? 'request_scoped_cooldown' : 'request_scoped')
  };
}

export function claudeRequestScopedAction(upstream, status, body, claudeConfig = null) {
  if (upstream?.type !== 'claude') return '';
  const metadata = upstream.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : {};
  let raw = metadata.request_scoped_errors ?? metadata['request-scoped-errors'];
  if (raw === undefined && isClaudeOAuthUpstream(upstream)) {
    const global = claudeConfig?.oauthRequestScopedErrors ?? claudeConfig?.['oauth-request-scoped-errors'];
    if (global && typeof global === 'object' && !Array.isArray(global)) raw = global.claude ?? global.anthropic;
  }
  let rules = raw;
  if (typeof raw === 'string') {
    try { rules = JSON.parse(raw); } catch { rules = []; }
  }
  if (!Array.isArray(rules)) return '';
  const code = Number(status);
  if (!Number.isInteger(code)) return '';
  const serializedBody = typeof body === 'string' ? body : JSON.stringify(body ?? '') || '';
  const errorText = serializedBody.slice(0, MAX_REQUEST_SCOPED_ERROR_TEXT);
  if (typeof errorText !== 'string') return '';
  for (const rule of rules.slice(0, 128)) {
    if (!rule || typeof rule !== 'object' || Number(rule.status) !== code) continue;
    const substrings = Array.isArray(rule.match) ? rule.match : [];
    const regexes = Array.isArray(rule['match-regexr']) ? rule['match-regexr']
      : Array.isArray(rule.match_regexr) ? rule.match_regexr : [];
    const substringMatch = substrings.some((value) => typeof value === 'string' && value && errorText.includes(value));
    let regexMatch = false;
    if (!substringMatch) {
      regexMatch = regexes.some((pattern) => {
        if (typeof pattern !== 'string' || !pattern || pattern.length > 256) return false;
        const expression = cachedRequestScopedRegex(pattern);
        return expression ? expression.test(errorText) : false;
      });
    }
    if (!substringMatch && !regexMatch) continue;
    const action = typeof rule.action === 'string' ? rule.action.trim().toLowerCase() : '';
    if (['stop', 'stop-and-cooldown', 'continue', 'continue-and-cooldown'].includes(action)) return action;
  }
  return '';
}

function cachedRequestScopedRegex(pattern) {
  const existing = requestScopedRegexCache.get(pattern);
  if (existing) return existing;
  try {
    const expression = new RegExp(pattern);
    requestScopedRegexCache.set(pattern, expression);
    while (requestScopedRegexCache.size > REQUEST_SCOPED_REGEX_CACHE_LIMIT) {
      requestScopedRegexCache.delete(requestScopedRegexCache.keys().next().value);
    }
    return expression;
  } catch {
    return null;
  }
}

export function claudeCoolingDisabled(upstream, claudeConfig = null) {
  if (upstream?.type !== 'claude') return false;
  const metadata = upstream.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : {};
  const raw = metadata.disable_cooling ?? metadata['disable-cooling'];
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;
  if (typeof raw === 'string') return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  return claudeConfig?.disableCooling === true || claudeConfig?.['disable-cooling'] === true;
}

export function claudeRequestRetryLimit(upstream, claudeConfig = null) {
  if (upstream?.type !== 'claude') return 0;
  const metadata = upstream.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : {};
  const raw = metadata.request_retry ?? metadata['request-retry']
    ?? claudeConfig?.requestRetry ?? claudeConfig?.['request-retry'];
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 8);
}

function claudeRateLimitDetails(headers) {
  const shared5h = headerValue(headers, 'anthropic-ratelimit-unified-5h-status')?.toLowerCase();
  const shared7d = headerValue(headers, 'anthropic-ratelimit-unified-7d-status')?.toLowerCase();
  const aggregate = headerValue(headers, 'anthropic-ratelimit-unified-status')?.toLowerCase();
  if (shared5h === 'rejected' || shared7d === 'rejected') return { credentialScoped: true };
  if (aggregate !== 'rejected') {
    return {
      credentialScoped: false,
      retryAfter: headerValue(headers, 'retry-after'),
      resetAt: resetHeaderValues(headers)
    };
  }
  const fableOnly = ['allowed', 'allowed_warning'].includes(shared5h)
    && ['allowed', 'allowed_warning'].includes(shared7d)
    && headerValue(headers, 'anthropic-ratelimit-unified-7d_oi-status')?.toLowerCase() === 'rejected';
  return {
    credentialScoped: !fableOnly,
    retryAfter: headerValue(headers, 'retry-after'),
    // CPA deliberately ignores the long 7d_oi reset for a Fable-only
    // rejection. Retry-After is still authoritative when present.
      resetAt: fableOnly
      ? resetHeaderValues(headers, new Set(['anthropic-ratelimit-unified-7d_oi-reset']))
      : resetHeaderValues(headers)
  };
}

export function classifySseEvent(event, { allowMisalignmentPolicy = false, upstreamType = '', headers = null } = {}) {
  const error = structuredError(event);
  const policyFailure = allowMisalignmentPolicy && misalignmentPolicyFailure(event);
  if (policyFailure) return { class: 'neutral', retryable: false, errorCode: policyFailure.code };
  const status = finiteStatus(event?.status ?? event?.status_code ?? error.status);
  const claudeRateLimit = upstreamType === 'claude' && (status === 429 || quotaCode(error.code, error.type))
    ? claudeRateLimitDetails(headers)
    : null;
  if (claudeRateLimit && !claudeRateLimit.credentialScoped) {
    if (error.fastModeCredits) return { class: 'neutral', retryable: false, ...(status ? { status } : {}), ...error, errorCode: error.code || 'fast_mode_credits_required' };
    return {
      class: 'neutral',
      retryable: true,
      ...(status ? { status } : {}),
      ...error,
      modelScoped: true,
      retryAfter: claudeRateLimit.retryAfter,
      resetAt: claudeRateLimit.resetAt,
      errorCode: error.code || error.type || 'rate_limit_error'
    };
  }
  if (status) return outcomeForStatus(status, error, allowMisalignmentPolicy);
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

function outcomeForStatus(status, metadata = {}, allowMisalignmentPolicy = false) {
  const { fastModeCredits = false, ...publicMetadata } = metadata;
  const normalized = {
    ...publicMetadata,
    code: publicMetadata.code ?? publicMetadata.errorCode ?? null,
    type: publicMetadata.type ?? publicMetadata.errorType ?? null,
    param: publicMetadata.param ?? publicMetadata.errorParam ?? null
  };
  if (!Number.isFinite(status)) return { class: 'unknown', retryable: false };
  if (status >= 200 && status < 300) return { class: 'success', retryable: false, status };
  if (status >= 300 && status < 400) return { class: 'neutral', retryable: false, status };
  if (allowMisalignmentPolicy && [400, 403].includes(status) && misalignmentPolicyFailure({ error: normalized })) {
    return { class: 'neutral', retryable: false, status, errorCode: normalized.code };
  }
  if (status === 401 || status === 403) return { class: 'credential', retryable: true, status, ...metadata };
  if (status === 402) return quotaOutcome({ status, ...metadata });
  if (status === 429) {
    if (fastModeCredits) {
      return { class: 'caller', retryable: false, status, ...publicMetadata, errorCode: publicMetadata.errorCode || 'fast_mode_credits_required' };
    }
    return quotaOutcome({ status, ...publicMetadata });
  }
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
    fastModeCredits: fastModeCreditsRequired(source.message),
    status: finiteStatus(source.status ?? source.status_code)
  };
}

function fastModeCreditsRequired(message) {
  const value = String(message || '').toLowerCase();
  return value.includes('fast') && (value.includes('usage credits') || value.includes('credits are required') || value.includes('fast request rejected'));
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

function resetHeaderValues(headers, excluded = new Set()) {
  return RESET_HEADER_NAMES.filter((name) => !excluded.has(name)).map((name) => headerValue(headers, name)).filter(Boolean);
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
