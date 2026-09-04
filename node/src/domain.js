import { createHash, randomUUID } from 'node:crypto';
import { OPENAI_MODEL_IDS } from './openai-pricing-snapshot.js';

export const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com';
export const DEFAULT_COMPASS_BASE_URL = 'https://compass.llm.shopee.io/compass-api/v1';
export const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com';
export const STATIC_MODEL_CATALOG = Object.freeze([
  ...OPENAI_MODEL_IDS,
  'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
  'glm-5.3-flash', 'kimi-k3'
].map((id) => Object.freeze({ id, object: 'model', owned_by: id.startsWith('claude-') ? 'compass' : 'codex' })));
export const SUPPORTED_TYPES = new Set(['codex', 'compass', 'claude']);
export const CREDITS_PER_DOLLAR = 25;
export const MICROS_PER_CREDIT = 40_000;
const MONTH_SECONDS = 27 * 24 * 60 * 60;
const SETTLEMENT_LIMIT = 100;

export function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function number(value, label, { integer = false, min = 0 } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && text(value) === '')) {
    throw new Error(`${label} is required`);
  }
  const parsed = typeof value === 'number' ? value : Number(text(value));
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be a number >= ${min}${integer ? ' (integer)' : ''}`);
  }
  return parsed;
}

export function retryAfterSeconds(value, now = Date.now()) {
  const normalized = text(value);
  if (!normalized) return null;
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : null;
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - now) / 1_000)) : null;
}

export function dollarsToCredits(value) {
  const dollars = number(value, 'capDollars');
  // Zero credits means "no cap", so a positive cap never rounds down into an unset one.
  return Math.max(Math.round(dollars * CREDITS_PER_DOLLAR), dollars > 0 ? 1 : 0);
}

export function dollarsToMicros(value) {
  const dollars = number(value, 'costUsd');
  const micros = Math.round(dollars * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new Error('costUsd is too large');
  return micros;
}

export function microsToCredits(value) {
  return Number(value) / MICROS_PER_CREDIT;
}

export function creditsToDollars(value) {
  return Number(value) / CREDITS_PER_DOLLAR;
}

export function normalizeBaseUrl(value, fallback) {
  return text(value || fallback).replace(/\/+$/, '').replace(/\/backend-api$/, '');
}

// Claude/CPA credentials may target an Anthropic-compatible gateway. Keep the
// URL operator-controlled, but do not let malformed values turn into an
// accidental fetch target. The Claude executor appends /v1/messages itself.
export function normalizeClaudeBaseUrl(value, fallback = DEFAULT_CLAUDE_BASE_URL) {
  const normalized = normalizeBaseUrl(value, fallback);
  try {
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('invalid Claude base URL');
    }
    return normalized;
  } catch {
    return normalizeBaseUrl(fallback, DEFAULT_CLAUDE_BASE_URL);
  }
}

export function claudeMetadataModelExcluded(upstream, model, claudeConfig = null) {
  if (upstream?.type !== 'claude') return false;
  const metadata = upstream.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : {};
  const raw = metadata.excluded_models ?? metadata['excluded-models'];
  const excluded = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' ? raw.split(',') : [];
  const requested = text(model).toLowerCase();
  if (!requested) return false;
  const requestedVariants = claudeModelNameVariants(requested);
  if (excluded.some((value) => intersectsClaudeModelVariants(requestedVariants, value))) return true;
  const aliasesRaw = metadata.model_aliases ?? metadata['model-aliases'];
  let aliases = aliasesRaw;
  if (typeof aliasesRaw === 'string') {
    try { aliases = JSON.parse(aliasesRaw); } catch { aliases = []; }
  }
  if (Array.isArray(aliases)) {
    const target = aliases.find((entry) => entry && intersectsClaudeModelVariants(requestedVariants, entry.alias));
    if (target && excluded.some((value) => intersectsClaudeModelVariants(claudeModelNameVariants(target.name), value))) return true;
  }
  if (!isClaudeOAuthUpstream(upstream)) return false;
  const globalExcluded = claudeConfig?.oauthExcludedModels ?? claudeConfig?.['oauth-excluded-models'];
  const values = globalExcluded && typeof globalExcluded === 'object' && !Array.isArray(globalExcluded)
    ? globalExcluded.claude ?? globalExcluded.anthropic ?? []
    : [];
  const globalList = Array.isArray(values) ? values : typeof values === 'string' ? values.split(',') : [];
  return globalList.some((value) => intersectsClaudeModelVariants(requestedVariants, value));
}

export function isClaudeOAuthUpstream(upstream) {
  return ['oauth', 'legacy_oauth'].includes(claudeCredentialKind(upstream));
}

export function claudeModelNameVariants(value) {
  const normalized = text(value).toLowerCase();
  if (!normalized) return [];
  const match = /^(.*)\(([^()]*)\)$/.exec(normalized);
  return match && match[1] ? [normalized, match[1]] : [normalized];
}

function intersectsClaudeModelVariants(variants, value) {
  const candidate = claudeModelNameVariants(value);
  return candidate.some((item) => variants.some((variant) => matchClaudeWildcard(item, variant) || matchClaudeWildcard(variant, item)));
}

// CPA treats excluded-model entries as case-insensitive patterns where '*'
// matches any substring. Keep matching local and bounded; these values are
// operator configuration, not regular expressions.
function matchClaudeWildcard(pattern, value) {
  if (!pattern || !value) return false;
  if (!pattern.includes('*')) return pattern === value;
  const parts = pattern.split('*');
  if (parts[0] && !value.startsWith(parts[0])) return false;
  if (parts.at(-1) && !value.endsWith(parts.at(-1))) return false;
  let offset = parts[0].length;
  const end = parts.length - 1;
  for (let index = 1; index < end; index += 1) {
    const segment = parts[index];
    if (!segment) continue;
    const found = value.indexOf(segment, offset);
    if (found < 0) return false;
    offset = found + segment.length;
  }
  return offset <= value.length;
}

export function claudeMetadataModelPrefix(upstream) {
  if (upstream?.type !== 'claude') return '';
  const metadata = upstream.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : {};
  const value = text(metadata.prefix);
  if (!value || value.includes('/') || value.length > 64) return '';
  return value;
}

// CLIProxyAPI's ClaudeKey models are richer than the routing.models allowlist:
// they describe the provider name, client alias, display name, and a few
// response/capability flags. Keep the imported shape intact, but expose only
// bounded, useful entries to the request/catalog paths.
export function claudeMetadataModelConfigs(upstream) {
  if (upstream?.type !== 'claude') return [];
  const metadata = upstream.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : {};
  let raw = metadata.models ?? metadata['model-configs'] ?? metadata.model_configs;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 256).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const name = text(entry.name);
    const alias = text(entry.alias);
    if (!name || name.length > 128 || alias.length > 128) return null;
    const displayName = text(entry.displayName || entry['display-name'] || entry.display_name);
    const maxContextLength = Number(entry.maxContextLength ?? entry['max-context-length'] ?? entry.max_context_length);
    return {
      name,
      ...(alias ? { alias } : {}),
      ...(displayName ? { displayName } : {}),
      ...(Number.isInteger(maxContextLength) && maxContextLength > 0 ? { maxContextLength } : {}),
      forceMapping: entry.forceMapping === true || entry['force-mapping'] === true || entry.force_mapping === true,
      isCompat: entry.isCompat === true || entry['is-compat'] === true || entry.is_compat === true,
      ...(entry.thinking && typeof entry.thinking === 'object' && !Array.isArray(entry.thinking) ? { thinking: entry.thinking } : {})
    };
  }).filter(Boolean);
}

export function defaultBaseUrl(type) {
  if (type === 'compass') return DEFAULT_COMPASS_BASE_URL;
  if (type === 'claude') return DEFAULT_CLAUDE_BASE_URL;
  return DEFAULT_CODEX_BASE_URL;
}

export function maskEmail(value) {
  const email = text(value);
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...local].map((character, index) => {
    if (index === 0 || !/^[A-Za-z0-9]$/.test(character)) return character;
    const digest = createHash('sha256').update(`${email}:${index}`).digest();
    return alphabet[digest.readUInt32BE(0) % alphabet.length];
  }).join('');
}

export function deriveUpstreamName(type, { projectId = '', email = '', accountId = '' } = {}) {
  if (type === 'compass') return text(projectId) || 'Compass project';
  if (type === 'claude') return maskEmail(email) || text(accountId) || 'Claude account';
  return maskEmail(email) || text(accountId) || 'Codex account';
}

export function decodeJwtPayload(token) {
  try {
    const [, payload] = text(token).split('.');
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export function accessTokenExpiresAt(token, expiresIn) {
  const seconds = Number(expiresIn);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(Date.now() + seconds * 1000).toISOString();
  const exp = Number(decodeJwtPayload(token).exp);
  return Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000).toISOString() : null;
}

function authClaim(claims, key) {
  const auth = claims?.['https://api.openai.com/auth'];
  return text(auth?.[key]) || text(claims?.[key]);
}

export function parseCodexAuthJson(raw) {
  let payload;
  try {
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('Codex auth JSON is malformed');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Codex auth JSON must be an object');
  }

  const tokens = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : payload;
  const accessToken = text(tokens.access_token || payload.access_token);
  if (!accessToken) throw new Error('Codex auth JSON is missing tokens.access_token');

  const idToken = text(tokens.id_token || payload.id_token);
  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);
  const profile = idClaims?.['https://api.openai.com/profile'] || accessClaims?.['https://api.openai.com/profile'];
  const accountId = text(tokens.account_id || authClaim(idClaims, 'chatgpt_account_id') || authClaim(accessClaims, 'chatgpt_account_id'));
  const email = text(idClaims?.email || accessClaims?.email || profile?.email);
  const subject = text(idClaims?.sub || accessClaims?.sub);
  const issuer = text(idClaims?.iss || accessClaims?.iss);

  return {
    accessToken,
    accessTokenExpiresAt: accessTokenExpiresAt(accessToken, tokens.expires_in || payload.expires_in),
    refreshToken: text(tokens.refresh_token || payload.refresh_token),
    idToken,
    accountId,
    email,
    subject,
    issuer,
    name: deriveUpstreamName('codex', { email, accountId })
  };
}

export function parseClaudeAuthJson(raw) {
  let payload;
  try {
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('Claude auth JSON is malformed');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Claude auth JSON must be an object');
  }
  const source = payload.claudeAiOauth && typeof payload.claudeAiOauth === 'object'
    ? payload.claudeAiOauth
    : payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : payload;
  const accessToken = text(source.access_token || source.accessToken || payload.access_token || payload.accessToken);
  const projectKey = text(source.project_key || source.projectKey || source.api_key || source.apiKey || payload.project_key || payload.projectKey || payload.api_key || payload.apiKey);
  if (!accessToken && !projectKey) throw new Error('Claude auth JSON is missing access_token or project_key');
  const refreshToken = text(source.refresh_token || source.refreshToken || payload.refresh_token || payload.refreshToken);
  const expiresIn = source.expires_in || source.expiresIn || payload.expires_in || payload.expiresIn;
  const expiresAt = normalizeClaudeExpiresAt(source.expires_at || source.expiresAt || payload.expires_at || payload.expiresAt)
    || (accessToken ? accessTokenExpiresAt(accessToken, expiresIn) : null);
  const email = text(source.email || payload.email);
  const accountId = text(source.account_uuid || source.accountUuid || source.account_id || source.accountId || payload.account_uuid || payload.accountId);
  const organizationId = text(source.organization_uuid || source.organizationUuid || source.organization_id || source.organizationId || payload.organization_uuid || payload.organizationId);
  const organizationName = text(source.organization_name || source.organizationName || payload.organization_name || payload.organizationName);
  const baseUrl = text(source.base_url || source.baseUrl || payload.base_url || payload.baseUrl);
  return {
    accessToken,
    projectKey,
    refreshToken,
    accessTokenExpiresAt: expiresAt || null,
    email,
    accountId,
    organizationId,
    organizationName,
    baseUrl,
    metadata: claudeAuthMetadata(payload, source),
    name: deriveUpstreamName('claude', { email, accountId })
  };
}

const CLAUDE_API_KEY_AUTH_KINDS = new Set(['api_key', 'apikey', 'claude_api_key', 'claude-api-key']);
const CLAUDE_OAUTH_AUTH_KINDS = new Set(['oauth', 'claude_oauth', 'oauth_token']);

export function isClaudeOAuthToken(token) {
  return typeof token === 'string' && token.startsWith('sk-ant-oat');
}

export function normalizeClaudeAuthKind(value) {
  return text(value).toLowerCase();
}

export function claudeCredentialKind(upstream, credentials = null) {
  if (upstream?.type !== 'claude' && !credentials) return 'unknown';
  const source = credentials && typeof credentials === 'object' ? credentials : upstream?.credentials || {};
  const metadata = upstream?.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : {};
  const authKind = normalizeClaudeAuthKind(
    source.authKind || source.auth_kind || metadata.auth_kind || metadata['auth-kind'] || metadata.auth_mode || metadata['auth-mode']
  );
  if (text(source.projectKey) || CLAUDE_API_KEY_AUTH_KINDS.has(authKind)) return 'api_key';
  if (CLAUDE_OAUTH_AUTH_KINDS.has(authKind)) return 'oauth';
  if (isClaudeOAuthToken(source.accessToken)) return 'oauth';
  if (Object.hasOwn(source, 'accessToken') && !Object.hasOwn(source, 'projectKey')) return 'legacy_oauth';
  if (text(source.accessToken)
    || upstream?.accessTokenExpiresAt !== null && upstream?.accessTokenExpiresAt !== undefined) return 'legacy_oauth';
  return 'unknown';
}

// Prefer the refresh token so access-token rotation keeps the local UUID stable.
export function deriveClaudeAccountId({ refreshToken = '', accessToken = '' } = {}) {
  const seed = text(refreshToken) || text(accessToken);
  if (!seed) return '';
  const hex = createHash('sha256')
    .update('codex-pooler:claude-account-id\0')
    .update(seed)
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function claudeOAuthInputError(input, { creating = false } = {}) {
  if (creating && text(input?.type).toLowerCase() !== 'claude') return null;
  const metadata = input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {};
  const hasCredentialInput = input?.authJson !== undefined || input?.accessToken !== undefined || input?.projectKey !== undefined;
  const inputAuthKind = normalizeClaudeAuthKind(input?.authKind || input?.['auth-kind'] || input?.auth_mode || input?.['auth-mode'] || metadata.auth_kind || metadata['auth-kind'] || metadata.auth_mode || metadata['auth-mode']);
  if (!hasCredentialInput && !CLAUDE_API_KEY_AUTH_KINDS.has(inputAuthKind)) return null;
  let auth;
  try {
    auth = input?.authJson !== undefined ? parseClaudeAuthJson(input.authJson) : parseClaudeAuthJson({
      access_token: input?.accessToken,
      project_key: input?.projectKey,
      refresh_token: input?.refreshToken,
      expires_at: input?.accessTokenExpiresAt
    });
  } catch (error) {
    return { code: 'invalid_request', message: error.message || 'Claude OAuth credentials are invalid' };
  }
  const authMetadata = auth.metadata && typeof auth.metadata === 'object' ? auth.metadata : {};
  const authKind = normalizeClaudeAuthKind(authMetadata.auth_kind || authMetadata['auth-kind'] || authMetadata.auth_mode || authMetadata['auth-mode'] || inputAuthKind);
  if (auth.projectKey || !auth.accessToken || !isClaudeOAuthToken(auth.accessToken) || CLAUDE_API_KEY_AUTH_KINDS.has(authKind)) {
    return { code: 'claude_oauth_required', message: 'Claude upstreams require Enterprise OAuth credentials; API keys are not supported' };
  }
  return null;
}

export function isSupportedClaudeOAuthUpstream(upstream) {
  return ['oauth', 'legacy_oauth'].includes(claudeCredentialKind(upstream));
}

function claudeAuthMetadata(payload, source) {
  const metadata = {};
  const sources = [payload?.metadata, source?.metadata, payload, source].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  const keys = [
    'cloak_mode', 'cloak_strict_mode', 'cloak_sensitive_words', 'cloak_cache_user_id',
    'timezone', 'claude_timezone', 'fingerprint_profile', 'claude_device_ids',
    'skip_account_profile', 'is_setup_token', 'setup_token', 'auth_kind',
    'scopes', 'scope', 'rebuild_mid_system_message', 'rebuild-mid-system-message',
    'cache_user_id', 'cache-user-id', 'cloak_cache_user_id', 'cloak-cache-user-id',
    'model_aliases', 'model-aliases', 'excluded_models', 'excluded-models',
    'models', 'model_configs', 'model-configs',
    'proxy_url', 'proxy-url', 'prefix',
    'disable_cooling', 'disable-cooling', 'request_retry', 'request-retry',
    'request_scoped_errors', 'request-scoped-errors', 'tool_prefix_disabled',
    'tool-prefix-disabled', 'experimental_cch_signing', 'experimental-cch-signing'
  ];
  for (const current of sources) {
    for (const key of keys) if (current[key] !== undefined && current[key] !== null) metadata[key] = current[key];
    for (const [key, value] of Object.entries(current)) {
      if (key.startsWith('header:') && typeof value === 'string') metadata[key] = value;
    }
    for (const [key, value] of Object.entries(current.headers || {})) {
      if (typeof key === 'string' && key.trim() && typeof value === 'string' && value.trim()) {
        metadata[`header:${key.trim()}`] = value.trim();
      }
    }
    if (current.cloak && typeof current.cloak === 'object' && !Array.isArray(current.cloak)) {
      metadata.cloak = { ...(metadata.cloak || {}), ...current.cloak };
    }
  }
  return metadata;
}

function claudeInputMetadata(input) {
  const metadata = {};
  const aliases = {
    modelAliases: 'model_aliases',
    'model-aliases': 'model_aliases',
    excludedModels: 'excluded_models',
    'excluded-models': 'excluded_models',
    proxyUrl: 'proxy_url',
    'proxy-url': 'proxy_url',
    rebuildMidSystemMessage: 'rebuild_mid_system_message',
    'rebuild-mid-system-message': 'rebuild_mid_system_message',
    disableCooling: 'disable_cooling',
    'disable-cooling': 'disable_cooling',
    requestRetry: 'request_retry',
    'request-retry': 'request_retry',
    requestScopedErrors: 'request_scoped_errors',
    'request-scoped-errors': 'request_scoped_errors',
    fingerprintProfile: 'fingerprint_profile',
    'fingerprint-profile': 'fingerprint_profile',
    experimentalCCHSigning: 'experimental_cch_signing',
    'experimental-cch-signing': 'experimental_cch_signing'
  };
  for (const [source, target] of Object.entries(aliases)) {
    if (input?.[source] !== undefined && input?.[source] !== null) metadata[target] = input[source];
  }
  if (input?.prefix !== undefined && input?.prefix !== null) metadata.prefix = input.prefix;
  if (input?.models !== undefined && input?.models !== null) metadata.models = input.models;
  if (input?.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)) {
    for (const [name, value] of Object.entries(input.headers)) {
      const normalizedName = text(name);
      if (normalizedName && typeof value === 'string' && value.trim()) metadata[`header:${normalizedName}`] = value.trim();
    }
  }
  if (input?.cloak && typeof input.cloak === 'object' && !Array.isArray(input.cloak)) metadata.cloak = input.cloak;
  return metadata;
}

function mergeClaudeInputMetadata(metadata, input) {
  const extra = claudeInputMetadata(input);
  return Object.keys(extra).length ? { ...(metadata || {}), ...extra } : (metadata || {});
}

function normalizeClaudeExpiresAt(value) {
  if (value === undefined || value === null || value === '') return '';
  const raw = typeof value === 'number' ? String(value) : text(value);
  const numeric = Number(raw);
  if (raw && Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

export function createUpstream(input, { allowLegacyClaudeApiKey = false } = {}) {
  const type = text(input.type).toLowerCase();
  if (!SUPPORTED_TYPES.has(type)) throw new Error('type must be codex, compass, or claude');
  if (type === 'claude' && !allowLegacyClaudeApiKey) {
    const policyError = claudeOAuthInputError(input, { creating: true });
    if (policyError) throw new Error(policyError.message);
  }
  const quotaSource = normalizeQuotaSource(input.quotaSource || input.metadata?.quota_type || input.metadata?.quotaType);
  const upstream = {
    id: randomUUID(),
    type,
    name: '',
    baseUrl: defaultBaseUrl(type),
    accountId: '',
    email: '',
    accessTokenExpiresAt: null,
    credentialEpoch: 1,
    compatibilityEpoch: 1,
    modelCatalogEpoch: 1,
    projectId: '',
    quota: null,
    quotaSource,
    spending: newSpending(),
    priority: null,
    credentials: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (type === 'codex') {
    const auth = input.authJson ? parseCodexAuthJson(input.authJson) : parseCodexAuthJson({ tokens: {
      access_token: input.accessToken,
      refresh_token: input.refreshToken,
      id_token: input.idToken,
      account_id: input.accountId
    }});
    upstream.accountId = auth.accountId;
    upstream.email = auth.email;
    upstream.name = deriveUpstreamName(type, upstream);
    upstream.accessTokenExpiresAt = auth.accessTokenExpiresAt;
    upstream.credentials = { accessToken: auth.accessToken, refreshToken: auth.refreshToken, idToken: auth.idToken };
    if (input.metadata && typeof input.metadata === 'object') upstream.metadata = input.metadata;
  } else if (type === 'compass') {
    upstream.projectId = text(input.projectId);
    if (!upstream.projectId) throw new Error('projectId is required');
    const projectKey = text(input.projectKey);
    if (!projectKey) throw new Error('projectKey is required');
    upstream.name = deriveUpstreamName(type, upstream);
    upstream.credentials = { projectKey };
    if (input.metadata && typeof input.metadata === 'object') upstream.metadata = input.metadata;
  } else {
    const auth = input.projectKey ? parseClaudeAuthJson({ project_key: input.projectKey }) : input.authJson ? parseClaudeAuthJson(input.authJson) : parseClaudeAuthJson({
      access_token: input.accessToken,
      project_key: input.projectKey,
      refresh_token: input.refreshToken,
      expires_at: input.accessTokenExpiresAt,
      email: input.email,
      account_id: input.accountId,
      organization_id: input.organizationId,
      organization_name: input.organizationName
    });
    upstream.accountId = auth.accountId || (auth.projectKey ? '' : deriveClaudeAccountId(auth));
    upstream.email = auth.email;
    upstream.baseUrl = normalizeClaudeBaseUrl(input.baseUrl || input.base_url || auth.baseUrl, DEFAULT_CLAUDE_BASE_URL);
    upstream.name = deriveUpstreamName(type, upstream);
    upstream.accessTokenExpiresAt = auth.projectKey ? null : auth.accessTokenExpiresAt;
    upstream.credentials = auth.projectKey
      ? { projectKey: auth.projectKey }
      : {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        ...(auth.organizationId ? { organizationId: auth.organizationId } : {}),
        ...(auth.organizationName ? { organizationName: auth.organizationName } : {})
      };
    if (Object.keys(auth.metadata || {}).length || input.metadata && typeof input.metadata === 'object' || Object.keys(claudeInputMetadata(input)).length || auth.accessToken) {
      const metadata = mergeClaudeInputMetadata({ ...(auth.metadata || {}), ...(input.metadata || {}) }, input);
      if (!metadata.auth_kind && !metadata['auth-kind']) metadata.auth_kind = auth.projectKey ? 'claude_api_key' : 'oauth';
      upstream.metadata = metadata;
    }
  }

  return upstream;
}

export function updateUpstream(upstream, input, { allowLegacyClaudeApiKey = false } = {}) {
  if (upstream.type === 'claude' && !allowLegacyClaudeApiKey) {
    const policyError = claudeOAuthInputError(input);
    if (policyError) throw new Error(policyError.message);
  }
  if (upstream.type !== 'claude') upstream.baseUrl = defaultBaseUrl(upstream.type);
  else upstream.baseUrl = normalizeClaudeBaseUrl(upstream.baseUrl, DEFAULT_CLAUDE_BASE_URL);

  if (upstream.type === 'codex') {
    if (input.authJson || input.accessToken) {
      const auth = input.authJson ? parseCodexAuthJson(input.authJson) : parseCodexAuthJson({ tokens: {
        access_token: input.accessToken,
        refresh_token: input.refreshToken || upstream.credentials.refreshToken,
        id_token: input.idToken || upstream.credentials.idToken,
        account_id: input.accountId || upstream.accountId
      }});
      upstream.accountId = auth.accountId || upstream.accountId;
      upstream.email = auth.email || upstream.email;
      upstream.accessTokenExpiresAt = auth.accessTokenExpiresAt;
      upstream.credentials = {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken || upstream.credentials.refreshToken,
        idToken: auth.idToken || upstream.credentials.idToken
      };
    }
  } else if (upstream.type === 'compass') {
    if (input.projectId !== undefined) {
      upstream.projectId = text(input.projectId);
      if (!upstream.projectId) throw new Error('projectId cannot be empty');
    }
    if (input.projectKey !== undefined && text(input.projectKey)) upstream.credentials.projectKey = text(input.projectKey);
  } else {
    if (input.baseUrl !== undefined || input.base_url !== undefined) {
      upstream.baseUrl = normalizeClaudeBaseUrl(input.baseUrl ?? input.base_url, DEFAULT_CLAUDE_BASE_URL);
    }
    if (input.projectKey !== undefined) {
      const projectKey = text(input.projectKey);
      if (!projectKey) throw new Error('projectKey cannot be empty');
      upstream.credentials = { projectKey };
      upstream.accessTokenExpiresAt = null;
      delete upstream.tokenRefresh;
      upstream.metadata = { ...(upstream.metadata || {}), auth_kind: 'claude_api_key' };
    } else if (input.authJson || input.accessToken) {
      const auth = input.authJson ? parseClaudeAuthJson(input.authJson) : parseClaudeAuthJson({
        access_token: input.accessToken,
        refresh_token: input.refreshToken || upstream.credentials.refreshToken,
        expires_at: input.accessTokenExpiresAt,
        email: input.email || upstream.email,
        account_id: input.accountId || upstream.accountId,
        organization_id: input.organizationId || upstream.credentials.organizationId,
        organization_name: input.organizationName || upstream.credentials.organizationName
      });
      if (auth.baseUrl) upstream.baseUrl = normalizeClaudeBaseUrl(auth.baseUrl, upstream.baseUrl);
      upstream.accountId = auth.accountId || upstream.accountId || (auth.projectKey ? '' : deriveClaudeAccountId(auth));
      upstream.email = auth.email || upstream.email;
      upstream.accessTokenExpiresAt = auth.accessTokenExpiresAt;
      upstream.credentials = {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken || upstream.credentials.refreshToken,
        ...(auth.organizationId || upstream.credentials.organizationId ? { organizationId: auth.organizationId || upstream.credentials.organizationId } : {}),
        ...(auth.organizationName || upstream.credentials.organizationName ? { organizationName: auth.organizationName || upstream.credentials.organizationName } : {})
      };
      if (Object.keys(auth.metadata || {}).length) upstream.metadata = { ...(upstream.metadata || {}), ...auth.metadata };
      if (auth.projectKey) {
        upstream.credentials = { projectKey: auth.projectKey };
        upstream.accessTokenExpiresAt = null;
        upstream.metadata = { ...(upstream.metadata || {}), auth_kind: 'claude_api_key' };
      } else if (!auth.metadata?.auth_kind && !auth.metadata?.['auth-kind']) {
        upstream.metadata = { ...(upstream.metadata || {}), auth_kind: 'oauth' };
      }
    }
  }
  if (input.metadata !== undefined && typeof input.metadata === 'object') {
    upstream.metadata = upstream.type === 'claude'
      ? { ...(upstream.metadata || {}), ...input.metadata }
      : input.metadata;
  }
  if (upstream.type === 'claude') upstream.metadata = mergeClaudeInputMetadata(upstream.metadata, input);
  if (input.quotaSource !== undefined || input.metadata?.quota_type !== undefined || input.metadata?.quotaType !== undefined) {
    upstream.quotaSource = normalizeQuotaSource(input.quotaSource || input.metadata?.quota_type || input.metadata?.quotaType);
  }

  upstream.name = deriveUpstreamName(upstream.type, upstream);
  upstream.updatedAt = new Date().toISOString();
  return upstream;
}

function newSpending() {
  return {
    capCredits: 0,
    spentCredits: 0,
    spentCostMicros: 0,
    capStartedAt: null,
    settlements: {}
  };
}

export function ensureSpending(upstream) {
  upstream.spending ||= newSpending();
  upstream.spending.settlements ||= {};
  if (!upstream.spending.capStartedAt && upstream.spending.periodStartedAt) upstream.spending.capStartedAt = upstream.spending.periodStartedAt;
  if (!Number.isSafeInteger(upstream.spending.spentCostMicros)) {
    upstream.spending.spentCostMicros = Math.max(0, Math.round((Number(upstream.spending.spentCredits) || 0) * MICROS_PER_CREDIT));
  }
  pruneSettlements(upstream.spending);
  return upstream.spending;
}

export function spendingSummary(spending = {}) {
  const capCredits = Number(spending.capCredits) || 0;
  const spentCostMicros = Number.isSafeInteger(spending.spentCostMicros)
    ? Math.max(spending.spentCostMicros, 0)
    : Math.max(0, Math.round((Number(spending.spentCredits) || 0) * MICROS_PER_CREDIT));
  const spentCredits = microsToCredits(spentCostMicros);
  const percentUsed = capCredits > 0 ? (spentCredits / capCredits) * 100 : null;
  const status = capCredits <= 0 ? 'not_set' : spentCredits >= capCredits ? 'reached' : 'normal';

  const settlements = spending.settlements || {};
  let lastActivityAt = spending.lastActivityAt || null;
  for (const s of Object.values(settlements)) {
    if (s && s.startedAt) {
      if (!lastActivityAt || new Date(s.startedAt) > new Date(lastActivityAt)) {
        lastActivityAt = s.startedAt;
      }
    }
  }

  return {
    capCredits,
    capDollars: creditsToDollars(capCredits),
    spentCredits,
    spentDollars: creditsToDollars(spentCredits),
    spentCostMicros,
    remainingCredits: capCredits > 0 ? Math.max(capCredits - spentCredits, 0) : null,
    remainingDollars: capCredits > 0 ? Math.max(creditsToDollars(capCredits - spentCredits), 0) : null,
    percentUsed,
    status,
    routingStatus: status,
    continuationStatus: capCredits <= 0 ? 'spend_cap_unset' : spentCredits < capCredits * 1.25 ? 'allowed' : 'spend_cap_reached',
    capStartedAt: spending.capStartedAt || null,
    lastActivityAt,
    settlementCount: Object.keys(settlements).length
  };
}

export function setSpendingCap(upstream, capCredits) {
  const cap = number(capCredits, 'capCredits', { integer: true });
  upstream.spending = {
    capCredits: cap,
    spentCredits: 0,
    spentCostMicros: 0,
    capStartedAt: cap > 0 ? new Date().toISOString() : null,
    settlements: {}
  };
  upstream.updatedAt = new Date().toISOString();
}

export function recordUsage(upstream, input) {
  const attemptId = text(input.attemptId);
  if (!attemptId) throw new Error('attemptId is required');
  const costSource = text(input.costSource);
  if (!['upstream_reported', 'pricing_snapshot'].includes(costSource)) {
    throw new Error('costSource must be upstream_reported or pricing_snapshot');
  }
  const settledCostMicros = number(input.settledCostMicros, 'settledCostMicros', { integer: true });
  if (!Number.isSafeInteger(settledCostMicros)) throw new Error('settledCostMicros is too large');
  const startedAt = parseDate(input.startedAt, 'startedAt');
  const spending = upstream.spending;
  spending.settlements ||= {};
  const previous = Object.hasOwn(spending.settlements, attemptId) ? spending.settlements[attemptId] : null;
  const effectiveStartedAt = previous?.startedAt || startedAt.toISOString();
  const previousCostMicros = previous?.settledCostMicros || 0;
  const deltaMicros = settledCostMicros - previousCostMicros;
  const capStartedAt = spending.capStartedAt ? new Date(spending.capStartedAt) : null;
  const counted = Boolean(Number(spending.capCredits) > 0 && capStartedAt && new Date(effectiveStartedAt) >= capStartedAt);
  let appliedDeltaMicros = 0;

  if (counted) {
    const currentMicros = Number.isSafeInteger(spending.spentCostMicros)
      ? spending.spentCostMicros
      : Math.round((Number(spending.spentCredits) || 0) * MICROS_PER_CREDIT);
    spending.spentCostMicros = Math.max(0, currentMicros + deltaMicros);
    spending.spentCredits = microsToCredits(spending.spentCostMicros);
    appliedDeltaMicros = deltaMicros;
  }

  Object.defineProperty(spending.settlements, attemptId, {
    value: { settledCostMicros, startedAt: effectiveStartedAt, costSource },
    enumerable: true,
    configurable: true,
    writable: true
  });
  spending.lastActivityAt = effectiveStartedAt;
  pruneSettlements(spending);
  upstream.updatedAt = new Date().toISOString();
  return {
    attemptId,
    settledCostMicros,
    previousSettledCostMicros: previousCostMicros,
    deltaMicros,
    appliedDeltaMicros,
    counted
  };
}

function pruneSettlements(spending) {
  // ponytail: retain recent settlement IDs for duplicate delivery; use SQLite if this idempotency window is too short.
  const overflow = Object.entries(spending.settlements).sort(([, a], [, b]) => Date.parse(a.startedAt || 0) - Date.parse(b.startedAt || 0)).slice(0, Math.max(0, Object.keys(spending.settlements).length - SETTLEMENT_LIMIT));
  // A settlement older than this window cannot be deduplicated: it is counted again rather than risk dropping a
  // slow request that legitimately settles after 100 newer ones, which under load is the far more common case.
  for (const [id] of overflow) delete spending.settlements[id];
}

function parseDate(value, label) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.valueOf())) throw new Error(`${label} must be a valid date`);
  return date;
}

export function spendingEligibility(upstream, continuation = false) {
  const spending = spendingSummary(upstream.spending);
  if (spending.capCredits <= 0) return { eligible: false, reason: 'spend_cap_unset', status: 'spend_cap_unset' };
  if (continuation && spending.spentCredits < spending.capCredits * 1.25) {
    return { eligible: true, reason: null, status: 'continuation_allowed' };
  }
  if (spending.spentCredits >= spending.capCredits) return { eligible: false, reason: 'spend_cap_reached', status: 'spend_cap_reached' };
  return { eligible: true, reason: null, status: 'normal' };
}

export function filterSpendCapEligible(upstreams, { continuationId = null } = {}) {
  const eligible = [];
  const exclusions = [];
  for (const upstream of upstreams) {
    const decision = spendingEligibility(upstream, upstream.id === continuationId);
    if (decision.eligible) eligible.push(upstream);
    else exclusions.push({ id: upstream.id, name: upstream.name, code: decision.reason, capCredits: spendingSummary(upstream.spending).capCredits });
  }
  const pinned = continuationId && exclusions.find((item) => item.id === continuationId && item.code === 'spend_cap_reached');
  if (pinned) {
    return {
      eligible: [],
      reserved: [],
      exclusions,
      error: { status: 503, code: 'pinned_continuation_spend_cap_reached', message: `${pinned.name || 'Upstream account'} reached its spending cap`, retryable: true, requiresNewUpstreamSession: false }
    };
  }
  if (eligible.length) return { eligible, reserved: [], exclusions, error: null };
  return {
    eligible: [],
    reserved: [],
    exclusions,
    error: { status: 503, code: 'no_eligible_backend', message: 'No upstream has an eligible spending cap', retryable: true }
  };
}

export function parseCodexQuota(payload, observedAt = new Date()) {
  const candidates = [];
  const rateLimitReached = payload?.rate_limit?.limit_reached === true;
  const addWindow = (window, source = 'primary', monthly = false) => {
    if (!window || typeof window !== 'object') return;
    // WHAM can omit usage percentages while still flagging the window as reached.
    const reportedUsedPercent = Number(window.used_percent);
    const usedPercent = Number.isFinite(reportedUsedPercent) ? reportedUsedPercent : (rateLimitReached ? 100 : NaN);
    if (!Number.isFinite(usedPercent)) return;
    const seconds = Number(window.limit_window_seconds);
    const remainingUnits = Number(window.remaining);
    const limitUnits = Number(window.limit);
    candidates.push({
      window,
      source,
      monthly,
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      remainingPercent: Number.isFinite(Number(window.remaining_percent)) ? Number(window.remaining_percent) : null,
      remainingUnits: Number.isFinite(remainingUnits) ? remainingUnits : null,
      limitUnits: Number.isFinite(limitUnits) ? limitUnits : null,
      seconds: Number.isFinite(seconds) ? seconds : 0
    });
  };
  const rateLimit = payload?.rate_limit;
  if (rateLimit && typeof rateLimit === 'object') {
    addWindow(rateLimit.primary_window || rateLimit.primary, 'primary');
    addWindow(rateLimit.secondary_window || rateLimit.secondary, 'secondary');
  }
  for (const item of Array.isArray(payload?.additional_rate_limits) ? payload.additional_rate_limits : []) {
    addWindow(item?.rate_limit?.primary_window || item?.rate_limit?.primary, item?.model || item?.limit_name || 'additional');
  }
  addWindow(payload?.spend_control?.individual_limit, 'spend_control', true);
  if (!candidates.length) throw new Error('Codex quota response had no usable quota window');

  const monthly = candidates.filter((candidate) => candidate.monthly || candidate.seconds >= MONTH_SECONDS);
  const selected = candidates.find((candidate) => candidate.source === 'spend_control')
    || [...(monthly.length ? monthly : candidates)].sort((a, b) => b.seconds - a.seconds)[0];
  const resetAt = resetTime(selected.window, observedAt);
  const balance = payload?.credits?.balance;
  const creditBalance = typeof balance === 'number' || (typeof balance === 'string' && balance.trim() !== '') ? Number(balance) : null;
  const remainingUnits = selected.remainingUnits ?? (Number.isFinite(creditBalance) ? creditBalance : null);
  const limitUnits = selected.limitUnits;
  return {
    label: selected.source === 'spend_control' ? 'Monthly usage' : (monthly.length ? 'Monthly quota' : 'Provider quota window'),
    usedPercent: selected.usedPercent,
    remainingPercent: selected.remainingPercent ?? Math.max(0, 100 - selected.usedPercent),
    remainingUnits,
    limitUnits,
    remainingDollars: selected.source === 'spend_control' && Number.isFinite(remainingUnits) ? creditsToDollars(remainingUnits) : null,
    limitDollars: selected.source === 'spend_control' && Number.isFinite(limitUnits) ? creditsToDollars(limitUnits) : null,
    windowSeconds: selected.seconds || null,
    resetAt,
    observedAt: new Date(observedAt).toISOString(),
    source: 'codex_usage_api'
  };
}

export function parseCompassQuota(payload, observedAt = new Date()) {
  const quota = payload?.data?.project?.quota_detail;
  const applied = typeof quota?.applied_balance === 'number' || (typeof quota?.applied_balance === 'string' && quota.applied_balance.trim() !== '') ? Number(quota.applied_balance) : NaN;
  const balance = typeof quota?.balance === 'number' || (typeof quota?.balance === 'string' && quota.balance.trim() !== '') ? Number(quota.balance) : NaN;
  if (payload?.retcode !== 0 || !Number.isFinite(applied) || applied <= 0 || !Number.isFinite(balance)) throw new Error('Compass quota response had no usable project balance');
  const usedPercent = Math.max(0, Math.min(100, ((applied - balance) / applied) * 100));
  const recurring = payload?.data?.project?.budget_type === 'recurring';
  const observed = new Date(observedAt);
  let resetAt = null;
  if (recurring) resetAt = new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth() + 1, 1)).toISOString();
  return {
    label: recurring ? 'Monthly project quota' : 'Project balance',
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    remainingUnits: balance,
    limitUnits: applied,
    remainingDollars: balance,
    limitDollars: applied,
    windowSeconds: recurring ? Math.round((new Date(resetAt) - new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth(), 1))) / 1000) : null,
    resetAt,
    observedAt: observed.toISOString(),
    source: 'compass_project_api'
  };
}

export function parseClaudeQuota(payload, observedAt = new Date()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Claude OAuth usage response must be an object');
  const windows = [];
  const seen = new Set();
  const addWindow = (key, label, windowSeconds, value) => {
    if (seen.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const usedPercent = Number(value.percent ?? value.utilization);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return;
    seen.add(key);
    windows.push({
      key,
      label,
      usedPercent,
      remainingPercent: claudeRemainingPercent(usedPercent),
      remainingUnits: null,
      limitUnits: null,
      remainingDollars: null,
      limitDollars: null,
      windowSeconds,
      resetAt: claudeResetTime(value.resets_at ?? value.reset_at),
      observedAt: new Date(observedAt).toISOString()
    });
  };
  const limits = Array.isArray(payload.limits) ? payload.limits : null;
  if (limits) {
    for (const entry of limits) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const kind = text(entry.kind);
      if (kind === 'session') addWindow('session', 'Session (5h)', 5 * 60 * 60, entry);
      else if (kind === 'weekly_all') addWindow('7d', 'Week (all)', 7 * 24 * 60 * 60, entry);
      else if (kind === 'weekly_scoped') {
        const model = entry.scope?.model;
        const name = text(model?.display_name || model?.id);
        if (name) addWindow(`7d_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, `Week (${name})`, 7 * 24 * 60 * 60, entry);
      } else if (kind) {
        addWindow(kind, kind.replace(/[_-]+/g, ' '), null, entry);
      }
    }
  }
  addWindow('session', 'Session (5h)', 5 * 60 * 60, payload.five_hour);
  addWindow('7d', 'Week (all)', 7 * 24 * 60 * 60, payload.seven_day);
  for (const [key, value] of Object.entries(payload)) {
    if (!key.startsWith('seven_day_') || key === 'seven_day_oauth_apps' || key === 'seven_day_cowork') continue;
    const name = key.slice('seven_day_'.length).replace(/[_-]+/g, ' ');
    addWindow(key, `Week (${name.replace(/\b\w/g, (letter) => letter.toUpperCase())})`, 7 * 24 * 60 * 60, value);
  }
  if (!windows.length) throw new Error('Claude OAuth usage response had no usable quota window');
  const extraUsage = parseClaudeExtraUsage(payload.extra_usage, observedAt);
  const selected = windows.find(({ key }) => key === 'session') || windows.find(({ key }) => key === '7d') || windows[0];
  const observed = new Date(observedAt).toISOString();
  return {
    label: selected.label,
    usedPercent: selected.usedPercent,
    remainingPercent: selected.remainingPercent,
    remainingUnits: null,
    limitUnits: null,
    remainingDollars: extraUsage?.remainingDollars ?? null,
    limitDollars: extraUsage?.limitDollars ?? null,
    windowSeconds: selected.windowSeconds,
    resetAt: selected.resetAt,
    observedAt: observed,
    source: 'claude_oauth_usage',
    ...(extraUsage ? { extraUsage } : {}),
    windows
  };
}

