import { randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { defaultBaseUrl } from './domain.js';
import { DEFAULT_SCOPE_ID } from './store.js';
import { modelCatalogForStore } from './codex-model-catalog.js';
import { codexHostHealthForStore, withCodexHostHealth } from './codex-host-health.js';
import { captureCodexCookies, codexCookieHeaders } from './codex-cookies.js';
import { ensureProviderCredentials, refreshProviderCredentials } from './providers.js';
import { AdapterError, adaptChatRequest, adaptResponsesRequest, customToolNamespaces, lowerNonStrictFunctionTools } from './openai-adapters.js';
import { codexHostUnavailable, pacingUnavailable, upstreamFailure } from './public-errors.js';
import { admissionPolicy, firewallAllowed, hostAllowed } from './admission.js';
import { extractUsage, mergeUsage, priceUsage } from './pricing.js';
import { consumeSseChunk, createChatStreamState, createPublicResponsesState, createSseParserState, decodeSseBlock, normalizeChatEvent, normalizePublicResponsesEvent, pendingSseBlock, restoreCustomToolCallNamespaces, retryableFirstSseEvent, splitSseBlocks } from './openai-streaming.js';
import { fetchWithHeaderDeadline, readWithIdleDeadline } from './upstream-deadlines.js';
import { codexProtocolHeaders, DEFAULT_ANTHROPIC_VERSION } from './protocol-compat.js';
import { classifyHttpResponse, classifySseEvent, classifyTransportError } from './upstream-outcomes.js';
import { MISALIGNMENT_POLICY_CODE, misalignmentPolicyFailure, publicMisalignmentError } from './policy-failures.js';
import { PacingError, upstreamPacerForStore } from './upstream-pacer.js';
import { gatewayDiagnosticsForStore } from './gateway-diagnostics.js';
import {
  compatibilityLearningForStore,
  compatibilityContext,
  compatibilityEvidenceFeature
} from './compatibility-learning.js';
import { compatibilityOptionalFields } from './compatibility-policy.js';

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
const ANTHROPIC_HEADERS = ['anthropic-version', 'anthropic-beta'];
const BACKEND_METADATA_HEADERS = [
  'x-codex-turn-metadata',
  'x-codex-window-id',
  'x-codex-parent-thread-id',
  'x-codex-installation-id',
  'x-codex-turn-state',
  'x-openai-subagent'
];
const CODEX_OPTIONAL_FALLBACK_FIELDS = new Set(compatibilityOptionalFields('codex'));
const COMPASS_OPTIONAL_FALLBACK_FIELDS = new Set(compatibilityOptionalFields('compass'));
const COMPATIBILITY_RETRY_LIMIT = Math.max(CODEX_OPTIONAL_FALLBACK_FIELDS.size, COMPASS_OPTIONAL_FALLBACK_FIELDS.size + 1);
const ANTHROPIC_BETA_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FORWARDED_HEADER_MAX_BYTES = 1024;
const PROMPT_CACHE_BREAKPOINT_TYPES = new Set(['input_text', 'input_image', 'input_file']);
const COMPACT_PAYLOAD_FIELDS = new Set([
  'model',
  'instructions',
  'input',
  'tools',
  'parallel_tool_calls',
  'reasoning',
  'service_tier',
  'prompt_cache_key',
  'text'
]);
const MAX_WEBSOCKET_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_ID_LENGTH = 200;
const MAX_GATEWAY_CANDIDATE_ATTEMPTS = 8;
const STREAM_ID_PATTERN = /^[A-Za-z0-9_.-]{1,256}$/;
const SESSION_HEADERS = ['x-codex-window-id', 'x-codex-session-id', 'session-id', 'x-session-id', 'x-session-affinity', 'session_id', 'x-codex-conversation-id'];
const TERMINAL_EVENT_TYPE = Symbol('terminalEventType');
const POLICY_ROUTES = new Set([
  '/v1/responses',
  '/v1/chat/completions',
  '/backend-api/codex/responses',
  '/backend-api/codex/v1/responses',
  '/backend-api/codex/v1/chat/completions',
  '/v1/responses/compact',
  '/backend-api/codex/responses/compact',
  '/backend-api/codex/v1/responses/compact'
]);

export async function proxyRequest({ req, res, path, payload, store, apiKey = process.env.CODEX_POOLER_API_KEY, fetchImpl = globalThis.fetch, upstreamDeadlines = {}, logger = null, codexHostHealth = codexHostHealthForStore(store) }) {
  if (!validApiKey(req, apiKey)) {
    sendJson(res, 401, { error: { type: 'authentication_error', message: 'Invalid API key' } }, { 'www-authenticate': 'Bearer' });
    return;
  }
  const sessionId = sessionAffinity(req);
  const authScopeId = requestScopeId(req);
  const accounting = requestAccounting(req);
  const modelCatalog = modelCatalogForStore(store);
  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'invalid_session_id', message: `x-codex-session-id must be at most ${MAX_SESSION_ID_LENGTH} characters`, param: 'x-codex-session-id' } });
    return;
  }
  if (path === '/v1/responses/compact') {
    sendJson(res, 404, { error: { type: 'invalid_request_error', code: 'unsupported_endpoint', message: 'Unsupported OpenAI /v1 endpoint', param: null } });
    return;
  }
  const compactionBridge = prepareCompactionTriggerBridge(path, payload);
  if (compactionBridge?.error) {
    sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'invalid_request', message: compactionBridge.error.message, param: compactionBridge.error.param } });
    return;
  }
  const sourcePath = compactionBridge ? '/v1/responses/compact' : normalizeProxyPath(path);
  const dispatchPayload = compactionBridge?.payload || payload;
  if (sourcePath === '/v1/chat/completions' && normalizedServiceTier(payload?.service_tier) === 'ultrafast') {
    sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'invalid_request', message: 'service_tier is not supported', param: 'service_tier' } });
    return;
  }
  if (sourcePath === '/v1/messages') {
    const anthropicHeaderError = validateAnthropicHeaders(req);
    if (anthropicHeaderError) {
      sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: anthropicHeaderError } });
      return;
    }
  }
  let codexPayload = payload;
  let codexAdapterError = null;
  try {
    if (path === '/v1/responses') codexPayload = adaptResponsesRequest(payload);
    else if (sourcePath === '/v1/chat/completions') codexPayload = adaptChatRequest(payload);
  } catch (error) {
    if (!(error instanceof AdapterError)) throw error;
    codexAdapterError = error;
  }
  const model = typeof payload?.model === 'string' ? payload.model.toLowerCase() : '';
  if (model && !store.modelAllowed(authScopeId, model)) {
    sendJson(res, 400, { error: { type: 'invalid_request_error', code: 'invalid_model', message: `Model ${payload.model} is not available`, param: 'model' } });
    return;
  }
  const routingPlan = chooseUpstreamPlan(store, req, sourcePath, dispatchPayload, path, modelCatalog);
  let candidates = routingPlan.candidates;
  if (codexAdapterError) {
    candidates = candidates.filter((candidate) => store.get(candidate.id, authScopeId)?.type === 'compass');
    if (!candidates.length) {
      routingPlan.diagnostics.exclusions.push({ code: 'codex_adapter_incompatible' });
      sendJson(res, 400, { error: { message: codexAdapterError.message, type: 'invalid_request_error', code: codexAdapterError.code, param: codexAdapterError.param } });
      return;
    }
  }
  const lifecycle = accounting.apiKeyId && (path === '/v1/responses' || path === '/v1/chat/completions')
    ? store.reserveGatewayRequest({ scopeId: authScopeId, apiKeyId: accounting.apiKeyId, endpoint: path, model, transport: payload?.stream === true ? 'http_sse' : 'http_json' })
    : null;
  if (!candidates.length) {
    finalizeGatewayFailure(store, lifecycle, null, {
      errorCode: 'no_compatible_backend',
      responseStatusCode: 503,
      exclusionReasons: routingPlan.diagnostics.exclusions.map(({ code }) => code)
    });
    return sendRoutingError(res, store, req, 'No compatible backend is available', 'no_compatible_backend');
  }
  const dispatched = await dispatchCandidates({ store, candidates, sourcePath, payload: dispatchPayload, req, res, path, codexPayload, fetchImpl, lifecycle, upstreamDeadlines, logger, modelCatalog, codexHostHealth });
  if (!dispatched) {
    finalizeGatewayFailure(store, lifecycle, null, { errorCode: 'upstream_request_failed', responseStatusCode: 502 });
    return sendFailure(res);
  }
  const { upstream, attemptId, startedAt, response, collected: dispatchedCollection, admission, hostBlocked, pacingError, failureCode } = dispatched;
  if (pacingError) {
    finalizeGatewayFailure(store, lifecycle, attemptId, { errorCode: `local_pacing_${pacingError.code}`, responseStatusCode: 429 });
    const failure = pacingUnavailable(pacingError);
    sendJson(res, failure.status, failure.body, failure.headers);
    return;
  }
  if (hostBlocked) {
    finalizeGatewayFailure(store, lifecycle, attemptId, { errorCode: 'codex_host_unavailable', responseStatusCode: 503 });
    const failure = codexHostUnavailable(response.headers.get('retry-after'));
    sendJson(res, failure.status, failure.body, failure.headers);
    return;
  }
  if (sessionId && !store.sessionUpstream(sessionId, authScopeId, accounting.apiKeyId)) store.pinSession(sessionId, upstream.id, authScopeId, accounting.apiKeyId);
  const responseOptions = {
    relayTurnState: isBackendMetadataRoute(path),
    nativeResponseControls: isBackendResponsesRoute(path)
  };
  const modelsEtag = isBackendResponsesRoute(path) ? modelCatalog.snapshot(authScopeId).etag : null;

  if (!response.ok) {
    const errorBytes = await readBoundedResponse(response);
    const policyError = publicPolicyError(errorBytes, path, sourcePath);
    const outcome = classifyHttpResponse(response, parseJson(errorBytes), {
      allowMisalignmentPolicy: policyRoute(path, sourcePath)
    });
    finalizeGatewayFailure(store, lifecycle, attemptId, {
      errorCode: policyError?.code || failureCode || gatewayOutcomeCode(outcome),
      responseStatusCode: response.status
    });
    const validAnthropic = response.status >= 400 && response.status < 500 && upstream.type === 'compass' && sourcePath === '/v1/messages' && validAnthropicError(errorBytes);
    if (policyError) sendJson(res, response.status, { error: policyError });
    else if (validAnthropic) writeResponse(res, response, errorBytes, responseOptions);
    else sendFailure(res, retryAfterHeader(response));
    return;
  }
  if (compactionBridge) {
    const bytes = await readResponseBytes(response, 16 * 1024 * 1024, upstreamDeadlines);
    const compactResult = parseJson(bytes);
    const compact = compactionBridgeResult(compactResult, path === '/v1/responses');
    if (!compact) {
      finalizeGatewayFailure(store, lifecycle, attemptId, { errorCode: 'invalid_compaction_response', responseStatusCode: 502 });
      sendJson(res, 502, { error: { type: 'server_error', code: 'invalid_compaction_response', message: 'Upstream compact response did not include encrypted compaction content', param: null } });
      return;
    }
    settleUsage(store, upstream, attemptId, startedAt, compactResult, dispatchPayload, accounting, lifecycle, response.status);
    if (path === '/v1/responses' && payload.stream !== true) {
      sendJson(res, 200, compact.response);
    } else {
      res.writeHead(200, responseHeaders(response, 'text/event-stream', responseOptions));
      res.end(compact.sse);
    }
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
      response, res, sourcePath,
      transformChat: upstream.type === 'codex' && sourcePath === '/v1/chat/completions',
      sanitizePublicResponses: upstream.type === 'codex' && path === '/v1/responses',
      publicResponsesNamespaces: path === '/v1/responses' ? customToolNamespaces(codexPayload.tools) : undefined,
      store, upstream, attemptId, startedAt, payload, accounting, lifecycle,
      responseStatusCode: response.status,
      responseOptions: { ...responseOptions, modelsEtag },
      upstreamDeadlines,
      admission,
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

function prepareCompactionTriggerBridge(path, payload) {
  const publicResponses = path === '/v1/responses';
  if ((!isBackendResponsesRoute(path) || payload?.stream !== true) && !publicResponses || !Array.isArray(payload?.input)) return null;
  const triggerIndexes = payload.input.flatMap((item, index) => plainObject(item) && item.type === 'compaction_trigger' ? [index] : []);
  if (!triggerIndexes.length) return null;
  const singletonTrigger = !publicResponses && payload.input.length === 1 && triggerIndexes[0] === 0;
  if (!singletonTrigger && (triggerIndexes.length !== 1 || triggerIndexes[0] !== payload.input.length - 1 || !visibleCompactionInput(payload.input.slice(0, -1)))) {
    return { error: { message: 'compaction_trigger must be the final input item and must follow visible input', param: 'input' } };
  }
  if (Object.hasOwn(payload, 'tools') && !Array.isArray(payload.tools)) return { error: { message: 'tools must be an array', param: 'tools' } };
  if (Object.hasOwn(payload, 'parallel_tool_calls') && typeof payload.parallel_tool_calls !== 'boolean') {
    return { error: { message: 'parallel_tool_calls must be a boolean', param: 'parallel_tool_calls' } };
  }
  if (Object.hasOwn(payload, 'text') && !plainObject(payload.text)) return { error: { message: 'text must be an object', param: 'text' } };
  const projected = Object.fromEntries(Object.entries(payload).filter(([key]) => COMPACT_PAYLOAD_FIELDS.has(key)));
  if (!Object.hasOwn(projected, 'prompt_cache_key') && Object.hasOwn(payload, 'promptCacheKey')) projected.prompt_cache_key = payload.promptCacheKey;
  projected.input = publicResponses ? payload.input : payload.input.slice(0, -1);
  return { payload: projected, publicResponses };
}

function visibleCompactionInput(input) {
  return input.some((item) => {
    if (typeof item === 'string') return item.trim().length > 0;
    if (!plainObject(item) || item.type === 'reasoning' || item.type === 'compaction_trigger') return false;
    if (visibleCompactionContent(item.content) || visibleCompactionContent(item.output)) return true;
    return typeof item.text === 'string' && item.text.trim().length > 0;
  });
}

function visibleCompactionContent(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (typeof part === 'string') return part.trim().length > 0;
    if (!plainObject(part)) return false;
    if (['input_text', 'text', 'output_text'].includes(part.type)) return typeof part.text === 'string' && part.text.trim().length > 0;
    if (part.type === 'input_image') return cleanString(part.image_url) !== null || cleanString(part.file_id) !== null;
    if (part.type === 'input_audio') return cleanString(part.audio_url) !== null;
    if (part.type === 'input_file') return cleanString(part.file_id) !== null;
    return false;
  });
}

