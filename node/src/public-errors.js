import { HttpError } from './http-ingress.js';

export function errorEnvelope(error) {
  if (error instanceof HttpError) return { status: error.statusCode, body: openaiError(error.type, error.code, error.message) };
  if (error?.statusCode === 404) return { status: 404, body: openaiError('invalid_request_error', 'not_found', 'Not found') };
  return upstreamFailure();
}

export function upstreamFailure() {
  return { status: 502, body: openaiError('server_error', 'upstream_error', 'Upstream request failed') };
}

export function openaiError(type, code, message, param = null) {
  return { error: { type, code, message, param } };
}
