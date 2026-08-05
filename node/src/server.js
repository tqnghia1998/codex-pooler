import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, notFound } from './store.js';
import { dollarsToMicros } from './domain.js';
import { refreshQuota } from './providers.js';
import { handleCompatibilityRequest, isCompatibilityRoute } from './compatibility.js';
import { HttpError, readRequestBody } from './http-ingress.js';
import { errorEnvelope } from './public-errors.js';
import { admissionPolicy, firewallAllowed, hostAllowed, localHost, originAllowed } from './admission.js';
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
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
export const AUTO_REFRESH_INTERVAL_MS = 60_000;
const QUOTA_REFRESH_CONCURRENCY = 3;

export function createApp({ store = new Store(), apiKey = process.env.CODEX_POOLER_API_KEY, fetchImpl = globalThis.fetch, compassGatewayToken = process.env.CODEX_POOLER_COMPASS_GATEWAY_TOKEN, ingress = {} } = {}) {
  store.configureApiKey(apiKey);
  const admission = admissionPolicy(ingress);
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
      if (url.pathname === '/healthz' || url.pathname === '/readyz') {
        sendJson(res, 200, { status: 'ok' });
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
        await proxyRequest({ req, res, path: url.pathname, payload: await jsonRuntimeBody(req, ingress, ['/v1/responses', '/v1/chat/completions', '/v1/messages'].includes(url.pathname)), store, apiKey, fetchImpl });
        return;
      }
      if (modelRoute) {
        await proxyModelsRequest({ req, res, path: url.pathname, store, apiKey, fetchImpl });
        return;
      }
      if (compatibilityRoute) {
        await handleCompatibilityRequest({ req, res, path: url.pathname, body: req.method === 'GET' || req.method === 'DELETE' ? Buffer.alloc(0) : await readRequestBody(req, ingress), store, fetchImpl });
        return;
      }
      if (rawProxyRoute) {
        await proxyRawRequest({ req, res, path: url.pathname, body: req.method === 'GET' || req.method === 'DELETE' ? Buffer.alloc(0) : await readRequestBody(req, ingress), store, apiKey, fetchImpl });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!localHost(req.headers.host) && !authenticateProxyRequest(req, store, apiKey)) {
          sendJson(res, 401, { error: { type: 'authentication_error', message: 'Invalid API key' } }, { 'www-authenticate': 'Bearer' });
          return;
        }
        await api(req, res, url, store, { fetchImpl, compassGatewayToken });
        return;
      }
      await staticFile(res, url.pathname);
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
      sendJson(res, failure.status, failure.body);
    }
  };
}

export function start(port = Number(process.env.PORT) || 3000, {
  store = new Store(),
  fetchImpl = globalThis.fetch,
  compassGatewayToken = process.env.CODEX_POOLER_COMPASS_GATEWAY_TOKEN,
  apiKey = process.env.CODEX_POOLER_API_KEY,
  pollIntervalMs = AUTO_REFRESH_INTERVAL_MS,
  host = process.env.CODEX_POOLER_BIND_HOST || '127.0.0.1',
  ingress = {}
} = {}) {
  if (!apiKey) throw new Error('CODEX_POOLER_API_KEY is required');
  const server = createHttpServer(createApp({ store, apiKey, fetchImpl, compassGatewayToken, ingress }));
  attachWebSocketProxy(server, { store, apiKey, fetchImpl, ingress });
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await refreshAllQuotas(store, { fetchImpl, compassGatewayToken });
    } finally {
      polling = false;
    }
  };
  void poll();
  const timer = setInterval(poll, pollIntervalMs);
  timer.unref?.();
  server.once('close', () => clearInterval(timer));
  server.listen(port, host, () => console.log(`codex-pooler-node listening on http://${host}:${server.address().port}`));
  return server;
}

export async function refreshAllQuotas(store, options = {}) {
  return mapConcurrent(store.list(), QUOTA_REFRESH_CONCURRENCY, async ({ id }) => {
    const upstream = store.get(id);
    if (!upstream) return;
    const credentials = store.credentials(id);
    const quota = await refreshQuota(upstream, credentials, {
      ...options,
      saveCredentials: (updated, accessTokenExpiresAt) => store.persistCredentials(id, updated, accessTokenExpiresAt)
    });
    store.setQuota(id, quota);
  });
}

async function api(req, res, url, store, options) {
  try {
    return await apiRequest(req, res, url, store, options);
  } catch (error) {
    if (error instanceof HttpError || error?.statusCode) throw error;
    throw new HttpError(400, 'invalid_request', error.message);
  }
}

async function apiRequest(req, res, url, store, { fetchImpl, compassGatewayToken }) {
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
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'upstreams') {
    const upstream = store.create(await body(req));
    sendJson(res, 201, { upstream });
    return;
  }
  if (!id || parts[1] !== 'upstreams') throw notFound();

  if (req.method === 'GET' && parts.length === 3) {
    const upstream = store.getPublic(id);
    if (!upstream) throw notFound();
    sendJson(res, 200, { upstream });
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
  if (req.method === 'POST' && action === 'refresh-quota' && parts.length === 4) {
    const upstream = store.get(id);
    if (!upstream) throw notFound();
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

async function staticFile(res, pathname) {
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css'].includes(filename)) {
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
