import { createHmac, randomUUID } from 'node:crypto';
import { HttpError } from './http-ingress.js';

const OWNER = randomUUID();
const active = new WeakMap();
export const NATIVE_RECOVERY_WINDOW_MS = 330_000;
const MAX_ITEMS = 4;

// Only keyed seals and write receipts are durable. Payloads stay in the caller.
export function nativeTurnIdentity(store, req, payload) {
  if (!object(payload) || payload.previous_response_id || !Array.isArray(payload.input)) return null;
  const body = payload.client_metadata?.['x-codex-turn-metadata'];
  let header;
  try { header = JSON.parse(req.headers?.['x-codex-turn-metadata'] || 'null'); } catch { return null; }
  const decode = (value) => {
    if (typeof value === 'string') { try { return JSON.parse(value); } catch { return null; } }
    return object(value) ? value : null;
  };
  const bodyMetadata = decode(body);
  const metadata = bodyMetadata || header;
  if (!object(metadata) || !bounded(metadata.turn_id)) return null;
  if (body !== undefined && !bodyMetadata || bodyMetadata && header && seal(store, bodyMetadata) !== seal(store, header)) throw new HttpError(400, 'invalid_turn_metadata', 'Native turn metadata is inconsistent');
  const auth = req.proxyAuth;
  const principal = auth?.shareSessionId || auth?.apiKeyId || auth?.id;
  const scopeId = auth?.scopeId || 'default';
  const thread = req.headers?.['thread-id'] || req.headers?.['session-id'] || req.headers?.['x-codex-session-id'] || req.headers?.['x-codex-window-id'];
  if (!principal || !bounded(thread)) return null;
  const kind = metadata.request_kind || 'turn';
  if (!['turn', 'compaction', 'prewarm', 'memory'].includes(kind)) return null;
  const options = { ...payload, client_metadata: { ...(payload.client_metadata || {}), 'x-codex-turn-metadata': metadata } };
  delete options.type;
  delete options.stream;
  delete options.input;
  // Transport marker has no bearing on native semantics.
  delete options.client_metadata.ws_request_header_x_openai_internal_codex_responses_lite;
  const optionSeal = seal(store, options);
  const key = seal(store, [scopeId, principal, thread, metadata.turn_id, kind, kind === 'turn' ? null : [optionSeal, payload.input]]);
  return { key, scopeId, optionSeal, inputSeal: seal(store, payload.input), inputLength: payload.input.length, agent: metadata.agent_name, kind };
}

export function beginNativeTurn(store, identity, payload, upstream) {
  if (!identity) return null;
  let running = active.get(store);
  if (!running) active.set(store, running = new Map());
  const previous = store.nativeTurnReceipt(identity.key);
  if (previous) {
    const sameAuthority = previous.upstreamId === upstream.id && previous.credentialEpoch === upstream.nativeRecoveryEpoch;
    const recent = Date.parse(previous.updatedAt) + NATIVE_RECOVERY_WINDOW_MS > Date.now();
    const ended = previous.status === 'interrupted' || previous.status === 'in_progress' && previous.owner !== OWNER;
    const proved = sameAuthority && recent && !previous.poisoned && !previous.partialTool && !previous.pendingWrite && previous.optionSeal === identity.optionSeal;
    const exact = previous.inputSeal === identity.inputSeal && previous.items.length === 0 && !previous.partialTool;
    const continuation = proved && verifyContinuation(store, previous, identity, payload.input);
    const toolContinuation = previous.status === 'succeeded' && continuation === 'tool';
    if (running.has(identity.key) || !proved || !(ended && (exact || continuation) || toolContinuation)) {
      throw new HttpError(409, 'duplicate_turn', 'Native turn cannot be replayed without a verified interrupted predecessor');
    }
  }
  const receipt = {
    version: 1, key: identity.key, optionSeal: identity.optionSeal, inputSeal: identity.inputSeal, inputLength: identity.inputLength,
    upstreamId: upstream.id, credentialEpoch: upstream.nativeRecoveryEpoch, owner: OWNER, generation: randomUUID(),
    status: 'in_progress', items: [], visible: false, partialTool: false, pendingTools: [], poisoned: false, pendingWrite: false, updatedAt: new Date().toISOString()
  };
  store.saveNativeTurnReceipt(identity.key, receipt);
  const lease = { receipt, store, finished: false, pendingWrites: 0 };
  running.set(identity.key, lease);
  return lease;
}

