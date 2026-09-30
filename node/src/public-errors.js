import { HttpError } from './http-ingress.js';
import { PacingError } from './upstream-pacer.js';

export function errorEnvelope(error) {
  if (error instanceof HttpError) return { status: error.statusCode, body: openaiError(error.type, error.code, error.message) };
  if (error instanceof PacingError && ['queue_full', 'queue_expired', 'would_wait'].includes(error.code)) return pacingUnavailable(error);
  if (error instanceof PacingError && error.code === 'account_removed') {
    return { status: 503, body: openaiError('server_error', 'no_eligible_backend', 'No eligible upstream is available') };
  }
  if (error?.codexHostCircuitOpen) return codexHostUnavailable(error.retryAfterSeconds);
  if (error?.statusCode === 404) return { status: 404, body: openaiError('invalid_request_error', 'not_found', 'Not found') };
  return upstreamFailure();
}

export function upstreamFailure() {
  return { status: 502, body: openaiError('server_error', 'upstream_error', 'Upstream request failed') };
}

export function codexHostUnavailable(retryAfterSeconds = 1) {
  const seconds = Math.max(1, Number(retryAfterSeconds) || 1);
  return {
    status: 503,
    body: openaiError('server_error', 'codex_host_unavailable', 'Codex host is temporarily unreachable'),
    headers: { 'retry-after': String(seconds) }
  };
}

export function pacingUnavailable(error) {
  const seconds = Math.max(1, Number(error?.retryAfterSeconds) || 1);
  const code = error?.code === 'queue_expired' ? 'local_pacing_queue_expired' : 'local_pacing_queue_full';
  const message = error?.code === 'queue_expired'
    ? 'The local pacing queue wait expired'
    : 'The local pacing queue is full';
  return {
    status: 429,
    body: openaiError('server_error', code, message),
    headers: { 'retry-after': String(seconds) }
  };
}

export function openaiError(type, code, message, param = null) {
  return { error: { type, code, message, param } };
}