function parseClaudeExtraUsage(value, observedAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.is_enabled !== true) return null;
  const monthlyLimitCredits = Number(value.monthly_limit);
  const usedCredits = Number(value.used_credits);
  if (!Number.isFinite(monthlyLimitCredits) || monthlyLimitCredits <= 0 || !Number.isFinite(usedCredits) || usedCredits < 0) return null;
  const limitDollars = monthlyLimitCredits / 100;
  const usedDollars = usedCredits / 100;
  return {
    enabled: value.is_enabled === true,
    usedDollars,
    remainingDollars: Math.max(0, limitDollars - usedDollars),
    limitDollars,
    observedAt: new Date(observedAt).toISOString()
  };
}

export function parseClaudeQuotaHeaders(headers, observedAt = new Date()) {
  const read = (name) => {
    const value = headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];
    return typeof value === 'string' ? value.trim() : '';
  };
  const windows = [];
  const addWindow = (key, label, windowSeconds, utilizationName, resetName) => {
    const rawUtilization = read(utilizationName);
    if (!rawUtilization) return;
    const utilization = Number(rawUtilization);
    if (!Number.isFinite(utilization) || utilization < 0) return;
    const usedPercent = Math.min(100, utilization * 100);
    windows.push({
      key,
      label,
      usedPercent,
      remainingPercent: claudeRemainingPercent(usedPercent),
      remainingUnits: null,
      limitUnits: null,
      remainingDollars: null,
      limitDollars: null,
      windowSeconds,
      resetAt: claudeResetTime(read(resetName)),
      observedAt: new Date(observedAt).toISOString()
    });
  };
  addWindow('session', 'Session (5h)', 5 * 60 * 60, 'anthropic-ratelimit-unified-5h-utilization', 'anthropic-ratelimit-unified-5h-reset');
  addWindow('7d', 'Week (all)', 7 * 24 * 60 * 60, 'anthropic-ratelimit-unified-7d-utilization', 'anthropic-ratelimit-unified-7d-reset');
  addWindow('overage', 'Overage', null, 'anthropic-ratelimit-unified-overage-utilization', 'anthropic-ratelimit-unified-overage-reset');
  if (!windows.length) throw new Error('Claude response had no usable quota headers');
  const representative = read('anthropic-ratelimit-unified-representative-claim');
  const representativeKey = representative === 'seven_day' ? '7d' : representative === 'five_hour' ? 'session' : representative === 'overage' ? 'overage' : null;
  const selected = windows.find(({ key }) => key === representativeKey)
    || windows.find(({ key }) => key === 'session')
    || windows.find(({ key }) => key === '7d')
    || windows[0];
  const observed = new Date(observedAt).toISOString();
  return {
    label: selected.label,
    usedPercent: selected.usedPercent,
    remainingPercent: selected.remainingPercent,
    remainingUnits: null,
    limitUnits: null,
    remainingDollars: null,
    limitDollars: null,
    windowSeconds: selected.windowSeconds,
    resetAt: selected.resetAt,
    observedAt: observed,
    source: 'claude_oauth_headers',
    windows
  };
}

