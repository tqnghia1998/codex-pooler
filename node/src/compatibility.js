import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { defaultBaseUrl } from './domain.js';
import { captureCodexCookies, codexCookieHeaders } from './codex-cookies.js';
import { ensureProviderCredentials, refreshProviderCredentials } from './providers.js';
import { upstreamFailure } from './public-errors.js';
import { HttpError } from './http-ingress.js';
import { extractUsage, upstreamCostMicros } from './pricing.js';
import { fetchWithHeaderDeadline, readWithIdleDeadline } from './upstream-deadlines.js';
import { codexProtocolHeaders } from './protocol-compat.js';
import { modelCatalogForStore } from './codex-model-catalog.js';
import { classifyHttpResponse, classifySseEvent, classifyTransportError } from './upstream-outcomes.js';
import { codexHostHealthForStore, withCodexHostHealth } from './codex-host-health.js';
import { PacingError, upstreamPacerForStore } from './upstream-pacer.js';
import {
  isShareCredential,
  personalShareSessions,
  releaseShareRequest,
  reserveShareRequest,
  selectPersonalShareSession
} from './share-authorization.js';

const IMAGE_MODELS = new Set(['gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini', 'gpt-image-2']);
const FILE_PURPOSES = new Set(['user_data', 'assistants', 'vision', 'batch', 'fine-tune']);
const UPLOAD_HOST_SUFFIXES = ['.oaiusercontent.com', '.blob.core.windows.net'];
const IMAGE_ENUMS = {
  size: new Set(['auto', '1024x1024', '1024x1536', '1536x1024']),
  quality: new Set(['auto', 'low', 'medium', 'high']),
  background: new Set(['auto', 'transparent', 'opaque']),
  input_fidelity: new Set(['low', 'high'])
};

export function isCompatibilityRoute(method, path) {
  if (method === 'GET' && (path === '/v1/files' || /^\/v1\/files\/[^/]+(?:\/content)?$/.test(path))) return true;
  if (method === 'DELETE' && /^\/v1\/files\/[^/]+$/.test(path)) return true;
  return method === 'POST' && ['/v1/files', '/v1/audio/transcriptions', '/v1/images/generations', '/v1/images/edits'].includes(path);
}

export function isUnsupportedV1Route(method, path) {
  if (method === 'POST' && ['/v1/images/variations', '/v1/embeddings', '/v1/batches', '/v1/moderations', '/v1/fine_tuning/jobs'].includes(path)) return true;
  if ((method === 'GET' || method === 'DELETE') && /^\/v1\/responses\/[^/]+$/.test(path)) return true;
  return method === 'POST' && /^\/v1\/responses\/[^/]+\/cancel$/.test(path);
}

export async function handleCompatibilityRequest({ req, res, path, body, store, fetchImpl = globalThis.fetch, upstreamDeadlines = {}, modelCatalog = modelCatalogForStore(store), codexHostHealth = codexHostHealthForStore(store) }) {
  try {
    if (path === '/v1/files') {
      if (req.method === 'GET') return sendJson(res, 200, { object: 'list', data: listFiles(store, req) });
      return await createFile({ req, res, body, store, fetchImpl, upstreamDeadlines, codexHostHealth });
    }
    const fileMatch = path.match(/^\/v1\/files\/([^/]+)(\/content)?$/);
    if (fileMatch) return fileOperation({ req, res, store, id: decodeURIComponent(fileMatch[1]), content: Boolean(fileMatch[2]) });
    if (path === '/v1/audio/transcriptions') {
      return await transcribe({ req, res, body, store, fetchImpl, upstreamDeadlines, codexHostHealth });
    }
    return await image({ req, res, path, body, store, fetchImpl, upstreamDeadlines, modelCatalog, codexHostHealth });
  } finally {
    releaseShareRequest(req, req.compatibilityShareAttemptId, 'compatibility_request_failed');
  }
}

