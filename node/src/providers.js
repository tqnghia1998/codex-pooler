import { accessTokenExpiresAt, DEFAULT_CODEX_BASE_URL, DEFAULT_COMPASS_BASE_URL, isAiswitchUpstream, normalizeBaseUrl, parseCodexQuota, parseCompassQuota } from './domain.js';
import { captureCodexCookies, codexCookieHeaders } from './codex-cookies.js';
import { decodeClaudeResponse } from './upstream-response.js';
import { claudeProxyDispatcher } from './claude-transport.js';

const CODEX_PATHS = ['/backend-api/wham/usage', '/backend-api/codex/usage', '/api/codex/usage'];
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CLAUDE_OAUTH_AUTH_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
export const CLAUDE_OAUTH_ROLES_URL = 'https://api.anthropic.com/api/oauth/claude_cli/roles';
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_OAUTH_REDIRECT_URI = 'http://localhost:54545/callback';
export const CLAUDE_OAUTH_SCOPE = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const CLAUDE_REFRESH_MAX_ATTEMPTS = 3;
const CLAUDE_REFRESH_MIN_BACKOFF_MS = 5_000;
const CLAUDE_REFRESH_MAX_BACKOFF_MS = 5 * 60_000;
const tokenRefreshes = new Map();
const claudeRefreshBlocks = new Map();
const CODEX_AUTH_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  origin: 'https://auth.openai.com',
  pragma: 'no-cache',
  referer: 'https://auth.openai.com/',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

export async function refreshQuota(upstream, credentials, {
  compassGatewayToken = process.env.CODEX_POOLER_COMPASS_GATEWAY_TOKEN,
  fetchImpl = globalThis.fetch,
  saveCredentials = () => {}
} = {}) {
  if (isAiswitchUpstream(upstream)) throw new Error('AISwitch quota requires a Compass SSO session');
  if (upstream.type === 'claude') return upstream.quota || null;
  if (upstream.type === 'compass') return refreshCompassQuota(upstream, compassGatewayToken, fetchImpl);
  return refreshCodexQuota(upstream, credentials, fetchImpl, saveCredentials);
}

export async function ensureProviderCredentials(upstream, credentials, {
  fetchImpl = globalThis.fetch,
  saveCredentials = () => {}
} = {}) {
  if (upstream.type === 'codex') return refreshCodexCredentials(upstream, credentials, fetchImpl, saveCredentials);
  if (upstream.type === 'claude') return refreshClaudeCredentials(upstream, credentials, fetchImpl, saveCredentials);
  return false;
}

export async function refreshProviderCredentials(upstream, credentials, {
  fetchImpl = globalThis.fetch,
  saveCredentials = () => {}
} = {}) {
  if (upstream.type === 'codex') return refreshCodexCredentials(upstream, credentials, fetchImpl, saveCredentials, true);
  if (upstream.type === 'claude') return refreshClaudeCredentials(upstream, credentials, fetchImpl, saveCredentials, true);
  return false;
}