function compactionBridgeResult(decoded, publicResponses = false) {
  if (!plainObject(decoded)) return null;
  const sources = Array.isArray(decoded.output) ? decoded.output : [];
  const validContent = (item) => publicResponses ? cleanString(item?.encrypted_content) : typeof item?.encrypted_content === 'string';
  let source = publicResponses
    ? sources.find((item) => plainObject(item) && ['compaction', 'compaction_summary'].includes(item.type))
    : sources.find((item) => plainObject(item) && ['compaction', 'compaction_summary'].includes(item.type) && validContent(item));
  if (source && !validContent(source)) return null;
  if (!source && plainObject(decoded.compaction_summary) && validContent(decoded.compaction_summary)) source = decoded.compaction_summary;
  if (!source) return null;
  const item = {
    type: 'compaction',
    encrypted_content: source.encrypted_content,
    ...(publicResponses
      ? source.id === null || typeof source.id === 'string' ? { id: source.id } : {}
      : typeof source.id === 'string' ? { id: source.id } : {}),
    ...(!publicResponses && typeof source.internal_chat_message_metadata_passthrough?.turn_id === 'string'
      ? { internal_chat_message_metadata_passthrough: { turn_id: source.internal_chat_message_metadata_passthrough.turn_id } }
      : {})
  };
  const response = {
    id: typeof decoded.id === 'string' ? decoded.id : 'resp_compaction',
    ...(publicResponses ? { object: 'response' } : {}),
    status: 'completed',
    output: [item],
    ...(plainObject(decoded.usage) ? { usage: decoded.usage } : {})
  };
  const sse = [
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
    'data: [DONE]\n\n'
  ].join('');
  return { item, response, sse };
}

function chooseUpstreams(store, req, path, payload, originalPath = path, modelCatalog = modelCatalogForStore(store)) {
  return chooseUpstreamPlan(store, req, path, payload, originalPath, modelCatalog).candidates;
}

function chooseUpstreamPlan(store, req, path, payload, originalPath = path, modelCatalog = modelCatalogForStore(store)) {
  const scopeId = requestScopeId(req);
  const sessionId = sessionAffinity(req);
  const apiKeyId = requestAccounting(req).apiKeyId;
  const pinnedId = store.sessionUpstream(sessionId, scopeId, apiKeyId);
  const rotationUpstreamId = store.sessionRotationUpstream(sessionId, scopeId, apiKeyId);
  const requestedId = header(req, 'x-upstream-id');
  const requestedType = header(req, 'x-upstream-type');
  const responsePinnedId = originalPath === '/v1/responses' ? store.responseUpstream(payload?.previous_response_id, scopeId, apiKeyId) : null;
  const model = typeof payload?.model === 'string' ? payload.model.toLowerCase() : '';
  const nativeCodex = originalPath.startsWith('/backend-api/codex/');
  const ultrafast = normalizedServiceTier(payload?.service_tier) === 'ultrafast';
  const preferredType = path === '/v1/messages' ? 'compass' : path === '/v1/responses/compact' || nativeCodex || ultrafast ? 'codex' : model.startsWith('claude-') ? 'compass' : 'codex';
  if (responsePinnedId && (requestedId && requestedId !== responsePinnedId || requestedType && store.get(responsePinnedId, scopeId)?.type !== requestedType)) {
    return { candidates: [], diagnostics: { exclusions: [{ code: 'response_pin_conflict' }] } };
  }
  return store.candidatePlanDetails({
    affinityId: pinnedId,
    pinnedId: responsePinnedId,
    requestedId: responsePinnedId || requestedId, requestedType: responsePinnedId ? '' : requestedType, preferredType,
    requiredType: path === '/v1/messages' ? 'compass' : path === '/v1/responses/compact' || nativeCodex || ultrafast ? 'codex' : '',
    rotateFromId: pinnedId || responsePinnedId || requestedId || requestedType ? '' : rotationUpstreamId,
    model,
    modelSupport: (upstreamId, requestedModel, generation) => {
      const supported = modelCatalog.supports(upstreamId, requestedModel, generation);
      if (supported === false) return false;
      return ultrafast
        ? modelCatalog.supportsServiceTier(upstreamId, requestedModel, 'ultrafast', generation)
        : supported;
    },
    scopeId,
    requirements: requestRequirements(path, payload),
    routeClass: payload?.stream === true ? 'proxy_stream' : 'proxy_http'
  });
}

async function dispatchCandidates({ store, candidates, sourcePath, payload, req, res, path, codexPayload, fetchImpl, lifecycle = null, upstreamDeadlines = {}, logger = null, modelCatalog = modelCatalogForStore(store), codexHostHealth = codexHostHealthForStore(store) }) {
  const scope = { model: payload?.model, routeClass: payload?.stream === true ? 'proxy_stream' : 'proxy_http' };
  const scopeId = requestScopeId(req);
  let terminalFailure = null;
  let codexHostBlocked = false;
  let candidatesAttempted = 0;
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (candidatesAttempted >= MAX_GATEWAY_CANDIDATE_ATTEMPTS) break;
    const upstream = store.get(candidate.id, scopeId);
    if (codexHostBlocked && upstream?.type === 'codex') continue;
    let admission = upstream && store.beginUpstreamAttempt(upstream.id, scope);
    if (!upstream || !admission) continue;
    candidatesAttempted += 1;
    const queuePacing = candidateIndex === candidates.length - 1
      || candidatesAttempted === MAX_GATEWAY_CANDIDATE_ATTEMPTS;
    const credentials = store.credentials(upstream.id);
    const startedAt = new Date().toISOString();
    const attempt = lifecycle ? store.beginGatewayAttempt(lifecycle.id, upstream.id, startedAt) : { id: randomUUID(), startedAt };
    const attemptId = attempt.id;
    const diagnostics = gatewayDiagnosticsForStore(store);
    let response;
    let collected;
    const compatibilityService = compatibilityLearningForStore(store);
    let compatibilityScope = compatibilityFactContext(upstream, sourcePath, payload, req, path);
    let compatibility = compatibilityState(upstream, compatibilityService.activeFact(upstream.id, compatibilityScope), sourcePath);
    diagnostics.credentialStarted(attemptId);
    try {
      const refreshed = await ensureProviderCredentials(upstream, credentials, {
        fetchImpl,
        saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
      });
      if (refreshed) {
        store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false });
        admission = store.beginUpstreamAttempt(upstream.id, scope);
        if (!admission) return { upstream, attemptId, startedAt, response: new Response(null, { status: 503 }) };
        compatibilityScope = compatibilityFactContext(store.get(upstream.id) || upstream, sourcePath, payload, req, path);
        compatibility = compatibilityState(upstream, compatibilityService.activeFact(upstream.id, compatibilityScope), sourcePath);
      }
    } catch (error) {
      logProxyFailure(logger, 'credentials', upstream.id, error);
      store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false });
      return { upstream, attemptId, startedAt, response: new Response(null, { status: 502 }) };
    } finally {
      diagnostics.credentialPrepared(attemptId);
    }
    try {
      let request = buildRequest(upstream, sourcePath, payload, req, credentials, path, codexPayload, compatibility);
      response = await requestUpstream(request, fetchImpl, { req, res }, upstreamDeadlines, upstream.type === 'codex' ? codexHostHealth : null, {
        store,
        upstreamId: upstream.id,
        model: payload?.model,
        queue: queuePacing,
        attemptId
      });
      persistResponseCookies(response, upstream, credentials, store);
      let authenticationRetried = false;
      const initialPolicyFailure = policyRoute(path, sourcePath) && [400, 403].includes(response.status)
        ? misalignmentPolicyFailure(parseJson(await readBoundedResponse(response.clone())))
        : null;
      if ((response.status === 401 || response.status === 403) && !initialPolicyFailure && upstream.type === 'codex' && credentials.refreshToken) {
        try {
          const refreshed = await refreshProviderCredentials(upstream, credentials, {
            fetchImpl,
            saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
          });
          if (refreshed) {
            store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false });
            admission = store.beginUpstreamAttempt(upstream.id, scope);
            if (!admission) return { upstream, attemptId, startedAt, response: new Response(null, { status: 503 }) };
            compatibilityScope = compatibilityFactContext(store.get(upstream.id) || upstream, sourcePath, payload, req, path);
            compatibility = compatibilityState(upstream, compatibilityService.activeFact(upstream.id, compatibilityScope), sourcePath);
          }
          request = buildRequest(upstream, sourcePath, payload, req, credentials, path, codexPayload, compatibility);
          response = await requestUpstream(request, fetchImpl, { req, res }, upstreamDeadlines, codexHostHealth, {
            store,
            upstreamId: upstream.id,
            model: payload?.model,
            queue: queuePacing,
            attemptId
          });
          persistResponseCookies(response, upstream, credentials, store);
          authenticationRetried = true;
        } catch {
          store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false });
          return { upstream, attemptId, startedAt, response, admission: null };
        }
      }
      let inspectedSse = null;
      for (let retries = 0; retries < COMPATIBILITY_RETRY_LIMIT; retries += 1) {
        if (response.ok && isEventStream(response)) {
          inspectedSse = await inspectInitialSseEvent(response, upstreamDeadlines, () => diagnostics.firstSseEvent(attemptId));
          response = inspectedSse.response;
        }
        const compatibilityResponse = ['error', 'response.failed'].includes(inspectedSse?.firstEvent?.type)
          ? new Response(JSON.stringify(inspectedSse.firstEvent), { status: 400, headers: { 'content-type': 'application/json' } })
          : response;
        const learned = await compatibilityFallback(compatibilityResponse, upstream, sourcePath, payload, request, compatibility);
        if (!learned) break;
        const feature = compatibilityEvidenceFeature(compatibility, learned);
        compatibility = learned;
        compatibilityService.observe({
          upstream: store.get(upstream.id) || upstream,
          context: compatibilityScope,
          value: compatibility,
          feature,
          observationId: attemptId
        });
        void response.body?.cancel('Retrying with provider-directed compatibility fallback').catch(() => {});
        request = buildRequest(upstream, sourcePath, payload, req, credentials, path, codexPayload, compatibility);
        response = await requestUpstream(request, fetchImpl, { req, res }, upstreamDeadlines, upstream.type === 'codex' ? codexHostHealth : null, {
          store,
          upstreamId: upstream.id,
          model: payload?.model,
          queue: queuePacing,
          attemptId
        });
        persistResponseCookies(response, upstream, credentials, store);
        inspectedSse = null;
      }
      if (response.ok && isEventStream(response)) {
        const inspected = inspectedSse || await inspectInitialSseEvent(response, upstreamDeadlines, () => diagnostics.firstSseEvent(attemptId));
        response = inspected.response;
        if (sourcePath !== '/v1/responses/compact' && inspected.retryable) {
          if (modelNotFoundFailure(inspected.firstEvent) && upstream.type === 'codex') {
            modelCatalog.markUnsupported(upstream.id, payload?.model);
          }
          void response.body?.cancel('Retrying a withheld first SSE event').catch(() => {});
          store.settleUpstreamAttempt(upstream.id, admission, classifySseEvent(inspected.firstEvent, {
            allowMisalignmentPolicy: policyRoute(path, sourcePath)
          }));
          retryGatewayAttempt(store, lifecycle, attemptId, { errorCode: 'upstream_first_event_failed', responseStatusCode: response.status });
          terminalFailure = {
            upstream,
            attemptId: null,
            startedAt,
            response: new Response(null, { status: 502 }),
            admission: null,
            failureCode: 'upstream_first_event_failed'
          };
          continue;
        }
      }
      if (authenticationRetried && (response.status === 401 || response.status === 403) && sourcePath !== '/v1/responses/compact') {
        const body = parseJson(await readBoundedResponse(response.clone()));
        const outcome = classifyHttpResponse(response, body, {
          allowMisalignmentPolicy: policyRoute(path, sourcePath)
        });
        if (outcome.errorCode === MISALIGNMENT_POLICY_CODE) {
          store.settleUpstreamAttempt(upstream.id, admission, outcome);
          return { upstream, attemptId, startedAt, response, admission: null };
        }
        await readBoundedResponse(response);
        store.settleUpstreamAttempt(upstream.id, admission, outcome);
        retryGatewayAttempt(store, lifecycle, attemptId, { errorCode: 'upstream_authentication_failed', responseStatusCode: response.status });
        terminalFailure = {
          upstream,
          attemptId: null,
          startedAt,
          response: new Response(null, { status: 502 }),
          admission: null,
          failureCode: 'upstream_authentication_failed'
        };
        continue;
      }
      const publicCodexCollection = response.ok
        && upstream.type === 'codex'
        && payload?.stream !== true
        && sourcePath !== '/v1/responses/compact'
        && (path === '/v1/responses' || sourcePath === '/v1/chat/completions');
      if (publicCodexCollection) {
        collected = await collectCodexResponse(response, upstreamDeadlines);
        const policyFailure = collected?.[TERMINAL_EVENT_TYPE] === 'response.failed'
          ? misalignmentPolicyFailure({ response: collected })
          : null;
        if (policyFailure) {
          store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false, errorCode: policyFailure.code });
          return {
            upstream,
            attemptId,
            startedAt,
            response: new Response(JSON.stringify({ error: policyFailure }), {
              status: 403,
              headers: { 'content-type': 'application/json' }
            }),
            admission: null
          };
        }
      }
    } catch (error) {
      if (error instanceof PacingError) {
        try { store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false }); } catch {}
        retryGatewayAttempt(store, lifecycle, attemptId, { errorCode: `local_pacing_${error.code}`, responseStatusCode: error.statusCode });
        if (error.code === 'aborted') throw error;
        if (['queue_full', 'queue_expired', 'would_wait'].includes(error.code)) {
          terminalFailure = {
            upstream,
            attemptId: null,
            startedAt,
            response: localPacingResponse(error),
            admission: null,
            pacingError: error
          };
        }
        continue;
      }
      logProxyFailure(logger, 'dispatch', upstream.id, error);
      if (error?.codexHostPreconnect || error?.codexHostCircuitOpen) {
        store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false });
        retryGatewayAttempt(store, lifecycle, attemptId, { errorCode: 'codex_host_unavailable' });
        if (error.codexHostCircuitOpen) {
          codexHostBlocked = true;
          terminalFailure = {
            upstream,
            attemptId: null,
            startedAt,
            response: localHostFailureResponse(error.retryAfterSeconds),
            admission: null,
            hostBlocked: true
          };
          continue;
        }
        continue;
      }
      store.settleUpstreamAttempt(upstream.id, admission, classifyTransportError(error, { clientCancelled: error?.upstreamFailureKind === 'cancelled' }));
      retryGatewayAttempt(store, lifecycle, attemptId, { errorCode: 'upstream_transport_failed' });
      terminalFailure = {
        upstream,
        attemptId: null,
        startedAt,
        response: new Response(null, { status: 502 }),
        admission: null,
        failureCode: 'upstream_transport_failed'
      };
      continue;
    }
    if (response.ok) {
      const streaming = isEventStream(response) || upstream.type === 'codex' && payload?.stream === true;
      if (!streaming || collected) store.settleUpstreamAttempt(upstream.id, admission, { class: 'success', retryable: false });
      return { upstream, attemptId, startedAt, response, collected, admission: streaming && !collected ? admission : null };
    }
    const body = parseJson(await readBoundedResponse(response.clone()));
    const outcome = classifyHttpResponse(response, body, {
      allowMisalignmentPolicy: policyRoute(path, sourcePath)
    });
    const retryable = sourcePath !== '/v1/responses/compact' && outcome.retryable;
    if (retryable) {
      if (outcome.modelNotFound && upstream.type === 'codex') modelCatalog.markUnsupported(upstream.id, payload?.model);
      await readBoundedResponse(response);
      store.settleUpstreamAttempt(upstream.id, admission, outcome);
      const failureCode = gatewayOutcomeCode(outcome);
      retryGatewayAttempt(store, lifecycle, attemptId, { errorCode: failureCode, responseStatusCode: response.status });
      terminalFailure = {
        upstream,
        attemptId: null,
        startedAt,
        response: new Response(null, { status: response.status, headers: retryAfterHeader(response) }),
        admission: null,
        failureCode
      };
      continue;
    }
    store.settleUpstreamAttempt(upstream.id, admission, outcome);
    return { upstream, attemptId, startedAt, response, admission: null };
  }
  return terminalFailure;
}