async function createFile({ req, res, body, store, fetchImpl, upstreamDeadlines, codexHostHealth }) {
  const form = await multipart(req, body);
  const unexpected = unsupportedFormField(form, new Set(['file', 'purpose']));
  if (unexpected) return invalid(res, `${unexpected} is not supported`, unexpected);
  const purpose = text(form.get('purpose'));
  if (!FILE_PURPOSES.has(purpose)) return invalid(res, purpose ? 'file purpose is not supported' : 'purpose is required', 'purpose');
  const file = form.get('file');
  if (!(file instanceof Blob)) return invalid(res, 'file is required', 'file');

  const provider = await codexContext(store, req, res, fetchImpl, upstreamDeadlines, { codexHostHealth });
  if (!provider) return noCodex(res);
  const filename = safeFilename(file.name || 'upload.bin');
  const created = await codexFetch(provider, '/backend-api/files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_name: filename, file_size: file.size, use_case: 'codex' })
  });
  const createdBody = await responseJson(created, provider.upstreamDeadlines, provider);
  if (!created.ok) return sendFailure(res, retryAfterHeader(created));
  const fileId = text(createdBody?.file_id);
  const uploadUrl = text(createdBody?.upload_url);
  if (!fileId || !uploadUrl) return sendFailure(res);

  if (!safeUploadUrl(uploadUrl)) return sendFailure(res);
  const upload = await timedFetch(uploadUrl, {
    method: 'PUT',
    redirect: 'error',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
    body: Buffer.from(await file.arrayBuffer())
  }, fetchImpl, upstreamDeadlines);
  if (!upload.ok) return sendFailure(res);

  const { response: finalized, body: finalizedBody } = await finalizeFile(provider, fileId);
  if (!finalized.ok) return sendFailure(res, retryAfterHeader(finalized));
  if (finalizedBody?.status !== 'success' || !text(finalizedBody?.download_url)) return sendFailure(res);
  pinCompatibilitySession(provider);

  const now = Math.floor(Date.now() / 1000);
  const record = store.saveFile({
    scopeId: fileScopeId(req),
    id: fileId,
    object: 'file',
    bytes: file.size,
    created_at: now,
    filename,
    purpose,
    status: 'uploaded',
    expires_at: integer(createdBody?.expires_at) || now + 86_400
  });
  releaseShareRequest(req, provider.shareAttemptId, null);
  sendJson(res, 200, record);
}

function fileOperation({ req, res, store, id, content }) {
  const file = fileScopes(req).map((scopeId) => store.getFile(id, scopeId)).find(Boolean);
  if (!file) return sendError(res, 404, 'file_not_found', 'File not found', 'file_id');
  if (req.method === 'GET' && !content) return sendJson(res, 200, file);
  return sendError(res, 404, 'unsupported_endpoint', 'Unsupported OpenAI /v1 endpoint');
}

async function transcribe({ req, res, body, store, fetchImpl, upstreamDeadlines, codexHostHealth }) {
  const form = await multipart(req, body);
  const unexpected = unsupportedFormField(form, new Set(['file', 'model', 'language', 'prompt', 'response_format', 'temperature', 'keywords', 'keywords[]', 'languages', 'languages[]']));
  if (unexpected) return invalid(res, `${unexpected} is not supported`, unexpected);
  const model = text(form.get('model'));
  if (!['gpt-4o-transcribe', 'gpt-transcribe'].includes(model)) {
    return sendError(res, model ? 404 : 400, model ? 'model_not_found' : 'invalid_request', model ? 'Audio transcription model is not supported' : 'model is required', 'model');
  }
  const file = form.get('file');
  if (!(file instanceof Blob)) return invalid(res, 'file is required', 'file');
  const provider = await codexContext(store, req, res, fetchImpl, upstreamDeadlines, { codexHostHealth });
  if (!provider) return noCodex(res);

  const upstreamForm = new FormData();
  upstreamForm.append('model', 'gpt-4o-transcribe');
  upstreamForm.append('file', file, 'audio.wav');
  const prompt = text(form.get('prompt'));
  if (prompt) upstreamForm.append('prompt', prompt);
  for (const [source, target] of [['keywords', 'keywords[]'], ['languages', 'languages[]']]) {
    for (const value of listValues(form, source)) {
      if (!text(value)) return invalid(res, `${source} must contain non-empty strings`, source);
      upstreamForm.append(target, value);
    }
  }
  const response = await codexFetch(provider, '/backend-api/transcribe', { method: 'POST', body: upstreamForm }, { pacingModel: 'gpt-4o-transcribe' });
  const responseBody = await responseJson(response, provider.upstreamDeadlines, provider);
  if (!response.ok) return sendFailure(res, retryAfterHeader(response));
  if (!responseBody) return sendFailure(res);
  pinCompatibilitySession(provider);
  delete responseBody.languages;
  settleCost(store, provider.upstream, responseBody, req);
  sendJson(res, response.status, responseBody, responseHeaders(response));
}

