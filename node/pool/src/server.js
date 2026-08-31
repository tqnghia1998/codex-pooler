import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/store.js';
import { refreshQuota } from '../../src/providers.js';
import { HttpError, readRequestBody } from '../../src/http-ingress.js';
import { errorEnvelope, openaiError } from '../../src/public-errors.js';
import { firewallAllowed, hostAllowed, originAllowed } from '../../src/admission.js';
import { codexHostHealthForStore } from '../../src/codex-host-health.js';
import {
  PROXY_ENDPOINTS,
  WEBSOCKET_ENDPOINTS,
  attachWebSocketProxy,
  authenticateProxyRequest,
  isAdditionalGatewayRoute,
  proxyModelsRequest,
  proxyRawRequest,
  proxyRequest
} from '../../src/proxy.js';
import { ProductStore } from './product-store.js';
import { CodexLoginManager } from './codex-login.js';

const productRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const publicDir = join(productRoot, 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};
const COOKIE_NAMES = {
  session: 'codex_pool_session',
  csrf: 'codex_pool_csrf',
  login: 'codex_pool_login'
};
export const QUOTA_REFRESH_INTERVAL_MS = 60_000;
const QUOTA_REFRESH_BATCH_SIZE = 10;

export function createApp({
  store = new Store(resolve(productRoot, '.data')),
  productStore = new ProductStore(resolve(productRoot, '.data')),
  codexLoginManager = new CodexLoginManager({ sharingStore: productStore, upstreamStore: store }),
  fetchImpl = globalThis.fetch,
  ingress = poolIngress(),
  cookieSecure = envBoolean(process.env.POOL_COOKIE_SECURE, false),
  upstreamDeadlines = {},
  logger = console,
  codexHostHealth = codexHostHealthForStore(store),
  onCodexCredentialsImported = () => {}
} = {}) {
  return async function app(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!hostAllowed(req.headers.host, ingress)) {
        sendJson(res, 403, { error: { type: 'permission_error', code: 'invalid_host', message: 'Invalid Host header' } });
        return;
      }
      if (isMutation(req.method) && !originAllowed(req.headers.origin, req.headers.host, ingress)) {
        sendJson(res, 403, { error: { type: 'permission_error', code: 'invalid_origin', message: 'Invalid Origin header' } });
        return;
      }
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok', product: 'codex-pool' });
        return;
      }
      if (url.pathname === '/readyz') {
        sendJson(res, 200, { status: 'ready', product: 'codex-pool' });
        return;
      }
      if (url.pathname.startsWith('/auth/')) {
        await authRequest(req, res, url, { productStore, codexLoginManager, cookieSecure, onCodexCredentialsImported });
        return;
      }
      if (url.pathname.startsWith('/api/pool/')) {
        await productApi(req, res, url, { store, productStore, fetchImpl });
        return;
      }

      const usageRoute = req.method === 'GET' && url.pathname === '/v1/usage';
      const modelRoute = req.method === 'GET'
        && ['/v1/models', '/backend-api/codex/models', '/backend-api/codex/v1/models'].includes(url.pathname);
      const jsonProxyRoute = req.method === 'POST' && PROXY_ENDPOINTS.has(url.pathname);
      const websocketOnlyRoute = req.method === 'GET' && WEBSOCKET_ENDPOINTS.has(url.pathname);
      const rawProxyRoute = isAdditionalGatewayRoute(req.method, url.pathname);
      if (usageRoute || modelRoute || jsonProxyRoute || websocketOnlyRoute || rawProxyRoute) {
        if (!firewallAllowed(req, ingress)) {
          sendJson(res, 403, { error: { type: 'permission_error', code: 'access_denied', message: 'Client IP is not allowed' } });
          return;
        }
        const auth = authenticateProxyRequest(req, store, null, {
          allowXApiKey: req.method === 'POST' && url.pathname === '/v1/messages',
          sharingStore: productStore,
          shareKeysOnly: true
        });
        if (!auth) {
          sendJson(res, 401, { error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid Codex Pool share key' } }, { 'www-authenticate': 'Bearer' });
          return;
        }
        req.proxyAuth = auth;
        req.sharingStore = productStore;
        const denial = shareSessionDenial(auth);
        if (denial) {
          sendJson(res, 403, { error: { type: 'permission_error', ...denial } });
          return;
        }
      }
      if (usageRoute) {
        if (url.searchParams.size) throw new HttpError(400, 'invalid_request', 'Usage query parameters are not supported');
        sendJson(res, 200, productStore.shareSessionUsage(req.proxyAuth.shareSessionId));
        return;
      }
      if (websocketOnlyRoute) {
        sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'websocket_upgrade_required', message: 'WebSocket upgrade required' } });
        return;
      }
      if (jsonProxyRoute) {
        await proxyRequest({
          req,
          res,
          path: url.pathname,
          payload: await jsonBody(req, ingress),
          store,
          apiKey: null,
          fetchImpl,
          upstreamDeadlines,
          logger,
          codexHostHealth
        });
        return;
      }
      if (modelRoute) {
        await proxyModelsRequest({ req, res, path: url.pathname, store, apiKey: null, fetchImpl, upstreamDeadlines, codexHostHealth });
        return;
      }
      if (rawProxyRoute) {
        const requestBody = ['GET', 'DELETE'].includes(req.method) ? Buffer.alloc(0) : await readRequestBody(req, ingress);
        await proxyRawRequest({ req, res, path: url.pathname, body: requestBody, store, apiKey: null, fetchImpl, upstreamDeadlines, logger, codexHostHealth });
        return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/backend-api/')) {
        sendJson(res, 404, { error: { type: 'invalid_request_error', code: 'unsupported_endpoint', message: 'Unsupported Codex Pool endpoint' } });
        return;
      }
      await staticFile(req, res, url.pathname, ingress);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const failure = poolErrorEnvelope(error);
      sendJson(res, failure.status, failure.body, failure.headers);
    }
  };
}

