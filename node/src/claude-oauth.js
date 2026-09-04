import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CLAUDE_OAUTH_AUTH_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_PROFILE_URL,
  CLAUDE_OAUTH_USAGE_URL,
  CLAUDE_OAUTH_REDIRECT_URI,
  CLAUDE_OAUTH_SCOPE,
  CLAUDE_OAUTH_TOKEN_URL
} from './providers.js';
import { parseClaudeAuthJson } from './domain.js';
import { decodeClaudeResponse } from './upstream-response.js';
import { claudeProxyDispatcher } from './claude-transport.js';

const PENDING_LOGIN_TTL_MS = 10 * 60_000;
const MAX_PENDING_LOGINS = 1_024;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLAUDE_CODE_VERSION = '2.1.260';
const configuredClaudeCodeVersion = process.env.CODEX_POOLER_CLAUDE_CODE_VERSION;
const CLAUDE_CODE_VERSION = /^\d+\.\d+\.\d+$/.test(configuredClaudeCodeVersion || '')
  ? configuredClaudeCodeVersion
  : DEFAULT_CLAUDE_CODE_VERSION;

export class ClaudeOAuthBroker {
  constructor({ store, fetchImpl = globalThis.fetch, proxyUrl = '' } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.proxyUrl = typeof proxyUrl === 'string' ? proxyUrl : '';
    this.pending = new Map();
  }

  start() {
    const state = randomUUID();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pending.set(state, { verifier, expiresAt: Date.now() + PENDING_LOGIN_TTL_MS });
    this.prune();
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      response_type: 'code',
      redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
      scope: CLAUDE_OAUTH_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state
    });
    return { state, authorizationUrl: `${CLAUDE_OAUTH_AUTH_URL}?${params}` };
  }

  async exchange({ code, state }) {
    const suppliedState = clean(state);
    const pending = this.pending.get(suppliedState);
    this.pending.delete(suppliedState);
    if (!pending || pending.expiresAt <= Date.now()) throw oauthError(400, 'Claude OAuth state is missing or expired');
    const callback = splitCallbackCode(code);
    if (callback.state && callback.state !== suppliedState) throw oauthError(400, 'Claude OAuth state does not match');
    const token = await exchangeCode({
      code: callback.code,
      state: suppliedState,
      verifier: pending.verifier,
      fetchImpl: this.fetchImpl,
      proxyUrl: this.proxyUrl
    });
    let profile = null;
    if (token.accessToken) {
      try {
        profile = await fetchProfile(token.accessToken, this.fetchImpl, { proxyUrl: this.proxyUrl });
      } catch (error) {
        if (!isAdvisoryLookupError(error)) throw error;
        // The token exchange is authoritative. Profile lookup is advisory and
        // can fail independently when the control-plane endpoint is degraded.
      }
    }
    const upstream = this.store.create({
      type: 'claude',
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt,
      email: profile?.account?.email || profile?.account?.email_address || token.email,
      accountId: profile?.account?.uuid || token.accountId,
      organizationId: profile?.organization?.uuid || token.organizationId,
      organizationName: profile?.organization?.name || token.organizationName,
      // CPA allocates the single credential device identity at exchange time,
      // so the first inference request cannot race identity initialization.
      metadata: { claude_device_ids: [randomBytes(32).toString('hex')] }
    }, { allowDuplicateCodexIdentity: false });
    return { upstream, account: profile || null };
  }

  prune() {
    const now = Date.now();
    for (const [state, login] of this.pending) if (login.expiresAt <= now) this.pending.delete(state);
    while (this.pending.size > MAX_PENDING_LOGINS) this.pending.delete(this.pending.keys().next().value);
  }
}

export async function exchangeCode({ code, state, verifier, fetchImpl = globalThis.fetch, proxyUrl = '' } = {}) {
  const { response, body } = await fetchClaudeOAuth(CLAUDE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'user-agent': 'axios/1.15.2',
      'accept-encoding': 'gzip, compress, deflate, br',
      connection: 'close'
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: clean(code),
      redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      code_verifier: clean(verifier),
      state: clean(state)
    })
  }, fetchImpl, proxyUrl);
  if (!response.ok) throw providerError(response.status, body, 'Claude OAuth code exchange failed', response.headers);
  return parseClaudeAuthJson(body);
}

export async function fetchProfile(accessToken, fetchImpl = globalThis.fetch, { proxyUrl = '' } = {}) {
  const { response, body } = await fetchClaudeOAuth(CLAUDE_OAUTH_PROFILE_URL, {
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${clean(accessToken)}`,
      'user-agent': 'axios/1.15.2',
      'accept-encoding': 'gzip, compress, deflate, br',
      'cache-control': 'no-cache',
      connection: 'close'
    }
  }, fetchImpl, proxyUrl);
  if (!response.ok) throw providerError(response.status, body, 'Claude OAuth profile lookup failed', response.headers);
  return body;
}

export async function fetchClaudeUsage(accessToken, fetchImpl = globalThis.fetch, { proxyUrl = '' } = {}) {
  const { response, body } = await fetchClaudeOAuth(CLAUDE_OAUTH_USAGE_URL, {
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${clean(accessToken)}`,
      'content-type': 'application/json',
      'user-agent': `claude-code/${CLAUDE_CODE_VERSION}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'cache-control': 'no-cache',
      connection: 'close'
    }
  }, fetchImpl, proxyUrl);
  if (!response.ok) throw providerError(response.status, body, 'Claude OAuth usage lookup failed', response.headers);
  return body;
}

async function fetchClaudeOAuth(url, options, fetchImpl, proxyUrl = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_REQUEST_TIMEOUT_MS);
  const dispatcher = fetchImpl === globalThis.fetch ? claudeProxyDispatcher(proxyUrl) : null;
  try {
    const response = await fetchImpl(url, {
      ...options,
      ...(dispatcher ? { dispatcher } : {}),
      signal: controller.signal
    });
    const decoded = await decodeClaudeResponse(response, { maxBytes: 2 * 1024 * 1024 });
    return { response: decoded, body: await responseJson(decoded) };
  } finally {
    clearTimeout(timer);
  }
}

function splitCallbackCode(value) {
  const raw = clean(value);
  const [code, state] = raw.split('#', 2);
  if (!code) throw oauthError(400, 'Claude OAuth code is required');
  return { code, state: clean(state) };
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function providerError(status, body, message, headers = null) {
  const error = new Error(message);
  error.statusCode = status;
  error.providerBody = body;
  const retryAfter = headers?.get?.('retry-after');
  if (typeof retryAfter === 'string' && retryAfter.trim()) error.retryAfter = retryAfter.trim();
  return error;
}

function oauthError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isAdvisoryLookupError(error) {
  return Number.isInteger(error?.statusCode) || error?.name === 'AbortError' || error instanceof TypeError;
}
