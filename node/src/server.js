import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, notFound } from './store.js';
import { dollarsToMicros, isAiswitchUpstream } from './domain.js';
import { codexRefreshFailureCode, codexRefreshFailureDetail, refreshProviderCredentials, refreshQuota } from './providers.js';
import { handleCompatibilityRequest, isCompatibilityRoute } from './compatibility.js';
import { HttpError, readRequestBody } from './http-ingress.js';
import { errorEnvelope } from './public-errors.js';
import { admissionPolicy, firewallAllowed, hostAllowed, localHost, originAllowed } from './admission.js';
import { modelCatalogForStore } from './codex-model-catalog.js';
import { CodexHostHealth, codexHostHealthForStore, codexHostHealthOptionsFromEnv } from './codex-host-health.js';
import { upstreamPacerForStore } from './upstream-pacer.js';
import { Readiness, readyReadiness } from './readiness.js';
import {
  PROXY_ENDPOINTS,
  WEBSOCKET_ENDPOINTS,
  attachWebSocketProxy,
  authenticateProxyRequest,
  isAdditionalGatewayRoute,
  proxyModelsRequest,
  proxyRawRequest,
  proxyRequest,
  validProxyApiKey
} from './proxy.js';

const publicDir = join(fileURLToPath(new URL('../public/', import.meta.url)));
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
export const AUTO_REFRESH_INTERVAL_MS = 60_000;
export const TOKEN_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const QUOTA_REFRESH_CONCURRENCY = 3;
const TOKEN_REFRESH_CONCURRENCY = 3;
const TOKEN_REFRESH_WINDOW_MS = 12 * 60 * 60 * 1_000;
const TOKEN_REFRESH_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const TOKEN_REFRESH_STALE_MS = 50_000;
const TOKEN_REFRESH_MAX_ATTEMPTS = 8;
const TOKEN_REFRESH_BATCH_SIZE = 100;