export function start(port = Number(process.env.POOL_PORT) || 3010, {
  dataDir = process.env.POOL_DATA_DIR || resolve(productRoot, '.data'),
  store = new Store(dataDir),
  productStore = new ProductStore(dataDir),
  fetchImpl = globalThis.fetch,
  host = process.env.POOL_BIND_HOST || '127.0.0.1',
  ingress = poolIngress(),
  cookieSecure = envBoolean(process.env.POOL_COOKIE_SECURE, false),
  quotaRefreshIntervalMs = Number(process.env.POOL_QUOTA_REFRESH_INTERVAL_MS) || QUOTA_REFRESH_INTERVAL_MS
} = {}) {
  const codexLoginManager = new CodexLoginManager({
    sharingStore: productStore,
    upstreamStore: store,
    command: process.env.POOL_CODEX_CLI || 'codex'
  });
  const codexHostHealth = codexHostHealthForStore(store);
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return [];
    refreshing = true;
    try {
      return await refreshAllQuotas(store, { fetchImpl });
    } finally {
      refreshing = false;
    }
  };
  const server = createHttpServer(createApp({
    store,
    productStore,
    codexLoginManager,
    fetchImpl,
    ingress,
    cookieSecure,
    codexHostHealth,
    onCodexCredentialsImported: refresh
  }));
  const websocketServer = attachWebSocketProxy(server, {
    store,
    sharingStore: productStore,
    shareKeysOnly: true,
    apiKey: null,
    fetchImpl,
    ingress,
    codexHostHealth
  });
  void refresh();
  const timer = setInterval(refresh, quotaRefreshIntervalMs);
  timer.unref?.();
  server.once('close', () => {
    clearInterval(timer);
    websocketServer.close();
    codexLoginManager.close();
  });
  server.listen(port, host, () => {
    console.log(`codex-pool listening on http://${host}:${server.address().port}`);
  });
  return server;
}

export async function refreshAllQuotas(store, { fetchImpl = globalThis.fetch } = {}) {
  const upstreams = store.list();
  const results = [];
  for (let index = 0; index < upstreams.length; index += QUOTA_REFRESH_BATCH_SIZE) {
    const batch = upstreams.slice(index, index + QUOTA_REFRESH_BATCH_SIZE);
    results.push(...await Promise.allSettled(batch.map(async ({ id }) => {
      const upstream = store.get(id);
      if (!upstream || upstream.type !== 'codex') return null;
      return refreshPoolUpstreamQuota(store, upstream, fetchImpl);
    })));
  }
  return results;
}

