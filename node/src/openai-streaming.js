import { randomUUID } from 'node:crypto';
import { publicMisalignmentError } from './policy-failures.js';

const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
export const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;
const RETRY_CODES = new Set(['upstream_request_timeout', 'stream_incomplete', 'server_error', 'overloaded_error', 'server_is_overloaded', 'websocket_connection_limit_reached']);
const FAILURE_REASONS = new Set([...RETRY_CODES, 'invalid_api_key', 'invalid_authentication', 'context_length_exceeded', 'insufficient_quota', 'invalid_previous_response_id', 'invalid_request', 'invalid_request_error', 'previous_response_not_found', 'rate_limit_exceeded', 'unauthorized', 'usage_limit_exceeded', 'usage_limit_reached', 'workspace_member_usage_limit_reached', 'workspace_owner_usage_limit_reached']);

export function splitSseBlocks(value) { return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n'); }

export function createSseParserState() {
  return { parts: [], bytes: 0, pendingLf: false, skipLeadingLf: false };
}

export function consumeSseChunk(state, value) {
  const parser = state?.parts && Number.isFinite(state.bytes) ? state : createSseParserState();
  const input = typeof value === 'string' ? value : '';
  const start = parser.skipLeadingLf && input.startsWith('\n') ? 1 : 0;
  const normalized = input.slice(start).replace(/\r\n?/g, '\n');
  const blocks = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const newline = normalized.indexOf('\n', cursor);
    const end = newline === -1 ? normalized.length : newline;
    if (end > cursor) {
      if (parser.pendingLf) {
        parser.parts.push('\n');
        parser.bytes += 1;
        parser.pendingLf = false;
      }
      const part = normalized.slice(cursor, end);
      parser.parts.push(part);
      parser.bytes += Buffer.byteLength(part);
      if (parser.bytes > MAX_SSE_EVENT_BYTES) return overflowResult();
    }
    if (newline === -1) break;
    if (parser.pendingLf) {
      blocks.push(parser.parts.join(''));
      parser.parts = [];
      parser.bytes = 0;
      parser.pendingLf = false;
    } else {
      parser.pendingLf = true;
      if (parser.bytes + 1 > MAX_SSE_EVENT_BYTES) return overflowResult();
    }
    cursor = newline + 1;
  }
  parser.skipLeadingLf = input.endsWith('\r');
  return {
    blocks,
    overflow: false,
    state: parser
  };
}

export function pendingSseBlock(state) {
  if (!state?.parts) return '';
  return `${state.parts.join('')}${state.pendingLf ? '\n' : ''}`;
}

function overflowResult() {
  return {
    blocks: [],
    overflow: true,
    state: createSseParserState()
  };
}

export function decodeSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const label = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
  if (!data) return { kind: 'drop' };
  if (data === '[DONE]') return { kind: 'done' };
  try {
    const event = JSON.parse(data);
    if (!plain(event) || label && event.type && label !== event.type) return { kind: 'drop' };
    return { kind: 'event', event: label && !event.type ? { ...event, type: label } : event };
  } catch { return { kind: 'drop' }; }
}

export function retryableFirstSseEvent(event) {
  const error = event?.error || event?.response?.error || event?.status_details?.error || event?.response?.status_details?.error || {};
  return RETRY_CODES.has(string(error.code) || string(error.type) || incompleteReason(event));
}

export function createPublicResponsesState(customToolNamespaces = {}) { return { sequence: -1, terminal: false, created: false, text: false, visible: false, responseId: '', customToolNamespaces }; }

export function normalizePublicResponsesEvent(source, state) {
  if (state.terminal || !plain(source)) return [];
  const event = canonical(source);
  if (!event || event.type.startsWith('codex.')) return [];
  const terminal = terminalKind(event);
  const result = [];
  if ((terminal === 'completed' || terminal === 'incomplete') && state.visible) {
    if (!state.created) result.push(encode({ type: 'response.created', response: lifecycle(event.response) }, synthetic(state)));
    if (!state.text && terminalText(event.response)) result.push(encode({ type: 'response.output_text.delta', delta: terminalText(event.response) }, synthetic(state)));
  }
  const sequence = nextSequence(event.sequence_number, state, Boolean(terminal));
  if (sequence === 'overflow') {
    state.terminal = true;
    return [...result, encode(failed({}, 'response_sequence_exhausted'), MAX_SEQUENCE)];
  }
  const projected = terminal === 'failed' ? failed(event) : project(event, terminal, state.customToolNamespaces);
  repairItem(projected, state.customToolNamespaces);
  state.sequence = sequence;
  result.push(encode(projected, sequence));
  if (projected.type === 'response.created') state.created = true;
  if (projected.type.startsWith('response.shell_call_')) state.created = true;
  if (projected.type === 'response.output_text.delta' && projected.delta) state.text = true;
  if (!terminal && projected.type !== 'response.created') state.visible = true;
  state.responseId ||= responseId(projected);
  if (terminal) state.terminal = true;
  return result;
}