export function createApp({ store = new Store(), apiKey = process.env.CODEX_POOLER_API_KEY, fetchImpl = globalThis.fetch, compassGatewayToken = process.env.CODEX_POOLER_COMPASS_GATEWAY_TOKEN, onTokenRefreshFailure = () => {}, ingress = {}, upstreamDeadlines = {}, logger = console, codexHostHealth = codexHostHealthForStore(store), readiness = readyReadiness() } = {}) {
  store.configureApiKey(apiKey);
  const admission = admissionPolicy(ingress);
  const modelCatalog = modelCatalogForStore(store);
  const upstreamPacer = upstreamPacerForStore(store);
  return async function app(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!hostAllowed(req.headers.host, admission)) {
        sendJson(res, 403, { error: 'Invalid Host header' });
        return;
      }
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originAllowed(req.headers.origin, req.headers.host, admission)) {
        sendJson(res, 403, { error: 'Invalid Origin header' });
        return;
      }
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/readyz') {
        const state = readiness.status();
        sendJson(res, state.status === 'ready' ? 200 : 503, state, state.status === 'ready' ? {} : { 'retry-after': '1' });
        return;
      }
      const usageRoute = url.pathname === '/v1/usage' && req.method === 'GET';
      const modelRoute = req.method === 'GET' && ['/v1/models', '/backend-api/codex/models', '/backend-api/codex/v1/models'].includes(url.pathname);
      const jsonProxyRoute = PROXY_ENDPOINTS.has(url.pathname) && req.method === 'POST';
      const websocketOnlyRoute = WEBSOCKET_ENDPOINTS.has(url.pathname) && req.method === 'GET';
      const compatibilityRoute = isCompatibilityRoute(req.method, url.pathname);
      const rawProxyRoute = isAdditionalGatewayRoute(req.method, url.pathname);
      const unsupportedRoute = isUnsupportedV1Route(req.method, url.pathname);
      if (usageRoute || modelRoute || jsonProxyRoute || websocketOnlyRoute || compatibilityRoute || rawProxyRoute || unsupportedRoute) {
        if (!firewallAllowed(req, admission)) {
          sendJson(res, 403, { error: { type: 'invalid_request_error', code: 'access_denied', message: 'client IP is not allowed', param: null } });
          return;
        }
        const auth = authenticateProxyRequest(req, store, apiKey, { allowXApiKey: req.method === 'POST' && url.pathname === '/v1/messages' });
        if (!auth) {
          sendJson(res, 401, { error: { type: 'authentication_error', message: 'Invalid API key' } }, { 'www-authenticate': 'Bearer' });
          return;
        }
        req.proxyAuth = auth;
      }
      if (usageRoute) {
        const parameter = url.searchParams.keys().next().value;
        if (parameter) {
          sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'unsupported_parameter', message: `${parameter} is not supported`, param: parameter } });
          return;
        }
        sendJson(res, 200, store.gatewayUsage(requestScopeId(req), req.proxyAuth?.id || null));
        return;
      }
      if (unsupportedRoute) {
        sendJson(res, 404, { error: { type: 'invalid_request_error', code: 'unsupported_endpoint', message: 'Unsupported OpenAI /v1 endpoint', param: null } });
        return;
      }
      if (websocketOnlyRoute) {
        sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'websocket_upgrade_required', message: 'WebSocket upgrade required', param: null } });
        return;
      }
      if (jsonProxyRoute) {
        await proxyRequest({ req, res, path: url.pathname, payload: await jsonRuntimeBody(req, ingress, ['/v1/responses', '/v1/chat/completions', '/v1/messages'].includes(url.pathname)), store, apiKey, fetchImpl, upstreamDeadlines, logger, codexHostHealth });
        return;
      }
      if (modelRoute) {
        await proxyModelsRequest({ req, res, path: url.pathname, store, apiKey, fetchImpl, upstreamDeadlines, codexHostHealth });
        return;
      }
      if (compatibilityRoute) {
        await handleCompatibilityRequest({ req, res, path: url.pathname, body: req.method === 'GET' || req.method === 'DELETE' ? Buffer.alloc(0) : await readRequestBody(req, ingress), store, fetchImpl, upstreamDeadlines, modelCatalog, codexHostHealth });
        return;
      }
      if (rawProxyRoute) {
        await proxyRawRequest({ req, res, path: url.pathname, body: req.method === 'GET' || req.method === 'DELETE' ? Buffer.alloc(0) : await readRequestBody(req, ingress), store, apiKey, fetchImpl, upstreamDeadlines, logger, codexHostHealth });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!localHost(req.headers.host) && !authenticateProxyRequest(req, store, apiKey)) {
          sendJson(res, 401, { error: { type: 'authentication_error', message: 'Invalid API key' } }, { 'www-authenticate': 'Bearer' });
          return;
        }
        await api(req, res, url, store, { fetchImpl, compassGatewayToken, onTokenRefreshFailure, modelCatalog, codexHostHealth, upstreamPacer, readiness });
        return;
      }
      await staticFile(res, url.pathname, req, admission);
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
      const failure = errorEnvelope(error);
      sendJson(res, failure.status, failure.body, failure.headers);
    }
  };
}

