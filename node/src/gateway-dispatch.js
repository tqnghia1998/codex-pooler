import { handleCompatibilityRequest, isCompatibilityRoute, isUnsupportedV1Route } from './compatibility.js';
import { readJsonObjectBody, readRequestBody } from './http-ingress.js';
import {
  PROXY_ENDPOINTS,
  WEBSOCKET_ENDPOINTS,
  isAdditionalGatewayRoute,
  proxyModelsRequest,
  proxyRawRequest,
  proxyRequest
} from './proxy.js';

const JSON_RUNTIME_PATHS = new Set(['/v1/responses', '/v1/chat/completions', '/v1/messages', '/v1/messages/count_tokens']);

export function gatewayRequestKind(method, path) {
  if (method === 'GET' && path === '/v1/usage') return 'usage';
  if (method === 'GET' && ['/v1/models', '/backend-api/codex/models', '/backend-api/codex/v1/models'].includes(path)) return 'models';
  if (method === 'POST' && PROXY_ENDPOINTS.has(path)) return 'proxy';
  if (method === 'GET' && WEBSOCKET_ENDPOINTS.has(path)) return 'websocket';
  if (isCompatibilityRoute(method, path)) return 'compatibility';
  if (isAdditionalGatewayRoute(method, path)) return 'raw';
  if (isUnsupportedV1Route(method, path)) return 'unsupported';
  return null;
}

export async function dispatchGatewayRequest({
  kind,
  req,
  res,
  url,
  store,
  apiKey,
  fetchImpl,
  ingress,
  upstreamDeadlines,
  logger,
  codexHostHealth,
  modelCatalog,
  claudeConfig,
  codexOptions,
  sendJson,
  handleUsage
}) {
  if (kind === 'usage') {
    await handleUsage();
    return;
  }
  if (kind === 'unsupported') {
    sendJson(res, 404, {
      error: {
        type: 'invalid_request_error',
        code: 'unsupported_endpoint',
        message: 'Unsupported OpenAI /v1 endpoint',
        param: null
      }
    });
    return;
  }
  if (kind === 'websocket') {
    sendJson(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: 'websocket_upgrade_required',
        message: 'WebSocket upgrade required',
        param: null
      }
    });
    return;
  }
  if (kind === 'proxy') {
    await proxyRequest({
      req,
      res,
      path: url.pathname,
      payload: await readJsonObjectBody(req, ingress, { plainBadRequest: JSON_RUNTIME_PATHS.has(url.pathname) }),
      store,
      apiKey,
      fetchImpl,
      upstreamDeadlines,
      logger,
      codexHostHealth,
      claudeConfig,
      codexOptions
    });
    return;
  }
  if (kind === 'models') {
    await proxyModelsRequest({ req, res, path: url.pathname, store, apiKey, fetchImpl, upstreamDeadlines, codexHostHealth, claudeConfig });
    return;
  }
  if (kind === 'compatibility') {
    await handleCompatibilityRequest({
      req,
      res,
      path: url.pathname,
      body: ['GET', 'DELETE'].includes(req.method) ? Buffer.alloc(0) : await readRequestBody(req, ingress),
      store,
      fetchImpl,
      upstreamDeadlines,
      modelCatalog,
      codexHostHealth
    });
    return;
  }
  if (kind === 'raw') {
    await proxyRawRequest({
      req,
      res,
      path: url.pathname,
      body: ['GET', 'DELETE'].includes(req.method) ? Buffer.alloc(0) : await readRequestBody(req, ingress),
      store,
      apiKey,
      fetchImpl,
      upstreamDeadlines,
      logger,
      codexHostHealth
    });
  }
}