async function image({ req, res, path, body, store, fetchImpl, upstreamDeadlines, modelCatalog, codexHostHealth }) {
  const edit = path.endsWith('/edits');
  let payload;
  let images = [];
  let mask;
  if (edit) {
    const form = await multipart(req, body);
    const unexpected = unsupportedFormField(form, new Set(['model', 'prompt', 'size', 'quality', 'background', 'input_fidelity', 'n', 'image', 'image[]', 'mask', 'response_format', 'user']));
    if (unexpected) return invalid(res, `${unexpected} is not supported`, unexpected);
    payload = Object.fromEntries([...form.entries()].filter(([, value]) => !(value instanceof Blob)));
    images = [...form.getAll('image'), ...form.getAll('image[]')].filter((value) => value instanceof Blob);
    mask = form.get('mask');
    if (!images.length) return invalid(res, 'image is required', 'image');
  } else {
    payload = jsonBody(body);
  }
  const error = validateImage(payload, edit);
  if (error) return invalid(res, error.message, error.param);
  const provider = await codexContext(store, req, res, fetchImpl, upstreamDeadlines, { modelCatalog, requireImageModel: true, codexHostHealth });
  if (!provider) return noCodex(res);
  const hostModel = provider.hostModel;

  const requestBody = imageResponsesPayload(payload, hostModel);
  if (edit) {
    const parts = [];
    for (const input of images) parts.push(await imagePart(input));
    if (mask instanceof Blob) {
      parts.push(await imagePart(mask));
      requestBody.input = [{
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: `${payload.prompt}\n\n(The final attached image is a transparent mask: only modify the regions where the mask is non-transparent.)` }, ...parts]
      }];
    } else {
      requestBody.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: payload.prompt }, ...parts] }];
    }
  }

  const response = await codexFetch(provider, '/backend-api/codex/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(requestBody)
  }, { deferSettlement: true, pacingModel: hostModel });
  let textBody;
  try {
    textBody = (await responseBytes(response, 32 * 1024 * 1024, provider.upstreamDeadlines)).toString('utf8');
  } catch (error) {
    settleCodexFetch(provider, response, classifyTransportError(error));
    throw error;
  }
  if (!response.ok) {
    let structuredBody = null;
    try { structuredBody = JSON.parse(textBody); } catch {}
    settleCodexFetch(provider, response, classifyHttpResponse(response, structuredBody));
    return sendFailure(res, retryAfterHeader(response));
  }
  const events = parseSse(textBody);
  const terminal = events.findLast((event) => ['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event?.type));
  settleCodexFetch(provider, response, terminal ? classifySseEvent(terminal) : { class: 'transient', retryable: true });
  const result = imageResponse(events);
  if (result.error) return sendError(res, result.error.status, result.error.code, result.error.message, result.error.param);
  pinCompatibilitySession(provider);
  settleCost(store, provider.upstream, result.costBody, req);
  sendJson(res, 200, result.body);
}

function validateImage(payload, edit) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { message: 'request body must be an object' };
  const allowed = edit
    ? new Set(['model', 'prompt', 'size', 'quality', 'background', 'input_fidelity', 'n', 'image', 'image[]', 'mask', 'response_format', 'user'])
    : new Set(['model', 'prompt', 'size', 'quality', 'background', 'n', 'response_format', 'user']);
  const unsupported = Object.keys(payload).find((field) => !allowed.has(field));
  if (unsupported) return { message: `${unsupported} is not supported`, param: unsupported };
  if (!IMAGE_MODELS.has(text(payload.model))) return { message: payload.model ? 'image model is not supported' : 'model is required', param: 'model' };
  if (!text(payload.prompt)) return { message: 'prompt is required', param: 'prompt' };
  for (const [field, allowed] of Object.entries(IMAGE_ENUMS)) {
    if (payload[field] !== undefined && !allowed.has(text(payload[field]))) return { message: `${field} is not supported`, param: field };
  }
  if (payload.n !== undefined && Number(payload.n) !== 1) return { message: 'n must be 1', param: 'n' };
  return null;
}