export function start(port = Number(process.env.PORT) || 3000, {
  store = new Store(),
  fetchImpl = globalThis.fetch,
  compassGatewayToken = process.env.CODEX_POOLER_COMPASS_GATEWAY_TOKEN,
  apiKey = process.env.CODEX_POOLER_API_KEY,
  pollIntervalMs = AUTO_REFRESH_INTERVAL_MS,
  tokenRefreshIntervalMs = TOKEN_REFRESH_INTERVAL_MS,
  host = process.env.CODEX_POOLER_BIND_HOST || '127.0.0.1',
  ingress = {}
} = {}) {
  if (!apiKey) throw new Error('CODEX_POOLER_API_KEY is required');
  let scheduleTokenRetry = () => {};
  const readiness = new Readiness({ storage: 'ready', apiKey: 'ready' });
  const codexHostHealth = new CodexHostHealth(codexHostHealthOptionsFromEnv());
  const upstreamPacer = upstreamPacerForStore(store);
  const modelCatalog = modelCatalogForStore(store);
  const server = createHttpServer(createApp({ store, apiKey, fetchImpl, compassGatewayToken, onTokenRefreshFailure: (...args) => scheduleTokenRetry(...args), ingress, codexHostHealth, readiness }));
  attachWebSocketProxy(server, { store, apiKey, fetchImpl, ingress, codexHostHealth });
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      return await refreshAllQuotas(store, { fetchImpl, compassGatewayToken });
    } finally {
      polling = false;
    }
  };
  const initialQuotaRefresh = poll()
    .then((results) => readiness.set('quotaRefresh', results?.some(({ status }) => status === 'rejected') ? 'degraded' : 'ready'))
    .catch(() => readiness.set('quotaRefresh', 'degraded'));
  const timer = setInterval(poll, pollIntervalMs);
  timer.unref?.();
  const tokenScheduler = createTokenRefreshScheduler(store, { fetchImpl, compassGatewayToken });
  scheduleTokenRetry = tokenScheduler.schedule;
  store.setTokenRefreshFailureHandler?.(tokenScheduler.schedule);
  const initialTokenRecovery = tokenScheduler.run()
    .then((results) => readiness.set('tokenRecovery', results?.some(({ status }) => status === 'rejected') ? 'degraded' : 'ready'))
    .catch(() => readiness.set('tokenRecovery', 'degraded'));
  const initialModelDiscovery = modelCatalog.resolve('default', { fetchImpl, codexHostHealth })
    .then(({ status }) => readiness.set('modelCatalog', status.source === 'live' ? 'ready' : 'degraded'))
    .catch(() => readiness.set('modelCatalog', 'degraded'));
  void Promise.allSettled([initialQuotaRefresh, initialTokenRecovery, initialModelDiscovery]);
  const tokenTimer = setInterval(tokenScheduler.run, tokenRefreshIntervalMs);
  tokenTimer.unref?.();
  server.once('close', () => {
    clearInterval(timer);
    clearInterval(tokenTimer);
    store.setTokenRefreshFailureHandler?.(null);
    tokenScheduler.close();
    upstreamPacer.close();
  });
  server.listen(port, host, () => console.log(`codex-pooler-node listening on http://${host}:${server.address().port}`));
  return server;
}

export async function refreshAllQuotas(store, options = {}) {
  const results = await mapConcurrent(store.list(), QUOTA_REFRESH_CONCURRENCY, async ({ id }) => {
    const upstream = store.get(id);
    if (!upstream) return;
    const credentials = store.credentials(id);
    if (isAiswitchUpstream(upstream)) return { status: 'skipped', id, source: 'aiswitch' };
    const quota = await refreshQuota(upstream, credentials, {
      ...options,
      saveCredentials: (updated, accessTokenExpiresAt) => store.persistCredentials(id, updated, accessTokenExpiresAt)
    });
    store.setQuota(id, quota, { notify: false });
    return { status: 'refreshed', id };
  });
  if (results.some((result) => result.value?.status === 'refreshed')) store.notifyUpstreamsChange();
  return results;
}

export async function refreshDueCodexTokens(store, { now = Date.now(), ...options } = {}) {
  const candidates = store.list()
    .map(({ id }) => ({ id, eligibleAt: tokenRefreshEligibleAt(store.get(id), now) }))
    .filter(({ eligibleAt }) => eligibleAt !== null)
    .sort((left, right) => left.eligibleAt - right.eligibleAt || left.id.localeCompare(right.id))
    .slice(0, TOKEN_REFRESH_BATCH_SIZE);
  return mapConcurrent(candidates, TOKEN_REFRESH_CONCURRENCY, async ({ id }) => {
    const upstream = store.get(id);
    const credentials = store.credentials(id);
    if (!credentials.refreshToken) return store.setTokenRefresh(id, tokenRefreshState('reauth_required', 'scheduled', now));
    return refreshCodexToken(store, id, { trigger: 'scheduled', now, ...options });
  });
}