export function codexRefreshFailureCode(error) {
  const body = error?.providerBody || {};
  const code = body.error?.code || body.error;
  if (['invalid_grant', 'revoked', 'invalid_refresh_token', 'token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(code)) return 'reauth_required';
  const text = [body.error_description, body.error_message, body.message, typeof body.error === 'string' ? body.error : ''].filter((value) => typeof value === 'string').join(' ').toLowerCase();
  return text.includes('refresh') && text.includes('token') && ['revoked', 'expired', 'invalid'].some((word) => text.includes(word)) ? 'reauth_required' : 'failed';
}

export function codexRefreshFailureDetail(error) {
  const message = error?.providerBody?.error?.message || error?.providerBody?.error_description || error?.providerBody?.error_message || error?.message;
  return typeof message === 'string' ? message.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
}

export function claudeRefreshFailureCode(error) {
  const body = error?.providerBody || {};
  const code = body.error?.code || body.error?.type || body.error;
  if (['invalid_grant', 'revoked', 'invalid_refresh_token', 'token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(code)) return 'reauth_required';
  const text = [body.error_description, body.error_message, body.message, typeof body.error === 'string' ? body.error : ''].filter((value) => typeof value === 'string').join(' ').toLowerCase();
  return text.includes('refresh') && text.includes('token') && ['revoked', 'expired', 'invalid'].some((word) => text.includes(word)) ? 'reauth_required' : 'failed';
}

export function claudeRefreshFailureDetail(error) {
  const message = error?.providerBody?.error?.message || error?.providerBody?.error_description || error?.providerBody?.error_message || error?.message;
  return typeof message === 'string' ? message.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
}

export function providerRefreshFailureCode(upstreamType, error) {
  return upstreamType === 'claude' ? claudeRefreshFailureCode(error) : codexRefreshFailureCode(error);
}

export function providerRefreshFailureDetail(upstreamType, error) {
  return upstreamType === 'claude' ? claudeRefreshFailureDetail(error) : codexRefreshFailureDetail(error);
}

async function refreshCodexQuota(upstream, credentials, fetchImpl, saveCredentials, retried = false) {
  await refreshCodexCredentials(upstream, credentials, fetchImpl, saveCredentials);
  const baseUrl = normalizeBaseUrl(upstream.baseUrl, DEFAULT_CODEX_BASE_URL);
  const headers = { authorization: `Bearer ${credentials.accessToken}`, ...codexCookieHeaders(credentials) };
  if (upstream.accountId) headers['chatgpt-account-id'] = upstream.accountId;

  let lastError;
  for (const path of CODEX_PATHS) {
    try {
      const response = await getJson(`${baseUrl}${path}`, headers, fetchImpl);
      if (captureCodexCookies(response, credentials)) {
        Object.assign(headers, codexCookieHeaders(credentials));
        saveCredentials(credentials, upstream.accessTokenExpiresAt);
      }
      if (response.status === 404) continue;
      if ((response.status === 401 || response.status === 403) && credentials.refreshToken && !retried) {
        await refreshCodexCredentials(upstream, credentials, fetchImpl, saveCredentials, true);
        return refreshCodexQuota(upstream, credentials, fetchImpl, saveCredentials, true);
      }
      if (!response.ok) throw providerError(response.status, response.body);
      try {
        return parseCodexQuota(response.body);
      } catch (error) {
        error.statusCode = 502;
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (error.statusCode && error.statusCode !== 404) break;
    }
  }
  throw lastError || new Error('Codex quota endpoint was not found');
}

async function refreshCodexCredentials(upstream, credentials, fetchImpl, saveCredentials, force = false) {
  if (!credentials.refreshToken) {
    if (force || tokenRefreshDue(upstream, credentials)) credentials.onTokenRefreshFailure?.({ providerBody: { error: 'invalid_refresh_token' } });
    return false;
  }
  if (!force && !tokenRefreshDue(upstream, credentials)) return false;
  const key = upstream.id || upstream.accountId || credentials.refreshToken;
  let refresh = tokenRefreshes.get(key);
  if (!refresh) {
    refresh = fetchCodexCredentials(credentials.refreshToken, fetchImpl);
    tokenRefreshes.set(key, refresh);
    void refresh.finally(() => {
      if (tokenRefreshes.get(key) === refresh) tokenRefreshes.delete(key);
    }).catch(() => {});
  }
  let updated;
  try {
    updated = await refresh;
  } catch (error) {
    credentials.onTokenRefreshFailure?.(error);
    throw error;
  }
  const nextCredentials = {
    ...credentials,
    accessToken: updated.accessToken,
    ...(updated.refreshToken ? { refreshToken: updated.refreshToken } : {}),
    ...(updated.idToken ? { idToken: updated.idToken } : {})
  };
  for (const key of ['credentialEpoch', 'modelCatalogEpoch', 'onTokenRefreshFailure', 'onTokenRefreshSuccess']) {
    const descriptor = Object.getOwnPropertyDescriptor(credentials, key);
    if (descriptor) Object.defineProperty(nextCredentials, key, descriptor);
  }
  if (saveCredentials(nextCredentials, updated.expiresAt) === false) return false;
  Object.assign(credentials, nextCredentials);
  upstream.accessTokenExpiresAt = updated.expiresAt;
  upstream.updatedAt = new Date().toISOString();
  credentials.onTokenRefreshSuccess?.();
  return true;
}

async function refreshClaudeCredentials(upstream, credentials, fetchImpl, saveCredentials, force = false) {
  if (!credentials.refreshToken) {
    if (force || tokenRefreshDue(upstream, credentials)) credentials.onTokenRefreshFailure?.({ providerBody: { error: 'invalid_refresh_token' } });
    return false;
  }
  if (!force && !tokenRefreshDue(upstream, credentials)) return false;
  const key = upstream.id || credentials.refreshToken;
  let refresh = tokenRefreshes.get(`claude:${key}`);
  if (!refresh) {
    refresh = fetchClaudeCredentials(credentials.refreshToken, fetchImpl, claudeProxyUrl(upstream));
    tokenRefreshes.set(`claude:${key}`, refresh);
    void refresh.finally(() => {
      if (tokenRefreshes.get(`claude:${key}`) === refresh) tokenRefreshes.delete(`claude:${key}`);
    }).catch(() => {});
  }
  let updated;
  try {
    updated = await refresh;
  } catch (error) {
    credentials.onTokenRefreshFailure?.(error);
    throw error;
  }
  const nextCredentials = {
    ...credentials,
    accessToken: updated.accessToken,
    ...(updated.refreshToken ? { refreshToken: updated.refreshToken } : {}),
    ...(updated.accountId ? { accountId: updated.accountId } : {}),
    ...(updated.email ? { email: updated.email } : {}),
    ...(updated.organizationId ? { organizationId: updated.organizationId } : {}),
    ...(updated.organizationName ? { organizationName: updated.organizationName } : {})
  };
  for (const keyName of ['credentialEpoch', 'onTokenRefreshFailure', 'onTokenRefreshSuccess']) {
    const descriptor = Object.getOwnPropertyDescriptor(credentials, keyName);
    if (descriptor) Object.defineProperty(nextCredentials, keyName, descriptor);
  }
  if (saveCredentials(nextCredentials, updated.expiresAt) === false) return false;
  Object.assign(credentials, nextCredentials);
  if (updated.accountId) upstream.accountId = updated.accountId;
  if (updated.email) upstream.email = updated.email;
  if (updated.organizationId) upstream.organizationId = updated.organizationId;
  if (updated.organizationName) upstream.organizationName = updated.organizationName;
  upstream.accessTokenExpiresAt = updated.expiresAt;
  upstream.updatedAt = new Date().toISOString();
  credentials.onTokenRefreshSuccess?.();
  return true;
}

async function fetchCodexCredentials(refreshToken, fetchImpl) {
  const response = await postForm(CODEX_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID
  }, fetchImpl);
  if (!response.ok) throw providerError(response.status, response.body);
  const accessToken = response.body?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('Codex token refresh returned no access token');
  return {
    accessToken,
    refreshToken: typeof response.body.refresh_token === 'string' && response.body.refresh_token || null,
    idToken: typeof response.body.id_token === 'string' && response.body.id_token || null,
    expiresAt: accessTokenExpiresAt(accessToken, response.body.expires_in)
  };
}

async function fetchClaudeCredentials(refreshToken, fetchImpl, proxyUrl = '') {
  const blockedUntil = claudeRefreshBlocks.get(refreshToken) || 0;
  if (blockedUntil > Date.now()) throw providerError(429, { error: { type: 'rate_limit_error', message: 'Claude token refresh is temporarily blocked' } });
  if (blockedUntil) claudeRefreshBlocks.delete(refreshToken);

  let response;
  let lastError;
  for (let attempt = 0; attempt < CLAUDE_REFRESH_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delayClaudeRefresh(attempt * 1_000);
    try {
      response = await requestJson(CLAUDE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'user-agent': 'axios/1.15.2',
          'accept-encoding': 'gzip, compress, deflate, br',
          connection: 'close'
        },
        body: JSON.stringify({
          client_id: CLAUDE_OAUTH_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          scope: CLAUDE_OAUTH_SCOPE
        })
      }, fetchImpl, proxyUrl);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= CLAUDE_REFRESH_MAX_ATTEMPTS) throw error;
      continue;
    }
    if (response.ok) break;
    lastError = providerError(response.status, response.body);
    if (response.status === 429) {
      claudeRefreshBlocks.set(refreshToken, Date.now() + claudeRefreshRetryAfterMs(response.headers));
      throw lastError;
    }
    if (response.status < 500 || attempt + 1 >= CLAUDE_REFRESH_MAX_ATTEMPTS) throw lastError;
  }
  if (!response?.ok) throw lastError || new Error('Claude token refresh failed');
  const accessToken = typeof response.body?.access_token === 'string' ? response.body.access_token.trim() : '';
  if (!accessToken) throw new Error('Claude token refresh returned no access token');
  claudeRefreshBlocks.delete(refreshToken);
  const updated = {
    accessToken,
    refreshToken: typeof response.body.refresh_token === 'string' && response.body.refresh_token || refreshToken,
    expiresAt: accessTokenExpiresAt(accessToken, response.body.expires_in),
    accountId: typeof response.body.account?.uuid === 'string' ? response.body.account.uuid : null,
    email: typeof response.body.account?.email_address === 'string' ? response.body.account.email_address : null,
    organizationId: typeof response.body.organization?.uuid === 'string' ? response.body.organization.uuid : null,
    organizationName: typeof response.body.organization?.name === 'string' ? response.body.organization.name : null
  };
  try {
    const profile = await fetchClaudeRefreshProfile(accessToken, fetchImpl, proxyUrl);
    updated.accountId = typeof profile?.account?.uuid === 'string' ? profile.account.uuid : updated.accountId;
    updated.email = typeof (profile?.account?.email || profile?.account?.email_address) === 'string'
      ? (profile.account.email || profile.account.email_address)
      : updated.email;
    updated.organizationId = typeof profile?.organization?.uuid === 'string' ? profile.organization.uuid : updated.organizationId;
    updated.organizationName = typeof profile?.organization?.name === 'string' ? profile.organization.name : updated.organizationName;
  } catch {
    // Refresh remains successful when the advisory profile control-plane lookup is unavailable.
  }
  return updated;
}

function delayClaudeRefresh(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function claudeRefreshRetryAfterMs(headers) {
  const retryAfterMs = headerValue(headers, 'retry-after-ms');
  if (retryAfterMs && /^\d+(?:\.\d+)?$/.test(retryAfterMs)) {
    return clampClaudeRefreshBackoff(Number(retryAfterMs));
  }
  const retryAfter = headerValue(headers, 'retry-after');
  if (/^\d+(?:\.\d+)?$/.test(retryAfter || '')) return clampClaudeRefreshBackoff(Number(retryAfter) * 1_000);
  if (retryAfter) {
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return clampClaudeRefreshBackoff(timestamp - Date.now());
  }
  return CLAUDE_REFRESH_MIN_BACKOFF_MS;
}

function clampClaudeRefreshBackoff(value) {
  return Math.min(Math.max(Number.isFinite(value) ? value : CLAUDE_REFRESH_MIN_BACKOFF_MS, CLAUDE_REFRESH_MIN_BACKOFF_MS), CLAUDE_REFRESH_MAX_BACKOFF_MS);
}

async function fetchClaudeRefreshProfile(accessToken, fetchImpl, proxyUrl = '') {
  const response = await requestJson(CLAUDE_OAUTH_PROFILE_URL, {
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'axios/1.15.2',
      'accept-encoding': 'gzip, compress, deflate, br',
      'cache-control': 'no-cache',
      connection: 'close'
    }
  }, fetchImpl, proxyUrl);
  if (!response.ok) throw providerError(response.status, response.body);
  return response.body;
}

function tokenRefreshDue(upstream, credentials) {
  const expiresAt = upstream.accessTokenExpiresAt || accessTokenExpiresAt(credentials.accessToken);
  return Boolean(expiresAt) && new Date(expiresAt).getTime() <= Date.now() + REFRESH_SKEW_MS;
}

async function refreshCompassQuota(upstream, gatewayToken, fetchImpl) {
  if (!gatewayToken) throw new Error('CODEX_POOLER_COMPASS_GATEWAY_TOKEN is not set');
  const baseUrl = normalizeBaseUrl(upstream.baseUrl, DEFAULT_COMPASS_BASE_URL);
  const projectId = encodeURIComponent(upstream.projectId);
  const response = await getJson(`${baseUrl}/open_project/detail/${projectId}`, {
    accept: 'application/json',
    authorization: `Bearer ${gatewayToken}`
  }, fetchImpl);
  if (!response.ok) throw providerError(response.status, response.body);
  try {
    return parseCompassQuota(response.body);
  } catch (error) {
    error.statusCode = 502;
    throw error;
  }
}

async function getJson(url, headers, fetchImpl) {
  return requestJson(url, { headers }, fetchImpl);
}

async function postForm(url, form, fetchImpl) {
  return requestJson(url, {
    method: 'POST',
    headers: { ...CODEX_AUTH_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form)
  }, fetchImpl);
}

async function requestJson(url, options, fetchImpl, proxyUrl = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const dispatcher = fetchImpl === globalThis.fetch ? claudeProxyDispatcher(proxyUrl) : null;
    let response = await fetchImpl(url, { ...options, ...(dispatcher ? { dispatcher } : {}), signal: controller.signal });
    if (String(url).includes('anthropic.com') || String(url).includes('claude.com')) {
      response = await decodeClaudeResponse(response, { maxBytes: 2 * 1024 * 1024 });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body, headers: response.headers };
  } catch (error) {
    if (error.statusCode) throw error;
    const wrapped = new Error(error.name === 'AbortError' ? 'Provider request timed out after 30 seconds' : `Provider request failed: ${error.message}`);
    wrapped.statusCode = 502;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

function claudeProxyUrl(upstream) {
  const metadata = upstream?.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : {};
  const value = metadata.proxy_url ?? metadata['proxy-url'];
  return typeof value === 'string' ? value : '';
}

function providerError(status, body) {
  const error = new Error(`Provider returned HTTP ${status}`);
  error.statusCode = status;
  error.providerBody = body;
  return error;
}

function headerValue(headers, name) {
  const value = headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];
  const normalized = Array.isArray(value) ? value[0] : value;
  return typeof normalized === 'string' ? normalized.trim() : '';
}
