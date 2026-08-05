import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { defaultBaseUrl, dollarsToMicros } from './domain.js';
import { captureCodexCookies, codexCookieHeaders } from './codex-cookies.js';
import { ensureProviderCredentials, refreshProviderCredentials } from './providers.js';
import { upstreamFailure } from './public-errors.js';
import { HttpError } from './http-ingress.js';
import { extractUsage } from './pricing.js';

const CODEX_VERSION = '0.146.0';
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

export async function handleCompatibilityRequest({ req, res, path, body, store, fetchImpl = globalThis.fetch }) {
  if (path === '/v1/files') {
    if (req.method === 'GET') return sendJson(res, 200, { object: 'list', data: store.listFiles(requestScopeId(req)) });
    return createFile({ req, res, body, store, fetchImpl });
  }
  const fileMatch = path.match(/^\/v1\/files\/([^/]+)(\/content)?$/);
  if (fileMatch) return fileOperation({ req, res, store, id: decodeURIComponent(fileMatch[1]), content: Boolean(fileMatch[2]) });
  if (path === '/v1/audio/transcriptions') return transcribe({ req, res, body, store, fetchImpl });
  return image({ req, res, path, body, store, fetchImpl });
}

async function createFile({ req, res, body, store, fetchImpl }) {
  const form = await multipart(req, body);
  const unexpected = unsupportedFormField(form, new Set(['file', 'purpose']));
  if (unexpected) return invalid(res, `${unexpected} is not supported`, unexpected);
  const purpose = text(form.get('purpose'));
  if (!FILE_PURPOSES.has(purpose)) return invalid(res, purpose ? 'file purpose is not supported' : 'purpose is required', 'purpose');
  const file = form.get('file');
  if (!(file instanceof Blob)) return invalid(res, 'file is required', 'file');

  const provider = await codexContext(store, req, fetchImpl);
  if (!provider) return noCodex(res);
  const filename = safeFilename(file.name || 'upload.bin');
  const created = await codexFetch(provider, '/backend-api/files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_name: filename, file_size: file.size, use_case: 'codex' })
  });
  const createdBody = await responseJson(created);
  if (!created.ok) return sendFailure(res);
  const fileId = text(createdBody?.file_id);
  const uploadUrl = text(createdBody?.upload_url);
  if (!fileId || !uploadUrl) return sendFailure(res);

  if (!safeUploadUrl(uploadUrl)) return sendFailure(res);
  const upload = await timedFetch(uploadUrl, {
    method: 'PUT',
    redirect: 'error',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
    body: Buffer.from(await file.arrayBuffer())
  }, fetchImpl);
  if (!upload.ok) return sendFailure(res);

  const { response: finalized, body: finalizedBody } = await finalizeFile(provider, fileId);
  if (!finalized.ok) return sendFailure(res);
  if (finalizedBody?.status !== 'success' || !text(finalizedBody?.download_url)) return sendFailure(res);

  const now = Math.floor(Date.now() / 1000);
  const record = store.saveFile({
    scopeId: requestScopeId(req),
    id: fileId,
    object: 'file',
    bytes: file.size,
    created_at: now,
    filename,
    purpose,
    status: 'uploaded',
    expires_at: integer(createdBody?.expires_at) || now + 86_400
  });
  sendJson(res, 200, record);
}

function fileOperation({ req, res, store, id, content }) {
  const file = store.getFile(id, requestScopeId(req));
  if (!file) return sendError(res, 404, 'file_not_found', 'File not found', 'file_id');
  if (req.method === 'GET' && !content) return sendJson(res, 200, file);
  return sendError(res, 404, 'unsupported_endpoint', 'Unsupported OpenAI /v1 endpoint');
}

async function transcribe({ req, res, body, store, fetchImpl }) {
  const form = await multipart(req, body);
  const unexpected = unsupportedFormField(form, new Set(['file', 'model', 'language', 'prompt', 'response_format', 'temperature', 'keywords', 'keywords[]', 'languages', 'languages[]']));
  if (unexpected) return invalid(res, `${unexpected} is not supported`, unexpected);
  const model = text(form.get('model'));
  if (!['gpt-4o-transcribe', 'gpt-transcribe'].includes(model)) {
    return sendError(res, model ? 404 : 400, model ? 'model_not_found' : 'invalid_request', model ? 'Audio transcription model is not supported' : 'model is required', 'model');
  }
  const file = form.get('file');
  if (!(file instanceof Blob)) return invalid(res, 'file is required', 'file');
  const provider = await codexContext(store, req, fetchImpl);
  if (!provider) return noCodex(res);

  const upstreamForm = new FormData();
  upstreamForm.append('file', file, 'audio.wav');
  const prompt = text(form.get('prompt'));
  if (prompt) upstreamForm.append('prompt', prompt);
  for (const [source, target] of [['keywords', 'keywords[]'], ['languages', 'languages[]']]) {
    for (const value of listValues(form, source)) {
      if (!text(value)) return invalid(res, `${source} must contain non-empty strings`, source);
      upstreamForm.append(target, value);
    }
  }
  const response = await codexFetch(provider, '/backend-api/transcribe', { method: 'POST', body: upstreamForm });
  const responseBody = await responseJson(response);
  if (!response.ok) return sendFailure(res);
  if (!responseBody) return sendFailure(res);
  delete responseBody.languages;
  settleCost(store, provider.upstream, responseBody, req);
  sendJson(res, response.status, responseBody, responseHeaders(response));
}