export async function refreshCodexToken(store, id, { trigger = 'manual', now = Date.now(), retryAttempt = null, ...options } = {}) {
  const upstream = store.get(id);
  if (!upstream) throw notFound();
  if (upstream.type !== 'codex') throw new HttpError(400, 'invalid_request', 'Token refresh is only available for Codex upstreams');
  const refreshing = upstream.tokenRefresh;
  if (refreshing?.status === 'reauth_required') return { upstream: store.getPublic(id), errorCode: 'reauth_required' };
  if (refreshing?.status === 'refreshing' && Date.parse(refreshing.startedAt) > now - TOKEN_REFRESH_STALE_MS) return { upstream: store.getPublic(id), errorCode: 'refresh_in_progress' };
  const credentials = store.credentials(id);
  if (!credentials.refreshToken) {
    return { upstream: store.setTokenRefresh(id, tokenRefreshState('reauth_required', trigger, now)), errorCode: 'reauth_required' };
  }
  store.setTokenRefresh(id, tokenRefreshState('refreshing', trigger, now));
  try {
    const refreshed = await refreshProviderCredentials(upstream, credentials, {
      ...options,
      saveCredentials: (updated, accessTokenExpiresAt) => store.persistCredentials(id, updated, accessTokenExpiresAt)
    });
    return refreshed ? { upstream: store.setTokenRefresh(id, tokenRefreshState('succeeded', trigger, now)) } : { upstream: store.getPublic(id) };
  } catch (error) {
    if ((Number(store.get(id)?.credentialEpoch) || 0) !== (Number(upstream.credentialEpoch) || 0)) return { upstream: store.getPublic(id) };
    const errorCode = codexRefreshFailureCode(error);
    return { upstream: store.setTokenRefresh(id, tokenRefreshState(errorCode, trigger, now, retryAttempt, codexRefreshFailureDetail(error))), errorCode };
  }
}

function tokenRefreshEligibleAt(upstream, now) {
  if (!upstream || upstream.type !== 'codex') return null;
  const refresh = upstream.tokenRefresh;
  if (refresh?.status === 'reauth_required') return null;
  if (refresh?.status === 'refreshing') {
    const startedAt = Date.parse(refresh.startedAt || upstream.updatedAt);
    return !Number.isFinite(startedAt) || startedAt <= now - TOKEN_REFRESH_STALE_MS ? Number.isFinite(startedAt) ? startedAt : now : null;
  }
  if (refresh?.status === 'failed') {
    const finishedAt = Date.parse(refresh.finishedAt || upstream.updatedAt);
    const eligibleAt = Number.isFinite(finishedAt) ? finishedAt + TOKEN_REFRESH_FAILURE_COOLDOWN_MS : now;
    return eligibleAt <= now ? eligibleAt : null;
  }
  const expiresAt = Date.parse(upstream.accessTokenExpiresAt);
  const eligibleAt = expiresAt - TOKEN_REFRESH_WINDOW_MS;
  return Number.isFinite(eligibleAt) && eligibleAt <= now ? eligibleAt : null;
}

function tokenRefreshState(status, trigger, now, retryAttempt = null, errorDetail = null) {
  const timestamp = new Date(now).toISOString();
  return status === 'refreshing'
    ? { status, startedAt: timestamp, trigger }
    : { status, finishedAt: timestamp, trigger, errorCode: status === 'succeeded' ? null : status, ...(errorDetail ? { errorDetail } : {}), ...(status === 'failed' && retryAttempt ? { retryAttempt } : {}) };
}