async function retryableUpstreamResponse(response, upstream) {
  if (upstream.type === 'compass' && (response.status === 401 || response.status === 403)) return { modelNotFound: false };
  if (response.status === 429 || response.status >= 500) return { modelNotFound: false };
  if (![400, 404, 422].includes(response.status)) return null;
  const body = parseJson(await readBoundedResponse(response.clone()));
  const error = body?.error || body?.response?.error;
  const modelNotFound = error?.code === 'model_not_found'
    || error?.type === 'model_not_found'
    || error?.type === 'invalid_request_error' && error?.param === 'model';
  return modelNotFound ? { modelNotFound: true } : null;
}

async function inspectInitialSseEvent(response, upstreamDeadlines = {}, onFirstEvent = null) {
  if (!response.body) return { response, retryable: true };
  const [probe, downstream] = response.body.tee();
  const reader = probe.getReader();
  const decoder = new TextDecoder();
  let parserState = createSseParserState();
  const finish = (result) => {
    void reader.cancel('Initial SSE event classified').catch(() => {});
    return result;
  };
  try {
    while (true) {
      const { done, value } = await readWithIdleDeadline(reader, upstreamDeadlines);
      const result = consumeSseChunk(parserState, done ? decoder.decode() : decoder.decode(value, { stream: true }));
      parserState = result.state;
      if (result.overflow) {
        void reader.cancel('Initial SSE event exceeded buffer limit').catch(() => {});
        void downstream.cancel('Initial SSE event exceeded buffer limit').catch(() => {});
        return { response: localSseFailure(response), retryable: false };
      }
      const pending = done ? pendingSseBlock(parserState) : '';
      const events = pending.trim()
        ? [...result.blocks, pending]
        : result.blocks;
      for (const event of events) {
        if (!hasSseData(event)) continue;
        onFirstEvent?.();
        const parsed = eventData(event);
        if (parsed) return finish({ response: streamResponseClone(response, downstream), retryable: retryableSseFailure(parsed), firstEvent: parsed });
        if (event.includes('data: [DONE]')) return finish({ response: streamResponseClone(response, downstream), retryable: false });
        return finish({ response: streamResponseClone(response, downstream), retryable: false });
      }
      if (done) return finish({ response: streamResponseClone(response, downstream), retryable: true });
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
  return event.status === 429 || event.status_code === 429 || error.code === 'rate_limit_exceeded' || modelNotFoundFailure(event);
}

function modelNotFoundFailure(event) {
  const error = event?.error || event?.response?.error || event?.status_details?.error || event?.response?.status_details?.error || {};
  return error.code === 'model_not_found'
    || error.type === 'model_not_found'
    || error.type === 'invalid_request_error' && error.param === 'model';
}

function buildRequest(upstream, sourcePath, payload, req, credentials, originalPath, codexPayload = payload, compatibility = {}) {
  const direct = upstream.type === 'compass';
  const { targetPath, body } = projectProxyRequest({
    upstreamType: upstream.type,
    sourcePath,
    payload,
    originalPath,
    codexPayload,
    compatibility
  });
  const baseUrl = defaultBaseUrl(upstream.type);
  const headers = {
    'content-type': 'application/json',
    accept: body.stream ? 'text/event-stream' : 'application/json',
    authorization: `Bearer ${credentials.accessToken || credentials.projectKey}`
  };
  if (!direct) Object.assign(
    headers,
    codexProtocolHeaders(req, { inheritClient: isBackendMetadataRoute(originalPath) }),
    codexCookieHeaders(credentials),
    upstream.accountId ? { 'chatgpt-account-id': upstream.accountId } : {}
  );
  const forwarded = direct && sourcePath === '/v1/messages'
    ? ANTHROPIC_HEADERS
    : !direct && isBackendMetadataRoute(originalPath) && sourcePath !== '/v1/chat/completions'
      ? BACKEND_METADATA_HEADERS
      : [];
  for (const name of forwarded) {
    const value = direct ? anthropicHeader(req, name) : req.headers[name];
    if (typeof value === 'string' && value) headers[name] = projectMetadataHeader(name, value);
  }
  if (direct && sourcePath === '/v1/messages' && !headers['anthropic-version']) headers['anthropic-version'] = DEFAULT_ANTHROPIC_VERSION;
  return { url: `${baseUrl}${targetPath}`, headers, body: JSON.stringify(body) };
}

export function projectProxyRequest({
  upstreamType,
  sourcePath,
  payload,
  originalPath = sourcePath,
  codexPayload = payload,
  compatibility = {}
}) {
  const direct = upstreamType === 'compass';
  const publicCompaction = sourcePath === '/v1/responses/compact' && originalPath === '/v1/responses';
  const targetPath = direct
    ? COMPASS_PATHS[sourcePath]
    : sourcePath === '/v1/responses/compact' && !publicCompaction ? CODEX_COMPACT_PATH : CODEX_RESPONSES_PATH;
  const normalizedBody = direct
    ? directUpstreamPayload(payload, sourcePath)
    : sourcePath === '/v1/chat/completions'
      ? normalizeCodexInput({ ...codexPayload, store: false, stream: true }, { native: isBackendMetadataRoute(originalPath) })
      : publicCompaction
        ? normalizeCodexInput(payload, { compact: true })
        : originalPath === '/v1/responses'
          ? publicResponsesPayload(codexPayload)
        : sourcePath === '/v1/responses/compact'
          ? normalizeCodexInput(payload, { compact: true, native: isBackendMetadataRoute(originalPath) })
          : normalizeCodexInput(payload, { native: isBackendMetadataRoute(originalPath) });
  return {
    targetPath,
    body: omitCompatibilityFields(
      normalizedBody,
      compatibility.unsupportedFields,
      new Set(compatibilityOptionalFields(upstreamType, sourcePath))
    )
  };
}

export function projectPublicWebSocketFrame(payload, { generate = true, compatibility = {} } = {}) {
  return {
    type: 'response.create',
    ...omitCompatibilityFields(publicResponsesPayload(payload), compatibility.unsupportedFields, CODEX_OPTIONAL_FALLBACK_FIELDS),
    generate
  };
}

async function requestUpstream(request, fetchImpl, downstream = null, upstreamDeadlines = {}, codexHostHealth = null, pacing = null) {
  const abort = downstream ? downstreamAbortSignal(downstream.req, downstream.res) : null;
  const diagnostics = pacing?.store && pacing.attemptId ? gatewayDiagnosticsForStore(pacing.store) : null;
  try {
    if (pacing?.store && pacing.upstreamId) {
      const pacingResult = await upstreamPacerForStore(pacing.store).acquire(pacing.upstreamId, {
        model: pacing.model,
        signal: abort?.signal,
        queue: pacing.queue
      });
      diagnostics?.queueWaited(pacing.attemptId, pacingResult.waitedMs);
    }
    diagnostics?.connectionStarted(pacing.attemptId);
    const response = await withCodexHostHealth(codexHostHealth, request.url, () => fetchWithHeaderDeadline(fetchImpl, request.url, {
        method: request.method || 'POST',
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: abort?.signal
      }, upstreamDeadlines));
    diagnostics?.responseHeaders(pacing.attemptId);
    return response;
  } catch (error) {
    if (error instanceof PacingError) throw error;
    if (error?.codexHostCircuitOpen) throw error;
    const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError';
    const wrapped = new Error(timedOut ? 'Upstream request timed out' : 'Upstream request failed');
    wrapped.statusCode = 502;
    wrapped.cause = error;
    wrapped.upstreamFailureKind = abort?.signal.reason?.message === 'Downstream request closed'
      ? 'cancelled'
      : timedOut ? 'timeout' : 'transport';
    if (error?.codexHostPreconnect) {
      wrapped.codexHostPreconnect = true;
      wrapped.codexHostPreconnectCode = error.codexHostPreconnectCode;
    }
    throw wrapped;
  } finally {
    abort?.cleanup();
  }
}

function localHostFailureResponse(retryAfterSeconds) {
  return new Response(null, {
    status: 503,
    headers: { 'retry-after': String(Math.max(1, Number(retryAfterSeconds) || 1)) }
  });
}

function localPacingResponse(error) {
  return new Response(null, {
    status: 429,
    headers: { 'retry-after': String(Math.max(1, Number(error?.retryAfterSeconds) || 1)) }
  });
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

async function compatibilityFallback(response, upstream, sourcePath, payload, request, current) {
  if (![400, 422].includes(response.status)) return null;
  let text;
  let body;
  try {
    const bytes = await readBoundedResponse(response.clone());
    text = bytes.toString('utf8');
    body = parseJson(bytes);
  } catch {
    return null;
  }
  if (upstream.type === 'codex') {
    const field = rejectedParameter(body, text);
    const requestBody = parseJson(Buffer.from(request.body));
    if (!CODEX_OPTIONAL_FALLBACK_FIELDS.has(field) || !Object.hasOwn(requestBody || {}, field) || current.unsupportedFields?.includes(field)) return null;
    return { ...current, unsupportedFields: [...new Set([...(current.unsupportedFields || []), field])] };
  }
  if (upstream.type === 'compass'
    && sourcePath === '/v1/messages'
    && payload?.thinking?.type === 'enabled'
    && current.adaptiveThinking !== true
    && adaptiveThinkingRequired(body, text)) {
    return { ...current, adaptiveThinking: true };
  }
  if (upstream.type === 'compass') {
    const field = rejectedParameter(body, text);
    const requestBody = parseJson(Buffer.from(request.body));
    const allowed = new Set(compatibilityOptionalFields('compass', sourcePath));
    if (!allowed.has(field) || !Object.hasOwn(requestBody || {}, field) || current.unsupportedFields?.includes(field)) return null;
    return { ...current, unsupportedFields: [...new Set([...(current.unsupportedFields || []), field])] };
  }
  return null;
}

function adaptiveThinkingRequired(body, text) {
  const messages = [body?.detail, body?.message, body?.error?.message, body?.response?.error?.message, text].filter((value) => typeof value === 'string');
  return messages.some((message) => /\b(?:adaptive thinking (?:is )?required|use adaptive thinking|thinking(?:\.type)? (?:must|should) (?:use|be) adaptive)\b/i.test(message)
    || /["'`]?thinking\.type\.enabled["'`]?\s+is not supported\b/i.test(message));
}

function rejectedParameter(body, text) {
  const param = cleanString(body?.error?.param || body?.response?.error?.param || body?.param);
  if (param && /^[A-Za-z][A-Za-z0-9_]*$/.test(param)) return param;
  const messages = [body?.detail, body?.message, body?.error?.message, body?.response?.error?.message, text].filter((value) => typeof value === 'string');
  for (const message of messages) {
    const match = /unsupported parameter(?:\s*[:=]\s*|\s+)[`'"]?([A-Za-z][A-Za-z0-9_]*)/i.exec(message);
    if (match) return match[1];
    const quoted = /["'`]([A-Za-z][A-Za-z0-9_]*)["'`]\s+(?:is|is currently)\s+not supported\b/i.exec(message);
    if (quoted) return quoted[1];
  }
  return '';
}

function compatibilityFactContext(upstream, sourcePath, payload, req, originalPath, { websocket = false } = {}) {
  return compatibilityContext(upstream, {
    req,
    inheritClient: isBackendMetadataRoute(originalPath),
    websocket,
    sourcePath,
    model: payload?.model,
    anthropicVersion: anthropicHeader(req, 'anthropic-version'),
    anthropicBeta: anthropicHeader(req, 'anthropic-beta')
  });
}

function compatibilityState(upstream, value, sourcePath = '') {
  const allowed = new Set(compatibilityOptionalFields(upstream?.type, sourcePath));
  const unsupportedFields = Array.isArray(value?.unsupportedFields)
    ? [...new Set(value.unsupportedFields.filter((field) => allowed.has(field)))]
    : [];
  return {
    ...(unsupportedFields.length ? { unsupportedFields } : {}),
    ...(upstream?.type === 'compass' && sourcePath === '/v1/messages' && value?.adaptiveThinking === true ? { adaptiveThinking: true } : {})
  };
}

function omitCompatibilityFields(payload, fields, allowed) {
  const blocked = new Set(Array.isArray(fields) ? fields.filter((field) => allowed.has(field)) : []);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !blocked.has(key)));
}

function directUpstreamPayload(payload, sourcePath) {
  if (sourcePath !== '/v1/messages' || payload?.thinking?.type !== 'enabled') return payload;
  const thinking = { ...payload.thinking, type: 'adaptive' };
  delete thinking.budget_tokens;
  const outputConfig = plainObject(payload.output_config) ? { ...payload.output_config } : {};
  if (!cleanString(outputConfig.effort)) outputConfig.effort = cleanString(payload.thinking.effort) || 'medium';
  return { ...payload, thinking, output_config: outputConfig };
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

function validateAnthropicHeaders(req) {
  const version = rawHeader(req, 'anthropic-version');
  if (version !== null && (!version || Buffer.byteLength(version) > FORWARDED_HEADER_MAX_BYTES || !validDateHeader(version))) {
    return 'anthropic-version must be a valid YYYY-MM-DD date';
  }
  const beta = rawHeader(req, 'anthropic-beta');
  if (beta !== null && (!beta || Buffer.byteLength(beta) > FORWARDED_HEADER_MAX_BYTES
    || beta.split(',').some((entry) => !ANTHROPIC_BETA_TOKEN_PATTERN.test(entry.trim())))) {
    return 'anthropic-beta must be a comma-separated list of beta identifiers';
  }
  return null;
}

function validDateHeader(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(timestamp);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function anthropicHeader(req, name) {
  const value = rawHeader(req, name);
  return value === null ? '' : value;
}

function rawHeader(req, name) {
  const value = req?.headers?.[name];
  if (value === undefined) return null;
  return typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
}

function responsesToChat(response, chatPayload = {}) {
  const output = Array.isArray(response.output) ? response.output : [];
  const text = typeof response.output_text === 'string'
    ? response.output_text
    : output.flatMap((item) => item?.content || (typeof item?.text === 'string' ? [{ text: item.text }] : [])).map((item) => typeof item?.text === 'string' ? item.text : '').join('');
  const calls = output.filter((item) => ['function_call', 'custom_tool_call'].includes(item?.type)).map((item) => item.type === 'custom_tool_call'
    ? {
        id: item.call_id || item.id,
        type: 'custom',
        custom: { name: typeof item.name === 'string' ? item.name : 'tool', input: typeof item.input === 'string' ? item.input : '' }
      }
    : {
        id: item.call_id || item.id,
        type: 'function',
        function: { name: typeof item.name === 'string' ? item.name : 'tool', arguments: typeof item.arguments === 'string' ? item.arguments : '' }
      });
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
  const policyFailure = collected?.[TERMINAL_EVENT_TYPE] === 'response.failed'
    && misalignmentPolicyFailure({ response: collected });
  if (policyFailure) return collected;
  const validJsonResponse = collected && typeof collected === 'object' && !Array.isArray(collected) && typeof collected.id === 'string' && !collected.error;
  if (!validJsonResponse || collected.status === 'failed' || collected[TERMINAL_EVENT_TYPE] === 'response.failed') {
    throw new Error('Invalid upstream response terminal');
  }
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

async function streamResponse({ response, res, sourcePath, transformChat, sanitizePublicResponses, publicResponsesNamespaces, store, upstream, admission = null, attemptId, startedAt, payload, accounting, lifecycle = null, responseStatusCode = null, responseOptions = {}, upstreamDeadlines = {}, onSuccessfulTerminal = null, logger = null }) {
  const headers = responseHeaders(response, transformChat || sanitizePublicResponses ? 'text/event-stream' : null, responseOptions);
  res.writeHead(response.status, headers);
  const reader = response.body?.getReader();
  if (!reader) {
    if (transformChat) res.end(chatStreamFailure());
    else if (sanitizePublicResponses) res.end(publicStreamFailure());
    else res.end();
    finalizeGatewayFailure(store, lifecycle, attemptId, { errorCode: 'upstream_stream_failed', responseStatusCode });
    return;
  }
  let downstreamClosed = false;
  let visible = false;
  let terminal = false;
  let completed = false;
  let usage;
  let healthOutcome = null;
  let parserState = createSseParserState();
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
    if (hasSseData(event)) gatewayDiagnosticsForStore(store).firstSseEvent(attemptId);
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
    const successfulTerminal = successfulSseTerminal(parsed, upstream.type, sourcePath);
    if (['response.failed', 'error'].includes(parsed.type) || parsed.type === 'response.incomplete' && !successfulTerminal) {
      healthOutcome = classifySseEvent(parsed, {
        allowMisalignmentPolicy: transformChat || sanitizePublicResponses
      });
    }
    if (successfulTerminal) onSuccessfulTerminal?.(parsed.response);
    if (successfulTerminal) healthOutcome = { class: 'success', retryable: false };
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
      healthOutcome = classifySseEvent(parsed, {
        allowMisalignmentPolicy: transformChat || sanitizePublicResponses
      });
      if (transformChat) await writeChunk(res, chatStreamFailure('upstream_response_failed', 'Upstream response failed'));
      else if (sanitizePublicResponses) await writeChunk(res, publicStreamFailure(nextPublicSequence()));
      else await writeChunk(res, `${event}\n\n`);
      void reader.cancel('Upstream terminal event').catch(() => {});
      return;
    }
    if (successfulTerminal) {
      terminal = true;
      completed = true;
    }
    if (parsed) visible = true;
    await writeChunk(res, `${event}\n\n`);
    if (successfulTerminal) void reader.cancel('Upstream terminal event').catch(() => {});
  };
  try {
    while (!downstreamClosed && !terminal) {
      const { done, value } = await readWithIdleDeadline(reader, upstreamDeadlines);
      if (done) break;
      const result = consumeSseChunk(parserState, decoder.decode(value, { stream: true }));
      parserState = result.state;
      if (result.overflow) throw new Error('SSE event exceeded buffer limit');
      for (const event of result.blocks) await relayEvent(event);
    }
    const final = consumeSseChunk(parserState, decoder.decode());
    parserState = final.state;
    if (final.overflow) throw new Error('SSE event exceeded buffer limit');
    for (const event of final.blocks) await relayEvent(event);
    const pending = pendingSseBlock(parserState);
    if (pending.trim() && !terminal) await relayEvent(pending);
    if (!downstreamClosed && visible && !terminal) {
      terminal = true;
      if (transformChat) await writeChunk(res, chatStreamFailure());
      else if (sanitizePublicResponses) await writeChunk(res, publicStreamFailure(nextPublicSequence()));
    }
    if (transformChat && completed && !chatState.terminal && !downstreamClosed) await writeChunk(res, 'data: [DONE]\n\n');
  } catch (error) {
    logProxyFailure(logger, 'stream', upstream.id, error);
    healthOutcome ||= classifyTransportError(error, { clientCancelled: downstreamClosed });
    if (!downstreamClosed && visible && !terminal) {
      terminal = true;
      if (transformChat) await writeChunk(res, chatStreamFailure());
      else if (sanitizePublicResponses) await writeChunk(res, publicStreamFailure(nextPublicSequence()));
    }
  } finally {
    reader.releaseLock();
    if (!res.writableEnded && !res.destroyed) res.end();
    if (completed) settleUsage(store, upstream, attemptId, startedAt, usage, payload, accounting, lifecycle, responseStatusCode);
    else if (lifecycle) finalizeGatewayFailure(store, lifecycle, attemptId, { errorCode: downstreamClosed ? 'downstream_closed' : healthOutcome?.errorCode || 'upstream_stream_failed', responseStatusCode });
    else if (response.ok && usage) settleUsage(store, upstream, attemptId, startedAt, usage, payload, accounting);
    if (admission) {
      const outcome = healthOutcome || (downstreamClosed
        ? { class: 'neutral', retryable: false, transport: 'cancelled' }
        : { class: 'transient', retryable: true, transport: 'incomplete_stream' });
      store.settleUpstreamAttempt(upstream.id, admission, outcome);
    }
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

function successfulSseTerminal(event, upstreamType, sourcePath) {
  if (upstreamType === 'compass' && sourcePath === '/v1/messages' && event?.type === 'message_stop') return true;
  return ['response.completed', 'response.incomplete'].includes(event?.type)
    && event.response?.status !== 'failed'
    && !event.error
    && !event.response?.error;
}

function gatewayOutcomeCode(outcome) {
  if (outcome?.class === 'caller') return outcome.modelNotFound ? 'upstream_model_unavailable' : 'upstream_request_rejected';
  if (outcome?.class === 'credential') return 'upstream_authentication_failed';
  if (outcome?.class === 'quota') return 'upstream_quota_exhausted';
  if (outcome?.class === 'transient') return 'upstream_response_failed';
  return 'upstream_response_failed';
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
    if (lifecycle) store.finalizeGatewayRequest({ requestId: lifecycle.id, attemptId, status: 'succeeded', responseStatusCode, usage, settledCostMicros: settlement?.settledCostMicros ?? null, costSource: settlement?.costSource ?? null });
    else {
      store.recordGatewayUsage({ ...accounting, attemptId, startedAt, usage, settledCostMicros: settlement?.settledCostMicros ?? null });
      if (settlement) store.addUsage(upstream.id, { attemptId, startedAt, ...settlement });
    }
    if (settlement) store.addSessionUsage(accounting.sessionId, upstream.id, settlement.settledCostMicros, accounting.scopeId, accounting.apiKeyId);
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

function sendFailure(res, extraHeaders = {}) {
  const failure = upstreamFailure();
  sendJson(res, failure.status, failure.body, extraHeaders);
}

function retryAfterHeader(response) {
  const value = response?.headers?.get?.('retry-after');
  return typeof value === 'string' && value.length <= 1_024 && !/[\x00-\x1f\x7f]/.test(value)
    ? { 'retry-after': value }
    : {};
}

function isEventStream(response) {
  return response.headers.get('content-type')?.includes('text/event-stream');
}

function writeResponse(res, response, body, responseOptions = {}) {
  res.writeHead(response.status, responseHeaders(response, null, responseOptions));
  res.end(body);
}

function responseHeaders(response, contentType = null, { relayTurnState = false, modelsEtag = null, nativeResponseControls = false } = {}) {
  const headers = { 'content-type': contentType || response.headers.get('content-type') || 'application/json' };
  for (const name of ['cache-control', 'content-disposition', 'request-id', 'retry-after', 'x-request-id']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  for (const [name, value] of response.headers) {
    if ((name.startsWith('anthropic-ratelimit-') || name.startsWith('x-ratelimit-')) && validResponseControlValue(value, true)) headers[name] = value;
  }
  if (relayTurnState) {
    const turnState = response.headers.get('x-codex-turn-state');
    if (turnState) headers['x-codex-turn-state'] = turnState;
  }
  if (nativeResponseControls) Object.assign(headers, nativeResponseControlHeaders(response.headers));
  if (modelsEtag) headers['x-models-etag'] = modelsEtag;
  return headers;
}

function nativeResponseControlHeaders(headers) {
  const projected = {};
  for (const [outputName, inputNames, presence = false] of [
    ['openai-model', ['openai-model', 'x-openai-model']],
    ['x-reasoning-included', ['x-reasoning-included'], true],
    ['x-codex-safety-buffering-enabled', ['x-codex-safety-buffering-enabled'], true],
    ['x-codex-safety-buffering-faster-model', ['x-codex-safety-buffering-faster-model']]
  ]) {
    const value = inputNames.map((name) => headers.get(name)).find((candidate) => validResponseControlValue(candidate, presence));
    if (value !== undefined) projected[outputName] = presence ? 'true' : value;
  }
  return projected;
}

function validResponseControlValue(value, presence = false) {
  return typeof value === 'string'
    && Buffer.byteLength(value) >= (presence ? 0 : 1)
    && Buffer.byteLength(value) <= 1024
    && !/[\x00-\x1f\x7f]/.test(value);
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
  return { scopeId: requestScopeId(req), apiKeyId: req.proxyAuth?.id || null, sessionId: sessionAffinity(req) };
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

export async function proxyRawRequest({ req, res, path, body, store, apiKey = process.env.CODEX_POOLER_API_KEY, fetchImpl = globalThis.fetch, upstreamDeadlines = {}, codexHostHealth = codexHostHealthForStore(store) }) {
  if (!validApiKey(req, apiKey)) {
    sendJson(res, 401, { error: { type: 'authentication_error', message: 'Invalid API key' } }, { 'www-authenticate': 'Bearer' });
    return;
  }
  const upstream = chooseRawUpstream(store, req);
  if (!upstream) return sendRoutingError(res, store, req, 'No eligible Codex upstream is available');
  const scope = { model: '', routeClass: 'raw_native' };
  let admission = store.beginUpstreamAttempt(upstream.id, scope);
  if (!admission) return sendRoutingError(res, store, req, 'No eligible Codex upstream is available');
  const credentials = store.credentials(upstream.id);
  const startedAt = new Date().toISOString();
  const attemptId = randomUUID();
  let response;
  try {
    const refreshed = await ensureProviderCredentials(upstream, credentials, {
      fetchImpl,
      saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
    });
    if (refreshed) {
      store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false });
      admission = store.beginUpstreamAttempt(upstream.id, scope);
      if (!admission) return sendRoutingError(res, store, req, 'No eligible Codex upstream is available');
    }
  } catch {
    store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false });
    sendFailure(res);
    return;
  }
  try {
    let request = buildRawRequest(upstream, req, path, body, credentials);
    response = await requestUpstream(request, fetchImpl, { req, res }, upstreamDeadlines, codexHostHealth, {
      store,
      upstreamId: upstream.id
    });
    persistResponseCookies(response, upstream, credentials, store);
    if ((response.status === 401 || response.status === 403) && credentials.refreshToken && rawMethodIsSafe(req.method)) {
      try {
        const refreshed = await refreshProviderCredentials(upstream, credentials, {
          fetchImpl,
          saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
        });
        if (refreshed) {
          store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false });
          admission = store.beginUpstreamAttempt(upstream.id, scope);
          if (!admission) return sendRoutingError(res, store, req, 'No eligible Codex upstream is available');
        }
      } catch {
        store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false });
        sendFailure(res);
        return;
      }
      request = buildRawRequest(upstream, req, path, body, credentials);
      response = await requestUpstream(request, fetchImpl, { req, res }, upstreamDeadlines, codexHostHealth, {
        store,
        upstreamId: upstream.id
      });
      persistResponseCookies(response, upstream, credentials, store);
    }
  } catch (error) {
    if (error instanceof PacingError) {
      try { store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false }); } catch {}
      if (error.code === 'aborted') return;
      if (error.code === 'account_removed') {
        sendRoutingError(res, store, req, 'No eligible Codex upstream is available');
        return;
      }
      const failure = pacingUnavailable(error);
      sendJson(res, failure.status, failure.body, failure.headers);
      return;
    }
    if (error?.codexHostPreconnect || error?.codexHostCircuitOpen) {
      store.settleUpstreamAttempt(upstream.id, admission, { class: 'neutral', retryable: false });
      if (error.codexHostCircuitOpen) {
        const failure = codexHostUnavailable(error.retryAfterSeconds);
        sendJson(res, failure.status, failure.body, failure.headers);
      } else {
        sendFailure(res);
      }
      return;
    }
    store.settleUpstreamAttempt(upstream.id, admission, classifyTransportError(error, { clientCancelled: error?.upstreamFailureKind === 'cancelled' }));
    sendFailure(res);
    return;
  }
  if (!response.ok) {
    const structuredBody = parseJson(await readBoundedResponse(response.clone(), 1024 * 1024, upstreamDeadlines));
    store.settleUpstreamAttempt(upstream.id, admission, classifyHttpResponse(response, structuredBody));
    await readBoundedResponse(response, 1024 * 1024, upstreamDeadlines);
    sendFailure(res, retryAfterHeader(response));
    return;
  }
  const sessionId = sessionAffinity(req);
  if (sessionId) store.pinSession(sessionId, upstream.id, requestScopeId(req), requestAccounting(req).apiKeyId);
  if (isEventStream(response)) {
    let streamUsage;
    let terminalEvent = null;
    try {
      const streamed = await streamPassthrough(response, res, (event) => {
        streamUsage = mergeUsage(streamUsage, extractUsage(event));
        if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event.type)) terminalEvent = event;
      }, upstreamDeadlines);
      const outcome = streamed.cancelled
        ? { class: 'neutral', retryable: false }
        : terminalEvent
          ? classifySseEvent(terminalEvent)
          : { class: 'transient', retryable: true };
      store.settleUpstreamAttempt(upstream.id, admission, outcome);
      if (['response.completed', 'response.incomplete'].includes(terminalEvent?.type) && streamUsage) {
        settleUsage(store, upstream, attemptId, startedAt, streamUsage, {}, requestAccounting(req));
      }
    } catch (error) {
      store.settleUpstreamAttempt(upstream.id, admission, classifyTransportError(error, { clientCancelled: error?.upstreamFailureKind === 'cancelled' }));
      if (!res.headersSent) sendFailure(res);
      else res.destroy();
    }
    return;
  }
  let bytes;
  try {
    bytes = await readResponseBytes(response, 16 * 1024 * 1024, upstreamDeadlines);
  } catch (error) {
    store.settleUpstreamAttempt(upstream.id, admission, classifyTransportError(error));
    throw error;
  }
  store.settleUpstreamAttempt(upstream.id, admission, { class: 'success', retryable: false });
  settleUsage(store, upstream, attemptId, startedAt, parseJson(bytes), {}, requestAccounting(req));
  writeResponse(res, response, bytes);
}

