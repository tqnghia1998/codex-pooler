import { createHash } from 'node:crypto';

const DEFAULT_WEBSOCKET_KEEPALIVE_MS = 30_000;
const DEFAULT_WEBSOCKET_IDLE_MS = 30 * 60 * 1_000;
const DEFAULT_WEBSOCKET_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_WEBSOCKET_PENDING_BYTES = 2 * 1024 * 1024;
const DEFAULT_WEBSOCKET_BACKPRESSURE_BYTES = 16 * 1024 * 1024;
const DEFAULT_BOOTSTRAP_BYTES = 512 * 1024;
const DEFAULT_BOOTSTRAP_EVENTS = 32;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 1_000;
const MAX_INPUT_ITEM_ID_LENGTH = 64;
const ID_PREFIXES = {
  message: 'msg',
  reasoning: 'rs',
  function_call: 'fc',
  custom_tool_call: 'ctc',
  custom_tool_call_output: 'ctco'
};

export function codexGatewayOptions(input = {}, env = process.env) {
  return {
    websocketKeepAliveMs: positiveInteger(input.websocketKeepAliveMs ?? env.CODEX_POOLER_CODEX_WEBSOCKET_KEEPALIVE_MS, DEFAULT_WEBSOCKET_KEEPALIVE_MS, 0, 60 * 60 * 1_000),
    websocketIdleMs: positiveInteger(input.websocketIdleMs ?? env.CODEX_POOLER_CODEX_WEBSOCKET_IDLE_MS, DEFAULT_WEBSOCKET_IDLE_MS, 1_000, 24 * 60 * 60 * 1_000),
    websocketFrameBytes: positiveInteger(input.websocketFrameBytes ?? env.CODEX_POOLER_CODEX_WEBSOCKET_FRAME_BYTES, DEFAULT_WEBSOCKET_FRAME_BYTES, 64 * 1024, 64 * 1024 * 1024),
    websocketPendingBytes: positiveInteger(input.websocketPendingBytes ?? env.CODEX_POOLER_CODEX_WEBSOCKET_PENDING_BYTES, DEFAULT_WEBSOCKET_PENDING_BYTES, 64 * 1024, 64 * 1024 * 1024),
    websocketBackpressureBytes: positiveInteger(input.websocketBackpressureBytes ?? env.CODEX_POOLER_CODEX_WEBSOCKET_BACKPRESSURE_BYTES, DEFAULT_WEBSOCKET_BACKPRESSURE_BYTES, 64 * 1024, 64 * 1024 * 1024),
    streamBootstrapBuffering: booleanValue(input.streamBootstrapBuffering ?? env.CODEX_POOLER_CODEX_STREAM_BOOTSTRAP_BUFFERING, false),
    streamBootstrapBytes: positiveInteger(input.streamBootstrapBytes ?? env.CODEX_POOLER_CODEX_STREAM_BOOTSTRAP_BYTES, DEFAULT_BOOTSTRAP_BYTES, 16 * 1024, 8 * 1024 * 1024),
    streamBootstrapEvents: positiveInteger(input.streamBootstrapEvents ?? env.CODEX_POOLER_CODEX_STREAM_BOOTSTRAP_EVENTS, DEFAULT_BOOTSTRAP_EVENTS, 1, 256),
    streamBootstrapTimeoutMs: positiveInteger(input.streamBootstrapTimeoutMs ?? env.CODEX_POOLER_CODEX_STREAM_BOOTSTRAP_TIMEOUT_MS, DEFAULT_BOOTSTRAP_TIMEOUT_MS, 50, 30_000),
    optimizeMultiAgentV2: booleanValue(input.optimizeMultiAgentV2 ?? env.CODEX_POOLER_CODEX_OPTIMIZE_MULTI_AGENT_V2, false),
    orphanDelegationCompatibility: booleanValue(input.orphanDelegationCompatibility ?? env.CODEX_POOLER_CODEX_ORPHAN_DELEGATION_COMPATIBILITY, false)
  };
}

export function isOfficialCodexClient(req) {
  // User-Agent is client-controlled and is only an opt-in compatibility hint,
  // never an authentication or authorization boundary.
  const userAgent = header(req, 'user-agent');
  return userAgent.startsWith('Codex Desktop/')
    || userAgent.startsWith('codex-tui/')
    || userAgent === 'codex_cli_rs'
    || userAgent.startsWith('codex_cli_rs/');
}

