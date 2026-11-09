import { createHmac } from 'node:crypto';
import { HttpError } from './http-ingress.js';

const active = new WeakMap();
const MAX_ACTIVE = 4096;

// Process-local admission only: no payloads, identities or retry results persist.
// Hold until the full request (including downstream delivery/settlement) finishes.
export function beginNativeHttpRequest(store, req, path, payload) {
  if (!['/backend-api/codex/responses', '/backend-api/codex/v1/responses',
    '/backend-api/codex/responses/compact', '/backend-api/codex/v1/responses/compact'].includes(path)) return null;
  const auth = req.proxyAuth || {};
  const principal = auth.personalKeyId || auth.shareSessionId || auth.apiKeyId || auth.id || req.headers?.authorization;
  if (!principal) return null;
  // Match native recovery's continuity precedence. Reconnect/window and attempt
  // metadata may change while a request in the same thread is still running.
  const continuity = ['thread-id', 'session-id', 'x-codex-session-id', 'x-codex-window-id']
    .map((name) => req.headers?.[name]).find((value) => typeof value === 'string' && value.trim())?.trim() || null;
  const identity = [auth.scopeId || 'default', principal, continuity,
    path.endsWith('/compact') ? 'compact' : 'responses'];
  const key = createHmac('sha256', store.key).update('native-http-active-v1\0')
    .update(JSON.stringify(identity)).update('\0').update(JSON.stringify(payload)).digest('hex');
  let running = active.get(store);
  if (!running) active.set(store, running = new Set());
  if (running.has(key)) throw new HttpError(409, 'duplicate_turn', 'An identical native HTTP request is still in progress');
  // Never evict a live fence to admit new work.
  if (running.size >= MAX_ACTIVE) throw new HttpError(503, 'native_request_capacity', 'Native HTTP request capacity reached');
  running.add(key);
  let released = false;
  return () => { if (!released) { released = true; running.delete(key); } };
}
