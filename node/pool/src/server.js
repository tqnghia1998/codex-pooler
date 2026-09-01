import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/store.js';
import { exportUpstreamCredentials } from '../../src/domain.js';
import { createTokenRefreshScheduler, TOKEN_REFRESH_INTERVAL_MS } from '../../src/codex-token-refresh.js';
import { refreshAllUpstreamQuotas, refreshUpstreamQuota } from '../../src/upstream-quota-refresh.js';
import { shareSessionDenial } from '../../src/share-authorization.js';
import { HttpError, readJsonObjectBody } from '../../src/http-ingress.js';
import { dispatchGatewayRequest, gatewayRequestKind } from '../../src/gateway-dispatch.js';
import { errorEnvelope, openaiError } from '../../src/public-errors.js';
import { firewallAllowed, hostAllowed, originAllowed } from '../../src/admission.js';
import { codexHostHealthForStore } from '../../src/codex-host-health.js';
import { modelCatalogForStore } from '../../src/codex-model-catalog.js';
import {
  attachWebSocketProxy,
  authenticateProxyRequest,
  testUpstreamConnection
} from '../../src/proxy.js';
import { ProductStore } from './product-store.js';
import { CodexLoginManager } from './codex-login.js';
import { createEmailScheduler, EMAIL_DELIVERY_INTERVAL_MS } from './email.js';
import { providerIssue } from './provider-availability.js';
import { openRedisSqlitePersistence } from '../../src/redis-sqlite.js';

const productRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const publicDir = join(productRoot, 'public');
const relaydeckDataDir = resolve(productRoot, '../.data');
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
export const PRODUCT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const ACCOUNT_COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;

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
  const modelCatalog = modelCatalogForStore(store);
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
        sendJson(res, 200, { status: 'ok', product: 'codex-share' });
        return;
      }
      if (url.pathname === '/readyz') {
        sendJson(res, 200, { status: 'ready', product: 'codex-share' });
        return;
      }
      if (url.pathname.startsWith('/auth/')) {
        await authRequest(req, res, url, {
          productStore,
          codexLoginManager,
          cookieSecure,
          onCodexCredentialsImported,
          logger
        });
        return;
      }
      if (url.pathname.startsWith('/api/pool/')) {
        await productApi(req, res, url, { store, productStore, fetchImpl });
        return;
      }

      const gatewayKind = gatewayRequestKind(req.method, url.pathname);
      if (gatewayKind) {
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
          sendJson(res, 401, { error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid Codex Share key' } }, { 'www-authenticate': 'Bearer' });
          return;
        }
        req.proxyAuth = auth;
        req.sharingStore = productStore;
        req.upstreamStore = store;
        const denial = shareSessionDenial(req.proxyAuth);
        if (denial) {
          sendJson(res, 403, { error: { type: 'permission_error', ...denial } });
          return;
        }
      }
      if (gatewayKind) {
        await dispatchGatewayRequest({
          kind: gatewayKind,
          req,
          res,
          url,
          store,
          apiKey: null,
          fetchImpl,
          ingress,
          upstreamDeadlines,
          logger,
          codexHostHealth,
          modelCatalog,
          sendJson,
          handleUsage: () => {
            if (url.searchParams.size) throw new HttpError(400, 'invalid_request', 'Usage query parameters are not supported');
            sendJson(res, 200, req.proxyAuth.kind === 'personal_share'
              ? productStore.personalKeyUsage(req.proxyAuth.accountId, store)
              : productStore.shareSessionUsage(req.proxyAuth.shareSessionId));
          }
        });
        return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/backend-api/')) {
        sendJson(res, 404, { error: { type: 'invalid_request_error', code: 'unsupported_endpoint', message: 'Unsupported Codex Share endpoint' } });
        return;
      }
      await staticFile(req, res, url.pathname, ingress);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error.plainBadRequest) {
        res.writeHead(error.statusCode, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      const failure = poolErrorEnvelope(error);
      sendJson(res, failure.status, failure.body, failure.headers);
    }
  };
}