export function createChatStreamState(payload) {
  return { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: typeof payload?.model === 'string' ? payload.model : 'unknown', serviceTier: null, roleSent: false, visible: false, terminal: false, toolCalls: false, includeUsage: payload?.stream_options?.include_usage === true };
}

export function normalizeChatEvent(event, state) {
  if (state.terminal || !plain(event) || string(event.type).startsWith('codex.')) return [];
  syncChat(event, state);
  const terminal = terminalKind(event);
  if (terminal === 'failed') {
    state.terminal = true;
    const policyError = publicMisalignmentError(event);
    if (policyError) return [{ error: policyError }];
    return state.roleSent ? [chatChunk(state, {}, 'stop')] : [{ error: { ...safeError(event), code: 'upstream_response_failed', message: 'Upstream response failed' } }];
  }
  const chunks = [];
  const role = () => { if (!state.roleSent) { state.roleSent = true; chunks.push(chatChunk(state, { role: 'assistant' }, null)); } };
  if (plain(event.moderation)) chunks.push({ ...chatChunk(state, null, null), choices: [], moderation: event.moderation });
  if (event.type === 'response.created') role();
  else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) { role(); state.visible = true; chunks.push(chatChunk(state, { content: event.delta }, null)); }
  else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
    state.visible = true;
    state.toolCalls = true;
    const index = integer(event.item.output_index) ?? integer(event.output_index) ?? 0;
    chunks.push(chatChunk(state, { tool_calls: [{ index, id: string(event.item.call_id) || string(event.item.id) || string(event.item_id) || `call_${index}`, type: 'function', function: { name: string(event.item.name) || 'tool', arguments: typeof event.item.arguments === 'string' ? event.item.arguments : '' } }] }, null));
  } else if (event.type === 'response.output_item.added' && event.item?.type === 'custom_tool_call') {
    state.visible = true;
    state.toolCalls = true;
    const index = integer(event.item.output_index) ?? integer(event.output_index) ?? 0;
    chunks.push(chatChunk(state, { tool_calls: [{ index, id: string(event.item.call_id) || string(event.item.id) || string(event.item_id) || `call_${index}`, type: 'custom', custom: { name: string(event.item.name) || 'tool', input: typeof event.item.input === 'string' ? event.item.input : '' } }] }, null));
  } else if (event.type === 'response.function_call_arguments.delta') {
    state.visible = true;
    state.toolCalls = true;
    chunks.push(chatChunk(state, { tool_calls: [{ index: integer(event.output_index) ?? 0, function: { arguments: typeof event.delta === 'string' ? event.delta : '' } }] }, null));
  } else if (event.type === 'response.custom_tool_call_input.delta') {
    state.visible = true;
    state.toolCalls = true;
    chunks.push(chatChunk(state, { tool_calls: [{ index: integer(event.output_index) ?? 0, custom: { input: typeof event.delta === 'string' ? event.delta : '' } }] }, null));
  } else if (terminal === 'completed' || terminal === 'incomplete') {
    role();
    state.toolCalls ||= Array.isArray(event.response?.output) && event.response.output.some((item) => ['function_call', 'custom_tool_call'].includes(item?.type));
    const finish = terminal === 'incomplete'
      ? ['content_filter', 'content-filter'].includes(incompleteReason(event)) ? 'content_filter' : 'length'
      : state.toolCalls ? 'tool_calls' : 'stop';
    chunks.push(chatChunk(state, {}, finish));
    const usage = state.includeUsage && chatUsage(event.response?.usage || event.usage);
    if (usage) chunks.push({ ...chatChunk(state, null, null), choices: [], usage });
    state.terminal = true;
    chunks.push('[DONE]');
  }
  return chunks;
}

