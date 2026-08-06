import { accessTokenExpiresAt, DEFAULT_CODEX_BASE_URL, DEFAULT_COMPASS_BASE_URL, isAiswitchUpstream, normalizeBaseUrl, parseCodexQuota, parseCompassQuota } from './domain.js';
import { captureCodexCookies, codexCookieHeaders } from './codex-cookies.js';

const CODEX_PATHS = ['/backend-api/wham/usage', '/backend-api/codex/usage', '/api/codex/usage'];
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const tokenRefreshes = new Map();
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
  if (upstream.type === 'compass') return refreshCompassQuota(upstream, compassGatewayToken, fetchImpl);
  return refreshCodexQuota(upstream, credentials, fetchImpl, saveCredentials);
}

export async function ensureProviderCredentials(upstream, credentials, {
  fetchImpl = globalThis.fetch,
  saveCredentials = () => {}
} = {}) {
  if (upstream.type === 'codex') return refreshCodexCredentials(upstream, credentials, fetchImpl, saveCredentials);
  return false;
}

export async function refreshProviderCredentials(upstream, credentials, {
  fetchImpl = globalThis.fetch,
  saveCredentials = () => {}
} = {}) {
  if (upstream.type === 'codex') return refreshCodexCredentials(upstream, credentials, fetchImpl, saveCredentials, true);
  return false;
}

export function codexRefreshFailureCode(error) {
  const body = error?.providerBody || {};
  const code = body.error?.code || body.error;
  if (['invalid_grant', 'revoked', 'invalid_refresh_token', 'token_expired', 'refresh_token_reused'].includes(code)) return 'reauth_required';
  const text = [body.error_description, body.error_message, body.message, typeof body.error === 'string' ? body.error : ''].filter((value) => typeof value === 'string').join(' ').toLowerCase();
  return text.includes('refresh') && text.includes('token') && ['revoked', 'expired', 'invalid'].some((word) => text.includes(word)) ? 'reauth_required' : 'failed';
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
  for (const key of ['credentialEpoch', 'onTokenRefreshFailure', 'onTokenRefreshSuccess']) {
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

async function requestJson(url, options, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
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

function providerError(status, body) {
  const error = new Error(`Provider returned HTTP ${status}`);
  error.statusCode = status;
  error.providerBody = body;
  return error;
}
