import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { defaultBaseUrl } from './domain.js';
import { DEFAULT_SCOPE_ID } from './store.js';
import { captureCodexCookies, codexCookieHeaders } from './codex-cookies.js';
import { ensureProviderCredentials, refreshProviderCredentials } from './providers.js';
import { AdapterError, adaptChatRequest, adaptResponsesRequest, customToolNamespaces, lowerNonStrictFunctionTools } from './openai-adapters.js';
import { upstreamFailure } from './public-errors.js';
import { admissionPolicy, firewallAllowed, hostAllowed } from './admission.js';
import { extractUsage, mergeUsage, priceUsage } from './pricing.js';
import { createChatStreamState, createPublicResponsesState, decodeSseBlock, normalizeChatEvent, normalizePublicResponsesEvent, restoreCustomToolCallNamespaces, retryableFirstSseEvent, splitSseBlocks } from './openai-streaming.js';
import { fetchWithHeaderDeadline, readWithIdleDeadline } from './upstream-deadlines.js';

export const WEBSOCKET_ENDPOINTS = new Set(['/v1/responses', '/backend-api/codex/responses', '/backend-api/codex/v1/responses']);

export const PROXY_ENDPOINTS = new Set([
  '/v1/responses',
  '/v1/responses/compact',
  '/v1/chat/completions',
  '/v1/messages',
  '/backend-api/codex/responses',
  '/backend-api/codex/v1/responses',
  '/backend-api/codex/responses/compact',
  '/backend-api/codex/v1/responses/compact',
  '/backend-api/codex/v1/chat/completions'
]);
const CODEX_RESPONSES_PATH = '/backend-api/codex/responses';
const CODEX_COMPACT_PATH = '/backend-api/codex/responses/compact';
const COMPASS_PATHS = {
  '/v1/responses': '/responses',
  '/v1/chat/completions': '/chat/completions',
  '/v1/messages': '/messages'
};
const CODEX_HEADERS = {
  'user-agent': 'codex_cli_rs/0.146.1',
  originator: 'codex_cli_rs',
  version: '0.146.1'
};
const ANTHROPIC_HEADERS = ['anthropic-version', 'anthropic-beta'];
const BACKEND_METADATA_HEADERS = [
  'x-codex-turn-metadata',
  'x-codex-window-id',
  'x-codex-parent-thread-id',
  'x-codex-installation-id',
  'x-codex-turn-state',
  'x-openai-subagent'
];
const UNSUPPORTED_CODEX_RESPONSE_FIELDS = new Set(['max_output_tokens', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_p']);
const PROMPT_CACHE_BREAKPOINT_TYPES = new Set(['input_text', 'input_image', 'input_file']);
const MAX_STREAM_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_WEBSOCKET_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_ID_LENGTH = 200;
const SESSION_HEADERS = ['x-codex-window-id', 'x-codex-session-id', 'session-id', 'x-session-id', 'x-session-affinity', 'session_id', 'x-codex-conversation-id'];
const MODEL_CATALOG_TTL_MS = 60_000;
const MODEL_CATALOG_CONCURRENCY = 3;
const TERMINAL_EVENT_TYPE = Symbol('terminalEventType');
const modelCatalogCache = new WeakMap();
const modelCatalogLoads = new WeakMap();

export async function proxyRequest({ req, res, path, payload, store, apiKey = process.env.CODEX_POOLER_API_KEY, fetchImpl = globalThis.fetch, upstreamDeadlines = {}, logger = null }) {
  if (!validApiKey(req, apiKey)) {
    sendJson(res, 401, { error: { type: 'authentication_error', message: 'Invalid API key' } }, { 'www-authenticate': 'Bearer' });
    return;
  }
  const sessionId = sessionAffinity(req);
  const authScopeId = requestScopeId(req);
  const accounting = requestAccounting(req);
  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'invalid_session_id', message: `x-codex-session-id must be at most ${MAX_SESSION_ID_LENGTH} characters`, param: 'x-codex-session-id' } });
    return;
  }
  if (path === '/v1/responses/compact') {
    sendJson(res, 404, { error: { type: 'invalid_request_error', code: 'unsupported_endpoint', message: 'Unsupported OpenAI /v1 endpoint', param: null } });
    return;
  }
  const sourcePath = normalizeProxyPath(path);
  let codexPayload = payload;
  try {
    if (path === '/v1/responses') codexPayload = adaptResponsesRequest(payload);
    else if (sourcePath === '/v1/chat/completions') codexPayload = adaptChatRequest(payload);
  } catch (error) {
    if (!(error instanceof AdapterError)) throw error;
    sendJson(res, 400, { error: { message: error.message, type: 'invalid_request_error', code: error.code, param: error.param } });
    return;
  }
  const model = typeof payload?.model === 'string' ? payload.model.toLowerCase() : '';
  if (model && !store.modelAllowed(authScopeId, model)) {
    sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'invalid_model', message: `Model ${payload.model} is not available`, param: 'model' } });
    return;
  }
  const lifecycle = accounting.apiKeyId && (path === '/v1/responses' || path === '/v1/chat/completions')
    ? store.reserveGatewayRequest({ scopeId: authScopeId, apiKeyId: accounting.apiKeyId, endpoint: path, model, transport: payload?.stream === true ? 'http_sse' : 'http_json' })
    : null;
  const candidates = chooseUpstreams(store, req, sourcePath, payload, path);
  if (!candidates.length) {
    finalizeGatewayFailure(store, lifecycle, null, { errorCode: 'no_compatible_backend', responseStatusCode: 503 });
    return sendRoutingError(res, store, req, 'No compatible backend is available', 'no_compatible_backend');
  }
  const dispatched = await dispatchCandidates({ store, candidates, sourcePath, payload, req, res, path, codexPayload, fetchImpl, lifecycle, upstreamDeadlines, logger });
  if (!dispatched) {
    finalizeGatewayFailure(store, lifecycle, null, { errorCode: 'upstream_request_failed', responseStatusCode: 502 });
    return sendFailure(res);
  }
  const { upstream, attemptId, startedAt, response, collected: dispatchedCollection } = dispatched;
  if (sessionId && !store.sessionUpstream(sessionId, authScopeId, accounting.apiKeyId)) store.pinSession(sessionId, upstream.id, authScopeId, accounting.apiKeyId);
  const responseOptions = { relayTurnState: isBackendMetadataRoute(path) };
  const modelsEtag = isBackendResponsesRoute(path) ? cachedModelCatalog(store, authScopeId)?.etag || null : null;

  if (!response.ok) {
    const errorBytes = await readBoundedResponse(response);
    finalizeGatewayFailure(store, lifecycle, attemptId, { errorCode: 'upstream_response_failed', responseStatusCode: response.status });
    const validAnthropic = response.status >= 400 && response.status < 500 && upstream.type === 'compass' && sourcePath === '/v1/messages' && validAnthropicError(errorBytes);
    if (validAnthropic) writeResponse(res, response, errorBytes, responseOptions);
    else sendFailure(res);
    return;
  }
  const publicCodex = upstream.type === 'codex' && (path === '/v1/responses' || sourcePath === '/v1/chat/completions');
  if (publicCodex && payload.stream !== true) {
    const collected = dispatchedCollection;
    settleUsage(store, upstream, attemptId, startedAt, collected, payload, accounting, lifecycle, response.status);
    if (path === '/v1/responses') learnResponsePin(store, collected, upstream.id, authScopeId, accounting.apiKeyId);
    const output = sourcePath === '/v1/chat/completions' ? responsesToChat(collected, payload) : restoreCustomToolCallNamespaces({ object: 'response', ...collected }, customToolNamespaces(codexPayload.tools));
    sendJson(res, 200, output);
    return;
  }
  if (isEventStream(response) || upstream.type === 'codex' && payload.stream === true) {
    await streamResponse({
      response, res,
      transformChat: upstream.type === 'codex' && sourcePath === '/v1/chat/completions',
      sanitizePublicResponses: upstream.type === 'codex' && path === '/v1/responses',
      publicResponsesNamespaces: path === '/v1/responses' ? customToolNamespaces(codexPayload.tools) : undefined,
      store, upstream, attemptId, startedAt, payload, accounting, lifecycle,
      responseStatusCode: response.status,
      responseOptions: { ...responseOptions, modelsEtag },
      upstreamDeadlines,
      onSuccessfulTerminal: path === '/v1/responses' ? (terminalResponse) => learnResponsePin(store, terminalResponse, upstream.id, authScopeId, accounting.apiKeyId) : null,
      logger
    });
    return;
  }

  const bytes = await readResponseBytes(response, 16 * 1024 * 1024, upstreamDeadlines);
  let output = bytes;
  if (upstream.type === 'codex' && sourcePath === '/v1/chat/completions') {
    try {
      output = Buffer.from(JSON.stringify(responsesToChat(JSON.parse(bytes.toString('utf8')), payload)));
    } catch {
      // Preserve an unexpected successful upstream body rather than inventing an error.
    }
  }
  settleUsage(store, upstream, attemptId, startedAt, parseJson(bytes), payload, accounting, lifecycle, response.status);
  writeResponse(res, response, output, responseOptions);
}