export async function proxyModelsRequest({ req, res, path, store, apiKey = process.env.CODEX_POOLER_API_KEY, fetchImpl = globalThis.fetch, upstreamDeadlines = {}, codexHostHealth = codexHostHealthForStore(store) }) {
  if (!validApiKey(req, apiKey)) {
    sendJson(res, 401, { error: { type: 'authentication_error', message: 'Invalid API key' } }, { 'www-authenticate': 'Bearer' });
    return;
  }
  const catalog = await modelCatalogForStore(store).resolve(requestScopeId(req), { fetchImpl, upstreamDeadlines, codexHostHealth });
  if (path === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: catalog.publicModels }, { etag: catalog.publicEtag });
  } else {
    sendJson(res, 200, { models: catalog.nativeModels }, { etag: catalog.etag });
  }
}

function chooseRawUpstream(store, req) {
  const scopeId = requestScopeId(req);
  const sessionId = sessionAffinity(req);
  const apiKeyId = requestAccounting(req).apiKeyId;
  const pinnedId = store.sessionUpstream(sessionId, scopeId, apiKeyId);
  const rotationUpstreamId = store.sessionRotationUpstream(sessionId, scopeId, apiKeyId);
  const requestedId = header(req, 'x-upstream-id');
  const candidates = store.candidatePlan({
    affinityId: pinnedId,
    requestedId,
    preferredType: 'codex',
    requiredType: 'codex',
    rotateFromId: pinnedId || requestedId ? '' : rotationUpstreamId,
    scopeId,
    routeClass: 'raw_native'
  });
  const chosen = candidates[0];
  return chosen ? store.get(chosen.id, scopeId) : null;
}

