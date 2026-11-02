import { classifySseEvent } from './upstream-outcomes.js';

const TERMINAL_ERRORS = new Set(['error', 'response.failed', 'response.incomplete']);
const COLLABORATION_CALLS = new Set(['spawn_agent', 'send_message', 'followup_task']);
const MAX_RETRY_SECONDS = (1n << 64n) - 1n;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;

export function normalizeNativeRetryAfter(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 128 || /[\x00-\x1f\x7f]/.test(value)) return null;
  const text = value.replace(/^ +| +$/g, '');
  if (/^\d+$/.test(text)) {
    const seconds = BigInt(text);
    return seconds <= MAX_RETRY_SECONDS ? String(seconds) : null;
  }
  const time = Date.parse(text);
  return Number.isFinite(time) && new Date(time).toUTCString() === text ? text : null;
}

export function nativeWebSocketRetryAfter(event) {
  if (!TERMINAL_ERRORS.has(event?.type) || (event.status ?? event.status_code) !== 429) return null;
  const nested = event.response?.error?.headers ?? event.error?.headers;
  for (const headers of [nested, event.headers]) {
    if (!object(headers)) continue;
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== 'retry-after') continue;
      const normalized = normalizeNativeRetryAfter(value);
      if (normalized !== null) return normalized;
    }
  }
  return null;
}

export function classifyNativeWebSocketEvent(event) {
  const outcome = classifySseEvent(event);
  const retryAfter = nativeWebSocketRetryAfter(event);
  return outcome.class === 'quota' && retryAfter !== null ? { ...outcome, retryAfter } : outcome;
}

// Only a new, unanchored full history can move to another producing account.
// Exempt the known outer collaboration ciphertext, never additional fields.
export function portableNativeHistory(payload) {
  if (payload?.type !== 'response.create' || payload.previous_response_id != null && payload.previous_response_id !== ''
    || payload.conversation != null || payload.conversation_id != null) return false;
  if (typeof payload.input === 'string') return nonblank(payload.input);
  if (!Array.isArray(payload.input) || !payload.input.length) return false;
  const pending = payload.input.map((item) => {
    if (item?.type === 'function_call' && item.namespace === 'collaboration'
      && COLLABORATION_CALLS.has(item.name) && item.status === 'completed'
      && nonblank(item.encrypted_content) && nonblank(item.call_id) && typeof item.arguments === 'string') {
      const { encrypted_content, ...rest } = item;
      return rest;
    }
    return item;
  });
  for (let visited = 0; pending.length; visited += 1) {
    if (visited >= 100_000) return false;
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (object(value)) {
      if (['item_reference', 'compaction_trigger'].includes(value.type)
        || ['file_id', 'previous_response_id', 'conversation_id', 'conversation'].some((key) => Object.hasOwn(value, key))) return false;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'encrypted_content') {
          if (!['reasoning', 'compaction'].includes(value.type) || typeof child !== 'string') return false;
        } else if (!(key === 'id' && value.type === 'compaction')) pending.push(child);
      }
    }
  }
  return true;
}