function createTokenRefreshScheduler(store, options) {
  const timers = new Map();
  const schedule = (id, trigger = 'scheduled', attempt = 1, retryAt = null) => {
    if (attempt >= TOKEN_REFRESH_MAX_ATTEMPTS) return;
    const upstream = store.get(id);
    if (!upstream || upstream.tokenRefresh?.status !== 'failed') return;
    const dueAt = retryAt || new Date(Date.now() + Math.min(2 ** attempt * 30_000, 3_600_000)).toISOString();
    const delay = Math.max(0, Date.parse(dueAt) - Date.now());
    clearTimeout(timers.get(id));
    store.setTokenRefresh(id, { ...upstream.tokenRefresh, trigger, retryAttempt: attempt, retryAt: dueAt });
    const timer = setTimeout(async () => {
      timers.delete(id);
      if (store.get(id)?.tokenRefresh?.status !== 'failed') return;
      try {
        const result = await refreshCodexToken(store, id, { ...options, trigger, retryAttempt: attempt + 1 });
        if (result.errorCode === 'failed') schedule(id, trigger, attempt + 1);
      } catch {}
    }, delay);
    timer.unref?.();
    timers.set(id, timer);
  };
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (const upstream of store.list()) {
        const refresh = store.get(upstream.id)?.tokenRefresh;
        if (refresh?.status === 'failed' && refresh.retryAttempt && refresh.retryAt) schedule(upstream.id, refresh.trigger, refresh.retryAttempt, refresh.retryAt);
      }
      const results = await refreshDueCodexTokens(store, options);
      for (const result of results) {
        const value = result.status === 'fulfilled' && result.value;
        if (value?.errorCode === 'failed') schedule(value.upstream.id, value.upstream.tokenRefresh.trigger, value.upstream.tokenRefresh.retryAttempt || 1);
      }
      return results;
    } finally {
      running = false;
    }
  };
  return { run, schedule, close: () => timers.forEach(clearTimeout) };
}

async function api(req, res, url, store, options) {
  try {
    return await apiRequest(req, res, url, store, options);
  } catch (error) {
    if (error instanceof HttpError || error?.statusCode) throw error;
    throw new HttpError(400, 'invalid_request', error.message);
  }
}