export function prepareCodexMultiAgentRequest(payload, req, options = {}) {
  const enabled = options.optimizeMultiAgentV2 === true && isOfficialCodexClient(req);
  const orphanEnabled = options.orphanDelegationCompatibility === true && isOfficialCodexClient(req);
  if (!enabled && !orphanEnabled) return { payload, optimized: false };
  let updated = structuredClone(payload);
  if (orphanEnabled && header(req, 'x-openai-subagent').toLowerCase() === 'collab_spawn') {
    updated = rewriteOrphanDelegation(updated);
  }
  if (!enabled) return { payload: updated, optimized: false };
  rewriteAgentMessageContent(updated);
  removeCollaborationMessageEncryption(updated);
  const optimized = renameCollaborationNamespace(updated);
  return { payload: updated, optimized };
}

export function restoreCodexMultiAgentResponse(value, optimized) {
  if (!optimized || !value || typeof value !== 'object') return value;
  if (!containsOptimizedCollaborationNamespace(value)) return value;
  const restored = structuredClone(value);
  copyOwnSymbolProperties(value, restored);
  restoreCollaborationNamespace(restored);
  return restored;
}

export function sanitizeCodexInputItemIds(payload) {
  if (!payload || !Array.isArray(payload.input)) return payload;
  const items = payload.input;
  const states = new Map();
  const normalizedIds = new Map();
  const dropped = new Set();

  for (const item of items) {
    if (shouldDropEncryptedReasoning(item)) {
      dropped.add(item);
      continue;
    }
    const original = typeof item?.id === 'string' ? item.id : null;
    if (original === null) continue;
    const normalized = normalizeItemId(item.type, original);
    normalizedIds.set(item, normalized);
    const state = states.get(normalized) || { preserved: false, occupied: false };
    if (normalized === original && codePointLength(normalized) <= MAX_INPUT_ITEM_ID_LENGTH) state.preserved = true;
    if (codePointLength(normalized) <= MAX_INPUT_ITEM_ID_LENGTH) state.occupied = true;
    states.set(normalized, state);
  }

  const mapped = new Map();
  const output = [];
  let changed = false;
  for (const item of items) {
    if (dropped.has(item)) {
      changed = true;
      continue;
    }
    const original = typeof item?.id === 'string' ? item.id : null;
    if (original === null) {
      output.push(item);
      continue;
    }
    let next = normalizedIds.get(item) || original;
    const state = states.get(next);
    if (next !== original && state?.preserved) next = shortenItemId(next, states);
    if (codePointLength(next) > MAX_INPUT_ITEM_ID_LENGTH) {
      if (!mapped.has(next)) mapped.set(next, shortenItemId(next, states));
      next = mapped.get(next);
    }
    if (next !== original) {
      output.push({ ...item, id: next });
      changed = true;
    } else output.push(item);
  }
  if (!changed) return payload;
  return { ...payload, input: output };
}

function rewriteAgentMessageContent(payload) {
  for (const item of payload.input || []) {
    if (item?.type !== 'agent_message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type !== 'encrypted_content' || typeof part.encrypted_content !== 'string') continue;
      part.type = 'input_text';
      part.text = part.encrypted_content;
      delete part.encrypted_content;
    }
  }
}

function removeCollaborationMessageEncryption(payload) {
  walkTools(payload.tools, (tool) => {
    if (!['spawn_agent', 'send_message', 'followup_task'].includes(tool?.name)) return;
    const message = tool.parameters?.properties?.message;
    if (message && typeof message === 'object') delete message.encrypted;
  });
  for (const item of payload.input || []) {
    if (item?.type === 'additional_tools') walkTools(item.tools, (tool) => {
      if (!['spawn_agent', 'send_message', 'followup_task'].includes(tool?.name)) return;
      const message = tool.parameters?.properties?.message;
      if (message && typeof message === 'object') delete message.encrypted;
    });
  }
}

function renameCollaborationNamespace(payload) {
  let changed = false;
  walkTools(payload.tools, (tool) => {
    if (tool?.type === 'namespace' && tool.name === 'collaboration' && hasSpawnAgent(tool.tools)) {
      tool.name = 'collaboration-optimize';
      changed = true;
    }
  });
  for (const item of payload.input || []) {
    if (item?.type === 'additional_tools') walkTools(item.tools, (tool) => {
      if (tool?.type === 'namespace' && tool.name === 'collaboration' && hasSpawnAgent(tool.tools)) {
        tool.name = 'collaboration-optimize';
        changed = true;
      }
    });
  }
  return changed;
}