async function image({ req, res, path, body, store, fetchImpl }) {
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
  const error = validateImage(payload);
  if (error) return invalid(res, error.message, error.param);
  const provider = await codexContext(store, req, fetchImpl);
  if (!provider) return noCodex(res);
  const hostModel = await imageHostModel(provider);
  if (!hostModel) return sendFailure(res);

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
  });
  const textBody = (await responseBytes(response, 32 * 1024 * 1024)).toString('utf8');
  if (!response.ok) return sendFailure(res);
  const result = imageResponse(parseSse(textBody));
  if (result.error) return sendError(res, result.error.status, result.error.code, result.error.message, result.error.param);
  settleCost(store, provider.upstream, result.costBody, req);
  sendJson(res, 200, result.body);
}

function validateImage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { message: 'request body must be an object' };
  const unsupported = Object.keys(payload).find((field) => !new Set(['model', 'prompt', 'size', 'quality', 'background', 'input_fidelity', 'n', 'image', 'image[]', 'mask', 'response_format', 'user']).has(field));
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

async function imageHostModel(provider) {
  const response = await codexFetch(provider, `/backend-api/codex/models?client_version=${encodeURIComponent(CODEX_VERSION)}`, { method: 'GET' });
  if (!response.ok) return null;
  const body = await responseJson(response);
  const models = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
  const model = models.find((item) => Array.isArray(item?.input_modalities) && item.input_modalities.includes('image')) || models[0];
  return text(model?.slug || model?.id);
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
  if (failed) return { error: { status: 502, code: 'upstream_error', message: 'Upstream request failed' } };
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
    body = await responseJson(response);
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

async function codexContext(store, req, fetchImpl) {
  const scopeId = requestScopeId(req);
  const sessionId = sessionAffinity(req);
  const pinnedId = store.sessionUpstream(sessionId, scopeId);
  const { eligible } = store.eligibility(pinnedId, scopeId);
  const requested = text(req.headers['x-upstream-id']);
  const record = requested
    ? eligible.find((item) => item.id === requested && item.type === 'codex')
    : pinnedId
      ? eligible.find((item) => item.id === pinnedId && item.type === 'codex')
      : eligible.find((item) => item.type === 'codex');
  if (!record) return null;
  if (sessionId) store.pinSession(sessionId, record.id, scopeId);
  const upstream = store.get(record.id, scopeId);
  const credentials = store.credentials(record.id);
  await ensureProviderCredentials(upstream, credentials, {
    fetchImpl,
    saveCredentials: (updated, expiresAt) => store.persistCredentials(record.id, updated, expiresAt)
  });
  return { upstream, credentials, store, fetchImpl };
}

async function codexFetch(context, path, options) {
  let response = await timedFetch(`${defaultBaseUrl('codex')}${path}`, withCodexHeaders(context, options), context.fetchImpl);
  persistCookies(response, context);
  if ((response.status === 401 || response.status === 403) && context.credentials.refreshToken) {
    await refreshProviderCredentials(context.upstream, context.credentials, {
      fetchImpl: context.fetchImpl,
      saveCredentials: (updated, expiresAt) => context.store.persistCredentials(context.upstream.id, updated, expiresAt)
    });
    response = await timedFetch(`${defaultBaseUrl('codex')}${path}`, withCodexHeaders(context, options), context.fetchImpl);
    persistCookies(response, context);
  }
  return response;
}

function withCodexHeaders(context, options) {
  return {
    ...options,
    headers: {
      authorization: `Bearer ${context.credentials.accessToken}`,
      accept: 'application/json',
      'user-agent': `codex_cli_rs/${CODEX_VERSION}`,
      originator: 'codex_cli_rs',
      version: CODEX_VERSION,
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

async function timedFetch(url, options, fetchImpl) {
  try {
    return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError';
    const wrapped = new Error(timedOut ? 'Upstream request timed out after 120 seconds' : `Upstream request failed: ${error.message}`);
    wrapped.statusCode = 502;
    throw wrapped;
  }
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
  const value = body?.usage?.price_cost_usd ?? body?.message?.usage?.price_cost_usd ?? body?.response?.usage?.price_cost_usd ?? body?.price_cost_usd;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

function settleCost(store, upstream, body, req) {
  const cost = extractCost(body);
  const attemptId = randomUUID();
  const startedAt = new Date().toISOString();
  try {
    store.recordGatewayUsage({ scopeId: requestScopeId(req), apiKeyId: req.proxyAuth?.id || null, attemptId, startedAt, usage: extractUsage(body), settledCostMicros: cost === undefined ? null : dollarsToMicros(cost) });
    if (cost !== undefined) store.addUsage(upstream.id, { attemptId, startedAt, settledCostMicros: dollarsToMicros(cost), costSource: 'upstream_reported' });
  } catch {
    // Accounting must not replace a successful provider response.
  }
}

async function responseJson(response) {
  try { return JSON.parse((await responseBytes(response)).toString('utf8')); } catch { return null; }
}

async function responseBytes(response, maxBytes = 16 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
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
  for (const name of ['x-request-id', 'cache-control']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function sendFailure(res) {
  const failure = upstreamFailure();
  return sendJson(res, failure.status, failure.body);
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