export function nativeRecoveryUpstream(store, identity) {
  return identity && store.nativeTurnReceipt(identity.key)?.upstreamId || null;
}

export function nativeWriteStarted(lease) {
  if (!lease || lease.finished) return;
  lease.pendingWrites += 1;
  lease.receipt.pendingWrite = true;
  save(lease);
}

export function nativeEventWritten(lease, event) {
  if (!lease || lease.finished) return;
  const receipt = lease.receipt;
  lease.pendingWrites = Math.max(0, lease.pendingWrites - 1);
  receipt.pendingWrite = lease.pendingWrites > 0;
  if (!object(event)) receipt.poisoned = true;
  else if (event.type === 'response.output_item.done') {
    const digest = completedItemSeal(lease.store, event.item);
    if (!digest || receipt.items.length >= MAX_ITEMS) receipt.poisoned = true;
    else receipt.items.push(digest);
    if (['function_call', 'custom_tool_call'].includes(event.item?.type)) {
      const key = seal(lease.store, ['tool', event.item.id || event.item.call_id]);
      receipt.pendingTools = receipt.pendingTools.filter((pending) => pending !== key);
      receipt.partialTool = receipt.pendingTools.length > 0;
    }
  } else if (event.type === 'response.output_item.added' && ['function_call', 'custom_tool_call'].includes(event.item?.type)) {
    observePartialTool(lease, event.item.id || event.item.call_id);
  }
  else if (['response.output_text.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta', 'response.custom_tool_call_input.delta'].includes(event.type)) {
    receipt.visible = true;
    if (['response.function_call_arguments.delta', 'response.custom_tool_call_input.delta'].includes(event.type)) observePartialTool(lease, event.item_id);
  }
  else if (!knownEvent(event.type)) receipt.poisoned = true;
  save(lease);
  if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event?.type)) {
    const success = ['response.completed', 'response.incomplete'].includes(event.type) && !event.response?.error
      && !['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded'].includes(event.response?.incomplete_details?.reason);
    finishNativeTurn(lease, success ? 'succeeded' : 'failed');
  }
}

export function finishNativeTurn(lease, status = 'interrupted') {
  if (!lease || lease.finished) return;
  lease.receipt.status = status;
  save(lease);
  lease.finished = true;
  active.get(lease.store)?.delete(lease.receipt.key);
}

export function bindNativeTurnUpstream(lease, upstream) {
  if (!lease || lease.finished) return;
  if (lease.receipt.items.length || lease.receipt.pendingWrite) throw new Error('Native turn authority is already visible');
  lease.receipt.upstreamId = upstream.id;
  lease.receipt.credentialEpoch = upstream.nativeRecoveryEpoch;
  save(lease);
}

function save(lease) {
  const current = lease.store.nativeTurnReceipt(lease.receipt.key);
  if (current?.generation !== lease.receipt.generation) { lease.finished = true; return; }
  lease.receipt.updatedAt = new Date().toISOString();
  lease.store.saveNativeTurnReceipt(lease.receipt.key, lease.receipt);
}