function rawMethodIsSafe(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase());
}

function buildRawRequest(upstream, req, path, body, credentials) {
  return {
    method: req.method,
    url: `${defaultBaseUrl(upstream.type)}${rawTargetPath(path)}`,
    headers: rawHeaders(upstream, credentials, req, { inheritClient: true }),
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

function rawHeaders(upstream, credentials, req, protocolOptions = {}) {
  const headers = {
    authorization: `Bearer ${credentials.accessToken || credentials.projectKey}`,
    accept: typeof req.headers.accept === 'string' ? req.headers.accept : '*/*'
  };
  if (typeof req.headers['content-type'] === 'string') headers['content-type'] = req.headers['content-type'];
  if (upstream.type === 'codex') Object.assign(headers, codexProtocolHeaders(req, protocolOptions), codexCookieHeaders(credentials), upstream.accountId ? { 'chatgpt-account-id': upstream.accountId } : {});
  return headers;
}

function persistResponseCookies(response, upstream, credentials, store) {
  if (upstream.type === 'codex' && captureCodexCookies(response, credentials)) {
    store.persistCredentials(upstream.id, credentials, upstream.accessTokenExpiresAt);
  }
}

async function streamPassthrough(response, res, onEvent = null, upstreamDeadlines = {}) {
  res.writeHead(response.status, responseHeaders(response));
  const reader = response.body?.getReader();
  if (!reader) {
    res.end();
    return { cancelled: false };
  }
  let parserState = createSseParserState();
  let downstreamClosed = false;
  const decoder = new TextDecoder();
  const observe = (chunk, final = false) => {
    if (!onEvent) return;
    const result = consumeSseChunk(parserState, decoder.decode(chunk, { stream: !final }));
    parserState = result.state;
    if (result.overflow) return;
    const pending = final ? pendingSseBlock(parserState) : '';
    const blocks = pending.trim()
      ? [...result.blocks, pending]
      : result.blocks;
    for (const block of blocks) {
      const decoded = decodeSseBlock(block);
      if (decoded.kind === 'event') onEvent(decoded.event);
    }
  };
  res.once('close', () => {
    downstreamClosed = true;
    void reader.cancel('Downstream closed').catch(() => {});
  });
  try {
    while (true) {
      const { done, value } = await readWithIdleDeadline(reader, upstreamDeadlines);
      if (done) break;
      observe(value);
      await writeChunk(res, Buffer.from(value));
    }
    observe(new Uint8Array(), true);
    return { cancelled: downstreamClosed };
  } catch (error) {
    if (downstreamClosed) {
      throw Object.assign(new Error('Downstream closed', { cause: error }), { upstreamFailureKind: 'cancelled' });
    }
    throw error;
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

export function attachWebSocketProxy(server, { store, apiKey = process.env.CODEX_POOLER_API_KEY, fetchImpl = globalThis.fetch, websocketUrl, ingress = {}, codexHostHealth = codexHostHealthForStore(store) } = {}) {
  const admission = admissionPolicy(ingress);
  const modelCatalog = modelCatalogForStore(store);
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
      if (isBackendResponsesRoute(path)) {
        req.codexModelsEtag = (await modelCatalog.resolve(requestScopeId(req), { fetchImpl, codexHostHealth })).etag;
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        wss.emit('connection', client, req);
      });
    })().catch(() => socket.destroy());
  });
  wss.on('connection', (client, req) => relayWebSocket(client, req, store, fetchImpl, websocketUrl, websocketIdleMs, modelCatalog, codexHostHealth));
  return wss;
}