async function authRequest(req, res, url, { productStore, codexLoginManager, cookieSecure, onCodexCredentialsImported }) {
  if (req.method === 'POST' && url.pathname === '/auth/codex/import') {
    const input = await body(req);
    if (typeof input.authJson !== 'string' || !input.authJson.trim()) {
      throw new HttpError(400, 'invalid_request', 'authJson is required');
    }
    let account;
    try {
      ({ account } = codexLoginManager.importAuthJson(input.authJson));
    } catch (error) {
      if (error?.statusCode) throw error;
      throw new HttpError(400, 'invalid_request', String(error.message || 'Codex auth JSON could not be imported').slice(0, 300));
    }
    const session = productStore.createAccountSession(account.id);
    void onCodexCredentialsImported();
    setCookies(res, [
      cookie(COOKIE_NAMES.login, '', { httpOnly: true, secure: cookieSecure, maxAge: 0 }),
      cookie(COOKIE_NAMES.session, session.token, { httpOnly: true, secure: cookieSecure, maxAge: 30 * 24 * 60 * 60 }),
      cookie(COOKIE_NAMES.csrf, session.csrfToken, { secure: cookieSecure, maxAge: 30 * 24 * 60 * 60 })
    ]);
    sendJson(res, 200, { account });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/auth/codex/start') {
    const attempt = codexLoginManager.start();
    setCookies(res, [
      cookie(COOKIE_NAMES.login, attempt.token, { httpOnly: true, secure: cookieSecure, maxAge: 20 * 60 })
    ]);
    sendJson(res, 201, { login: attempt.login });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/codex/status') {
    const token = requestCookies(req)[COOKIE_NAMES.login];
    const login = codexLoginManager.status(token);
    if (!login) throw new HttpError(401, 'authentication_error', 'Codex login attempt is unavailable');
    if (login.status === 'completed') {
      const completed = productStore.consumeCompletedCodexLogin(token);
      if (!completed) throw new HttpError(401, 'authentication_error', 'Codex login attempt has already been consumed');
      void onCodexCredentialsImported();
      setCookies(res, [
        cookie(COOKIE_NAMES.login, '', { httpOnly: true, secure: cookieSecure, maxAge: 0 }),
        cookie(COOKIE_NAMES.session, completed.session.token, { httpOnly: true, secure: cookieSecure, maxAge: 30 * 24 * 60 * 60 }),
        cookie(COOKIE_NAMES.csrf, completed.session.csrfToken, { secure: cookieSecure, maxAge: 30 * 24 * 60 * 60 })
      ]);
      sendJson(res, 200, { login: completed.login });
      return;
    }
    sendJson(res, 200, { login });
    return;
  }
  if (req.method === 'DELETE' && url.pathname === '/auth/codex/login') {
    const token = requestCookies(req)[COOKIE_NAMES.login];
    if (!token || !codexLoginManager.cancel(token)) throw new HttpError(404, 'not_found', 'Codex login attempt was not found');
    setCookies(res, [cookie(COOKIE_NAMES.login, '', { httpOnly: true, secure: cookieSecure, maxAge: 0 })]);
    sendJson(res, 204, null);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    const auth = accountSession(req, productStore, true);
    productStore.revokeAccountSession(requestCookies(req)[COOKIE_NAMES.session]);
    setCookies(res, [
      cookie(COOKIE_NAMES.session, '', { httpOnly: true, secure: cookieSecure, maxAge: 0 }),
      cookie(COOKIE_NAMES.csrf, '', { secure: cookieSecure, maxAge: 0 })
    ]);
    if (!auth.account) throw new HttpError(401, 'authentication_error', 'Account session is unavailable');
    sendJson(res, 204, null);
    return;
  }
  throw new HttpError(404, 'not_found', 'Not found');
}