async function apiRequest(req, res, url, store, { fetchImpl, compassGatewayToken, onTokenRefreshFailure, modelCatalog, codexHostHealth, upstreamPacer, readiness }) {
  if (req.method === 'GET' && url.pathname === '/api/upstreams/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('event: ready\ndata: {"type":"upstreams"}\n\n');
    const unsubscribe = store.onUpstreamsChange(() => res.write('event: upstreams\ndata: {"type":"upstreams"}\n\n'));
    req.once('close', unsubscribe);
    return;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts[2];
  const action = parts[3];

  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'scopes') {
    sendJson(res, 201, { scope: store.createScope(await body(req)) });
    return;
  }
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'api-keys') {
    sendJson(res, 200, { apiKeys: store.listApiKeys() });
    return;
  }
  if (req.method === 'PATCH' && parts.length === 3 && parts[1] === 'scopes') {
    sendJson(res, 200, { scope: store.updateScope(id, await body(req)) });
    return;
  }
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'api-keys') {
    sendJson(res, 201, { apiKey: store.createApiKey(await body(req)) });
    return;
  }
  if (req.method === 'PATCH' && parts.length === 3 && parts[1] === 'api-keys') {
    sendJson(res, 200, { apiKey: store.updateApiKey(id, await body(req)) });
    return;
  }

  if (req.method === 'GET' && parts.length === 3 && parts[1] === 'upstreams' && parts[2] === 'eligibility') {
    const result = store.eligibility(url.searchParams.get('continuationId'));
    sendJson(res, result.error?.status || 200, result);
    return;
  }
  if (req.method === 'POST' && parts.length === 3 && parts[1] === 'spending-caps' && parts[2] === 'bulk') {
    sendJson(res, 200, store.bulkCaps(await body(req)));
    return;
  }
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'upstreams') {
    sendJson(res, 200, { upstreams: store.list() });
    return;
  }
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'model-catalog') {
    sendJson(res, 200, { catalog: modelCatalog.status(url.searchParams.get('scopeId') || 'default') });
    return;
  }
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'codex-host-health') {
    sendJson(res, 200, { hostHealth: codexHostHealth.status() });
    return;
  }
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'pacing') {
    sendJson(res, 200, { pacing: upstreamPacer.status() });
    return;
  }
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'diagnostics') {
    sendJson(res, 200, { readiness: readiness.status(), gateway: store.gatewayDiagnostics() });
    return;
  }
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'routing') {
    sendJson(res, 200, { policy: store.routingPolicy() });
    return;
  }
  if (req.method === 'PUT' && parts.length === 2 && parts[1] === 'routing') {
    sendJson(res, 200, { policy: store.setRoutingPolicy(await body(req)) });
    return;
  }
  if (req.method === 'POST' && parts.length === 3 && parts[1] === 'routing' && parts[2] === 'dry-run') {
    const input = routingDryRunInput(await body(req));
    sendJson(res, 200, {
      routing: store.routingDryRun({
        ...input,
        modelSupport: (upstreamId, model, generation) => modelCatalog.supports(upstreamId, model, generation)
      })
    });
    return;
  }
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'upstreams') {
    const upstream = store.create(await body(req));
    sendJson(res, 201, { upstream });
    return;
  }

  if (req.method === 'PUT' && parts.length === 3 && parts[1] === 'upstreams' && parts[2] === 'priority') {
    const payload = await body(req);
    sendJson(res, 200, { upstreams: store.setPriorityList(payload.ids) });
    return;
  }

  if (!id || parts[1] !== 'upstreams') throw notFound();

  if (req.method === 'GET' && parts.length === 3) {
    const upstream = store.getPublic(id);
    if (!upstream) throw notFound();
    sendJson(res, 200, { upstream });
    return;
  }
  if (req.method === 'GET' && action === 'credentials' && parts.length === 4) {
    const upstream = store.get(id);
    if (!upstream) throw notFound();
    const credentials = store.credentials(id);
    sendJson(res, 200, { credentials });
    return;
  }
  if (req.method === 'PATCH' && parts.length === 3) {
    sendJson(res, 200, { upstream: store.update(id, await body(req)) });
    return;
  }
  if (req.method === 'DELETE' && parts.length === 3) {
    store.remove(id);
    sendJson(res, 204, null);
    return;
  }
  if (req.method === 'POST' && action === 'refresh-token' && parts.length === 4) {
    const result = await refreshCodexToken(store, id, { fetchImpl, compassGatewayToken });
    if (result.errorCode === 'failed') onTokenRefreshFailure(id, 'manual');
    if (result.errorCode) {
      const status = result.errorCode === 'failed' ? 502 : 409;
      const message = result.errorCode === 'reauth_required' ? result.upstream.tokenRefresh?.errorDetail || 'Codex reauthentication is required' : result.errorCode === 'refresh_in_progress' ? 'Codex token refresh is already in progress' : 'Codex token refresh failed';
      throw new HttpError(status, `token_refresh_${result.errorCode}`, message);
    }
    sendJson(res, 200, result);
    return;
  }
  if (req.method === 'POST' && action === 'clear-cooldown' && parts.length === 4) {
    sendJson(res, 200, { upstream: store.clearUpstreamCooldown(id) });
    return;
  }
  if (req.method === 'POST' && action === 'refresh-quota' && parts.length === 4) {
    const upstream = store.get(id);
    if (!upstream) throw notFound();
    if (isAiswitchUpstream(upstream)) {
      sendJson(res, 200, { upstream: store.getPublic(id), skipped: 'aiswitch' });
      return;
    }
    const credentials = store.credentials(id);
    const quota = await refreshQuota(upstream, credentials, {
      fetchImpl,
      compassGatewayToken,
      saveCredentials: (updated, accessTokenExpiresAt) => store.persistCredentials(id, updated, accessTokenExpiresAt)
    });
    sendJson(res, 200, { upstream: store.setQuota(id, quota) });
    return;
  }
  if (req.method === 'PUT' && action === 'cap' && parts.length === 4) {
    sendJson(res, 200, { upstream: store.setCap(id, await body(req)) });
    return;
  }
  if (req.method === 'POST' && action === 'usage' && parts.length === 4) {
    const input = await body(req);
    if (input.settledCostMicros === undefined && input.costUsd !== undefined) input.settledCostMicros = dollarsToMicros(input.costUsd);
    sendJson(res, 200, store.addUsage(id, input));
    return;
  }
  if (req.method === 'GET' && action === 'spending' && parts.length === 4) {
    sendJson(res, 200, { spending: store.spending(id) });
    return;
  }
  throw notFound();
}