export function start(port = Number(process.env.POOL_PORT) || 3010, {
  dataDir = process.env.POOL_DATA_DIR || resolve(productRoot, '.data'),
  store = null,
  productStore = null,
  fetchImpl = globalThis.fetch,
  host = process.env.POOL_BIND_HOST || '127.0.0.1',
  ingress = poolIngress(),
  cookieSecure = envBoolean(process.env.POOL_COOKIE_SECURE, false),
  quotaRefreshIntervalMs = Number(process.env.POOL_QUOTA_REFRESH_INTERVAL_MS) || QUOTA_REFRESH_INTERVAL_MS,
  tokenRefreshIntervalMs = Number(process.env.POOL_TOKEN_REFRESH_INTERVAL_MS) || TOKEN_REFRESH_INTERVAL_MS,
  emailDeliveryIntervalMs = Number(process.env.POOL_EMAIL_DELIVERY_INTERVAL_MS) || EMAIL_DELIVERY_INTERVAL_MS,
  productCleanupIntervalMs = Number(process.env.POOL_PRODUCT_CLEANUP_INTERVAL_MS) || PRODUCT_CLEANUP_INTERVAL_MS
} = {}) {
  const poolDataDir = requirePoolDataDir(dataDir);
  store ||= new Store(poolDataDir);
  productStore ||= new ProductStore(poolDataDir);
  const codexLoginManager = new CodexLoginManager({
    sharingStore: productStore,
    upstreamStore: store,
    command: process.env.POOL_CODEX_CLI || 'codex'
  });
  const codexHostHealth = codexHostHealthForStore(store);
  const tokenScheduler = createTokenRefreshScheduler(store, { fetchImpl });
  const emailScheduler = createEmailScheduler(productStore, { intervalMs: emailDeliveryIntervalMs });
  store.setTokenRefreshFailureHandler?.(tokenScheduler.schedule);
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return [];
    refreshing = true;
    try {
      const results = await refreshAllQuotas(store, { fetchImpl });
      productStore.expireDue();
      productStore.observeProviders(store);
      await emailScheduler.run();
      return results;
    } finally {
      refreshing = false;
    }
  };
  const refreshImportedUpstream = async (upstreamId) => {
    try {
      await refreshUpstreamQuota(store, upstreamId, { fetchImpl });
    } finally {
      productStore.observeProviders(store);
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
    onCodexCredentialsImported: refreshImportedUpstream
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
  productStore.cleanup();
  void refresh();
  const timer = setInterval(refresh, quotaRefreshIntervalMs);
  timer.unref?.();
  const cleanupTimer = setInterval(() => productStore.cleanup(), productCleanupIntervalMs);
  cleanupTimer.unref?.();
  void tokenScheduler.run();
  void emailScheduler.run();
  const tokenTimer = setInterval(tokenScheduler.run, tokenRefreshIntervalMs);
  tokenTimer.unref?.();
  server.once('close', () => {
    clearInterval(timer);
    clearInterval(cleanupTimer);
    clearInterval(tokenTimer);
    store.setTokenRefreshFailureHandler?.(null);
    tokenScheduler.close();
    emailScheduler.close();
    websocketServer.close();
    codexLoginManager.close();
  });
  server.listen(port, host, () => {
    console.log(`codex-share listening on http://${host}:${server.address().port}`);
  });
  return server;
}

export async function startConfigured() {
  if (!process.env.POOL_REDIS_URL) return start();
  const dataDir = process.env.POOL_DATA_DIR || resolve(productRoot, '.data');
  requirePoolDataDir(dataDir);
  const persistence = await openRedisSqlitePersistence({
    url: process.env.POOL_REDIS_URL,
    prefix: process.env.POOL_REDIS_PREFIX,
    logger: console
  });
  try {
    await persistence.restore(dataDir);
    const store = new Store(dataDir);
    const productStore = new ProductStore(dataDir);
    store.sqlite = persistence.attach('db.sqlite', store.sqlite, store.keyPath);
    productStore.sqlite = persistence.attach('pool.sqlite', productStore.sqlite, productStore.keyPath);
    await persistence.flush();
    const server = start(undefined, { dataDir, store, productStore });
    installRedisShutdown(server, persistence);
    return server;
  } catch (error) {
    await persistence.close().catch(() => {});
    throw error;
  }
}

function requirePoolDataDir(dataDir) {
  const resolved = resolve(dataDir);
  if (resolved === relaydeckDataDir) {
    throw new Error('POOL_DATA_DIR must not point to Relaydeck node/.data');
  }
  return resolved;
}

function installRedisShutdown(server, persistence) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void persistence.close().finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGHUP', stop);
  server.once('close', () => {
    if (!stopping) void persistence.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
  });
}