async function relayWebSocket(client, req, store, fetchImpl, websocketUrl, websocketIdleMs, modelCatalog = modelCatalogForStore(store), codexHostHealth = codexHostHealthForStore(store)) {
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
  let targetUpstreamId = upstream?.id || null;
  let pendingBytes = 0;
  let publicSequence = 0;
  let publicTurnActive = false;
  let publicAttempt;
  let publicLifecycle;
  let publicPayload;
  let publicUsage;
  let publicState;
  let publicOutput = false;
  let publicStreamId = null;
  let publicGenerate = true;
  let nativeResponseControls = {};
  let nativeMetadataSent = false;
  let retriedTurn = false;
  let publicCompatibilityRetries = 0;
  let activeFrame;
  let turnCandidates = [];
  let turnCandidateIndex = 0;
  let publicAdmission = null;
  const nativeCircuitScope = { model: '', routeClass: 'raw_native' };
  let nativeConnectionAdmission = null;
  let nativeAdmission = null;
  const pending = [];
  const queuedTurns = [];
  let queuedTurnBytes = 0;
  let idleTimer = null;
  const pacingAbort = new AbortController();
  let sendChain = Promise.resolve();
  const socketPacingAborts = new WeakMap();
  const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };
  const settlePublicAdmission = (outcome) => {
    const active = publicAdmission;
    publicAdmission = null;
    if (!active) return;
    try { store.settleUpstreamAttempt(active.upstreamId, active.admission, outcome); } catch {}
  };
  const settleNativeAdmission = (outcome) => {
    const active = nativeAdmission;
    nativeAdmission = null;
    if (!active) return;
    try { store.settleUpstreamAttempt(active.upstreamId, active.admission, outcome); } catch {}
  };
  const settleNativeConnectionAdmission = (outcome) => {
    const active = nativeConnectionAdmission;
    nativeConnectionAdmission = null;
    if (!active) return;
    try { store.settleUpstreamAttempt(active.upstreamId, active.admission, outcome); } catch {}
  };
  const renewPublicAdmission = (candidate) => {
    settlePublicAdmission({ class: 'neutral', retryable: false });
    const scope = { model: publicPayload?.model, routeClass: 'proxy_stream' };
    const admission = store.beginUpstreamAttempt(candidate.id, scope);
    if (!admission) return false;
    publicAdmission = { upstreamId: candidate.id, admission };
    return true;
  };
  const renewNativeAdmissions = (candidate) => {
    const hadTurn = Boolean(nativeAdmission);
    settleNativeAdmission({ class: 'neutral', retryable: false });
    settleNativeConnectionAdmission({ class: 'neutral', retryable: false });
    if (!hadTurn) return true;
    const admission = store.beginUpstreamAttempt(candidate.id, nativeCircuitScope);
    if (!admission) return false;
    nativeAdmission = { upstreamId: candidate.id, admission };
    return true;
  };
  const acquirePublicCandidate = (startIndex, scope) => {
    for (let index = startIndex; index < turnCandidates.length; index += 1) {
      const candidate = turnCandidates[index];
      const admission = store.beginUpstreamAttempt(candidate.id, scope);
      if (!admission) continue;
      return { candidate, index, activeAdmission: { upstreamId: candidate.id, admission } };
    }
    return null;
  };
  const activatePublicCandidate = ({ candidate, index, activeAdmission }) => {
    turnCandidateIndex = index;
    publicAdmission = activeAdmission;
    return candidate;
  };
  const publicWebSocketFrame = (candidate, payload, generate = publicGenerate, compatibilityOverride = null) => {
    const context = compatibilityFactContext(candidate, '/v1/responses', payload, req, '/v1/responses', { websocket: true });
    const compatibility = compatibilityState(candidate, compatibilityOverride || compatibilityLearningForStore(store).activeFact(candidate.id, context));
    return Buffer.from(JSON.stringify(projectPublicWebSocketFrame(payload, { generate, compatibility })));
  };
  const replacePendingPublicFrame = (candidate) => {
    if (!publicTurnActive || !publicPayload) return;
    activeFrame = { data: publicWebSocketFrame(candidate, publicPayload), isBinary: false };
    pending.splice(0, pending.length, activeFrame);
    pendingBytes = activeFrame.data.byteLength;
  };
  const framePacingModel = (frame) => {
    if (!frame || frame.isBinary) return '';
    try {
      const payload = JSON.parse(frame.data.toString());
      return payload?.type === 'response.create' && typeof payload.model === 'string' ? payload.model : '';
    } catch {
      return '';
    }
  };
  const sendFrame = (socket, frame, candidate) => {
    const attemptId = publicResponses ? publicAttempt?.id : null;
    const task = async () => {
      if (socket !== targetSocket || socket.readyState !== WebSocket.OPEN || client.readyState !== WebSocket.OPEN) return;
      const model = framePacingModel(frame);
      if (model) {
        const pacingResult = await upstreamPacerForStore(store).acquire(candidate.id, {
          model,
          signal: socketPacingAborts.get(socket)?.signal || pacingAbort.signal
        });
        gatewayDiagnosticsForStore(store).queueWaited(attemptId, pacingResult.waitedMs);
      }
      if (socket !== targetSocket || socket.readyState !== WebSocket.OPEN || client.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount + frame.data.byteLength > MAX_WEBSOCKET_PENDING_BYTES) {
        closeBoth(1009, 'Websocket backpressure limit exceeded');
        return;
      }
      socket.send(frame.data, { binary: frame.isBinary });
    };
    sendChain = sendChain.then(task, task);
    return sendChain;
  };
  const handleFramePacingFailure = (error) => {
    if (!(error instanceof PacingError) || error.code === 'aborted') return;
    const removed = error.code === 'account_removed';
    if (publicResponses && publicTurnActive) {
      settlePublicAdmission({ class: 'neutral', retryable: false });
      finalizeGatewayFailure(store, publicLifecycle, publicAttempt?.id, {
        errorCode: removed ? 'no_eligible_backend' : `local_pacing_${error.code}`,
        responseStatusCode: removed ? 503 : 429
      });
      publicWebSocketFailure(
        client,
        removed ? 'no_eligible_backend' : error.code === 'queue_expired' ? 'local_pacing_queue_expired' : 'local_pacing_queue_full',
        removed ? 'No eligible Codex upstream is available' : error.message,
        publicSequence++,
        publicStreamId,
        null,
        removed ? 503 : 429
      );
      publicTurnActive = false;
      activeFrame = null;
      publicAttempt = null;
      publicLifecycle = null;
      publicUsage = null;
      publicStreamId = null;
      startNextPublicTurn();
      return;
    }
    settleNativeAdmission({ class: 'neutral', retryable: false });
    client.close(1013, 'Local pacing queue is unavailable');
  };
  const retryPublicWebSocketCompatibility = (frame, candidate) => {
    if (!publicTurnActive || publicOutput || publicCompatibilityRetries >= COMPATIBILITY_RETRY_LIMIT) return false;
    if (!['error', 'response.failed'].includes(frame?.type)) return false;
    const field = rejectedParameter(frame, JSON.stringify(frame));
    if (!CODEX_OPTIONAL_FALLBACK_FIELDS.has(field) || !Object.hasOwn(publicPayload || {}, field)) return false;
    const context = compatibilityFactContext(candidate, '/v1/responses', publicPayload, req, '/v1/responses', { websocket: true });
    const compatibility = compatibilityState(candidate, compatibilityLearningForStore(store).activeFact(candidate.id, context));
    if (compatibility.unsupportedFields?.includes(field)) return false;
    const learned = {
      ...compatibility,
      unsupportedFields: [...new Set([...(compatibility.unsupportedFields || []), field])]
    };
    compatibilityLearningForStore(store).observe({
      upstream: store.get(candidate.id) || candidate,
      context,
      value: learned,
      feature: `unsupported_field:${field}`,
      observationId: publicAttempt?.id || ''
    });
    retryGatewayAttempt(store, publicLifecycle, publicAttempt?.id, { errorCode: 'upstream_compatibility_retry' });
    publicAttempt = publicLifecycle
      ? store.beginGatewayAttempt(publicLifecycle.id, candidate.id)
      : { id: randomUUID(), startedAt: new Date().toISOString() };
    gatewayDiagnosticsForStore(store).credentialStarted(publicAttempt.id);
    gatewayDiagnosticsForStore(store).credentialPrepared(publicAttempt.id);
    publicCompatibilityRetries += 1;
    activeFrame = { data: publicWebSocketFrame(candidate, publicPayload, publicGenerate, learned), isBinary: false };
    if (targetSocket?.readyState === WebSocket.OPEN) {
      void sendFrame(targetSocket, activeFrame, candidate).catch(handleFramePacingFailure);
    }
    else {
      pending.splice(0, pending.length, activeFrame);
      pendingBytes = activeFrame.data.byteLength;
    }
    return true;
  };
  const failActiveTurn = (code, message, outcome = { class: 'transient', retryable: true }) => {
    if (!publicResponses || !publicTurnActive) return;
    publicTurnActive = false;
    activeFrame = null;
    pending.length = 0;
    pendingBytes = 0;
    settlePublicAdmission(outcome);
    finalizeGatewayFailure(store, publicLifecycle, publicAttempt?.id, { errorCode: code });
    publicAttempt = null;
    publicLifecycle = null;
    publicUsage = null;
    publicWebSocketFailure(
      client,
      code === 'codex_host_unavailable' || code === MISALIGNMENT_POLICY_CODE ? code : 'server_error',
      message,
      publicSequence++,
      publicStreamId,
      null,
      code === MISALIGNMENT_POLICY_CODE ? 403 : null
    );
    publicStreamId = null;
    startNextPublicTurn();
  };
  const resetIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      if (publicTurnActive) failActiveTurn('upstream_websocket_idle_timeout', 'Upstream websocket timed out', classifyTransportError(Object.assign(new Error('WebSocket idle timeout'), { upstreamFailureKind: 'timeout' })));
      if (targetSocket?.readyState === WebSocket.OPEN || targetSocket?.readyState === WebSocket.CONNECTING) targetSocket.close(1011, 'Upstream websocket timed out');
    }, websocketIdleMs);
  };
  const startNextPublicTurn = () => {
    const next = queuedTurns.shift();
    if (!next || client.readyState !== WebSocket.OPEN) return;
    queuedTurnBytes -= next.byteLength;
    setImmediate(() => {
      if (client.readyState === WebSocket.OPEN) client.emit('message', next, false);
    });
  };
  const closeBoth = (code = 1000, reason = '') => {
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
    if (targetSocket?.readyState === WebSocket.OPEN || targetSocket?.readyState === WebSocket.CONNECTING) targetSocket.close(code, reason);
  };
  client.on('message', (data, isBinary) => {
    if (client.readyState !== WebSocket.OPEN) return;
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
        const streamId = validateStreamId(frame.stream_id);
        const generate = validateGenerate(frame.generate);
        const { type: _type, generate: _generate, stream_id: _streamId, ...request } = frame;
        const payload = adaptResponsesRequest({ ...request, stream: true });
        const compactionBridge = prepareCompactionTriggerBridge('/v1/responses', payload);
        if (compactionBridge?.error) throw new AdapterError(compactionBridge.error.message, compactionBridge.error.param);
        turnCandidates = chooseUpstreams(store, req, '/v1/responses', payload, '/v1/responses', modelCatalog).map((entry) => store.get(entry.id, requestScopeId(req))).filter((entry) => entry?.type === 'codex');
        const acquired = acquirePublicCandidate(0, { model: payload.model, routeClass: 'proxy_stream' });
        if (!acquired) throw new AdapterError('No eligible Codex upstream');
        const candidate = activatePublicCandidate(acquired);
        const upstreamFrame = publicWebSocketFrame(candidate, payload, generate);
        const lifecycle = accounting.apiKeyId
          ? store.reserveGatewayRequest({ scopeId, apiKeyId: accounting.apiKeyId, endpoint: '/v1/responses', model: payload.model || '', transport: 'websocket' })
          : null;
        const attempt = lifecycle
          ? store.beginGatewayAttempt(lifecycle.id, candidate.id)
          : { id: randomUUID(), startedAt: new Date().toISOString() };
        gatewayDiagnosticsForStore(store).credentialStarted(attempt.id);
        data = upstreamFrame;
        publicTurnActive = true;
        publicSequence = 0;
        publicOutput = false;
        publicStreamId = streamId;
        publicGenerate = generate;
        publicPayload = payload;
        publicUsage = null;
        publicState = createPublicResponsesState(customToolNamespaces(payload.tools));
        retriedTurn = false;
        publicCompatibilityRetries = 0;
        activeFrame = { data: upstreamFrame, isBinary: false };
        publicLifecycle = lifecycle;
        publicAttempt = attempt;
        if (compactionBridge) {
          void executePublicWebSocketCompaction(compactionBridge.payload, candidate);
          return;
        }
        const needsConnection = !compactionBridge
          && (!targetSocket || ![WebSocket.OPEN, WebSocket.CONNECTING].includes(targetSocket.readyState) || targetUpstreamId !== candidate.id);
        upstream = candidate;
        if (needsConnection) {
          if (targetSocket?.readyState === WebSocket.OPEN || targetSocket?.readyState === WebSocket.CONNECTING) targetSocket.close();
          credentials = store.credentials(upstream.id);
          targetSocket = undefined;
          targetUpstreamId = null;
          void ensureProviderCredentials(upstream, credentials, { fetchImpl, saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt) }).then((refreshed) => {
            gatewayDiagnosticsForStore(store).credentialPrepared(attempt.id);
            if (refreshed && !renewPublicAdmission(upstream)) {
              failActiveTurn('upstream_credentials_failed', 'No eligible Codex upstream', { class: 'neutral', retryable: false });
              return;
            }
            if (refreshed) replacePendingPublicFrame(upstream);
            void connect().catch(() => failActiveTurn('upstream_connect_failed', 'Upstream websocket connection failed'));
          }).catch(() => {
            gatewayDiagnosticsForStore(store).credentialPrepared(attempt.id);
            failActiveTurn('upstream_credentials_failed', 'No eligible Codex upstream', { class: 'neutral', retryable: false });
          });
        } else {
          gatewayDiagnosticsForStore(store).credentialPrepared(attempt.id);
          gatewayDiagnosticsForStore(store).responseHeaders(attempt.id);
        }
      } catch (error) {
        settlePublicAdmission({ class: 'neutral', retryable: false });
        return publicWebSocketFailure(
          client,
          'invalid_request_error',
          error instanceof AdapterError ? error.message : 'Invalid response.create frame',
          0,
          null,
          error instanceof AdapterError ? error.param : null,
          400
        );
      }
    }
    if (!publicResponses && !nativeAdmission && upstream) {
      settleNativeConnectionAdmission({ class: 'neutral', retryable: false });
      const admission = store.beginUpstreamAttempt(upstream.id, nativeCircuitScope);
      if (!admission) return client.close(1013, 'No eligible Codex upstream is available');
      nativeAdmission = { upstreamId: upstream.id, admission };
    }
    if (targetSocket?.readyState === WebSocket.OPEN) {
      const frame = { data, isBinary };
      void sendFrame(targetSocket, frame, upstream).catch(handleFramePacingFailure);
    } else {
      pendingBytes += data.byteLength;
      if (pendingBytes > MAX_WEBSOCKET_PENDING_BYTES) client.close(1009, 'Pending websocket data exceeded limit');
      else pending.push({ data, isBinary });
    }
  });
  client.on('close', () => {
    pacingAbort.abort(new DOMException('Downstream websocket closed', 'AbortError'));
    if (targetSocket) socketPacingAborts.get(targetSocket)?.abort(new DOMException('Downstream websocket closed', 'AbortError'));
    clearIdle();
    if (publicTurnActive) {
      settlePublicAdmission({ class: 'neutral', retryable: false });
      finalizeGatewayFailure(store, publicLifecycle, publicAttempt?.id, { errorCode: 'downstream_closed' });
    }
    settleNativeAdmission({ class: 'neutral', retryable: false });
    settleNativeConnectionAdmission({ class: 'neutral', retryable: false });
    publicTurnActive = false;
    publicLifecycle = null;
    publicAttempt = null;
    publicStreamId = null;
    pending.length = 0;
    pendingBytes = 0;
    queuedTurns.length = 0;
    queuedTurnBytes = 0;
    if (targetSocket?.readyState === WebSocket.OPEN || targetSocket?.readyState === WebSocket.CONNECTING) targetSocket.close();
    targetSocket = undefined;
    targetUpstreamId = null;
  });
  client.on('error', () => closeBoth(1011, 'Client websocket error'));

  const retryPublicTurn = (outcome = { class: 'transient', retryable: true }) => {
    if (!publicResponses || !publicTurnActive || publicOutput || retriedTurn || !activeFrame) return false;
    settlePublicAdmission(outcome);
    const acquired = acquirePublicCandidate(turnCandidateIndex + 1, { model: publicPayload.model, routeClass: 'proxy_stream' });
    if (!acquired) return false;
    retryGatewayAttempt(store, publicLifecycle, publicAttempt?.id, { errorCode: 'upstream_websocket_retryable_failure' });
    retriedTurn = true;
    const fallback = activatePublicCandidate(acquired);
    upstream = fallback;
    credentials = store.credentials(upstream.id);
    const previousSocket = targetSocket;
    targetSocket = undefined;
    targetUpstreamId = null;
    if (previousSocket?.readyState === WebSocket.OPEN || previousSocket?.readyState === WebSocket.CONNECTING) previousSocket.close();
    publicAttempt = publicLifecycle
      ? store.beginGatewayAttempt(publicLifecycle.id, upstream.id)
      : { id: randomUUID(), startedAt: new Date().toISOString() };
    const retryAttemptId = publicAttempt.id;
    gatewayDiagnosticsForStore(store).credentialStarted(retryAttemptId);
    activeFrame = { data: publicWebSocketFrame(upstream, publicPayload), isBinary: false };
    pending.splice(0, pending.length, activeFrame);
    pendingBytes = activeFrame.data.byteLength;
    void ensureProviderCredentials(upstream, credentials, {
      fetchImpl,
      saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
    }).then((refreshed) => {
      gatewayDiagnosticsForStore(store).credentialPrepared(retryAttemptId);
      if (refreshed && !renewPublicAdmission(upstream)) {
        failActiveTurn('upstream_credentials_failed', 'Upstream response failed', { class: 'neutral', retryable: false });
        return;
      }
      if (refreshed) replacePendingPublicFrame(upstream);
      void connect().catch(() => failActiveTurn('upstream_connect_failed', 'Upstream websocket connection failed'));
    }).catch(() => {
      gatewayDiagnosticsForStore(store).credentialPrepared(retryAttemptId);
      failActiveTurn('upstream_credentials_failed', 'Upstream response failed', { class: 'neutral', retryable: false });
    });
    return true;
  };

  const executePublicWebSocketCompaction = async (compactPayload, candidate) => {
    try {
      const candidateCredentials = store.credentials(candidate.id);
      const refreshed = await ensureProviderCredentials(candidate, candidateCredentials, {
        fetchImpl,
        saveCredentials: (updated, expiresAt) => store.persistCredentials(candidate.id, updated, expiresAt)
      });
      if (refreshed && !renewPublicAdmission(candidate)) throw new Error('Codex upstream is not currently eligible');
      if (!publicTurnActive || client.readyState !== WebSocket.OPEN) return;
      let compatibilityScope = compatibilityFactContext(candidate, '/v1/responses/compact', compactPayload, req, '/v1/responses');
      let compatibility = compatibilityState(candidate, compatibilityLearningForStore(store).activeFact(candidate.id, compatibilityScope));
      let request = buildRequest(candidate, '/v1/responses/compact', compactPayload, req, candidateCredentials, '/v1/responses', compactPayload, compatibility);
      let response = await requestUpstream(request, fetchImpl, { req: null, res: client }, {}, codexHostHealth, {
        store,
        upstreamId: candidate.id,
        model: compactPayload?.model
      });
      const initialPolicyFailure = [400, 403].includes(response.status)
        ? misalignmentPolicyFailure(parseJson(await readBoundedResponse(response.clone())))
        : null;
      if ((response.status === 401 || response.status === 403) && !initialPolicyFailure && candidateCredentials.refreshToken) {
        try {
          const refreshed = await refreshProviderCredentials(candidate, candidateCredentials, {
            fetchImpl,
            saveCredentials: (updated, expiresAt) => store.persistCredentials(candidate.id, updated, expiresAt)
          });
          if (refreshed && !renewPublicAdmission(candidate)) throw new Error('Codex upstream is not currently eligible');
          if (refreshed) {
            compatibilityScope = compatibilityFactContext(store.get(candidate.id) || candidate, '/v1/responses/compact', compactPayload, req, '/v1/responses');
            compatibility = compatibilityState(candidate, compatibilityLearningForStore(store).activeFact(candidate.id, compatibilityScope));
          }
          request = buildRequest(candidate, '/v1/responses/compact', compactPayload, req, candidateCredentials, '/v1/responses', compactPayload, compatibility);
          response = await requestUpstream(request, fetchImpl, { req: null, res: client }, {}, codexHostHealth, {
            store,
            upstreamId: candidate.id,
            model: compactPayload?.model
          });
        } catch (error) {
          settlePublicAdmission({ class: 'neutral', retryable: false });
          throw Object.assign(error, { upstreamOutcomeSettled: true });
        }
      }
      for (let retries = 0; retries < COMPATIBILITY_RETRY_LIMIT; retries += 1) {
        const learned = await compatibilityFallback(response, candidate, '/v1/responses/compact', compactPayload, request, compatibility);
        if (!learned) break;
        const feature = compatibilityEvidenceFeature(compatibility, learned);
        compatibility = learned;
        compatibilityLearningForStore(store).observe({
          upstream: store.get(candidate.id) || candidate,
          context: compatibilityScope,
          value: compatibility,
          feature,
          observationId: publicAttempt?.id || ''
        });
        void response.body?.cancel('Retrying WebSocket compaction with provider-directed compatibility fallback').catch(() => {});
        request = buildRequest(candidate, '/v1/responses/compact', compactPayload, req, candidateCredentials, '/v1/responses', compactPayload, compatibility);
        response = await requestUpstream(request, fetchImpl, { req: null, res: client }, {}, codexHostHealth, {
          store,
          upstreamId: candidate.id,
          model: compactPayload?.model
        });
      }
      if (!response.ok) {
        const body = parseJson(await readBoundedResponse(response.clone()));
        const outcome = classifyHttpResponse(response, body, { allowMisalignmentPolicy: true });
        settlePublicAdmission(outcome);
        throw Object.assign(new Error('Upstream compact request failed'), {
          upstreamOutcomeSettled: true,
          policyFailure: [400, 403].includes(response.status) ? misalignmentPolicyFailure(body) : null
        });
      }
      const decoded = parseJson(await readResponseBytes(response));
      const compact = compactionBridgeResult(decoded, true);
      if (!compact) throw new Error('Invalid upstream compact response');
      const events = [
        { type: 'response.output_item.done', item: compact.item, sequence_number: publicSequence++ },
        { type: 'response.completed', response: compact.response, sequence_number: publicSequence++ }
      ];
      for (const event of events) {
        const encoded = JSON.stringify(publicStreamId ? { ...event, stream_id: publicStreamId } : event);
        if (client.readyState === WebSocket.OPEN) client.send(encoded);
      }
      if (sessionId) store.pinSession(sessionId, candidate.id, scopeId, accounting.apiKeyId);
      learnResponsePin(store, compact.response, candidate.id, scopeId, accounting.apiKeyId);
      if (publicAttempt) {
        settleUsage(store, candidate, publicAttempt.id, publicAttempt.startedAt, decoded, publicPayload, accounting, publicLifecycle, response.status);
      }
      settlePublicAdmission({ class: 'success', retryable: false });
      publicTurnActive = false;
      activeFrame = null;
      publicAttempt = null;
      publicLifecycle = null;
      publicUsage = null;
      publicStreamId = null;
      startNextPublicTurn();
    } catch (error) {
      if (error instanceof PacingError) {
        settlePublicAdmission({ class: 'neutral', retryable: false });
        const removed = error.code === 'account_removed';
        if (client.readyState === WebSocket.OPEN) {
          publicWebSocketFailure(
            client,
            removed ? 'no_eligible_backend' : error.code === 'queue_expired' ? 'local_pacing_queue_expired' : 'local_pacing_queue_full',
            removed ? 'No eligible Codex upstream is available' : error.message,
            publicSequence++,
            publicStreamId,
            null,
            removed ? 503 : 429
          );
        }
        publicTurnActive = false;
        activeFrame = null;
        publicAttempt = null;
        publicLifecycle = null;
        publicUsage = null;
        publicStreamId = null;
        startNextPublicTurn();
        return;
      }
      if (error?.policyFailure) {
        failActiveTurn(error.policyFailure.code, error.policyFailure.message, {
          class: 'neutral',
          retryable: false,
          errorCode: error.policyFailure.code
        });
        return;
      }
      failActiveTurn(
        'invalid_compaction_response',
        'Upstream compact response failed',
        error?.upstreamOutcomeSettled ? { class: 'neutral', retryable: false } : classifyTransportError(error)
      );
    }
  };

  const connect = async (authenticationRetried = false, connectionUpstream = upstream, connectionCredentials = credentials) => {
    if (client.readyState !== WebSocket.OPEN || publicResponses && (!publicTurnActive || upstream?.id !== connectionUpstream?.id)) return;
    if (!publicResponses && !nativeConnectionAdmission && !nativeAdmission) {
      const admission = store.beginUpstreamAttempt(connectionUpstream.id, nativeCircuitScope);
      if (!admission) {
        client.close(1013, 'No eligible Codex upstream is available');
        return;
      }
      nativeConnectionAdmission = { upstreamId: connectionUpstream.id, admission };
    }
    try {
      const pacingResult = await upstreamPacerForStore(store).acquire(connectionUpstream.id, {
        model: publicResponses ? publicPayload?.model : '',
        signal: pacingAbort.signal
      });
      if (publicResponses) gatewayDiagnosticsForStore(store).queueWaited(publicAttempt?.id, pacingResult.waitedMs);
    } catch (error) {
      if (error instanceof PacingError) {
        if (publicResponses) handleFramePacingFailure(error);
        else {
          settleNativeConnectionAdmission({ class: 'neutral', retryable: false });
          settleNativeAdmission({ class: 'neutral', retryable: false });
          if (error.code !== 'aborted') client.close(1013, 'Local pacing queue is unavailable');
        }
        return;
      }
      throw error;
    }
    if (client.readyState !== WebSocket.OPEN || publicResponses && (!publicTurnActive || upstream?.id !== connectionUpstream?.id)) return;
    const target = websocketUrl?.(connectionUpstream) || `${defaultBaseUrl(connectionUpstream.type).replace(/^http/, 'ws')}/backend-api/codex/responses`;
    if (publicResponses) gatewayDiagnosticsForStore(store).connectionStarted(publicAttempt?.id);
    const hostAdmission = codexHostHealth.begin(target);
    if (!hostAdmission.admitted) {
      const outcome = { class: 'neutral', retryable: false };
      if (publicResponses && publicTurnActive) {
        failActiveTurn('codex_host_unavailable', 'Codex host is temporarily unreachable', outcome);
      } else {
        settleNativeConnectionAdmission(outcome);
        settleNativeAdmission(outcome);
        client.close(1013, 'Codex host is temporarily unreachable');
      }
      return;
    }
    let socket;
    try {
      socket = new WebSocket(target, {
        headers: {
          ...rawHeaders(connectionUpstream, connectionCredentials, req, { inheritClient: !publicResponses, websocket: true }),
          ...(publicResponses ? {} : backendWebSocketMetadata(req)),
          origin: 'https://chatgpt.com'
        },
        handshakeTimeout: 120_000,
        maxPayload: MAX_WEBSOCKET_PENDING_BYTES
      });
    } catch (error) {
      codexHostHealth.release(hostAdmission.lease);
      throw error;
    }
    let refreshingConnection = false;
    let socketTransportOutcome = null;
    let hostLease = hostAdmission.lease;
    const socketPacingAbort = new AbortController();
    socketPacingAborts.set(socket, socketPacingAbort);
    const settleHostResponse = () => {
      if (!hostLease) return;
      codexHostHealth.settleResponse(hostLease);
      hostLease = null;
    };
    const settleHostError = (error) => {
      if (!hostLease) return { preconnect: false, open: false };
      const outcome = codexHostHealth.settleError(hostLease, error);
      hostLease = null;
      return outcome;
    };
    const releaseHostLease = () => {
      if (!hostLease) return;
      codexHostHealth.release(hostLease);
      hostLease = null;
    };
    targetSocket = socket;
    targetUpstreamId = connectionUpstream.id;
    socket.on('upgrade', (response) => {
      settleHostResponse();
      if (publicResponses) gatewayDiagnosticsForStore(store).responseHeaders(publicAttempt?.id);
      if (socket === targetSocket && !publicResponses) nativeResponseControls = nativeResponseControlHeaders(new Headers(response.headers));
    });
    socket.on('open', () => {
      settleHostResponse();
      if (socket !== targetSocket || client.readyState !== WebSocket.OPEN) return socket.close();
      if (!publicResponses) settleNativeConnectionAdmission({ class: 'neutral', retryable: false });
      resetIdle();
      for (const frame of pending.splice(0)) void sendFrame(socket, frame, connectionUpstream).catch(handleFramePacingFailure);
      pendingBytes = 0;
    });
    socket.on('message', (data, isBinary) => {
      if (socket !== targetSocket || client.readyState !== WebSocket.OPEN) return;
      resetIdle();
      if (publicResponses) {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
        gatewayDiagnosticsForStore(store).firstSseEvent(publicAttempt?.id);
        if (retryPublicWebSocketCompatibility(frame, connectionUpstream)) return;
        const frameOutcome = classifySseEvent(frame, { allowMisalignmentPolicy: true });
        if (!publicOutput && frameOutcome.retryable) {
          if (modelNotFoundFailure(frame)) modelCatalog.markUnsupported(connectionUpstream.id, publicPayload?.model);
          if (retryPublicTurn(frameOutcome)) return;
        }
        const projected = normalizePublicResponsesEvent(frame, publicState);
        if (!projected.length) return;
        const events = projected.map((block) => decodeSseBlock(block)).filter((decoded) => decoded.kind === 'event').map((decoded) => decoded.event);
        if (!events.length) return;
        publicOutput = true;
        publicUsage = mergeUsage(publicUsage, extractUsage(frame));
        const terminal = events.find((event) => ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type));
        if (sessionId && !terminal?.type?.endsWith('failed')) store.pinSession(sessionId, connectionUpstream.id, scopeId, requestAccounting(req).apiKeyId);
        for (const event of events) {
          const encoded = JSON.stringify(publicStreamId ? { ...event, stream_id: publicStreamId } : event);
          if (client.bufferedAmount + Buffer.byteLength(encoded) > MAX_WEBSOCKET_PENDING_BYTES) return closeBoth(1009, 'Websocket backpressure limit exceeded');
          client.send(encoded);
        }
        if (!terminal) return;
        publicTurnActive = false;
        activeFrame = null;
        if (terminal.type === 'response.failed') {
          const outcome = classifySseEvent(frame, { allowMisalignmentPolicy: true });
          settlePublicAdmission(outcome);
          finalizeGatewayFailure(store, publicLifecycle, publicAttempt?.id, {
            errorCode: outcome.errorCode === MISALIGNMENT_POLICY_CODE ? outcome.errorCode : 'upstream_response_failed'
          });
        }
        else {
          settlePublicAdmission({ class: 'success', retryable: false });
          learnResponsePin(store, terminal.response, connectionUpstream.id, scopeId, accounting.apiKeyId);
          if (publicAttempt) settleUsage(store, connectionUpstream, publicAttempt.id, publicAttempt.startedAt, publicUsage, publicPayload, accounting, publicLifecycle, 200);
        }
        publicAttempt = null;
        publicLifecycle = null;
        publicUsage = null;
        publicStreamId = null;
        clearIdle();
        startNextPublicTurn();
        return;
      }
      let nativeFrame = null;
      if (!isBinary) {
        try { nativeFrame = JSON.parse(data.toString()); } catch {}
      }
      if (nativeFrame && ['error', 'response.failed'].includes(nativeFrame.type)) {
        settleNativeAdmission(classifySseEvent(nativeFrame));
      } else if (nativeFrame && ['response.completed', 'response.incomplete'].includes(nativeFrame.type)) {
        settleNativeAdmission({ class: 'success', retryable: false });
      }
      if (!nativeMetadataSent) {
        nativeMetadataSent = true;
        const metadata = JSON.stringify({
          type: 'codex.response.metadata',
          headers: {
            ...(req.codexModelsEtag ? { 'x-models-etag': req.codexModelsEtag } : {}),
            ...(nativeResponseControls['openai-model'] ? { 'openai-model': nativeResponseControls['openai-model'] } : {})
          }
        });
        if (client.bufferedAmount + Buffer.byteLength(metadata) > MAX_WEBSOCKET_PENDING_BYTES) return closeBoth(1009, 'Websocket backpressure limit exceeded');
        client.send(metadata);
      }
      const sanitized = sanitizeNativeResponseControlFrame(data, isBinary);
      if (client.bufferedAmount + sanitized.byteLength > MAX_WEBSOCKET_PENDING_BYTES) closeBoth(1009, 'Websocket backpressure limit exceeded');
      else client.send(sanitized, { binary: isBinary });
    });
    socket.on('unexpected-response', async (_request, response) => {
      settleHostResponse();
      if (socket !== targetSocket || client.readyState !== WebSocket.OPEN) {
        response.resume();
        return;
      }
      const body = await readWebSocketHandshakeBody(response);
      if (socket !== targetSocket || client.readyState !== WebSocket.OPEN) return;
      const policyFailure = publicResponses && [400, 403].includes(response.statusCode)
        ? misalignmentPolicyFailure(body)
        : null;
      if (policyFailure && publicTurnActive) {
        failActiveTurn(policyFailure.code, policyFailure.message, { class: 'neutral', retryable: false, errorCode: policyFailure.code });
      } else if (!authenticationRetried && connectionCredentials.refreshToken && (response.statusCode === 401 || response.statusCode === 403)) {
        refreshingConnection = true;
        try {
          const refreshed = await refreshProviderCredentials(connectionUpstream, connectionCredentials, {
            fetchImpl,
            saveCredentials: (updated, expiresAt) => store.persistCredentials(connectionUpstream.id, updated, expiresAt)
          });
          if (refreshed) {
            const renewed = publicResponses
              ? renewPublicAdmission(connectionUpstream)
              : renewNativeAdmissions(connectionUpstream);
            if (!renewed) throw new Error('Codex upstream is not currently eligible');
            if (publicResponses) replacePendingPublicFrame(connectionUpstream);
          }
          if (socket === targetSocket) {
            targetSocket = undefined;
            targetUpstreamId = null;
          }
          void connect(true, connectionUpstream, connectionCredentials).catch((error) => {
            if (client.readyState !== WebSocket.OPEN) return;
            if (publicResponses && publicTurnActive) failActiveTurn('upstream_connect_failed', 'Upstream websocket connection failed');
            else closeBoth(1011, error.message || 'Upstream websocket connection failed');
          });
        } catch (error) {
          if (client.readyState !== WebSocket.OPEN) return;
          if (publicResponses && publicTurnActive) failActiveTurn('upstream_credentials_failed', 'Upstream websocket authentication failed', { class: 'neutral', retryable: false });
          else {
            settleNativeAdmission({ class: 'neutral', retryable: false });
            settleNativeConnectionAdmission({ class: 'neutral', retryable: false });
            closeBoth(1011, error.message || 'Upstream websocket authentication failed');
          }
        }
      } else {
        const outcome = classifyHttpResponse({ statusCode: response.statusCode, headers: response.headers }, body, {
          allowMisalignmentPolicy: publicResponses
        });
        if (retryPublicTurn(outcome)) return;
        if (publicResponses && publicTurnActive) {
          if (socket === targetSocket) {
            targetSocket = undefined;
            targetUpstreamId = null;
          }
          failActiveTurn('upstream_websocket_handshake_failed', 'Upstream websocket handshake failed', outcome);
        }
        else {
          settleNativeConnectionAdmission(outcome);
          settleNativeAdmission(outcome);
          closeBoth(1011, 'Upstream websocket handshake failed');
        }
      }
    });
    socket.on('close', (code, reason) => {
      socketPacingAbort.abort(new DOMException('Upstream websocket closed', 'AbortError'));
      releaseHostLease();
      if (socket !== targetSocket || refreshingConnection || client.readyState !== WebSocket.OPEN) return;
      targetSocket = undefined;
      targetUpstreamId = null;
      const outcome = socketTransportOutcome || classifyTransportError(new Error('Upstream WebSocket closed'));
      if (retryPublicTurn(outcome)) return;
      if (publicResponses && publicTurnActive) {
        clearIdle();
        failActiveTurn('upstream_websocket_interrupted', 'Upstream response interrupted', outcome);
        return;
      }
      if (publicResponses) {
        clearIdle();
        return;
      }
      settleNativeConnectionAdmission(outcome);
      settleNativeAdmission(outcome);
      client.close(code, reason);
    });
    socket.on('error', (error) => {
      if (socket !== targetSocket || refreshingConnection) return;
      const hostOutcome = settleHostError(error);
      const outcome = hostOutcome.preconnect
        ? { class: 'neutral', retryable: false }
        : classifyTransportError(error);
      socketTransportOutcome = outcome;
      if (publicResponses) {
        if (hostOutcome.preconnect) {
          if (!hostOutcome.open && retryPublicTurn(outcome)) return;
          if (publicTurnActive) {
            targetSocket = undefined;
            targetUpstreamId = null;
            failActiveTurn(
              hostOutcome.open ? 'codex_host_unavailable' : 'upstream_websocket_connect_failed',
              hostOutcome.open ? 'Codex host is temporarily unreachable' : 'Upstream websocket connection failed',
              outcome
            );
          }
          return;
        }
        return socket.close();
      }
      settleNativeConnectionAdmission(outcome);
      settleNativeAdmission(outcome);
      closeBoth(hostOutcome.open ? 1013 : 1011, hostOutcome.open ? 'Codex host is temporarily unreachable' : 'Upstream websocket error');
    });
  };

  try {
    if (upstream) {
      const refreshed = await ensureProviderCredentials(upstream, credentials, {
        fetchImpl,
        saveCredentials: (updated, expiresAt) => store.persistCredentials(upstream.id, updated, expiresAt)
      });
      if (refreshed && !renewNativeAdmissions(upstream)) {
        client.close(1013, 'No eligible Codex upstream is available');
        return;
      }
      await connect();
    }
  } catch (error) {
    settleNativeAdmission({ class: 'neutral', retryable: false });
    settleNativeConnectionAdmission({ class: 'neutral', retryable: false });
    client.close(1011, error.message || 'Upstream websocket connection failed');
  }
}