async function jsonRuntimeBody(req, ingress, plainBadRequest = false) {
  const bytes = await readRequestBody(req, ingress);
  if (!bytes.length) return {};
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    const error = new HttpError(400, 'invalid_request', 'request body must be JSON');
    error.plainBadRequest = plainBadRequest;
    throw error;
  }
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, 'request_too_large', 'request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'invalid_request', 'request body must be JSON');
  }
}

function routingDryRunInput(input = {}) {
  const string = (name, max = 200) => {
    if (input[name] === undefined || input[name] === null) return '';
    if (typeof input[name] !== 'string' || input[name].length > max) throw new Error(`${name} must be a string of at most ${max} characters`);
    return input[name];
  };
  const requirements = input.requirements === undefined ? {} : input.requirements;
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) throw new Error('requirements must be an object');
  const allowedRequirements = new Set(['responses', 'streaming', 'tools', 'imageInput', 'reasoning', 'serviceTier']);
  const unsupported = Object.keys(requirements).find((key) => !allowedRequirements.has(key));
  if (unsupported) throw new Error(`unsupported routing requirement ${unsupported}`);
  const normalizedRequirements = {};
  for (const name of ['responses', 'streaming', 'tools', 'imageInput', 'reasoning']) {
    if (requirements[name] !== undefined) {
      if (typeof requirements[name] !== 'boolean') throw new Error(`${name} must be a boolean`);
      normalizedRequirements[name] = requirements[name];
    }
  }
  if (requirements.serviceTier !== undefined) {
    if (typeof requirements.serviceTier !== 'string' || requirements.serviceTier.length > 80) throw new Error('serviceTier must be a string of at most 80 characters');
    normalizedRequirements.serviceTier = requirements.serviceTier;
  }
  const strategy = input.strategy === undefined ? null : string('strategy', 80);
  const requestedType = string('requestedType', 20);
  const preferredType = string('preferredType', 20);
  const requiredType = string('requiredType', 20);
  for (const [name, value] of Object.entries({ requestedType, preferredType, requiredType })) {
    if (value && !['codex', 'compass'].includes(value)) throw new Error(`${name} must be codex or compass`);
  }
  const now = input.now === undefined ? Date.now() : Number(input.now);
  if (!Number.isFinite(now) || now < 0) throw new Error('now must be a non-negative timestamp');
  return {
    strategy,
    affinityId: string('affinityId'),
    pinnedId: string('pinnedId'),
    requestedId: string('requestedId'),
    requestedType,
    preferredType,
    requiredType,
    rotateFromId: string('rotateFromId'),
    model: string('model'),
    routeClass: string('routeClass', 80) || 'proxy_http',
    scopeId: string('scopeId') || null,
    requirements: normalizedRequirements,
    now
  };
}

async function mapConcurrent(items, limit, mapper) {
  const results = Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
}

function isUnsupportedV1Route(method, path) {
  if (method === 'POST' && ['/v1/images/variations', '/v1/embeddings', '/v1/batches', '/v1/moderations', '/v1/fine_tuning/jobs'].includes(path)) return true;
  if ((method === 'GET' || method === 'DELETE') && /^\/v1\/responses\/[^/]+$/.test(path)) return true;
  return method === 'POST' && /^\/v1\/responses\/[^/]+\/cancel$/.test(path);
}

async function staticFile(res, pathname, req, admission) {
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css', 'assets/relaydeck.svg'].includes(filename)) {
    // Any other path is an unrecognized runtime-surface request (typo, probe, or a
    // backend-api route we don't implement), not a real static asset. Enforce the
    // firewall before the fixed 404 so a blocked client gets the same access_denied
    // it gets from every other runtime route, instead of silently learning nothing
    // is enforced here.
    if (!firewallAllowed(req, admission)) {
      sendJson(res, 403, { error: { type: 'invalid_request_error', code: 'access_denied', message: 'client IP is not allowed', param: null } });
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const content = await readFile(join(publicDir, filename));
  res.writeHead(200, { 'content-type': MIME_TYPES[filename.slice(filename.lastIndexOf('.'))] });
  res.end(content);
}

function requestScopeId(req) {
  return req.proxyAuth?.scopeId || 'default';
}

function sendJson(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  if (status === 204) return res.end();
  res.end(JSON.stringify(value));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start();