async function productRequest(req, res, url, { store, productStore, fetchImpl }) {
  const auth = accountSession(req, productStore, isMutation(req.method));
  const accountId = auth.account.id;
  const parts = url.pathname.split('/').filter(Boolean);
  const resource = parts[2];
  const id = parts[3];
  const action = parts[4];

  if (req.method === 'GET' && resource === 'me' && parts.length === 3) {
    sendJson(res, 200, { account: auth.account });
    return;
  }
  if (req.method === 'GET' && resource === 'upstreams' && parts.length === 3) {
    const upstreams = productStore.listAccountUpstreamLinks(accountId)
      .flatMap(({ upstreamId }) => {
        const upstream = store.getPublic(upstreamId);
        return upstream ? [upstream] : [];
      });
    sendJson(res, 200, { upstreams });
    return;
  }
  if (req.method === 'POST' && resource === 'upstreams' && id && action === 'refresh-quota') {
    const upstream = store.get(id);
    if (!upstream || !productStore.accountOwnsUpstream(accountId, id)) throw notFound();
    if (upstream.type !== 'codex') throw new HttpError(400, 'invalid_request', 'Only Codex accounts can refresh quota');
    const quota = await refreshPoolUpstreamQuota(store, upstream, fetchImpl);
    sendJson(res, 200, { upstream: quota });
    return;
  }
  if (req.method === 'GET' && resource === 'offers' && parts.length === 3) {
    sendJson(res, 200, { offers: productStore.listOffers(accountId, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'offers' && parts.length === 3) {
    sendJson(res, 201, { offer: productStore.createOffer(accountId, await body(req), store) });
    return;
  }
  if (req.method === 'PATCH' && resource === 'offers' && id && parts.length === 4) {
    sendJson(res, 200, { offer: productStore.updateOffer(accountId, id, await body(req), store) });
    return;
  }
  if (req.method === 'GET' && resource === 'tickets' && parts.length === 3) {
    sendJson(res, 200, { tickets: productStore.listTickets(accountId, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'tickets' && parts.length === 3) {
    sendJson(res, 201, { ticket: productStore.createTicket(accountId, await body(req), store) });
    return;
  }
  if (req.method === 'POST' && resource === 'tickets' && action === 'cancel') {
    sendJson(res, 200, { ticket: productStore.cancelTicket(accountId, id, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'tickets' && action === 'reject') {
    sendJson(res, 200, { ticket: productStore.rejectTicket(accountId, id, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'tickets' && action === 'approve') {
    sendJson(res, 200, { session: productStore.approveTicket(accountId, id, await body(req), store) });
    return;
  }
  if (req.method === 'GET' && resource === 'sessions' && parts.length === 3) {
    sendJson(res, 200, { sessions: productStore.listSessions(accountId, store) });
    return;
  }
  if (req.method === 'PATCH' && resource === 'sessions' && id && parts.length === 4) {
    sendJson(res, 200, { session: productStore.updateSession(accountId, id, await body(req), store) });
    return;
  }
  if (req.method === 'POST' && resource === 'sessions' && action === 'revoke') {
    sendJson(res, 200, { session: productStore.revokeSession(accountId, id, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'sessions' && action === 'reveal-key') {
    sendJson(res, 200, productStore.revealSessionKey(accountId, id));
    return;
  }
  if (req.method === 'POST' && resource === 'sessions' && action === 'rotate-key') {
    sendJson(res, 200, productStore.rotateSessionKey(accountId, id));
    return;
  }
  throw new HttpError(404, 'not_found', 'Not found');
}

async function productApi(req, res, url, context) {
  try {
    return await productRequest(req, res, url, context);
  } catch (error) {
    if (error instanceof HttpError || error?.statusCode) throw error;
    throw new HttpError(400, 'invalid_request', String(error.message || 'Invalid request').slice(0, 300));
  }
}

async function refreshPoolUpstreamQuota(store, upstream, fetchImpl) {
  const quota = await refreshQuota(upstream, store.credentials(upstream.id), {
    fetchImpl,
    saveCredentials: (updated, accessTokenExpiresAt) => store.persistCredentials(upstream.id, updated, accessTokenExpiresAt)
  });
  return store.setQuota(upstream.id, quota);
}

function accountSession(req, productStore, requireCsrf) {
  const cookies = requestCookies(req);
  const csrf = typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : null;
  const auth = productStore.authenticateAccountSession(cookies[COOKIE_NAMES.session], csrf);
  if (!auth) throw new HttpError(401, 'authentication_error', 'Account session is unavailable');
  if (requireCsrf && (!csrf || cookies[COOKIE_NAMES.csrf] !== csrf || !auth.csrfValid)) {
    throw new HttpError(403, 'permission_error', 'CSRF validation failed');
  }
  return auth;
}

async function jsonBody(req, ingress) {
  const bytes = await readRequestBody(req, ingress);
  if (!bytes.length) return {};
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object');
  }
}

async function body(req) {
  return jsonBody(req, {
    maxCompressedBodyBytes: 2 * 1024 * 1024,
    maxDecompressedBodyBytes: 2 * 1024 * 1024
  });
}

async function staticFile(req, res, pathname, ingress) {
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css'].includes(filename)) {
    if (!firewallAllowed(req, ingress)) {
      sendJson(res, 403, { error: { type: 'permission_error', code: 'access_denied', message: 'Client IP is not allowed' } });
      return;
    }
    sendJson(res, 404, { error: { type: 'invalid_request_error', code: 'not_found', message: 'Not found' } });
    return;
  }
  const content = await readFile(join(publicDir, filename));
  const extension = filename.slice(filename.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': MIME_TYPES[extension], 'cache-control': filename === 'index.html' ? 'no-store' : 'public, max-age=300' });
  res.end(content);
}

function poolIngress(input = {}) {
  return {
    allowedHosts: csv(input.allowedHosts ?? process.env.POOL_ALLOWED_HOSTS, ['localhost', '127.0.0.1', '[::1]']).map(normalizeHost),
    allowedOrigins: csv(input.allowedOrigins ?? process.env.POOL_ALLOWED_ORIGINS, []),
    firewallAllowlist: csv(input.firewallAllowlist ?? process.env.POOL_FIREWALL_ALLOWLIST, []),
    trustedProxies: csv(input.trustedProxies ?? process.env.POOL_TRUSTED_PROXIES, []),
    maxCompressedBodyBytes: Number(input.maxCompressedBodyBytes) || 2 * 1024 * 1024,
    maxDecompressedBodyBytes: Number(input.maxDecompressedBodyBytes) || 2 * 1024 * 1024
  };
}

function normalizeHost(value) {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function csv(value, fallback) {
  if (value === undefined) return fallback;
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function requestCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((cookies, item) => {
    const index = item.indexOf('=');
    if (index <= 0) return cookies;
    const name = item.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(item.slice(index + 1).trim());
    } catch {}
    return cookies;
  }, {});
}

function cookie(name, value, { httpOnly = false, secure = false, maxAge = null } = {}) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
    ...(httpOnly ? ['HttpOnly'] : []),
    ...(secure ? ['Secure'] : []),
    ...(maxAge === null ? [] : [`Max-Age=${maxAge}`])
  ].join('; ');
}

function setCookies(res, cookies) {
  res.setHeader('set-cookie', cookies);
}

function isMutation(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

function envBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}

function shareSessionDenial(auth) {
  if (auth?.sessionStatus === 'paused') return { code: 'share_session_paused', message: 'The share session is paused' };
  if (auth?.sessionStatus === 'revoked') return { code: 'share_session_revoked', message: 'The share session is revoked' };
  if (auth?.sessionStatus !== 'active' || auth?.remainingMicros <= 0) {
    return { code: 'share_session_exhausted', message: 'The share session quota is exhausted' };
  }
  return null;
}

function poolErrorEnvelope(error) {
  if (error instanceof HttpError) {
    const type = error.statusCode === 401 ? 'authentication_error'
      : error.statusCode === 403 ? 'permission_error'
        : error.type;
    return { status: error.statusCode, body: openaiError(type, error.code, error.message) };
  }
  if ([400, 401, 403, 409].includes(error?.statusCode)) {
    const status = error.statusCode;
    const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : 'invalid_request_error';
    const code = status === 403 ? 'forbidden' : status === 409 ? 'conflict' : 'invalid_request';
    return { status, body: openaiError(type, code, String(error.message || code).slice(0, 300)) };
  }
  return errorEnvelope(error);
}

function sendJson(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  if (status === 204) return res.end();
  res.end(JSON.stringify(value));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) start();