function publicTokenRefresh(value) {
  if (!value || !['succeeded', 'refreshing', 'failed', 'reauth_required'].includes(value.status)) return null;
  return {
    status: value.status,
    startedAt: value.startedAt || null,
    finishedAt: value.finishedAt || null,
    trigger: value.trigger || null,
    errorCode: value.errorCode || null,
    errorDetail: text(value.errorDetail) || null
  };
}

function resetTime(window, observedAt) {
  const explicit = window.reset_at ?? window.resets_at;
  if (typeof explicit === 'number' && explicit > 0) return new Date(explicit * 1000).toISOString();
  if (typeof explicit === 'string' && explicit.trim()) {
    const value = explicit.trim();
    if (/^\d+$/.test(value)) return new Date(Number(value) * 1000).toISOString();
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  const after = Number(window.reset_after_seconds);
  if (Number.isFinite(after) && after >= 0) return new Date(new Date(observedAt).getTime() + after * 1000).toISOString();
  return null;
}

function claudeResetTime(value) {
  if (typeof value === 'number' && value > 0) return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) return claudeResetTime(Number(normalized));
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function claudeRemainingPercent(usedPercent) {
  return Number(Math.max(0, 100 - usedPercent).toFixed(6));
}

export function isAiswitchUpstream(upstream) {
  return upstream?.type === 'compass' && normalizeQuotaSource(upstream.quotaSource || upstream.metadata?.quota_type || upstream.metadata?.quotaType) === 'aiswitch';
}

function normalizeQuotaSource(value) {
  const source = text(value).toLowerCase();
  if (source === 'aiswitch' || source === 'cqp') return 'aiswitch';
  if (source === 'compass') return 'compass';
  return null;
}

export function publicUpstream(upstream) {
  const spending = spendingSummary(upstream.spending);
  const health = upstream.health && typeof upstream.health === 'object' ? upstream.health : null;
  return {
    id: upstream.id,
    priority: Number.isInteger(upstream.priority) ? upstream.priority : null,
    type: upstream.type,
    ...(upstream.type === 'claude' ? { baseUrl: normalizeClaudeBaseUrl(upstream.baseUrl) } : {}),
    name: deriveUpstreamName(upstream.type, upstream),
    accountId: upstream.accountId || null,
    email: text(upstream.email) || null,
    accessTokenExpiresAt: upstream.accessTokenExpiresAt || null,
    tokenRefresh: publicTokenRefresh(upstream.tokenRefresh),
    projectId: upstream.projectId || null,
    hasCredentials: Object.values(upstream.credentials || {}).some(Boolean),
    metadata: upstream.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : null,
    quota: upstream.quota,
    quotaSource: isAiswitchUpstream(upstream) ? 'aiswitch' : upstream.quotaSource || null,
    pacing: upstream.pacing,
    spending,
    updatedAt: upstream.updatedAt || null,
    lastSuccessfulAt: upstream.lastSuccessfulAt || null,
    health: health ? {
      status: health.status || 'available',
      failureClass: health.failureClass || null,
      cooldownSource: health.cooldownSource || null,
      cooldownStartedAt: health.cooldownStartedAt || null,
      nextEligibleAt: health.nextEligibleAt || null
    } : null,
    eligibility: spendingEligibility(upstream).status
  };
}

export function exportUpstreamCredentials(upstream, credentials) {
  if (upstream.type === 'codex') {
    return {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: credentials.idToken || null,
        access_token: credentials.accessToken || null,
        refresh_token: credentials.refreshToken || null,
        account_id: upstream.accountId || null
      }
    };
  }
  if (upstream.type === 'claude') {
    if (credentials.projectKey) return {
      auth_mode: 'claude_api_key',
      project_key: credentials.projectKey,
      base_url: normalizeClaudeBaseUrl(upstream.baseUrl),
      email: upstream.email || null,
      account_uuid: upstream.accountId || null
    };
    return {
      ...(upstream.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : {}),
      auth_mode: 'claude_oauth',
      base_url: normalizeClaudeBaseUrl(upstream.baseUrl),
      access_token: credentials.accessToken || null,
      refresh_token: credentials.refreshToken || null,
      expires_at: upstream.accessTokenExpiresAt || null,
      account_uuid: upstream.accountId || null,
      organization_uuid: credentials.organizationId || null,
      organization_name: credentials.organizationName || null,
      email: upstream.email || null
    };
  }
  return {
    project_id: upstream.projectId || null,
    project_key: credentials.projectKey || null
  };
}