export async function refreshAllQuotas(store, { fetchImpl = globalThis.fetch } = {}) {
  return refreshAllUpstreamQuotas(store, {
    fetchImpl,
    shouldRefresh: (upstream) => upstream.type === 'codex'
  });
}

async function authRequest(req, res, url, { productStore, codexLoginManager, cookieSecure, onCodexCredentialsImported, logger }) {
  if (req.method === 'POST' && url.pathname === '/auth/codex/import') {
    const input = await body(req);
    if (typeof input.authJson !== 'string' || !input.authJson.trim()) {
      throw new HttpError(400, 'invalid_request', 'authJson is required');
    }
    let account;
    let upstream;
    try {
      ({ account, upstream } = codexLoginManager.importAuthJson(input.authJson));
    } catch (error) {
      if (error?.statusCode) throw error;
      throw new HttpError(400, 'invalid_request', String(error.message || 'Codex auth JSON could not be imported').slice(0, 300));
    }
    const session = productStore.createAccountSession(account.id);
    await refreshImportedCredentials(onCodexCredentialsImported, upstream.id, logger);
    setCookies(res, [
      cookie(COOKIE_NAMES.login, '', { httpOnly: true, secure: cookieSecure, maxAge: 0 }),
      cookie(COOKIE_NAMES.session, session.token, { httpOnly: true, secure: cookieSecure, maxAge: ACCOUNT_COOKIE_MAX_AGE_SECONDS }),
      cookie(COOKIE_NAMES.csrf, session.csrfToken, { secure: cookieSecure, maxAge: ACCOUNT_COOKIE_MAX_AGE_SECONDS })
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
      const accountId = productStore.accountIdForCompletedCodexLogin(token);
      if (!accountId) throw new HttpError(401, 'authentication_error', 'Codex login attempt has already been consumed');
      await Promise.all(productStore.listAccountUpstreamLinks(accountId)
        .map(({ upstreamId }) => refreshImportedCredentials(onCodexCredentialsImported, upstreamId, logger)));
      const completed = productStore.consumeCompletedCodexLogin(token);
      if (!completed) throw new HttpError(401, 'authentication_error', 'Codex login attempt has already been consumed');
      setCookies(res, [
        cookie(COOKIE_NAMES.login, '', { httpOnly: true, secure: cookieSecure, maxAge: 0 }),
        cookie(COOKIE_NAMES.session, completed.session.token, { httpOnly: true, secure: cookieSecure, maxAge: ACCOUNT_COOKIE_MAX_AGE_SECONDS }),
        cookie(COOKIE_NAMES.csrf, completed.session.csrfToken, { secure: cookieSecure, maxAge: ACCOUNT_COOKIE_MAX_AGE_SECONDS })
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

async function refreshImportedCredentials(refresh, upstreamId, logger) {
  try {
    await refresh(upstreamId);
  } catch (error) {
    logger?.warn?.(`Codex Share quota refresh failed for upstream ${upstreamId}: ${error?.code || error?.name || 'Error'}`);
  }
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
  if (req.method === 'GET' && resource === 'personal-key' && parts.length === 3) {
    sendJson(res, 200, { personalKey: productStore.personalKey(accountId, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'personal-key' && id === 'reveal' && parts.length === 4) {
    sendJson(res, 200, productStore.revealPersonalKey(accountId));
    return;
  }
  if (req.method === 'POST' && resource === 'personal-key' && id === 'rotate' && parts.length === 4) {
    sendJson(res, 200, productStore.rotatePersonalKey(accountId));
    return;
  }
  if (req.method === 'GET' && resource === 'personal-keys' && parts.length === 3) {
    sendJson(res, 200, { personalKeys: productStore.listPersonalKeys(accountId, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'personal-keys' && parts.length === 3) {
    sendJson(res, 201, productStore.createNamedPersonalKey(accountId, await body(req), store));
    return;
  }
  if (req.method === 'POST' && resource === 'upstreams' && id === 'aiswitch' && parts.length === 4) {
    const input = await body(req);
    const upstream = store.create({
      type: 'compass',
      quotaSource: 'aiswitch',
      projectId: input.projectId,
      projectKey: input.projectKey
    });
    try {
      const cappedUpstream = store.setCap(upstream.id, { capDollars: 1_000_000 });
      productStore.linkUpstream(accountId, upstream.id);
      const provider = productStore.setManualShareBudget(accountId, upstream.id, input, store);
      sendJson(res, 201, {
        upstream: {
          ...cappedUpstream,
          providerIssue: providerIssue(cappedUpstream),
          sharing: provider.sharing,
          commitment: provider.commitment
        }
      });
    } catch (error) {
      productStore.cleanupUpstream(upstream.id);
      store.remove(upstream.id);
      throw error;
    }
    return;
  }
  if (req.method === 'POST' && resource === 'personal-keys' && id && action === 'reveal') {
    sendJson(res, 200, productStore.revealNamedPersonalKey(accountId, id));
    return;
  }
  if (req.method === 'POST' && resource === 'personal-keys' && id && action === 'rotate') {
    sendJson(res, 200, productStore.rotateNamedPersonalKey(accountId, id));
    return;
  }
  if (req.method === 'POST' && resource === 'personal-keys' && id && action === 'revoke') {
    sendJson(res, 200, { personalKey: productStore.revokeNamedPersonalKey(accountId, id, store) });
    return;
  }
  if (req.method === 'GET' && resource === 'upstreams' && parts.length === 3) {
    const upstreams = productStore.listAccountUpstreamLinks(accountId)
      .flatMap(({ upstreamId, manualShareBudgetMicros }) => {
        const upstream = store.getPublic(upstreamId);
        if (!upstream) return [];
        const provider = productStore.providerSummary(accountId, upstreamId, store, { manualShareBudgetMicros });
        return [{
          ...upstream,
          name: upstream.email || upstream.name,
          providerIssue: providerIssue(upstream),
          sharing: provider.sharing,
          commitment: provider.commitment
        }];
      });
    sendJson(res, 200, { upstreams });
    return;
  }
  if (req.method === 'GET' && resource === 'upstreams' && id === 'credentials' && parts.length === 4) {
    const credentials = productStore.listAccountUpstreamLinks(accountId)
      .flatMap(({ upstreamId }) => {
        const upstream = store.get(upstreamId);
        return upstream ? [{
          id: upstream.id,
          name: upstream.email || upstream.name,
          credentials: exportUpstreamCredentials(upstream, store.credentials(upstream.id))
        }] : [];
      });
    sendJson(res, 200, { credentials });
    return;
  }
  if (req.method === 'POST' && resource === 'upstreams' && id && action === 'refresh-quota') {
    const upstream = store.get(id);
    if (!upstream || !productStore.accountOwnsUpstream(accountId, id)) {
      throw new HttpError(404, 'not_found', 'Not found');
    }
    if (upstream.quotaSource === 'aiswitch') {
      sendJson(res, 200, { upstream: store.getPublic(id), skipped: 'manual_share_budget' });
      return;
    }
    if (upstream.type !== 'codex') throw new HttpError(400, 'invalid_request', 'Only Codex accounts can refresh quota');
    sendJson(res, 200, { upstream: await refreshUpstreamQuota(store, id, { fetchImpl }) });
    return;
  }
  if (req.method === 'PUT' && resource === 'upstreams' && id && action === 'manual-budget') {
    sendJson(res, 200, { provider: productStore.setManualShareBudget(accountId, id, await body(req), store) });
    return;
  }
  if (req.method === 'POST' && resource === 'upstreams' && id && action === 'test-connection') {
    if (!productStore.accountOwnsUpstream(accountId, id)) {
      throw new HttpError(404, 'not_found', 'Not found');
    }
    sendJson(res, 200, {
      connection: await testUpstreamConnection({
        store,
        upstreamId: id,
        req,
        res,
        fetchImpl
      })
    });
    return;
  }
  if (req.method === 'GET' && resource === 'providers' && id && parts.length === 4) {
    sendJson(res, 200, { provider: productStore.providerSummary(accountId, id, store) });
    return;
  }
  if (req.method === 'POST' && resource === 'providers' && id && action === 'pause') {
    sendJson(res, 200, { provider: productStore.setProviderSharing(accountId, id, 'paused', store) });
    return;
  }
  if (req.method === 'POST' && resource === 'providers' && id && action === 'resume') {
    sendJson(res, 200, { provider: productStore.setProviderSharing(accountId, id, 'active', store) });
    return;
  }
  if (req.method === 'POST' && resource === 'providers' && id && action === 'revoke-all') {
    sendJson(res, 200, { provider: productStore.revokeProviderSharing(accountId, id, store) });
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
  if (req.method === 'POST' && resource === 'sessions' && action === 'test-connection') {
    const session = productStore.session(id, accountId, store);
    if (session.role !== 'consumer') throw new HttpError(404, 'not_found', 'Not found');
    const proxyAuth = productStore.shareSessionAccess(id);
    const denial = shareSessionDenial(proxyAuth);
    if (denial) throw new HttpError(409, denial.code, denial.message);
    if (session.providerIssue) {
      throw new HttpError(409, session.providerIssue.code, session.providerIssue.message);
    }
    sendJson(res, 200, {
      connection: await testUpstreamConnection({
        store,
        upstreamId: proxyAuth.upstreamId,
        req,
        res,
        fetchImpl,
        proxyAuth,
        sharingStore: productStore,
        allowUnavailableCandidate: false
      })
    });
    return;
  }
  if (req.method === 'GET' && resource === 'quota-requests' && parts.length === 3) {
    sendJson(res, 200, { quotaRequests: productStore.listQuotaRequests(accountId) });
    return;
  }
  if (req.method === 'POST' && resource === 'quota-requests' && parts.length === 3) {
    sendJson(res, 201, { quotaRequest: productStore.createQuotaRequest(accountId, await body(req)) });
    return;
  }
  if (req.method === 'POST' && resource === 'quota-requests' && id && action === 'cancel') {
    sendJson(res, 200, { quotaRequest: productStore.cancelQuotaRequest(accountId, id) });
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
  return readJsonObjectBody(req, ingress, { message: 'Request body must be a JSON object' });
}

async function body(req) {
  return jsonBody(req, {
    maxCompressedBodyBytes: 2 * 1024 * 1024,
    maxDecompressedBodyBytes: 2 * 1024 * 1024
  });
}

async function staticFile(req, res, pathname, ingress) {
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css', 'assets/codex-share.svg'].includes(filename)) {
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void startConfigured().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