function isBackendResponsesRoute(path) {
  return path === '/backend-api/codex/responses' || path === '/backend-api/codex/v1/responses';
}

function isBackendMetadataRoute(path) {
  return isBackendResponsesRoute(path) || path === '/backend-api/codex/responses/compact' || path === '/backend-api/codex/v1/responses/compact';
}

function normalizeProxyPath(path) {
  if (path === '/backend-api/codex/responses' || path === '/backend-api/codex/v1/responses') return '/v1/responses';
  if (path === '/backend-api/codex/responses/compact' || path === '/backend-api/codex/v1/responses/compact') return '/v1/responses/compact';
  if (path === '/backend-api/codex/v1/chat/completions') return '/v1/chat/completions';
  return path;
}

function chooseUpstreams(store, req, path, payload, originalPath = path) {
  const scopeId = requestScopeId(req);
  const sessionId = sessionAffinity(req);
  const pinnedId = store.sessionUpstream(sessionId, scopeId, requestAccounting(req).apiKeyId);
  const requestedId = header(req, 'x-upstream-id');
  const requestedType = header(req, 'x-upstream-type');
  const responsePinnedId = originalPath === '/v1/responses' ? store.responseUpstream(payload?.previous_response_id, scopeId, requestAccounting(req).apiKeyId) : null;
  const model = typeof payload?.model === 'string' ? payload.model.toLowerCase() : '';
  const nativeCodex = originalPath.startsWith('/backend-api/codex/');
  const preferredType = path === '/v1/messages' ? 'compass' : path === '/v1/responses/compact' || nativeCodex ? 'codex' : model.startsWith('claude-') ? 'compass' : 'codex';
  if (responsePinnedId && (requestedId && requestedId !== responsePinnedId || requestedType && store.get(responsePinnedId, scopeId)?.type !== requestedType)) return [];
  const candidates = store.candidatePlan({
    pinnedId: responsePinnedId,
    requestedId: responsePinnedId || requestedId, requestedType: responsePinnedId ? '' : requestedType, preferredType,
    requiredType: path === '/v1/messages' ? 'compass' : path === '/v1/responses/compact' || nativeCodex ? 'codex' : '',
    model,
    scopeId,
    requirements: requestRequirements(path, payload),
    routeClass: payload?.stream === true ? 'proxy_stream' : 'proxy_http'
  });
  return pinnedId ? [...candidates.filter((candidate) => candidate.id === pinnedId), ...candidates.filter((candidate) => candidate.id !== pinnedId)] : candidates;
}

async function dispatchCandidates({ store, candidates, sourcePath, payload, req, res, path, codexPayload, fetchImpl, lifecycle = null, upstreamDeadlines = {}, logger = null }) {
  const scope = { model: payload?.model, routeClass: payload?.stream === true ? 'proxy_stream' : 'proxy_http' };
  const scopeId = requestScopeId(req);
  for (const candidate of candidates) {
    const upstream = store.get(candidate.id, scopeId);
    if (!upstream || !store.beginCircuit(upstream.id, scope)) continue;
    const credentials = store.credentials(upstream.id);
    const startedAt = new Date().toISOString();
    const attempt = lifecycle ? store.beginGatewayAttempt(lifecycle.id, upstream.id, startedAt) : { id: randomUUID(), startedAt };
    const attemptId = attempt.id;
    let response;
    let collected;
    try {
      await ensureProviderCredentials(upstream, credentials, {
        fetchImpl,
        saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
      });
    } catch (error) {
      logProxyFailure(logger, 'credentials', upstream.id, error);
      store.releaseCircuit(upstream.id, scope);
      return { upstream, attemptId, startedAt, response: new Response(null, { status: 502 }) };
    }
    try {
      let request = buildRequest(upstream, sourcePath, payload, req, credentials, path, codexPayload);
      response = await requestUpstream(request, fetchImpl, { req, res }, upstreamDeadlines);
      persistResponseCookies(response, upstream, credentials, store);
      let authenticationRetried = false;
      if ((response.status === 401 || response.status === 403) && upstream.type === 'codex' && credentials.refreshToken) {
        try {
          await refreshProviderCredentials(upstream, credentials, {
            fetchImpl,
            saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
          });
          request = buildRequest(upstream, sourcePath, payload, req, credentials, path, codexPayload);
          response = await requestUpstream(request, fetchImpl, { req, res }, upstreamDeadlines);
          persistResponseCookies(response, upstream, credentials, store);
          authenticationRetried = true;
        } catch {
          store.releaseCircuit(upstream.id, scope);
          return { upstream, attemptId, startedAt, response };
        }
      }
      if (sourcePath === '/v1/responses/compact' && response.status === 400 && await unsupportedParameterResponse(response)) {
        request = { ...request, body: JSON.stringify(stripUnsupportedCodexFields(JSON.parse(request.body))) };
        response = await requestUpstream(request, fetchImpl, { req, res }, upstreamDeadlines);
        persistResponseCookies(response, upstream, credentials, store);
      }
      if (response.ok && isEventStream(response)) {
        const inspected = await inspectInitialSseEvent(response, upstreamDeadlines);
        response = inspected.response;
        if (sourcePath !== '/v1/responses/compact' && inspected.retryable) {
          void response.body?.cancel('Retrying a withheld first SSE event').catch(() => {});
          store.recordCircuitFailure(upstream.id, scope);
          retryGatewayAttempt(store, lifecycle, attemptId, { errorCode: 'upstream_first_event_failed', responseStatusCode: response.status });
          continue;
        }
      }
      if (authenticationRetried && (response.status === 401 || response.status === 403) && sourcePath !== '/v1/responses/compact') {
        await readBoundedResponse(response);
        store.recordCircuitFailure(upstream.id, scope);
        retryGatewayAttempt(store, lifecycle, attemptId, { errorCode: 'upstream_authentication_failed', responseStatusCode: response.status });
        continue;
      }
      const publicCodexCollection = response.ok && upstream.type === 'codex' && payload?.stream !== true && (path === '/v1/responses' || sourcePath === '/v1/chat/completions');
      if (publicCodexCollection) collected = await collectCodexResponse(response, upstreamDeadlines);
    } catch (error) {
      logProxyFailure(logger, 'dispatch', upstream.id, error);
      store.recordCircuitFailure(upstream.id, scope);
      retryGatewayAttempt(store, lifecycle, attemptId, { errorCode: 'upstream_transport_failed' });
      continue;
    }
    if (response.ok) {
      store.completeCircuit(upstream.id, scope, true);
      return { upstream, attemptId, startedAt, response, collected };
    }
    if (sourcePath !== '/v1/responses/compact' && await retryableUpstreamResponse(response, upstream)) {
      await readBoundedResponse(response);
      store.recordCircuitFailure(upstream.id, scope);
      retryGatewayAttempt(store, lifecycle, attemptId, { errorCode: 'upstream_retryable_response', responseStatusCode: response.status });
      continue;
    }
    store.releaseCircuit(upstream.id, scope);
    return { upstream, attemptId, startedAt, response };
  }
  return null;
}

async function retryableUpstreamResponse(response, upstream) {
  if (upstream.type === 'compass' && (response.status === 401 || response.status === 403)) return true;
  if (response.status === 429 || response.status >= 500) return true;
  if (![400, 404, 422].includes(response.status)) return false;
  const body = parseJson(await readBoundedResponse(response.clone()));
  const error = body?.error || body?.response?.error;
  return error?.code === 'model_not_found' || error?.type === 'model_not_found' || error?.type === 'invalid_request_error' && error?.param === 'model';
}