function publicWebSocketFailure(client, code, message, sequenceNumber = 0, streamId = null, param = null, status = null) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify({
      type: 'error',
      ...(status ? { status } : {}),
      sequence_number: sequenceNumber,
      error: { type: status >= 400 && status < 500 ? 'invalid_request_error' : 'server_error', code, message, param },
      ...(streamId ? { stream_id: streamId } : {})
    }));
  }
}

function sanitizeNativeResponseControlFrame(data, isBinary) {
  if (isBinary) return data;
  let event;
  try { event = JSON.parse(data.toString()); } catch { return data; }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return data;
  let changed = false;
  if (Object.hasOwn(event, 'headers')) {
    event.headers = event.headers && typeof event.headers === 'object' && !Array.isArray(event.headers)
      ? nativeResponseControlMap(event.headers)
      : undefined;
    if (event.headers === undefined) delete event.headers;
    changed = true;
  }
  if (event.response && typeof event.response === 'object' && !Array.isArray(event.response) && Object.hasOwn(event.response, 'headers')) {
    event.response = { ...event.response };
    event.response.headers = event.response.headers && typeof event.response.headers === 'object' && !Array.isArray(event.response.headers)
      ? nativeResponseControlMap(event.response.headers)
      : undefined;
    if (event.response.headers === undefined) delete event.response.headers;
    changed = true;
  }
  return changed ? Buffer.from(JSON.stringify(event)) : data;
}

