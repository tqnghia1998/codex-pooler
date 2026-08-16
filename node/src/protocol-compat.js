const DEFAULT_CODEX_VERSION = '0.146.1';
const DEFAULT_CODEX_ORIGINATOR = 'codex_cli_rs';
const DEFAULT_CODEX_WEBSOCKET_BETA = 'responses_websockets=2026-02-06';
const HEADER_VALUE_MAX_BYTES = 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/;
const BETA_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._=:+/-]{0,255}$/;

export function codexProtocolHeaders(req = null, { inheritClient = false, websocket = false } = {}) {
  const inheritedVersion = inheritClient ? safeToken(header(req, 'version')) : '';
  const inheritedOriginator = inheritClient ? safeToken(header(req, 'originator')) : '';
  const version = inheritedVersion || safeToken(process.env.CODEX_POOLER_CODEX_CLIENT_VERSION) || DEFAULT_CODEX_VERSION;
  const originator = inheritedOriginator || safeToken(process.env.CODEX_POOLER_CODEX_ORIGINATOR) || DEFAULT_CODEX_ORIGINATOR;
  const headers = {
    'user-agent': `${originator}/${version}`,
    originator,
    version
  };
  const beta = codexBetaHeader(req, { inheritClient, websocket });
  if (beta) headers['openai-beta'] = beta;
  return headers;
}

export function codexProtocolVersion(req = null, { inheritClient = false } = {}) {
  return codexProtocolHeaders(req, { inheritClient }).version;
}

function codexBetaHeader(req, { inheritClient, websocket }) {
  const configured = safeBetaList(process.env.CODEX_POOLER_CODEX_HTTP_BETA);
  const inherited = inheritClient ? safeBetaList(header(req, 'openai-beta')) : [];
  const required = websocket
    ? safeBetaList(process.env.CODEX_POOLER_CODEX_WEBSOCKET_BETA || DEFAULT_CODEX_WEBSOCKET_BETA)
    : [];
  const values = [...new Set([...required, ...configured, ...inherited])];
  const joined = values.join(',');
  return Buffer.byteLength(joined) <= HEADER_VALUE_MAX_BYTES ? joined : values[0] || '';
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