function verifyContinuation(store, receipt, identity, input) {
  if (!receipt.items.length || input.length <= receipt.inputLength) return false;
  if (seal(store, input.slice(0, receipt.inputLength)) !== receipt.inputSeal) return false;
  const added = input.slice(receipt.inputLength);
  const output = added.slice(0, receipt.items.length);
  if (output.length !== receipt.items.length || output.some((item, index) => completedItemSeal(store, item) !== receipt.items[index])) return false;
  const suffix = added.slice(output.length);
  if (!suffix.length) return 'grown';
  const results = [];
  while (suffix.length && ['function_call_output', 'custom_tool_call_output'].includes(suffix[0]?.type)) results.push(suffix.shift());
  const calls = output.filter((item) => ['function_call', 'custom_tool_call'].includes(item?.type));
  if (calls.length || results.length) {
    if (!calls.length || calls.length !== results.length || new Set(calls.map((call) => call.call_id)).size !== calls.length) return false;
    if (calls.some((call, index) => {
      const result = results[index];
      return !bounded(call.call_id) || !bounded(call.name) || typeof (call.type === 'function_call' ? call.arguments : call.input) !== 'string'
        || result.type !== (call.type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output') || result.call_id !== call.call_id
        || !(typeof result.output === 'string' || Array.isArray(result.output))
        || ['name', 'namespace'].some((field) => result[field] !== undefined && result[field] !== call[field]);
    })) return false;
    if (!suffix.length) return 'tool';
  }
  if (!bounded(identity.agent) || !suffix.every((item) => incomingMail(item, identity.agent))) return false;
  if (!output.some(preemptible) || output.some((item) => !preemptible(item) && !calls.includes(item))) return false;
  return 'mailbox';
}

function incomingMail(item, agent) {
  return item?.type === 'agent_message' && bounded(item.author) && item.author !== agent && item.recipient === agent
    && Array.isArray(item.content) && item.content.length > 0 && item.content.every((part) =>
      part?.type === 'input_text' && typeof part.text === 'string' && part.text.length > 0
      || part?.type === 'encrypted_content' && typeof part.encrypted_content === 'string' && part.encrypted_content.length > 0);
}

function observePartialTool(lease, id) {
  const receipt = lease.receipt;
  receipt.partialTool = true;
  if (!bounded(id)) { receipt.poisoned = true; return; }
  const key = seal(lease.store, ['tool', id]);
  if (!receipt.pendingTools.includes(key)) {
    if (receipt.pendingTools.length >= MAX_ITEMS) receipt.poisoned = true;
    else receipt.pendingTools.push(key);
  }
}

function preemptible(item) { return item?.type === 'reasoning' || item?.type === 'message' && item.role === 'assistant' && item.phase === 'commentary'; }

export function completedItemSeal(store, item) {
  if (!object(item) || !['reasoning', 'message', 'function_call', 'custom_tool_call'].includes(item.type)) return null;
  let projected = { ...item };
  delete projected.status;
  delete projected.internal_chat_message_metadata_passthrough;
  if (item.type === 'reasoning') {
    projected = pick(item, ['type', 'id', 'summary', 'encrypted_content', 'content']);
    if (Array.isArray(projected.summary)) projected.summary = projected.summary.map((part) => pick(part, ['type', 'text']));
    if (Array.isArray(projected.content)) projected.content = projected.content.some((part) => part.type === 'reasoning_text') ? projected.content.map((part) => pick(part, ['type', 'text'])) : undefined;
  } else if (item.type === 'message') {
    if (item.role !== 'assistant') return null;
    if (item.phase === 'commentary' && typeof item.id === 'string' && item.content?.length && item.content.every((part) => part.type === 'output_text' && typeof part.text === 'string')) {
      projected = pick(item, ['type', 'id', 'role', 'phase']);
      projected.content = item.content.map((part) => pick(part, ['type', 'text']));
    } else if (Array.isArray(projected.content)) projected.content = projected.content.map((part) => {
      const value = { ...part }; delete value.annotations; delete value.logprobs; return value;
    });
  }
  return seal(store, projected);
}

function seal(store, value) { return createHmac('sha256', store.key).update('native-recovery-v1\0').update(JSON.stringify(canonical(value))).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== null && value[key] !== undefined).map((key) => [key, canonical(value[key])]));
}
function pick(value, keys) { return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])); }
function bounded(value) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function knownEvent(type) {
  return ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.content_part.done', 'response.output_text.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.reasoning_summary_text.done', 'response.reasoning_text.done', 'response.function_call_arguments.done', 'response.custom_tool_call_input.done', 'response.completed', 'response.incomplete', 'response.failed', 'error', 'codex.response.metadata'].includes(type);
}
