import { createHash } from 'node:crypto';

const DEFAULT_CODEX_VERSION = '0.146.1';
const DEFAULT_CODEX_ORIGINATOR = 'codex_cli_rs';
const DEFAULT_CODEX_WEBSOCKET_BETA = 'responses_websockets=2026-02-06';
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
export const PROTOCOL_FINGERPRINT_VERSION = 1;
const HEADER_VALUE_MAX_BYTES = 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/;
const BETA_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._=:+/-]{0,255}$/;

export function codexProtocolHeaders(req = null, { inheritClient = false, websocket = false, env = process.env } = {}) {
  const inheritedVersion = inheritClient ? safeToken(header(req, 'version')) : '';
  const inheritedOriginator = inheritClient ? safeToken(header(req, 'originator')) : '';
  const version = inheritedVersion || safeToken(env.CODEX_POOLER_CODEX_CLIENT_VERSION) || DEFAULT_CODEX_VERSION;
  const originator = inheritedOriginator || safeToken(env.CODEX_POOLER_CODEX_ORIGINATOR) || DEFAULT_CODEX_ORIGINATOR;
  const headers = {
    'user-agent': `${originator}/${version}`,
    originator,
    version
  };
  const beta = codexBetaHeader(req, { inheritClient, websocket, env });
  if (beta) headers['openai-beta'] = beta;
  return headers;
}

export function codexProtocolVersion(req = null, { inheritClient = false } = {}) {
  return codexProtocolHeaders(req, { inheritClient }).version;
}

export function compatibilityProtocolFingerprint(provider, {
  req = null,
  inheritClient = false,
  websocket = false,
  anthropicVersion = '',
  anthropicBeta = '',
  env = process.env
} = {}) {
  const values = provider === 'codex'
    ? normalizedCodexFingerprintValues(codexProtocolHeaders(req, { inheritClient, websocket, env }))
    : {
        version: safeToken(anthropicVersion || header(req, 'anthropic-version')) || DEFAULT_ANTHROPIC_VERSION,
        beta: [...new Set(safeBetaList(anthropicBeta || header(req, 'anthropic-beta')))].sort()
      };
  const fingerprint = {
    schemaVersion: PROTOCOL_FINGERPRINT_VERSION,
    provider,
    values
  };
  return {
    version: PROTOCOL_FINGERPRINT_VERSION,
    hash: createHash('sha256').update(canonicalJson(fingerprint)).digest('hex').slice(0, 32),
    values
  };
}

export function defaultProtocolFingerprints() {
  return {
    codex: compatibilityProtocolFingerprint('codex'),
    codexWebsocket: compatibilityProtocolFingerprint('codex', { websocket: true }),
    compass: compatibilityProtocolFingerprint('compass')
  };
}

function codexBetaHeader(req, { inheritClient, websocket, env }) {
  const configured = safeBetaList(env.CODEX_POOLER_CODEX_HTTP_BETA);
  const inherited = inheritClient ? safeBetaList(header(req, 'openai-beta')) : [];
  const required = websocket
    ? safeBetaList(env.CODEX_POOLER_CODEX_WEBSOCKET_BETA || DEFAULT_CODEX_WEBSOCKET_BETA)
    : [];
  const values = [...new Set([...required, ...configured, ...inherited])];
  const joined = values.join(',');
  return Buffer.byteLength(joined) <= HEADER_VALUE_MAX_BYTES ? joined : values[0] || '';
}

function normalizedCodexFingerprintValues(headers) {
  const beta = safeBetaList(headers['openai-beta']).sort();
  return {
    'user-agent': headers['user-agent'],
    originator: headers.originator,
    version: headers.version,
    ...(beta.length ? { 'openai-beta': beta.join(',') } : {})
  };
}

function safeBetaList(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((entry) => entry.trim()).filter((entry) => BETA_TOKEN_PATTERN.test(entry));
}

function safeToken(value) {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  return TOKEN_PATTERN.test(token) ? token : '';
}

function header(req, name) {
  const value = req?.headers?.[name];
  return typeof value === 'string' && Buffer.byteLength(value) <= HEADER_VALUE_MAX_BYTES && !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : '';
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
