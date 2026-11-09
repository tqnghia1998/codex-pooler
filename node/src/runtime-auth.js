// Runtime instance denials cannot be repaired by rotating an account token.
const TERMINAL_CODES = new Set(['runtime_assertion_invalid', 'runtime_instance_paused', 'runtime_instance_revoked', 'invalid_agent_instance_assertion']);
export function terminalRuntimeAuthDenial(response, body = null) {
  if (![401, 403].includes(Number(response?.status ?? response?.statusCode))) return false;
  const headers = response?.headers;
  const raw = typeof headers?.get === 'function' ? headers.get('x-error-json') : headers?.['x-error-json'];
  const encoded = Array.isArray(raw) ? raw[0] : raw;
  if (typeof encoded === 'string' && encoded.length <= 8192) {
    try {
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') === encoded && TERMINAL_CODES.has(JSON.parse(bytes.toString('utf8'))?.error?.code)) return true;
    } catch {}
  }
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    if (Buffer.byteLength(body) > 65536) return false;
    try { body = JSON.parse(body.toString()); } catch { return false; }
  }
  return TERMINAL_CODES.has(body?.error?.code);
}