async function inspectInitialSseEvent(response, upstreamDeadlines = {}) {
  if (!response.body) return { response, retryable: true };
  const [probe, downstream] = response.body.tee();
  const reader = probe.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const finish = (result) => {
    void reader.cancel('Initial SSE event classified').catch(() => {});
    return result;
  };
  try {
    while (true) {
      const { done, value } = await readWithIdleDeadline(reader, upstreamDeadlines);
      if (done) return finish({ response: streamResponseClone(response, downstream), retryable: !hasSseData(buffer) });
      buffer += decoder.decode(value, { stream: true });
      const events = splitSseBlocks(buffer);
      buffer = events.pop() || '';
      if (Buffer.byteLength(buffer) > MAX_STREAM_BUFFER_BYTES) {
        void reader.cancel('Initial SSE event exceeded buffer limit').catch(() => {});
        void downstream.cancel('Initial SSE event exceeded buffer limit').catch(() => {});
        return { response: localSseFailure(response), retryable: false };
      }
      for (const event of events) {
        if (!hasSseData(event)) continue;
        const parsed = eventData(event);
        if (parsed) return finish({ response: streamResponseClone(response, downstream), retryable: retryableSseFailure(parsed) });
        if (event.includes('data: [DONE]')) return finish({ response: streamResponseClone(response, downstream), retryable: false });
        return finish({ response: streamResponseClone(response, downstream), retryable: false });
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function streamResponseClone(response, body) {
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function localSseFailure(response) {
  return new Response('event: error\ndata: {"type":"error","error":{"type":"server_error","code":"server_error","message":"Upstream stream event exceeded limit"}}\n\n', {
    status: response.status,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function retryableSseFailure(event) {
  if (!['response.failed', 'error'].includes(event?.type)) return false;
  if (retryableFirstSseEvent(event)) return true;
  const error = event.error || event.response?.error || {};
  return event.status === 429 || event.status_code === 429 || error.code === 'rate_limit_exceeded' || error.code === 'model_not_found' || error.type === 'model_not_found' || error.type === 'invalid_request_error' && error.param === 'model';
}

function buildRequest(upstream, sourcePath, payload, req, credentials, originalPath, codexPayload = payload) {
  const direct = upstream.type === 'compass';
  const targetPath = direct
    ? COMPASS_PATHS[sourcePath]
    : sourcePath === '/v1/responses/compact' ? CODEX_COMPACT_PATH : CODEX_RESPONSES_PATH;
  const normalizedBody = direct
    ? directUpstreamPayload(payload, sourcePath)
    : sourcePath === '/v1/chat/completions'
      ? normalizeCodexInput({ ...codexPayload, store: false, stream: true }, { native: isBackendMetadataRoute(originalPath) })
      : originalPath === '/v1/responses'
        ? publicResponsesPayload(codexPayload)
        : sourcePath === '/v1/responses/compact'
          ? normalizeCodexInput(payload, { compact: true, native: isBackendMetadataRoute(originalPath) })
          : normalizeCodexInput(payload, { native: isBackendMetadataRoute(originalPath) });
  const body = !direct && sourcePath !== '/v1/responses/compact' ? stripUnsupportedCodexFields(normalizedBody) : normalizedBody;
  const baseUrl = defaultBaseUrl(upstream.type);
  const headers = {
    'content-type': 'application/json',
    accept: body.stream ? 'text/event-stream' : 'application/json',
    authorization: `Bearer ${credentials.accessToken || credentials.projectKey}`
  };
  if (!direct) Object.assign(headers, CODEX_HEADERS, codexCookieHeaders(credentials), upstream.accountId ? { 'chatgpt-account-id': upstream.accountId } : {});
  const forwarded = direct && sourcePath === '/v1/messages'
    ? ANTHROPIC_HEADERS
    : !direct && isBackendMetadataRoute(originalPath) && sourcePath !== '/v1/chat/completions'
      ? BACKEND_METADATA_HEADERS
      : [];
  for (const name of forwarded) {
    const value = req.headers[name];
    if (typeof value === 'string' && value) headers[name] = projectMetadataHeader(name, value);
  }
  return { url: `${baseUrl}${targetPath}`, headers, body: JSON.stringify(body) };
}

async function requestUpstream(request, fetchImpl, downstream = null, upstreamDeadlines = {}) {
  const abort = downstream ? downstreamAbortSignal(downstream.req, downstream.res) : null;
  try {
    return await fetchWithHeaderDeadline(fetchImpl, request.url, {
      method: request.method || 'POST',
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: abort?.signal
    }, upstreamDeadlines);
  } catch (error) {
    const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError';
    const wrapped = new Error(timedOut ? 'Upstream request timed out' : 'Upstream request failed');
    wrapped.statusCode = 502;
    throw wrapped;
  } finally {
    abort?.cleanup();
  }
}

function downstreamAbortSignal(req, res, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Upstream request timed out', 'TimeoutError')), timeoutMs);
  const abort = () => controller.abort(new DOMException('Downstream request closed', 'AbortError'));
  req?.once('aborted', abort);
  res?.once('close', abort);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      req?.removeListener('aborted', abort);
      res?.removeListener('close', abort);
    }
  };
}

async function unsupportedParameterResponse(response) {
  try { return (await response.clone().text()).includes('Unsupported parameter'); } catch { return false; }
}

function stripUnsupportedCodexFields(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !UNSUPPORTED_CODEX_RESPONSE_FIELDS.has(key)));
}

function directUpstreamPayload(payload, sourcePath) {
  if (sourcePath !== '/v1/messages' || payload?.thinking?.type !== 'enabled' || !requiresAdaptiveThinking(payload.model)) return payload;
  const thinking = { ...payload.thinking, type: 'adaptive' };
  delete thinking.budget_tokens;
  return { ...payload, thinking };
}

function requiresAdaptiveThinking(model) {
  if (typeof model !== 'string') return false;
  const match = /^claude-[a-z]+-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] || 0);
  return major > 4 || major === 4 && minor >= 7;
}

function normalizeCodexInput(payload, { compact = false, native = false } = {}) {
  const normalized = normalizeReasoningAliases(payload);
  if (!native && typeof normalized.input === 'string') {
    normalized.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: normalized.input }] }];
  }
  if (native) normalizeNativeCodexInput(normalized);
  if (typeof normalized.service_tier === 'string') {
    const tier = normalized.service_tier.trim().toLowerCase();
    if (tier === 'fast') normalized.service_tier = 'priority';
    else if (tier === 'auto' || tier === 'default') delete normalized.service_tier;
  }
  const reasoning = plainObject(normalized.reasoning) ? { ...normalized.reasoning } : {};
  if (typeof reasoning.effort === 'string') {
    const effort = reasoning.effort.trim().toLowerCase();
    if (effort === 'minimal') reasoning.effort = 'low';
    else if (effort === 'ultra') reasoning.effort = 'max';
  }
  if (!compact || Object.keys(reasoning).length) normalized.reasoning = reasoning;
  else delete normalized.reasoning;
  if (!compact) {
    delete normalized.type;
    delete normalized.generate;
    if (!Object.hasOwn(normalized, 'instructions')) normalized.instructions = '';
    const include = Array.isArray(normalized.include) ? normalized.include : [];
    let foundEncrypted = false;
    normalized.include = include.filter((entry) => {
      if (entry !== 'reasoning.encrypted_content') return true;
      if (foundEncrypted) return false;
      foundEncrypted = true;
      return true;
    });
    if (!foundEncrypted) normalized.include.push('reasoning.encrypted_content');
  }
  return stripPromptCacheControls(normalized);
}

// Codex's backend doesn't support these OpenAI Responses cache-control knobs;
// drop them before egress while leaving prompt_cache_key intact.
function stripPromptCacheControls(payload) {
  const { prompt_cache_options, ...rest } = payload;
  return stripPromptCacheBreakpoints(rest);
}

function stripPromptCacheBreakpoints(value) {
  if (Array.isArray(value)) return value.map(stripPromptCacheBreakpoints);
  if (!plainObject(value)) return value;
  const removeHere = PROMPT_CACHE_BREAKPOINT_TYPES.has(value.type) && Object.hasOwn(value, 'prompt_cache_breakpoint');
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (removeHere && key === 'prompt_cache_breakpoint') continue;
    out[key] = stripPromptCacheBreakpoints(nested);
  }
  return out;
}

function normalizeNativeCodexInput(payload) {
  if (Array.isArray(payload.input)) {
    payload.input = payload.input
      .filter((item) => !(plainObject(item) && item.content === null && Object.hasOwn(item, 'encrypted_content')))
      .map(cleanNativeInputItem);
  }
  if (!nativeToolResultContinuation(payload)) delete payload.previous_response_id;
  payload.tools = removeEncryptedSchemaMarkers(lowerNonStrictFunctionTools(payload.tools));
}

function nativeToolResultContinuation(payload) {
  return typeof payload.previous_response_id === 'string' && Array.isArray(payload.input) && payload.input.some((item) => plainObject(item) && ['function_call_output', 'computer_call_output', 'custom_tool_call_output'].includes(item.type));
}

function cleanNativeInputItem(item) {
  if (!plainObject(item) || item.type === 'compaction' || item.type === 'item_reference' || !Object.hasOwn(item, 'id')) return item;
  const id = item.id;
  return typeof id === 'string' && /^[^_]+_.+$/.test(id) ? item : Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'id'));
}

function removeEncryptedSchemaMarkers(value) {
  if (Array.isArray(value)) return value.map(removeEncryptedSchemaMarkers);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'encrypted_content' && key !== 'encrypted_content_marker')
    .map(([key, child]) => [key, removeEncryptedSchemaMarkers(child)]));
}

function normalizeReasoningAliases(payload) {
  const normalized = { ...payload };
  const canonicalEffort = extractNativeReasoningEffort(payload);
  const effortAlias = popFirst(normalized, ['reasoning_effort', 'reasoningEffort']);
  const summaryAlias = popFirst(normalized, ['reasoning_summary', 'reasoningSummary']);
  const thinking = normalized.thinking;
  const enableThinking = normalized.enable_thinking;
  delete normalized.thinking;
  delete normalized.enable_thinking;

  const reasoning = plainObject(normalized.reasoning) ? { ...normalized.reasoning } : {};
  putMissingCleanString(reasoning, 'effort', effortAlias);
  putMissingCleanString(reasoning, 'summary', summaryAlias);
  const thinkingReasoning = normalizeThinkingAlias(thinking, enableThinking);
  if (thinkingReasoning) {
    for (const [key, value] of Object.entries(thinkingReasoning)) {
      if (!Object.hasOwn(reasoning, key)) reasoning[key] = value;
    }
  }
  if (canonicalEffort === null) delete reasoning.effort;
  else reasoning.effort = canonicalEffort;
  if (Object.keys(reasoning).length) normalized.reasoning = reasoning;
  else delete normalized.reasoning;
  return normalized;
}