function imageResponsesPayload(payload, hostModel) {
  const tool = {
    type: 'image_generation',
    model: payload.model,
    size: payload.size || 'auto',
    quality: payload.quality || 'auto'
  };
  if (payload.background !== undefined) tool.background = payload.background;
  if (payload.input_fidelity !== undefined) tool.input_fidelity = payload.input_fidelity;
  return {
    model: hostModel,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: payload.prompt }] }],
    tools: [tool],
    tool_choice: { type: 'image_generation' },
    store: false,
    stream: true
  };
}

async function imagePart(file) {
  return { type: 'input_image', image_url: `data:${file.type || 'application/octet-stream'};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}` };
}

function imageResponse(events) {
  const items = [];
  let usage;
  let costBody;
  for (const event of events) {
    if (event?.type === 'response.output_item.done' && event.item?.type === 'image_generation_call') items.push(event.item);
    const output = event?.response?.output || event?.output;
    if (Array.isArray(output)) items.push(...output.filter((item) => item?.type === 'image_generation_call'));
    usage ||= event?.response?.tool_usage?.image_gen || event?.tool_usage?.image_gen;
    if (extractCost(event) !== undefined) costBody = event;
  }
  const uniqueItems = [...new Map(items.map((item, index) => [item.id || item.result || index, item])).values()];
  const failed = uniqueItems.find((item) => item.status === 'failed');
  if (failed) {
    const error = failed.error && typeof failed.error === 'object' ? failed.error : null;
    return { error: {
      status: error?.type === 'invalid_request_error' ? 400 : 502,
      code: text(error?.code) || 'image_generation_failed',
      message: text(error?.message) || 'upstream image generation failed',
      ...(text(error?.param) ? { param: error.param } : {})
    } };
  }
  const data = uniqueItems.flatMap((item) => text(item.result) ? [{ b64_json: item.result, ...(text(item.revised_prompt) ? { revised_prompt: item.revised_prompt } : {}) }] : []);
  if (!data.length) return { error: { status: 502, code: 'image_generation_failed', message: 'Upstream image response contained no image data' } };
  const normalizedUsage = normalizeUsage(usage);
  return { body: { created: Math.floor(Date.now() / 1000), data, ...(normalizedUsage ? { usage: normalizedUsage } : {}) }, costBody };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = integer(usage.input_tokens);
  const output = integer(usage.output_tokens);
  const total = integer(usage.total_tokens) || (input !== null && output !== null ? input + output : null);
  const result = {};
  if (input !== null) result.input_tokens = input;
  if (output !== null) result.output_tokens = output;
  if (total !== null) result.total_tokens = total;
  if (usage.input_tokens_details && typeof usage.input_tokens_details === 'object') result.input_tokens_details = usage.input_tokens_details;
  if (usage.output_tokens_details && typeof usage.output_tokens_details === 'object') result.output_tokens_details = usage.output_tokens_details;
  return Object.keys(result).length ? result : null;
}