function canonical(event) {
  if (!event.type && responseId({ response: event })) return { type: 'response.completed', response: { ...event, status: 'completed' } };
  if (event.type === 'response.done') {
    if (!plain(event.response)) return null;
    const status = string(event.response.status);
    if (status && status !== 'completed') return { ...event, type: 'response.failed' };
    return { ...event, type: 'response.completed', response: { ...event.response, status: 'completed' } };
  }
  return typeof event.type === 'string' ? event : null;
}
function terminalKind(event) {
  if (event.type === 'response.failed' || event.type === 'error' || failedIncomplete(event)) return 'failed';
  if (event.type === 'response.completed' && plain(event.response) && (event.response.status === undefined || event.response.status === 'completed')) return 'completed';
  return event.type === 'response.incomplete' && plain(event.response) ? 'incomplete' : null;
}
function failedIncomplete(event) { const response = event.response || {}; return event.type === 'response.incomplete' && (response.status === 'failed' || [event.error, response.error, event.status_details?.error, response.status_details?.error].some(plain) || FAILURE_REASONS.has(incompleteReason(event))); }
function nextSequence(incoming, state, terminal) { const value = Number.isSafeInteger(incoming) && incoming >= 0 && incoming > state.sequence ? incoming : state.sequence + 1; return value > MAX_SEQUENCE || !terminal && value === MAX_SEQUENCE ? 'overflow' : value; }
function synthetic(state) { state.sequence += 1; return state.sequence; }
function project(event, terminal, namespaces) { const value = structuredClone(event); if (terminal === 'completed') value.response.status = 'completed'; if (plain(value.response) && Array.isArray(value.response.output)) value.response.output.forEach((item, index) => repairItem({ item, output_index: index }, namespaces)); return value; }
function failed(event, reason = '') { const response = plain(event.response) ? event.response : {}; const usage = safeUsage(response.usage || event.usage); return { type: 'response.failed', response: { id: responseId({ response }) || 'resp_failed', object: 'response', created_at: 0, status: 'failed', error: safeError(event), ...(reason || incompleteReason(event) ? { incomplete_details: { reason: reason || incompleteReason(event) } } : {}), model: 'unknown', output: [], output_text: '', instructions: null, metadata: null, ...(usage ? { usage } : {}), temperature: null, top_p: null, parallel_tool_calls: false, tool_choice: 'auto', tools: [] } }; }
function safeError(event) { return publicMisalignmentError(event) || { type: 'server_error', code: 'server_error', message: 'upstream request failed', param: null }; }
function safeUsage(usage) { if (!plain(usage)) return null; const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0; const input = number(usage.input_tokens ?? usage.prompt_tokens); const output = number(usage.output_tokens ?? usage.completion_tokens); return { input_tokens: input, output_tokens: output, total_tokens: Number.isSafeInteger(usage.total_tokens) && usage.total_tokens >= 0 ? usage.total_tokens : input + output }; }
function repairItem(event, namespaces = {}) { const item = event.item; if (!plain(item)) return; if (item.type === 'custom_tool_call' && (item.namespace === undefined || item.namespace === null) && namespaces[item.name]) item.namespace = namespaces[item.name]; if (string(item.id)) return; const index = integer(item.output_index) ?? integer(event.output_index); item.id = string(item.call_id) || string(event.item_id) || `${string(item.type) || 'item'}${index === null ? '' : `_${index}`}`; }

// Applies the same custom_tool_call namespace restoration to a fully-collected
// non-streaming Responses body (the SSE path repairs items via repairItem/project).
export function restoreCustomToolCallNamespaces(response, namespaces = {}) {
  if (plain(response) && Array.isArray(response.output)) {
    for (const item of response.output) repairItem({ item }, namespaces);
  }
  return response;
}
function lifecycle(response) { return { id: responseId({ response }) || 'resp_failed', object: 'response', created_at: 0, status: 'in_progress' }; }
function terminalText(response) { for (const item of response?.output || []) for (const part of item?.content || []) if (typeof part?.text === 'string' && part.text) return part.text; return ''; }
function encode(event, sequence) { return `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`; }
function responseId(event) { const value = string(event?.response?.id); return /^resp_[A-Za-z0-9_-]{1,250}$/.test(value) && Buffer.byteLength(value) <= 255 ? value : ''; }
function syncChat(event, state) { const response = plain(event.response) ? event.response : event; if (string(response.id)) state.id = response.id; if (Number.isInteger(response.created)) state.created = response.created; else if (Number.isInteger(response.created_at)) state.created = response.created_at; if (string(response.model)) state.model = response.model; state.serviceTier = string(event.service_tier) || string(response.service_tier) || state.serviceTier; }
function chatChunk(state, delta, finish) { return { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model, ...(state.serviceTier ? { service_tier: state.serviceTier } : {}), choices: [{ index: 0, delta: delta || {}, finish_reason: finish }] }; }
function chatUsage(value) { if (!plain(value)) return null; const input = integer(value.prompt_tokens) ?? integer(value.input_tokens); const output = integer(value.completion_tokens) ?? integer(value.output_tokens); const result = {}; if (input !== null) result.prompt_tokens = input; if (output !== null) result.completion_tokens = output; const total = integer(value.total_tokens) ?? (input !== null && output !== null ? input + output : null); if (total !== null) result.total_tokens = total; return Object.keys(result).length ? result : null; }
function incompleteReason(event) { return string(event?.response?.incomplete_details?.reason) || string(event?.incomplete_details?.reason); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function string(value) { return typeof value === 'string' ? value.trim() : ''; }
function integer(value) { return Number.isInteger(value) ? value : null; }