function extractNativeReasoningEffort(payload) {
  if (plainObject(payload.reasoning) && Object.hasOwn(payload.reasoning, 'effort')) return cleanString(payload.reasoning.effort);
  for (const key of ['reasoning_effort', 'reasoningEffort']) {
    if (Object.hasOwn(payload, key)) return cleanString(payload[key]);
  }
  if (Object.hasOwn(payload, 'thinking')) return extractThinkingEffort(payload.thinking);
  if (Object.hasOwn(payload, 'enable_thinking')) return payload.enable_thinking === true ? 'medium' : null;
  return null;
}

function extractThinkingEffort(thinking) {
  if (typeof thinking === 'boolean') return thinking ? 'medium' : null;
  if (typeof thinking === 'string') {
    const value = thinking.trim().toLowerCase();
    if (['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) return value;
    return ['enabled', 'true', 'on'].includes(value) ? 'medium' : null;
  }
  if (plainObject(thinking)) {
    const effort = cleanString(thinking.effort);
    if (effort !== null) return effort.toLowerCase();
    if (typeof thinking.type === 'string' && thinking.type.trim().toLowerCase() === 'enabled') return 'medium';
    if (thinking.enabled === true) return 'medium';
  }
  return null;
}

function normalizeThinkingAlias(thinking, enableThinking) {
  if (typeof thinking === 'boolean') return thinking ? { effort: 'medium' } : null;
  if (typeof thinking === 'string') {
    const value = thinking.trim().toLowerCase();
    if (['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) return { effort: value };
    if (['enabled', 'true', 'on'].includes(value)) return { effort: 'medium' };
    return null;
  }
  if (plainObject(thinking)) {
    const result = {};
    putMissingCleanString(result, 'effort', thinking.effort, true);
    putMissingCleanString(result, 'summary', thinking.summary);
    if (Object.keys(result).length) return result;
    if (typeof thinking.type === 'string') return thinking.type.trim().toLowerCase() === 'enabled' ? { effort: 'medium' } : null;
    if (typeof thinking.enabled === 'boolean') return thinking.enabled ? { effort: 'medium' } : null;
  }
  return enableThinking === true ? { effort: 'medium' } : null;
}

function popFirst(object, keys) {
  let value = null;
  for (const key of keys) {
    if (value === null && Object.hasOwn(object, key) && object[key] !== null && object[key] !== undefined) value = object[key];
    delete object[key];
  }
  return value;
}

function putMissingCleanString(object, key, value, lowercase = false) {
  if (Object.hasOwn(object, key)) return;
  const cleaned = cleanString(value);
  if (cleaned !== null) object[key] = lowercase ? cleaned.toLowerCase() : cleaned;
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function publicResponsesPayload(payload) {
  return normalizeCodexInput({ ...payload, store: false, stream: true });
}

function projectMetadataHeader(name, value) {
  if (name !== 'x-codex-turn-metadata') return value;
  try {
    const metadata = JSON.parse(value);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !Object.hasOwn(metadata, 'code_mode_tool_names')) return value;
    delete metadata.code_mode_tool_names;
    return JSON.stringify(metadata);
  } catch {
    return value;
  }
}

function responsesToChat(response, chatPayload = {}) {
  const output = Array.isArray(response.output) ? response.output : [];
  const text = typeof response.output_text === 'string'
    ? response.output_text
    : output.flatMap((item) => item?.content || (typeof item?.text === 'string' ? [{ text: item.text }] : [])).map((item) => typeof item?.text === 'string' ? item.text : '').join('');
  const calls = output.filter((item) => item?.type === 'function_call').map((item) => ({
    id: item.call_id || item.id,
    type: 'function',
    function: { name: typeof item.name === 'string' ? item.name : 'tool', arguments: typeof item.arguments === 'string' ? item.arguments : '' }
  }));
  const usage = response.usage;
  const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens;
  const completionTokens = usage?.completion_tokens ?? usage?.output_tokens;
  const incomplete = response.status === 'incomplete' || response[TERMINAL_EVENT_TYPE] === 'response.incomplete';
  const finishReason = incomplete
    ? ['content_filter', 'content-filter'].includes(response.incomplete_details?.reason) ? 'content_filter' : 'length'
    : calls.length ? 'tool_calls' : 'stop';
  return {
    id: response.id || `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Number.isInteger(response.created) ? response.created : Number.isInteger(response.created_at) ? response.created_at : Math.floor(Date.now() / 1000),
    model: typeof response.model === 'string' ? response.model : typeof chatPayload.model === 'string' ? chatPayload.model : 'unknown',
    choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finishReason }],
    ...(usage ? { usage: Object.fromEntries(Object.entries({
      prompt_tokens: promptTokens,
      prompt_tokens_details: usage.prompt_tokens_details,
      completion_tokens: completionTokens,
      total_tokens: usage.total_tokens ?? (Number.isInteger(promptTokens) && Number.isInteger(completionTokens) ? promptTokens + completionTokens : undefined)
    }).filter(([, value]) => value !== undefined)) } : {}),
    ...(typeof response.service_tier === 'string' ? { service_tier: response.service_tier } : {})
  };
}

async function collectCodexResponse(response, upstreamDeadlines = {}) {
  const bytes = await readResponseBytes(response, 16 * 1024 * 1024, upstreamDeadlines);
  const collected = collectEventStreamText(bytes.toString('utf8')) || parseJson(bytes);
  const validJsonResponse = collected && typeof collected === 'object' && !Array.isArray(collected) && typeof collected.id === 'string' && !collected.error;
  if (!validJsonResponse || collected.status === 'failed' || collected[TERMINAL_EVENT_TYPE] === 'response.failed') throw new Error('Invalid upstream response terminal');
  return collected;
}

function collectEventStreamText(text) {
  const events = splitSseBlocks(text).map(eventData).filter(Boolean);
  const terminal = events.findLast((event) => event?.response && ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type));
  if (!terminal) return null;
  const response = { ...terminal.response };
  Object.defineProperty(response, TERMINAL_EVENT_TYPE, { value: terminal.type });
  if (!Array.isArray(response.output) || response.output.length === 0) {
    const items = events.filter((event) => event.type === 'response.output_item.done' && event.item).map((event) => event.item);
    if (items.length) response.output = items;
    else {
      const deltas = events.filter((event) => event.type === 'response.output_text.delta' && typeof event.delta === 'string').map((event) => event.delta);
      const done = events.filter((event) => event.type === 'response.output_text.done' && typeof event.text === 'string').map((event) => event.text);
      const outputText = (deltas.length ? deltas : done).join('');
      if (outputText) response.output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: outputText }] }];
    }
  }
  return response;
}

async function streamResponse({ response, res, transformChat, sanitizePublicResponses, publicResponsesNamespaces, store, upstream, attemptId, startedAt, payload, accounting, lifecycle = null, responseStatusCode = null, responseOptions = {}, upstreamDeadlines = {}, onSuccessfulTerminal = null, logger = null }) {
  const headers = responseHeaders(response, transformChat || sanitizePublicResponses ? 'text/event-stream' : null, responseOptions);
  res.writeHead(response.status, headers);
  const reader = response.body?.getReader();
  if (!reader) return res.end();
  let downstreamClosed = false;
  let visible = false;
  let terminal = false;
  let completed = false;
  let usage;
  let buffer = '';
  const decoder = new TextDecoder();
  const publicState = sanitizePublicResponses ? createPublicResponsesState(publicResponsesNamespaces) : null;
  // Synthetic terminals continue the stream's own sequence so a client never sees it restart.
  const nextPublicSequence = () => publicState ? (publicState.sequence = Math.min(Number.MAX_SAFE_INTEGER, publicState.sequence + 1)) : 0;
  const chatState = transformChat ? createChatStreamState(payload) : null;
  res.once('close', () => {
    if (!res.writableEnded) downstreamClosed = true;
    void reader.cancel('Downstream closed').catch(() => {});
  });
  const relayEvent = async (event) => {
    if (terminal || downstreamClosed) return;
    const decoded = decodeSseBlock(event);
    const parsed = decoded.kind === 'event' ? decoded.event : null;
    if (!parsed) {
      if (!hasSseData(event)) return;
      if (event.includes('data: [DONE]')) {
        terminal = true;
        completed = true;
        void reader.cancel('Upstream terminal event').catch(() => {});
        if (sanitizePublicResponses) await writeChunk(res, `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' }, sequence_number: nextPublicSequence() })}\n\n`);
        else if (!transformChat) await writeChunk(res, `${event}\n\n`);
      } else if (sanitizePublicResponses || transformChat) {
        terminal = true;
        if (transformChat) await writeChunk(res, chatStreamFailure());
        else await writeChunk(res, publicStreamFailure(nextPublicSequence()));
      } else {
        await writeChunk(res, `${event}\n\n`);
      }
      return;
    }
    usage = mergeUsage(usage, extractUsage(parsed));
    const successfulTerminal = (parsed.type === 'response.completed' || parsed.type === 'response.incomplete') && parsed.response?.status !== 'failed' && !parsed.error && !parsed.response?.error;
    if (successfulTerminal) onSuccessfulTerminal?.(parsed.response);
    if (transformChat) {
      for (const chunk of normalizeChatEvent(parsed, chatState)) await writeChunk(res, chunk === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(chunk)}\n\n`);
      visible ||= chatState.visible;
      terminal ||= chatState.terminal;
      completed ||= successfulTerminal;
      return;
    }
    if (sanitizePublicResponses) {
      for (const chunk of normalizePublicResponsesEvent(parsed, publicState)) await writeChunk(res, chunk);
      visible ||= publicState.visible;
      terminal ||= publicState.terminal;
      completed ||= successfulTerminal;
      return;
    }
    const type = parsed.type;
    if (type === 'response.failed' || type === 'error') {
      terminal = true;
      if (transformChat) await writeChunk(res, chatStreamFailure('upstream_response_failed', 'Upstream response failed'));
      else if (sanitizePublicResponses) await writeChunk(res, publicStreamFailure(nextPublicSequence()));
      else await writeChunk(res, `${event}\n\n`);
      void reader.cancel('Upstream terminal event').catch(() => {});
      return;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      terminal = true;
      completed = true;
      void reader.cancel('Upstream terminal event').catch(() => {});
    }
    if (parsed) visible = true;
    await writeChunk(res, `${event}\n\n`);
  };
  try {
    while (!downstreamClosed && !terminal) {
      const { done, value } = await readWithIdleDeadline(reader, upstreamDeadlines);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer) > MAX_STREAM_BUFFER_BYTES) throw new Error('SSE event exceeded buffer limit');
      const events = splitSseBlocks(buffer);
      buffer = events.pop() || '';
      for (const event of events) await relayEvent(event);
    }
    buffer += decoder.decode();
    if (buffer.trim() && !terminal) await relayEvent(buffer);
    if (!downstreamClosed && visible && !terminal) {
      terminal = true;
      if (transformChat) await writeChunk(res, chatStreamFailure());
      else if (sanitizePublicResponses) await writeChunk(res, publicStreamFailure(nextPublicSequence()));
    }
    if (transformChat && completed && !downstreamClosed) await writeChunk(res, 'data: [DONE]\n\n');
  } catch (error) {
    logProxyFailure(logger, 'stream', upstream.id, error);
    if (!downstreamClosed && visible && !terminal) {
      terminal = true;
      if (transformChat) await writeChunk(res, chatStreamFailure());
      else if (sanitizePublicResponses) await writeChunk(res, publicStreamFailure(nextPublicSequence()));
    }
  } finally {
    reader.releaseLock();
    if (!res.writableEnded && !res.destroyed) res.end();
    if (completed) settleUsage(store, upstream, attemptId, startedAt, usage, payload, accounting, lifecycle, responseStatusCode);
    else if (lifecycle) finalizeGatewayFailure(store, lifecycle, attemptId, { errorCode: downstreamClosed ? 'downstream_closed' : 'upstream_stream_failed', responseStatusCode });
    else if (response.ok && usage) settleUsage(store, upstream, attemptId, startedAt, usage, payload, accounting);
  }
}

function publicStreamFailure(sequenceNumber = 0) {
  return `event: error\ndata: ${JSON.stringify({ type: 'error', sequence_number: sequenceNumber, code: 'server_error', message: 'upstream request failed: stream interrupted before terminal response event', param: null, error: { type: 'server_error', code: 'server_error', message: 'upstream request failed: stream interrupted before terminal response event', param: null } })}\n\n`;
}

function chatStreamFailure(code = 'server_error', message = 'upstream request failed: stream interrupted before terminal response event') {
  return `data: ${JSON.stringify({ error: { type: 'server_error', code, message, param: null } })}\n\n`;
}

function hasSseData(event) {
  return event.split(/\r?\n/).some((line) => line.startsWith('data:'));
}

function eventData(event) {
  const decoded = decodeSseBlock(event);
  return decoded.kind === 'event' ? decoded.event : null;
}

function logProxyFailure(logger, stage, upstreamId, error) {
  logger?.warn?.(`proxy ${stage} failed for upstream ${upstreamId}: ${error?.name || 'Error'}`);
}

function settleUsage(store, upstream, attemptId, startedAt, body, payload = {}, accounting = {}, lifecycle = null, responseStatusCode = null) {
  const usage = body?.inputTokens !== undefined || body?.upstreamCostMicros !== undefined ? body : extractUsage(body);
  const settlement = usage?.upstreamCostMicros === undefined
    ? priceUsage([body?.model, body?.response?.model, payload?.model], usage, startedAt, payload?.service_tier)
    : { settledCostMicros: usage.upstreamCostMicros, costSource: 'upstream_reported' };
  try {
    if (lifecycle) {
      store.finalizeGatewayRequest({ requestId: lifecycle.id, attemptId, status: 'succeeded', responseStatusCode, usage, settledCostMicros: settlement?.settledCostMicros ?? null, costSource: settlement?.costSource ?? null });
      return;
    }
    store.recordGatewayUsage({ ...accounting, attemptId, startedAt, usage, settledCostMicros: settlement?.settledCostMicros ?? null });
    if (settlement) store.addUsage(upstream.id, { attemptId, startedAt, ...settlement });
  } catch {
    // Accounting must not replace a successful provider response.
  }
}

function retryGatewayAttempt(store, lifecycle, attemptId, details) {
  if (!lifecycle) return;
  try { store.retryGatewayAttempt(lifecycle.id, attemptId, details); } catch {}
}

function finalizeGatewayFailure(store, lifecycle, attemptId, details) {
  if (!lifecycle) return;
  try { store.finalizeGatewayRequest({ requestId: lifecycle.id, attemptId, status: 'failed', ...details }); } catch {}
}

function learnResponsePin(store, response, upstreamId, scopeId, apiKeyId) {
  if (!apiKeyId || response?.[TERMINAL_EVENT_TYPE] === 'response.failed') return;
  try { store.pinResponse(response?.id, upstreamId, scopeId, apiKeyId); } catch {}
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
}

async function readResponseBytes(response, maxBytes = 16 * 1024 * 1024, upstreamDeadlines = {}) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readWithIdleDeadline(reader, upstreamDeadlines);
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel('Response body exceeded limit');
        throw Object.assign(new Error('Upstream response body is too large'), { statusCode: 502 });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedResponse(response, maxBytes = 1024 * 1024, upstreamDeadlines = {}) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (size <= maxBytes) {
      const { done, value } = await readWithIdleDeadline(reader, upstreamDeadlines);
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) break;
      chunks.push(Buffer.from(value));
    }
    await reader.cancel('Error body exceeded limit');
    return Buffer.alloc(0);
  } finally {
    reader.releaseLock();
  }
}

function validAnthropicError(bytes) {
  const body = parseJson(bytes);
  return body?.type === 'error' && typeof body?.error?.type === 'string' && typeof body?.error?.message === 'string';
}

function sendFailure(res) {
  const failure = upstreamFailure();
  sendJson(res, failure.status, failure.body);
}

function isEventStream(response) {
  return response.headers.get('content-type')?.includes('text/event-stream');
}

function writeResponse(res, response, body, responseOptions = {}) {
  res.writeHead(response.status, responseHeaders(response, null, responseOptions));
  res.end(body);
}

function responseHeaders(response, contentType = null, { relayTurnState = false, modelsEtag = null } = {}) {
  const headers = { 'content-type': contentType || response.headers.get('content-type') || 'application/json' };
  for (const name of ['cache-control', 'content-disposition', 'x-request-id', 'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  if (relayTurnState) {
    const turnState = response.headers.get('x-codex-turn-state');
    if (turnState) headers['x-codex-turn-state'] = turnState;
  }
  if (modelsEtag) headers['x-models-etag'] = modelsEtag;
  return headers;
}

function sessionAffinity(req) {
  return SESSION_HEADERS.map((name) => header(req, name)).find(Boolean) || '';
}

function requestRequirements(path, payload = {}) {
  return {
    responses: path !== '/v1/messages',
    streaming: payload.stream === true,
    tools: Array.isArray(payload.tools) && payload.tools.length > 0,
    imageInput: hasInputImage(payload.input || payload.messages),
    reasoning: payload.reasoning !== undefined || payload.reasoning_effort !== undefined,
    serviceTier: typeof payload.service_tier === 'string' && payload.service_tier.trim() ? payload.service_tier.trim().toLowerCase() : ''
  };
}

function hasInputImage(value) {
  if (Array.isArray(value)) return value.some(hasInputImage);
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'input_image' || value.type === 'image_url' || value.type === 'image') return true;
  return Object.values(value).some(hasInputImage);
}

function requestScopeId(req) {
  return req.proxyAuth?.scopeId || DEFAULT_SCOPE_ID;
}

function requestAccounting(req) {
  return { scopeId: requestScopeId(req), apiKeyId: req.proxyAuth?.id || null };
}

function header(req, name) {
  const value = req.headers[name];
  return typeof value === 'string' ? value.trim() : '';
}

export function isAdditionalGatewayRoute(method, path) {
  return method === 'GET' && ['/api/codex/usage', '/wham/usage', '/backend-api/wham/usage'].includes(path) || method === 'POST' && [
    '/backend-api/transcribe',
    '/backend-api/files'
  ].includes(path) || method === 'POST' && /^\/backend-api\/files\/[^/]+\/uploaded$/.test(path) || method === 'POST' && [
    '/backend-api/codex/images/generations',
    '/backend-api/codex/images/edits'
  ].includes(path);
}

export async function proxyRawRequest({ req, res, path, body, store, apiKey = process.env.CODEX_POOLER_API_KEY, fetchImpl = globalThis.fetch, upstreamDeadlines = {} }) {
  if (!validApiKey(req, apiKey)) {
    sendJson(res, 401, { error: { type: 'authentication_error', message: 'Invalid API key' } }, { 'www-authenticate': 'Bearer' });
    return;
  }
  const upstream = chooseRawUpstream(store, req);
  if (!upstream) return sendRoutingError(res, store, req, 'No eligible Codex upstream is available');
  const scope = { model: '', routeClass: 'raw_native' };
  if (!store.beginCircuit(upstream.id, scope)) return sendRoutingError(res, store, req, 'No eligible Codex upstream is available');
  const credentials = store.credentials(upstream.id);
  const startedAt = new Date().toISOString();
  const attemptId = randomUUID();
  let response;
  try {
    await ensureProviderCredentials(upstream, credentials, {
      fetchImpl,
      saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
    });
    let request = buildRawRequest(upstream, req, path, body, credentials);
    response = await requestUpstream(request, fetchImpl, { req, res }, upstreamDeadlines);
    persistResponseCookies(response, upstream, credentials, store);
    if ((response.status === 401 || response.status === 403) && credentials.refreshToken && rawMethodIsSafe(req.method)) {
      await refreshProviderCredentials(upstream, credentials, {
        fetchImpl,
        saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
      });
      request = buildRawRequest(upstream, req, path, body, credentials);
      response = await requestUpstream(request, fetchImpl, { req, res }, upstreamDeadlines);
      persistResponseCookies(response, upstream, credentials, store);
    }
  } catch {
    store.recordCircuitFailure(upstream.id, scope);
    sendFailure(res);
    return;
  }
  if (!response.ok) {
    if (await retryableUpstreamResponse(response)) store.recordCircuitFailure(upstream.id, scope);
    else store.releaseCircuit(upstream.id, scope);
    await readBoundedResponse(response, 1024 * 1024, upstreamDeadlines);
    sendFailure(res);
    return;
  }
  store.completeCircuit(upstream.id, scope, true);
  const sessionId = sessionAffinity(req);
  if (sessionId) store.pinSession(sessionId, upstream.id, requestScopeId(req), requestAccounting(req).apiKeyId);
  if (isEventStream(response)) {
    let streamUsage;
    let terminal = false;
    await streamPassthrough(response, res, (event) => {
      streamUsage = mergeUsage(streamUsage, extractUsage(event));
      terminal ||= ['response.completed', 'response.incomplete'].includes(event.type);
    }, upstreamDeadlines);
    if (terminal && streamUsage) settleUsage(store, upstream, attemptId, startedAt, streamUsage, {}, requestAccounting(req));
    return;
  }
  const bytes = await readResponseBytes(response, 16 * 1024 * 1024, upstreamDeadlines);
  settleUsage(store, upstream, attemptId, startedAt, parseJson(bytes), {}, requestAccounting(req));
  writeResponse(res, response, bytes);
}

export async function proxyModelsRequest({ req, res, path, store, apiKey = process.env.CODEX_POOLER_API_KEY, fetchImpl = globalThis.fetch }) {
  if (!validApiKey(req, apiKey)) {
    sendJson(res, 401, { error: { type: 'authentication_error', message: 'Invalid API key' } }, { 'www-authenticate': 'Bearer' });
    return;
  }
  const catalog = await loadModelCatalog(store, req, fetchImpl, res);
  if (!catalog.eligibleCount) {
    sendJson(res, 503, { error: { type: 'server_error', message: 'No eligible upstream is available' } });
    return;
  }
  if (!catalog.data.length && catalog.lastError) {
    sendFailure(res);
    return;
  }
  if (path === '/v1/models') sendJson(res, 200, { object: 'list', data: catalog.data });
  else sendJson(res, 200, { models: catalog.data }, { etag: catalog.etag });
}

async function loadModelCatalog(store, req, fetchImpl, res = null) {
  const scopeId = requestScopeId(req);
  const cached = modelCatalogCache.get(store)?.get(scopeId);
  if (cached?.expiresAt > Date.now()) return cached;

  const loads = modelCatalogLoads.get(store) || new Map();
  const existing = loads.get(scopeId);
  if (existing) return existing;

  const load = fetchModelCatalog(store, req, fetchImpl, scopeId, res);
  loads.set(scopeId, load);
  modelCatalogLoads.set(store, loads);
  try {
    return await load;
  } finally {
    loads.delete(scopeId);
    if (!loads.size) modelCatalogLoads.delete(store);
  }
}

function cachedModelCatalog(store, scopeId) {
  const cached = modelCatalogCache.get(store)?.get(scopeId);
  return cached?.expiresAt > Date.now() ? cached : null;
}

async function fetchModelCatalog(store, req, fetchImpl, scopeId, res = null) {
  const cache = modelCatalogCache.get(store);
  const eligible = store.eligibility(null, scopeId).eligible;
  const results = await mapConcurrent(eligible, MODEL_CATALOG_CONCURRENCY, async (record) => {
    const upstream = store.get(record.id, scopeId);
    if (!upstream) return { models: [] };
    const credentials = store.credentials(record.id);
    try {
      await ensureProviderCredentials(upstream, credentials, {
        fetchImpl,
        saveCredentials: (updated, expiresAt) => store.persistCredentials(record.id, updated, expiresAt)
      });
      const target = upstream.type === 'compass' ? '/models' : `/backend-api/codex/models?client_version=${encodeURIComponent(CODEX_HEADERS.version)}`;
      let response = await requestUpstream({ method: 'GET', url: `${defaultBaseUrl(upstream.type)}${target}`, headers: rawHeaders(upstream, credentials, req) }, fetchImpl, { req, res });
      persistResponseCookies(response, upstream, credentials, store);
      if ((response.status === 401 || response.status === 403) && credentials.refreshToken) {
        await refreshProviderCredentials(upstream, credentials, {
          fetchImpl,
          saveCredentials: (updated, expiresAt) => store.persistCredentials(record.id, updated, expiresAt)
        });
        response = await requestUpstream({ method: 'GET', url: `${defaultBaseUrl(upstream.type)}${target}`, headers: rawHeaders(upstream, credentials, req) }, fetchImpl, { req, res });
        persistResponseCookies(response, upstream, credentials, store);
      }
      if (!response.ok) throw Object.assign(new Error(`Provider returned HTTP ${response.status}`), { statusCode: 502 });
      const allowedModels = upstream.routing?.models || [];
      return { models: normalizeModels(parseJson(await readResponseBytes(response, 4 * 1024 * 1024)), upstream)
        .filter((model) => !allowedModels.length || allowedModels.includes(model.id.toLowerCase())) };
    } catch (error) {
      return { models: [], error };
    }
  });
  const models = results.flatMap(({ models }) => models);
  const lastError = results.every(({ error }) => error) ? results.find(({ error }) => error)?.error : null;
  const data = dedupeModels(models).filter((model) => store.modelAllowed(scopeId, model.id));
  const catalog = {
    data,
    eligibleCount: eligible.length,
    lastError,
    etag: data.length || !lastError ? modelEtag({ models: data }) : null,
    expiresAt: Date.now() + MODEL_CATALOG_TTL_MS
  };
  if (catalog.etag) {
    const scopes = modelCatalogCache.get(store) || new Map();
    scopes.set(scopeId, catalog);
    modelCatalogCache.set(store, scopes);
  } else {
    cache?.delete(scopeId);
    if (!cache?.size) modelCatalogCache.delete(store);
  }
  return catalog;
}

async function mapConcurrent(items, limit, mapper) {
  const results = Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

function modelEtag(body) {
  const digest = createHash('sha256').update(canonicalJson(body)).digest('hex');
  return `W/"cp-models-v1-${digest}"`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function chooseRawUpstream(store, req) {
  const scopeId = requestScopeId(req);
  const sessionId = sessionAffinity(req);
  const apiKeyId = requestAccounting(req).apiKeyId;
  const pinnedId = store.sessionUpstream(sessionId, scopeId, apiKeyId);
  const requestedId = header(req, 'x-upstream-id');
  const candidates = store.candidatePlan({
    requestedId,
    preferredType: 'codex',
    requiredType: 'codex',
    scopeId,
    routeClass: 'raw_native'
  });
  const ordered = pinnedId
    ? [...candidates.filter((candidate) => candidate.id === pinnedId), ...candidates.filter((candidate) => candidate.id !== pinnedId)]
    : candidates;
  const chosen = ordered[0];
  return chosen ? store.get(chosen.id, scopeId) : null;
}

function rawMethodIsSafe(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase());
}

function buildRawRequest(upstream, req, path, body, credentials) {
  return {
    method: req.method,
    url: `${defaultBaseUrl(upstream.type)}${rawTargetPath(path)}`,
    headers: rawHeaders(upstream, credentials, req),
    body: body.length ? body : undefined
  };
}

function rawTargetPath(path) {
  if (path === '/v1/files') return '/backend-api/files';
  if (path.startsWith('/v1/files/')) return `/backend-api/files/${path.slice('/v1/files/'.length)}`;
  if (path === '/v1/audio/transcriptions') return '/backend-api/transcribe';
  if (path === '/v1/images/generations') return '/backend-api/codex/images/generations';
  if (path === '/v1/images/edits') return '/backend-api/codex/images/edits';
  return path;
}

function backendWebSocketMetadata(req) {
  const headers = {};
  for (const name of BACKEND_METADATA_HEADERS) {
    const value = header(req, name);
    if (value) headers[name] = projectMetadataHeader(name, value);
  }
  return headers;
}

function rawHeaders(upstream, credentials, req) {
  const headers = {
    authorization: `Bearer ${credentials.accessToken || credentials.projectKey}`,
    accept: typeof req.headers.accept === 'string' ? req.headers.accept : '*/*'
  };
  if (typeof req.headers['content-type'] === 'string') headers['content-type'] = req.headers['content-type'];
  if (upstream.type === 'codex') Object.assign(headers, CODEX_HEADERS, codexCookieHeaders(credentials), upstream.accountId ? { 'chatgpt-account-id': upstream.accountId } : {});
  return headers;
}

function persistResponseCookies(response, upstream, credentials, store) {
  if (upstream.type === 'codex' && captureCodexCookies(response, credentials)) {
    store.persistCredentials(upstream.id, credentials, upstream.accessTokenExpiresAt);
  }
}

function normalizeModels(body, upstream) {
  const values = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return values.map((model) => {
    const id = typeof model === 'string' ? model : model?.id || model?.slug || model?.name;
    return id ? { ...(typeof model === 'object' ? model : {}), id, object: 'model', owned_by: model?.owned_by || upstream.type } : null;
  }).filter(Boolean);
}

function dedupeModels(models) {
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

async function streamPassthrough(response, res, onEvent = null, upstreamDeadlines = {}) {
  res.writeHead(response.status, responseHeaders(response));
  const reader = response.body?.getReader();
  if (!reader) return res.end();
  let buffer = '';
  const decoder = new TextDecoder();
  const observe = (chunk) => {
    if (!onEvent) return;
    buffer += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffer) > MAX_STREAM_BUFFER_BYTES) {
      buffer = '';
      return;
    }
    const blocks = splitSseBlocks(buffer);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const decoded = decodeSseBlock(block);
      if (decoded.kind === 'event') onEvent(decoded.event);
    }
  };
  res.once('close', () => { void reader.cancel('Downstream closed').catch(() => {}); });
  try {
    while (true) {
      const { done, value } = await readWithIdleDeadline(reader, upstreamDeadlines);
      if (done) break;
      observe(value);
      await writeChunk(res, Buffer.from(value));
    }
    observe(new Uint8Array());
  } finally {
    reader.releaseLock();
    res.end();
  }
}

async function writeChunk(res, chunk) {
  if (res.destroyed || res.write(chunk)) return;
  await Promise.race([once(res, 'drain'), once(res, 'close')]);
}

export function authenticateProxyRequest(req, store, expected, { allowXApiKey = false } = {}) {
  if (!expected) return { scopeId: DEFAULT_SCOPE_ID };
  store.configureApiKey(expected);
  const authorization = req.headers.authorization;
  const key = typeof authorization === 'string'
    ? authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
    : allowXApiKey && typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  return store.authenticateApiKey(key);
}

export function validProxyApiKey(req, expected) {
  return Boolean(req.proxyAuth) || validApiKey(req, expected);
}

export function attachWebSocketProxy(server, { store, apiKey = process.env.CODEX_POOLER_API_KEY, fetchImpl = globalThis.fetch, websocketUrl, ingress = {} } = {}) {
  const admission = admissionPolicy(ingress);
  const websocketIdleMs = Number.isFinite(ingress.websocketIdleMs) && ingress.websocketIdleMs > 0 ? ingress.websocketIdleMs : 30 * 60 * 1000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_PENDING_BYTES });
  wss.on('headers', (headers, req) => {
    if (req.codexModelsEtag) headers.push(`x-models-etag: ${req.codexModelsEtag}`);
    if (isBackendResponsesRoute(new URL(req.url, 'http://localhost').pathname)) {
      const turnState = header(req, 'x-codex-turn-state');
      if (turnState) headers.push(`x-codex-turn-state: ${turnState}`);
    }
  });
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!hostAllowed(req.headers.host, admission) || !WEBSOCKET_ENDPOINTS.has(path) || !firewallAllowed(req, admission)) {
        socket.destroy();
        return;
      }
      const auth = authenticateProxyRequest(req, store, apiKey);
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      req.proxyAuth = auth;
      if (sessionAffinity(req).length > MAX_SESSION_ID_LENGTH) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (isBackendResponsesRoute(path)) req.codexModelsEtag = cachedModelCatalog(store, requestScopeId(req))?.etag;
      wss.handleUpgrade(req, socket, head, (client) => {
        wss.emit('connection', client, req);
      });
    })().catch(() => socket.destroy());
  });
  wss.on('connection', (client, req) => relayWebSocket(client, req, store, fetchImpl, websocketUrl, websocketIdleMs));
  return wss;
}

async function relayWebSocket(client, req, store, fetchImpl, websocketUrl, websocketIdleMs) {
  const publicResponses = new URL(req.url, 'http://localhost').pathname === '/v1/responses';
  const sessionId = sessionAffinity(req);
  const scopeId = requestScopeId(req);
  const accounting = requestAccounting(req);
  let upstream = publicResponses ? null : chooseRawUpstream(store, req);
  if (!upstream && !publicResponses) {
    client.close(1013, 'No eligible Codex upstream is available');
    return;
  }
  let credentials = upstream && store.credentials(upstream.id);
  let targetSocket;
  let retried = false;
  let refreshing = false;
  let pendingBytes = 0;
  let publicSequence = 0;
  let publicTurnActive = false;
  let publicAttempt;
  let publicLifecycle;
  let publicPayload;
  let publicUsage;
  let publicState;
  let publicOutput = false;
  let retriedTurn = false;
  let activeFrame;
  let turnCandidates = [];
  let turnCandidateIndex = 0;
  const pending = [];
  const queuedTurns = [];
  let queuedTurnBytes = 0;
  let idleTimer = null;
  const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };
  const failActiveTurn = (code, message) => {
    if (!publicResponses || !publicTurnActive) return;
    publicTurnActive = false;
    activeFrame = null;
    finalizeGatewayFailure(store, publicLifecycle, publicAttempt?.id, { errorCode: code });
    publicAttempt = null;
    publicLifecycle = null;
    publicUsage = null;
    publicWebSocketFailure(client, 'server_error', message, publicSequence++);
    startNextPublicTurn();
  };
  const resetIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      if (publicTurnActive) failActiveTurn('upstream_websocket_idle_timeout', 'Upstream websocket timed out');
      if (targetSocket?.readyState === WebSocket.OPEN || targetSocket?.readyState === WebSocket.CONNECTING) targetSocket.close(1011, 'Upstream websocket timed out');
    }, websocketIdleMs);
  };
  const startNextPublicTurn = () => {
    const next = queuedTurns.shift();
    if (!next || client.readyState !== WebSocket.OPEN) return;
    queuedTurnBytes -= next.byteLength;
    setImmediate(() => client.emit('message', next, false));
  };
  const closeBoth = (code = 1000, reason = '') => {
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
    if (targetSocket?.readyState === WebSocket.OPEN || targetSocket?.readyState === WebSocket.CONNECTING) targetSocket.close(code, reason);
  };
  client.on('message', (data, isBinary) => {
    if (isBinary) return client.close(1003, 'Binary WebSocket frames are not supported');
    if (publicResponses) {
      try {
        const frame = JSON.parse(data.toString());
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.type !== 'response.create') throw new AdapterError('Invalid response.create frame');
        if (publicTurnActive) {
          const queued = Buffer.from(data);
          if (queuedTurnBytes + queued.byteLength > MAX_WEBSOCKET_PENDING_BYTES) return client.close(1009, 'Pending websocket data exceeded limit');
          queuedTurnBytes += queued.byteLength;
          queuedTurns.push(queued);
          return;
        }
        const { type: _type, generate: _generate, ...request } = frame;
        const payload = adaptResponsesRequest({ ...request, stream: true });
        turnCandidates = chooseUpstreams(store, req, '/v1/responses', payload).map((entry) => store.get(entry.id, requestScopeId(req))).filter((entry) => entry?.type === 'codex');
        turnCandidateIndex = 0;
        const candidate = turnCandidates[0];
        if (!candidate) throw new AdapterError('No eligible Codex upstream');
        const needsConnection = !targetSocket || ![WebSocket.OPEN, WebSocket.CONNECTING].includes(targetSocket.readyState) || upstream?.id !== candidate.id;
        if (needsConnection) {
          if (targetSocket?.readyState === WebSocket.OPEN || targetSocket?.readyState === WebSocket.CONNECTING) targetSocket.close();
          upstream = candidate;
          credentials = store.credentials(upstream.id);
          targetSocket = undefined;
          void ensureProviderCredentials(upstream, credentials, { fetchImpl, saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt) }).then(connect).catch(() => failActiveTurn('upstream_credentials_failed', 'No eligible Codex upstream'));
        }
        data = Buffer.from(JSON.stringify({ ...publicResponsesPayload(payload), generate: true }));
        publicTurnActive = true;
        publicSequence = 0;
        publicOutput = false;
        publicPayload = payload;
        publicUsage = null;
        publicState = createPublicResponsesState(customToolNamespaces(payload.tools));
        retriedTurn = false;
        activeFrame = { data, isBinary: false };
        publicLifecycle = accounting.apiKeyId
          ? store.reserveGatewayRequest({ scopeId, apiKeyId: accounting.apiKeyId, endpoint: '/v1/responses', model: payload.model || '', transport: 'websocket' })
          : null;
        publicAttempt = publicLifecycle
          ? store.beginGatewayAttempt(publicLifecycle.id, candidate.id)
          : { id: randomUUID(), startedAt: new Date().toISOString() };
      } catch (error) {
        return publicWebSocketFailure(client, 'invalid_request_error', 'Invalid response.create frame');
      }
    }
    if (targetSocket?.readyState === WebSocket.OPEN) {
      if (targetSocket.bufferedAmount + data.byteLength > MAX_WEBSOCKET_PENDING_BYTES) closeBoth(1009, 'Websocket backpressure limit exceeded');
      else targetSocket.send(data, { binary: isBinary });
    } else {
      pendingBytes += data.byteLength;
      if (pendingBytes > MAX_WEBSOCKET_PENDING_BYTES) client.close(1009, 'Pending websocket data exceeded limit');
      else pending.push({ data, isBinary });
    }
  });
  client.on('close', () => {
    clearIdle();
    if (publicTurnActive) finalizeGatewayFailure(store, publicLifecycle, publicAttempt?.id, { errorCode: 'downstream_closed' });
    publicTurnActive = false;
    publicLifecycle = null;
    publicAttempt = null;
    if (targetSocket?.readyState === WebSocket.OPEN || targetSocket?.readyState === WebSocket.CONNECTING) targetSocket.close();
  });
  client.on('error', () => closeBoth(1011, 'Client websocket error'));

  const retryPublicTurn = () => {
    if (!publicResponses || !publicTurnActive || publicOutput || retriedTurn || !activeFrame) return false;
    retryGatewayAttempt(store, publicLifecycle, publicAttempt?.id, { errorCode: 'upstream_websocket_retryable_failure' });
    retriedTurn = true;
    const fallback = turnCandidates[turnCandidateIndex + 1];
    if (fallback) {
      turnCandidateIndex += 1;
      upstream = fallback;
      credentials = store.credentials(upstream.id);
    }
    const previousSocket = targetSocket;
    targetSocket = undefined;
    if (previousSocket?.readyState === WebSocket.OPEN || previousSocket?.readyState === WebSocket.CONNECTING) previousSocket.close();
    publicAttempt = publicLifecycle
      ? store.beginGatewayAttempt(publicLifecycle.id, upstream.id)
      : { id: randomUUID(), startedAt: new Date().toISOString() };
    pending.splice(0, pending.length, activeFrame);
    pendingBytes = activeFrame.data.byteLength;
    void ensureProviderCredentials(upstream, credentials, {
      fetchImpl,
      saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
    }).then(connect).catch(() => failActiveTurn('upstream_credentials_failed', 'Upstream response failed'));
    return true;
  };

  const connect = () => {
    const target = websocketUrl?.(upstream) || `${defaultBaseUrl(upstream.type).replace(/^http/, 'ws')}/backend-api/codex/responses`;
    const socket = new WebSocket(target, {
      headers: { ...rawHeaders(upstream, credentials, req), ...(publicResponses ? {} : backendWebSocketMetadata(req)), origin: 'https://chatgpt.com', 'openai-beta': 'responses_websockets=2026-02-06' },
      handshakeTimeout: 120_000,
      maxPayload: MAX_WEBSOCKET_PENDING_BYTES
    });
    targetSocket = socket;
    socket.on('open', () => {
      resetIdle();
      for (const { data, isBinary } of pending.splice(0)) socket.send(data, { binary: isBinary });
      pendingBytes = 0;
    });
    socket.on('message', (data, isBinary) => {
      if (socket !== targetSocket || client.readyState !== WebSocket.OPEN) return;
      resetIdle();
      if (publicResponses) {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
        if (!publicOutput && retryableSseFailure(frame) && retryPublicTurn()) return;
        const projected = normalizePublicResponsesEvent(frame, publicState);
        if (!projected.length) return;
        const events = projected.map((block) => decodeSseBlock(block)).filter((decoded) => decoded.kind === 'event').map((decoded) => decoded.event);
        if (!events.length) return;
        publicOutput = true;
        publicUsage = mergeUsage(publicUsage, extractUsage(frame));
        const terminal = events.find((event) => ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type));
        if (sessionId && !terminal?.type?.endsWith('failed')) store.pinSession(sessionId, upstream.id, scopeId, requestAccounting(req).apiKeyId);
        for (const event of events) {
          const encoded = JSON.stringify(event);
          if (client.bufferedAmount + Buffer.byteLength(encoded) > MAX_WEBSOCKET_PENDING_BYTES) return closeBoth(1009, 'Websocket backpressure limit exceeded');
          client.send(encoded);
        }
        if (!terminal) return;
        publicTurnActive = false;
        activeFrame = null;
        if (terminal.type === 'response.failed') finalizeGatewayFailure(store, publicLifecycle, publicAttempt?.id, { errorCode: 'upstream_response_failed' });
        else {
          learnResponsePin(store, terminal.response, upstream.id, scopeId, accounting.apiKeyId);
          if (publicAttempt) settleUsage(store, upstream, publicAttempt.id, publicAttempt.startedAt, publicUsage, publicPayload, accounting, publicLifecycle, 200);
        }
        publicAttempt = null;
        publicLifecycle = null;
        publicUsage = null;
        clearIdle();
        startNextPublicTurn();
        return;
      }
      if (client.bufferedAmount + data.byteLength > MAX_WEBSOCKET_PENDING_BYTES) closeBoth(1009, 'Websocket backpressure limit exceeded');
      else client.send(data, { binary: isBinary });
    });
    socket.on('unexpected-response', async (_request, response) => {
      response.resume();
      if (!retried && credentials.refreshToken && (response.statusCode === 401 || response.statusCode === 403)) {
        retried = true;
        refreshing = true;
        try {
          await refreshProviderCredentials(upstream, credentials, {
            fetchImpl,
            saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
          });
          connect();
          refreshing = false;
        } catch (error) {
          closeBoth(1011, error.message || 'Upstream websocket authentication failed');
        }
      } else if (!retryPublicTurn()) {
        if (publicResponses && publicTurnActive) failActiveTurn('upstream_websocket_handshake_failed', 'Upstream websocket handshake failed');
        else closeBoth(1011, 'Upstream websocket handshake failed');
      }
    });
    socket.on('close', (code, reason) => {
      if (socket !== targetSocket || refreshing || client.readyState !== WebSocket.OPEN) return;
      targetSocket = undefined;
      if (retryPublicTurn()) return;
      if (publicResponses && publicTurnActive) {
        clearIdle();
        failActiveTurn('upstream_websocket_interrupted', 'Upstream response interrupted');
        return;
      }
      client.close(code, reason);
    });
    socket.on('error', () => {
      if (socket !== targetSocket || refreshing) return;
      if (publicResponses && publicTurnActive && !publicOutput) return socket.close();
      closeBoth(1011, 'Upstream websocket error');
    });
  };

  try {
    if (upstream) {
      await ensureProviderCredentials(upstream, credentials, {
        fetchImpl,
        saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
      });
      connect();
    }
  } catch (error) {
    client.close(1011, error.message || 'Upstream websocket connection failed');
  }
}

function publicWebSocketFailure(client, code, message, sequenceNumber = 0) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', sequence_number: sequenceNumber, error: { type: 'server_error', code, message, param: null } }));
}

function sendRoutingError(res, store, req, fallback = 'No eligible upstream is available', code = 'no_eligible_backend') {
  const scopeId = requestScopeId(req);
  const pinnedId = store.sessionUpstream(sessionAffinity(req), scopeId, requestAccounting(req).apiKeyId);
  const error = store.eligibility(pinnedId, scopeId).error;
  sendJson(res, error?.status || 503, { error: { type: 'server_error', code: error?.code || code, message: error?.message || fallback, param: code === 'no_compatible_backend' ? 'model' : undefined } });
}

function validApiKey(req, expected) {
  if (req.proxyAuth) return true;
  if (!expected) return true;
  const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
    ? req.headers.authorization.slice(7).trim()
    : '';
  const left = Buffer.from(bearer);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(body));
}