async function finalizeFile(provider, fileId) {
  const deadline = Date.now() + 30_000;
  let response;
  let body;
  do {
    response = await codexFetch(provider, `/backend-api/files/${encodeURIComponent(fileId)}/uploaded`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    body = await responseJson(response, provider.upstreamDeadlines, provider);
    if (!response.ok || body?.status === 'success' || !['retry', 'retrying', 'pending'].includes(text(body?.status))) return { response, body };
    if (Date.now() >= deadline) return { response, body };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  return { response, body };
}

function unsupportedFormField(form, allowed) {
  for (const [key] of form.entries()) if (!allowed.has(key)) return key;
  return null;
}

const COMPATIBILITY_CIRCUIT_SCOPE = { routeClass: 'compatibility_native', model: '' };

async function codexContext(store, req, res, fetchImpl, upstreamDeadlines = {}, { modelCatalog = modelCatalogForStore(store), requireImageModel = false, codexHostHealth = codexHostHealthForStore(store) } = {}) {
  const scopeId = requestScopeId(req);
  const personalKey = req.proxyAuth?.kind === 'personal_share';
  const sharedUpstreamId = req.proxyAuth?.kind === 'share_session' ? req.proxyAuth.upstreamId : '';
  const apiKeyId = isShareCredential(req.proxyAuth) ? null : req.proxyAuth?.id || null;
  const sessionId = sessionAffinity(req);
  const personalSessions = personalShareSessions(req, { sessionId });
  if (personalKey) req.personalShareSessions = personalSessions;
  const pinnedId = sharedUpstreamId || (personalKey ? '' : store.sessionUpstream(sessionId, scopeId, apiKeyId));
  const rotationUpstreamId = personalKey ? null : store.sessionRotationUpstream(sessionId, scopeId, apiKeyId);
  const headerRequestedId = text(req.headers['x-upstream-id']);
  if (personalKey && headerRequestedId) return null;
  if (sharedUpstreamId && headerRequestedId && headerRequestedId !== sharedUpstreamId) return null;
  const requestedId = sharedUpstreamId || headerRequestedId;
  const candidates = store.candidatePlan({ affinityId: pinnedId, requestedId, preferredType: 'codex', requiredType: 'codex', rotateFromId: pinnedId || requestedId ? '' : rotationUpstreamId, scopeId, routeClass: COMPATIBILITY_CIRCUIT_SCOPE.routeClass, ignoreQuotaCooldown: Boolean(req.ignoreQuotaCooldown) });
  const allowed = personalKey
    ? candidates.filter((candidate) => personalSessions.some((session) => session.upstreamId === candidate.id))
    : candidates;
  for (const candidate of allowed) {
    if (!selectPersonalShareSession(req, candidate.id, { affinityId: sessionId, allowReselect: true })) continue;
    const upstream = store.get(candidate.id, scopeId);
    const credentials = store.credentials(candidate.id);
    try {
      await ensureProviderCredentials(upstream, credentials, {
        fetchImpl,
        saveCredentials: (updated, expiresAt) => store.persistCredentials(candidate.id, updated, expiresAt)
      });
      const hostModel = requireImageModel
        ? await modelCatalog.imageModel(candidate.id, { fetchImpl, upstreamDeadlines, codexHostHealth })
        : null;
      if (requireImageModel && !hostModel) continue;
      const shareAttemptId = compatibilityShareAttemptId(req);
      if (!reserveShareRequest(req, shareAttemptId, {
        model: hostModel || '',
        route: new URL(req.url, 'http://localhost').pathname
      })) {
        continue;
      }
      return {
        upstream,
        credentials,
        store,
        fetchImpl,
        req,
        res,
        scopeId,
        apiKeyId,
        sessionId,
        upstreamDeadlines,
        hostModel,
        codexHostHealth,
        shareAttemptId
      };
    } catch (error) {
      if (error?.codexHostCircuitOpen) throw error;
    }
  }
  return null;
}

function pinCompatibilitySession(context) {
  if (context?.sessionId && !isShareCredential(context.req.proxyAuth)) {
    context.store.pinSession(context.sessionId, context.upstream.id, context.scopeId, context.apiKeyId);
  }
}

async function codexFetch(context, path, options, { deferSettlement = false, pacingModel = '' } = {}) {
  const scope = { ...COMPATIBILITY_CIRCUIT_SCOPE, ignoreQuotaCooldown: Boolean(context.req.ignoreQuotaCooldown) };
  let admission = context.store.beginUpstreamAttempt(context.upstream.id, scope);
  if (!admission) throw Object.assign(new Error('Codex upstream is not currently eligible'), { statusCode: 503 });
  const abort = downstreamAbortSignal(context.req, context.res);
  let response;
  try {
    if (!context.req.disablePacing) {
      await upstreamPacerForStore(context.store).acquire(context.upstream.id, { model: pacingModel, signal: abort.signal });
    }
    response = await timedFetch(`${defaultBaseUrl('codex')}${path}`, withCodexHeaders(context, { ...options, signal: abort.signal }), context.fetchImpl, context.upstreamDeadlines, context.codexHostHealth);
    persistCookies(response, context);
    if ((response.status === 401 || response.status === 403) && context.credentials.refreshToken) {
      try {
        const refreshed = await refreshProviderCredentials(context.upstream, context.credentials, {
          fetchImpl: context.fetchImpl,
          saveCredentials: (updated, expiresAt) => context.store.persistCredentials(context.upstream.id, updated, expiresAt)
        });
        if (refreshed) {
          context.store.settleUpstreamAttempt(context.upstream.id, admission, { class: 'neutral', retryable: false });
          admission = context.store.beginUpstreamAttempt(context.upstream.id, scope);
          if (!admission) throw Object.assign(new Error('Codex upstream is not currently eligible'), { statusCode: 503 });
        }
      } catch (error) {
        context.store.settleUpstreamAttempt(context.upstream.id, admission, { class: 'neutral', retryable: false });
        error.upstreamOutcomeSettled = true;
        throw error;
      }
      if (!context.req.disablePacing) {
        await upstreamPacerForStore(context.store).acquire(context.upstream.id, { model: pacingModel, signal: abort.signal });
      }
      response = await timedFetch(`${defaultBaseUrl('codex')}${path}`, withCodexHeaders(context, { ...options, signal: abort.signal }), context.fetchImpl, context.upstreamDeadlines, context.codexHostHealth);
      persistCookies(response, context);
    }
  } catch (error) {
    if (!error?.upstreamOutcomeSettled) {
      try {
        context.store.settleUpstreamAttempt(
          context.upstream.id,
          admission,
          error instanceof PacingError || error?.codexHostPreconnect || error?.codexHostCircuitOpen
            ? { class: 'neutral', retryable: false }
            : classifyTransportError(error)
        );
      } catch {}
    }
    throw error;
  } finally {
    abort.cleanup();
  }
  Object.defineProperty(response, 'relaydeckAdmission', { value: admission });
  if (!deferSettlement) {
    Object.defineProperty(response, 'relaydeckSettleAfterBody', { value: true });
  }
  return response;
}

function settleCodexFetch(context, response, outcome) {
  const admission = response?.relaydeckAdmission;
  if (!admission) return;
  context.store.settleUpstreamAttempt(context.upstream.id, admission, outcome);
}

function withCodexHeaders(context, options) {
  return {
    ...options,
    headers: {
      authorization: `Bearer ${context.credentials.accessToken}`,
      accept: 'application/json',
      ...codexProtocolHeaders(),
      ...codexCookieHeaders(context.credentials),
      ...(context.upstream.accountId ? { 'chatgpt-account-id': context.upstream.accountId } : {}),
      ...(options.headers || {})
    }
  };
}

function persistCookies(response, context) {
  if (captureCodexCookies(response, context.credentials)) {
    context.store.persistCredentials(context.upstream.id, context.credentials, context.upstream.accessTokenExpiresAt);
  }
}

async function timedFetch(url, options, fetchImpl, upstreamDeadlines = {}, codexHostHealth = null) {
  try {
    return await withCodexHostHealth(codexHostHealth, url, () => fetchWithHeaderDeadline(fetchImpl, url, options, upstreamDeadlines));
  } catch (error) {
    if (error?.codexHostCircuitOpen) throw error;
    const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError';
    const wrapped = new Error(timedOut ? 'Upstream request timed out' : `Upstream request failed: ${error.message}`, { cause: error });
    wrapped.statusCode = 502;
    wrapped.upstreamFailureKind = timedOut ? 'timeout' : 'transport';
    if (error?.codexHostPreconnect) {
      wrapped.codexHostPreconnect = true;
      wrapped.codexHostPreconnectCode = error.codexHostPreconnectCode;
    }
    throw wrapped;
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

async function multipart(req, body) {
  const contentType = text(req.headers['content-type']);
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new HttpError(400, 'invalid_request', 'request body must be multipart/form-data');
  try {
    return await new Request('http://localhost', { method: 'POST', headers: { 'content-type': contentType }, body }).formData();
  } catch {
    throw new HttpError(400, 'invalid_request', 'multipart request body is malformed');
  }
}

function listValues(form, name) {
  return [...form.getAll(name), ...form.getAll(`${name}[]`)].filter((value) => !(value instanceof Blob));
}

function jsonBody(body) {
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'invalid_request', 'request body must be JSON');
  }
}

function parseSse(body) {
  return body.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return [];
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}

function extractCost(body) {
  return upstreamCostMicros(body?.usage) ?? upstreamCostMicros(body?.message?.usage) ?? upstreamCostMicros(body?.response?.usage) ?? upstreamCostMicros(body);
}

function settleCost(store, upstream, body, req) {
  const settledCostMicros = extractCost(body);
  const attemptId = req.compatibilityShareAttemptId || randomUUID();
  const startedAt = new Date().toISOString();
  try {
    const scopeId = requestScopeId(req);
    const shared = isShareCredential(req.proxyAuth);
    const apiKeyId = shared ? null : req.proxyAuth?.id || null;
    if (!shared) store.recordGatewayUsage({ scopeId, apiKeyId, attemptId, startedAt, usage: extractUsage(body), settledCostMicros: settledCostMicros ?? null });
    if (settledCostMicros !== undefined) {
      store.addUsage(upstream.id, { attemptId, startedAt, settledCostMicros, costSource: 'upstream_reported' });
      if (!shared) store.addSessionUsage(sessionAffinity(req), upstream.id, settledCostMicros, scopeId, apiKeyId);
      if (shared && req.proxyAuth.shareSessionId) req.sharingStore?.settleSession(req.proxyAuth.shareSessionId, attemptId, settledCostMicros);
    } else if (shared) {
      releaseShareRequest(req, attemptId, null);
    }
  } catch {
    // Accounting must not replace a successful provider response.
  }
}

function compatibilityShareAttemptId(req) {
  if (!isShareCredential(req.proxyAuth)) return null;
  req.compatibilityShareAttemptId ||= randomUUID();
  return req.compatibilityShareAttemptId;
}

async function responseJson(response, upstreamDeadlines = {}, context = null) {
  let bytes;
  try {
    bytes = await responseBytes(response, 16 * 1024 * 1024, upstreamDeadlines);
  } catch (error) {
    if (context && response?.relaydeckSettleAfterBody) settleCodexFetch(context, response, classifyTransportError(error));
    throw error;
  }
  let body = null;
  try { body = JSON.parse(bytes.toString('utf8')); } catch {}
  if (context && response?.relaydeckSettleAfterBody) {
    settleCodexFetch(context, response, response.ok
      ? body === null ? { class: 'transient', retryable: true } : { class: 'success', retryable: false }
      : classifyHttpResponse(response, body));
  }
  return body;
}

async function responseBytes(response, maxBytes = 16 * 1024 * 1024, upstreamDeadlines = {}) {
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

function responseHeaders(response) {
  const headers = {};
  for (const name of ['x-request-id', 'cache-control', 'retry-after']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function retryAfterHeader(response) {
  const value = response?.headers?.get?.('retry-after');
  return typeof value === 'string' && value.length <= 1_024 && !/[\x00-\x1f\x7f]/.test(value)
    ? { 'retry-after': value }
    : {};
}

function sendFailure(res, headers = {}) {
  const failure = upstreamFailure();
  return sendJson(res, failure.status, failure.body, headers);
}

function invalid(res, message, param = null) {
  return sendError(res, 400, 'invalid_request', message, param);
}

function noCodex(res) {
  return sendError(res, 503, 'no_eligible_backend', 'No eligible Codex upstream is available');
}

function sendError(res, status, code, message, param = null) {
  return sendJson(res, status, { error: { type: status >= 500 ? 'server_error' : status === 401 ? 'authentication_error' : 'invalid_request_error', code, message, param } });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function sessionAffinity(req) {
  for (const name of ['x-codex-window-id', 'x-codex-session-id', 'session-id', 'x-session-id', 'x-session-affinity', 'session_id', 'x-codex-conversation-id']) {
    const value = text(req.headers[name]);
    if (value) return value;
  }
  return '';
}

function requestScopeId(req) {
  return req.proxyAuth?.scopeId || 'default';
}

function fileScopes(req) {
  if (req.proxyAuth?.kind === 'share_session' && req.proxyAuth.shareSessionId) {
    return [`share-session:${req.proxyAuth.shareSessionId}`];
  }
  if (req.proxyAuth?.kind === 'personal_share') {
    return personalShareSessions(req).map(({ shareSessionId }) => `share-session:${shareSessionId}`);
  }
  return [requestScopeId(req)];
}

function fileScopeId(req) {
  if (isShareCredential(req.proxyAuth) && req.proxyAuth.shareSessionId) {
    return `share-session:${req.proxyAuth.shareSessionId}`;
  }
  return requestScopeId(req);
}

function listFiles(store, req) {
  const seen = new Set();
  return fileScopes(req).flatMap((scopeId) => store.listFiles(scopeId))
    .filter((file) => !seen.has(file.id) && seen.add(file.id));
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function integer(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function safeFilename(value) {
  return value.replace(/[\\/]/g, '_').slice(0, 255) || 'upload.bin';
}

function safeUploadUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || host === 'localhost' || host.endsWith('.local')) return false;
    if (!UPLOAD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
    if (isIP(host) === 4 && (/^10\./.test(host) || /^127\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host))) return false;
    if (isIP(host) === 6 && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:'))) return false;
    return true;
  } catch {
    return false;
  }
}