function nativeResponseControlMap(headers) {
  const entries = Object.entries(headers);
  const projected = {};
  for (const [outputName, inputNames, presence = false] of [
    ['openai-model', ['openai-model', 'x-openai-model']],
    ['x-reasoning-included', ['x-reasoning-included'], true],
    ['x-codex-safety-buffering-enabled', ['x-codex-safety-buffering-enabled'], true],
    ['x-codex-safety-buffering-faster-model', ['x-codex-safety-buffering-faster-model']]
  ]) {
    const selected = inputNames.flatMap((inputName) => {
      const exact = entries.filter(([name]) => name === inputName);
      const folded = entries.filter(([name]) => name !== inputName && name.toLowerCase() === inputName);
      return [...exact, ...folded];
    }).map(([, value]) => value).find((value) => presence
      ? (typeof value === 'string' && validResponseControlValue(value, true)) || typeof value === 'number' || typeof value === 'boolean'
      : validResponseControlValue(value));
    if (selected !== undefined) projected[outputName] = presence ? 'true' : selected;
  }
  return projected;
}

function validateStreamId(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !STREAM_ID_PATTERN.test(value)) {
    throw new AdapterError('stream_id must be 1-256 ASCII characters matching [A-Za-z0-9_.-]+', 'stream_id');
  }
  return value;
}

function validateGenerate(value) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new AdapterError('generate must be a boolean', 'generate');
  return value;
}

function normalizedServiceTier(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function policyRoute(path, sourcePath) {
  return POLICY_ROUTES.has(path) || POLICY_ROUTES.has(sourcePath);
}

function publicPolicyError(bytes, path, sourcePath) {
  return policyRoute(path, sourcePath) ? publicMisalignmentError(parseJson(bytes)) : null;
}

async function readWebSocketHandshakeBody(response, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > maxBytes) return null;
      chunks.push(Buffer.from(chunk));
    }
    return parseJson(Buffer.concat(chunks, size));
  } catch {
    return null;
  }
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