function restoreCollaborationNamespace(value) {
  if (Array.isArray(value)) {
    for (const child of value) restoreCollaborationNamespace(child);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const isCall = value.type === 'function_call' || value.type === 'custom_tool_call';
  if (value.type === 'namespace' && value.name === 'collaboration-optimize') value.name = 'collaboration';
  if (isCall && typeof value.namespace === 'string' && value.namespace === 'collaboration-optimize') value.namespace = 'collaboration';
  if (isCall && typeof value.name === 'string' && value.name.startsWith('collaboration-optimize__')) {
    value.name = `collaboration__${value.name.slice('collaboration-optimize__'.length)}`;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'arguments' || key === 'input' || key === 'output' && ['function_call_output', 'custom_tool_call_output'].includes(value.type)) continue;
    restoreCollaborationNamespace(child);
  }
}

function containsOptimizedCollaborationNamespace(value) {
  if (typeof value === 'string') return value === 'collaboration-optimize' || value.startsWith('collaboration-optimize__');
  if (Array.isArray(value)) return value.some(containsOptimizedCollaborationNamespace);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsOptimizedCollaborationNamespace);
}

function copyOwnSymbolProperties(source, target) {
  for (const symbol of Object.getOwnPropertySymbols(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, symbol);
    if (descriptor) Object.defineProperty(target, symbol, descriptor);
  }
}

function rewriteOrphanDelegation(payload) {
  if (!Array.isArray(payload.input)) return payload;
  const available = new Map();
  for (const item of payload.input) {
    if (item?.type !== 'function_call' || typeof item.call_id !== 'string') continue;
    available.set(item.call_id, (available.get(item.call_id) || 0) + 1);
  }
  payload.input = payload.input.map((item) => {
    if (item?.type !== 'function_call_output') return item;
    if (typeof item.call_id === 'string' && (available.get(item.call_id) || 0) > 0) {
      available.set(item.call_id, available.get(item.call_id) - 1);
      return item;
    }
    const tool = item.namespace === 'codex_app' && ['create_thread', 'send_message_to_thread'].includes(item.name)
      ? `codex_app__${item.name}`
      : null;
    if (!tool) return item;
    const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
    return { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Tool output from ${tool}:\n${output}` }] };
  });
  return payload;
}

function walkTools(tools, visitor) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    visitor(tool, tools);
    if (tool?.type === 'namespace') walkTools(tool.tools, visitor);
  }
}

function hasSpawnAgent(tools) {
  let found = false;
  walkTools(tools, (tool) => { if (tool?.name === 'spawn_agent') found = true; });
  return found;
}

function shouldDropEncryptedReasoning(item) {
  return item?.type === 'reasoning'
    && typeof item.id === 'string'
    && codePointLength(item.id) > MAX_INPUT_ITEM_ID_LENGTH
    && typeof item.encrypted_content === 'string'
    && item.encrypted_content.length > 0;
}

function normalizeItemId(type, id) {
  const prefix = ID_PREFIXES[type];
  if (!prefix || !id || id.startsWith(prefix)) return id;
  return `${prefix}_${id}`;
}

function shortenItemId(id, states, attempt = 0) {
  const hashInput = attempt ? `${id}\u0000${attempt}` : id;
  const suffix = `_${createHash('sha256').update(hashInput).digest('hex').slice(0, 16)}`;
  const prefix = Array.from(id).slice(0, MAX_INPUT_ITEM_ID_LENGTH - suffix.length).join('');
  const shortened = `${prefix}${suffix}`;
  const state = states.get(shortened);
  if (state?.occupied) return shortenItemId(id, states, attempt + 1);
  states.set(shortened, { occupied: true, preserved: false });
  return shortened;
}

function codePointLength(value) { return Array.from(value).length; }

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN;
  if (!Number.isInteger(parsed) || parsed < minimum) return fallback;
  return Math.min(parsed, maximum);
}

function booleanValue(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function header(req, name) {
  const value = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()];
  return typeof value === 'string' ? value.trim() : '';
}
