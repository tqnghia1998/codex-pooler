import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_ANTHROPIC_VERSION } from './protocol-compat.js';
import { CLAUDE_BIP39_WORDS } from './claude-bip39.js';
import { fetchProfile } from './claude-oauth.js';
import { HttpError } from './http-ingress.js';
import { claudeMetadataModelConfigs, claudeMetadataModelPrefix, isClaudeOAuthUpstream } from './domain.js';
import { applyClaudePayloadConfig } from './claude-payload.js';
import { cacheClaudeThinkingReplay, clearClaudeThinkingReplay, getClaudeThinkingReplay, restoreClaudeThinkingReplay } from './claude-thinking-replay.js';

const CLAUDE_CODE_BETA = 'claude-code-20250219';
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
const CLAUDE_EXTENDED_CACHE_BETA = 'extended-cache-ttl-2025-04-11';
const CLAUDE_TOOL_BETA = 'advanced-tool-use-2025-11-20';
const CLAUDE_TOKEN_COUNTING_BETA = 'token-counting-2024-11-01';
const CLAUDE_FAST_MODE_BETA = 'fast-mode-2026-02-01';
const CLAUDE_CONTEXT_1M_BETA = 'context-1m-2025-08-07';
const CLAUDE_MID_SYSTEM_BETA = 'mid-conversation-system-2026-04-07';
const CLAUDE_ADVISOR_TOOL_BETA = 'advisor-tool-2026-03-01';
const CLAUDE_SERVER_FALLBACK_BETA = 'server-side-fallback-2026-06-01';
const CLAUDE_STRUCTURED_OUTPUTS_BETA = 'structured-outputs-2025-12-15';
const CLAUDE_CACHE_DIAGNOSIS_BETA = 'cache-diagnosis-2026-04-07';
const CLAUDE_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const CLAUDE_REDACT_THINKING_BETA = 'redact-thinking-2026-02-12';
const CLAUDE_THINKING_TOKEN_COUNT_BETA = 'thinking-token-count-2026-05-13';
const CLAUDE_CONTEXT_BETA = 'context-management-2025-06-27';
const CLAUDE_CACHE_SCOPE_BETA = 'prompt-caching-scope-2026-01-05';
const CLAUDE_EFFORT_BETA = 'effort-2025-11-24';
const CLAUDE_FALLBACK_CREDIT_BETA = 'fallback-credit-2026-06-01';
const BETA_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_HEADERS = [
  'session-id', 'session_id', 'x-codex-window-id', 'x-codex-session-id', 'x-session-id',
  'x-http-session-id', 'x-session-affinity', 'x-slot-session-id', 'x-conversation-id',
  'x-thread-id', 'thread-id', 'x-client-request-id'
];

const DEVICE_ID_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SESSION_ID_LENGTH = 200;
export const CLAUDE_TOOL_ALIASES = Symbol('claudeToolAliases');
export const CLAUDE_MODEL_ALIAS = Symbol('claudeModelAlias');
export const CLAUDE_DIAGNOSTICS_STATE = Symbol('claudeDiagnosticsState');
export const CLAUDE_HELPER_PROFILE = Symbol('claudeHelperProfile');
export const CLAUDE_NATIVE_REQUEST = Symbol('claudeNativeRequest');
const claudeIdentityPrepares = new Map();
const claudeDiagnostics = new Map();
const claudeCloakUserIds = new Map();
const claudeCloakSessions = new Map();
const claudeDeviceProfiles = new Map();
const CLAUDE_CLOAK_USER_ID_TTL_MS = 60 * 60_000;
const CLAUDE_CLOAK_USER_ID_LIMIT = 512;
const CLAUDE_DIAGNOSTICS_LIMIT = 10_240;
const CLAUDE_DIAGNOSTICS_PRUNE_INTERVAL_MS = 60_000;
let lastClaudeDiagnosticsPruneAt = 0;

// CPA preserves signed thinking for compatible Claude API-key models so a
// provider-side model variant switch does not invalidate a subsequent tool
// turn. This is deliberately limited to authenticated callers and explicit
// is-compat model configuration; ordinary OAuth and native Claude Code traffic
// must never share hidden reasoning through this cache.
export function prepareClaudeThinkingReplayRequest({ req, body, credentials, upstream, sessionId, claudeConfig = null } = {}) {
  const scope = claudeThinkingReplayScope({ req, body, credentials, upstream, sessionId, claudeConfig });
  if (!scope) return { body, scope: null };
  const cached = getClaudeThinkingReplay(scope);
  if (!cached.length) return { body, scope };
  const restored = restoreClaudeThinkingReplay(body, cached);
  return {
    body: restored.body,
    scope: restored.restored ? { ...scope, replayApplied: true } : scope
  };
}

export function recordClaudeThinkingReplay(scope, content) {
  return cacheClaudeThinkingReplay(scope, content);
}

export function forgetClaudeThinkingReplay(scope) {
  clearClaudeThinkingReplay(scope);
}

// Claude Code OAuth requests carry a credential identity in metadata.user_id.
// This is not account authentication; it is the stable device/account/session
// envelope that Anthropic expects from the Claude Code entrypoint.
export function prepareClaudeRequestBody({ req, body, credentials, upstream, countTokens = false, sessionId = claudeSessionIdForRequest(req, body, countTokens), claudeConfig = null, requestPath = '' }) {
  const oauth = isClaudeOAuthCredential(credentials, upstream);
  const originalBody = plainObject(body) || Array.isArray(body) ? structuredClone(body) : body;
  const routedModel = stripClaudeModelPrefix(body?.model, upstream);
  const modelAlias = resolveClaudeModelAlias(routedModel, upstream, claudeConfig);
  const cliProfile = isClaudeCliProfileCredential(credentials, upstream);
  const directAnthropic = isAnthropicClaudeBaseUrl(upstream?.baseUrl);
  const cloakSettings = claudeCloakSettings(upstream, claudeConfig);
  const explicitCloak = cloakSettings.mode !== 'never' && (
    ['always', 'auto'].includes(cloakSettings.mode) || cloakSettings.strictMode ||
    cloakSettings.sensitiveWords.length > 0 || cloakSettings.rebuildMidSystemMessage || cloakSettings.cacheUserId || cloakSettings.configured
  );
  const identitySeed = String(upstream?.id || upstream?.accountId || upstream?.email || credentials?.accessToken || 'claude-oauth');
  const accountUuid = validUuid(upstream?.accountId)
    ? upstream.accountId
    : stableUuid(`account|${identitySeed}`);
  const deviceId = validDeviceId(upstream?.metadata?.claude_device_ids?.[0])
    ? upstream.metadata.claude_device_ids[0]
    : stableHex(`device|${identitySeed}`);
  const existingMetadata = plainObject(body?.metadata) ? body.metadata : {};
  const applyPayloadConfig = (value) => applyClaudePayloadConfig(value, {
    config: claudeConfig,
    original: originalBody,
    model: routedModel,
    requestedModel: body?.model,
    protocol: 'claude',
    fromProtocol: 'claude',
    headers: req?.headers,
    requestPath
  });
  const existingUserId = parseUserId(existingMetadata.user_id);
  const userId = {
    device_id: deviceId,
    account_uuid: accountUuid,
    session_id: sessionId,
    ...Object.fromEntries(Object.entries(existingUserId).filter(([key]) => !['device_id', 'account_uuid', 'session_id'].includes(key)))
  };
  let prepared = cliProfile
    ? {
      ...body,
      metadata: {
        ...existingMetadata,
        user_id: JSON.stringify(userId)
      }
    }
    : { ...body };
  if (modelAlias) prepared.model = modelAlias.upstreamModel;
  else if (routedModel !== body?.model) prepared.model = routedModel;
  const modelSuffix = parseClaudeModelSuffix(prepared.model);
  const hadExplicitMaxTokens = Object.hasOwn(prepared, 'max_tokens');
  if (modelSuffix.hasSuffix) prepared.model = modelSuffix.base;
  delete prepared.betas;
  const confirmedNative = isNativeClaudeCodeRequest(req, body, countTokens);
  const helperProfile = isMeasuredClaudeHelper(req, body, countTokens);
  const nativeClient = confirmedNative || Boolean(helperProfile);
  prepared = normalizeClaudeBody(prepared, {
    nativeClient,
    injectContextManagement: cloakSettings.mode !== 'never' && !nativeClient && directAnthropic && (cliProfile || explicitCloak)
  });
  if (modelSuffix.hasSuffix) applyClaudeModelSuffix(prepared, modelSuffix.rawSuffix, { hadExplicitMaxTokens });
  if (helperProfile) Object.defineProperty(prepared, CLAUDE_HELPER_PROFILE, { value: helperProfile, enumerable: false });
  if (nativeClient) Object.defineProperty(prepared, CLAUDE_NATIVE_REQUEST, { value: true, enumerable: false });
  if (countTokens && directAnthropic) {
    delete prepared.metadata;
    delete prepared.context_management;
    delete prepared.diagnostics;
    delete prepared.thinking;
    delete prepared.output_config;
    delete prepared.max_tokens;
  }
  if (cloakSettings.rebuildMidSystemMessage) rebuildClaudeMidSystemMessages(prepared);
  const cloakEnabled = cloakSettings.mode !== 'never';
  const shouldTransform = cliProfile || explicitCloak;
  if (directAnthropic && !nativeClient && (!shouldTransform || !cloakEnabled) && usesLegacySystemReminder(prepared) && hasClaudeMidSystemMessage(prepared)) {
    throw new HttpError(400, 'invalid_request_error', `role 'system' is not supported on this model. Model ${JSON.stringify(prepared.model || 'unknown')} predates mid-conversation system turns, so system instructions must stay in the top-level system field for it.`);
  }
  if (cloakEnabled && shouldTransform && !nativeClient) {
    const systemError = validateClaudeSystemPrompt(prepared.system);
    if (systemError) throw new HttpError(400, 'invalid_request_error', systemError);
  }
  const aliases = nativeClient || !cloakEnabled || !cliProfile ? new Map() : aliasClaudeOAuthTools(prepared, safeHeader(req, 'authorization') || 'codex-pooler');
  if (!countTokens && !nativeClient && !shouldTransform && countClaudeCacheControls(prepared) === 0) {
    ensureClaudeCacheControls(prepared);
  }
  if (!shouldTransform) {
    prepared = applyPayloadConfig(prepared);
    return attachClaudeModelAlias(attachClaudeRequestProfile(prepared, nativeClient, helperProfile), modelAlias);
  }
  if (!cliProfile) {
    const metadata = plainObject(prepared.metadata) ? prepared.metadata : {};
    const existing = parseUserId(metadata.user_id);
    const existingUserId = validClaudeUserId(existing) ? metadata.user_id : createClaudeCloakUserId({
      key: credentials?.projectKey || credentials?.accessToken || upstream?.id || identitySeed,
      cached: cloakSettings.cacheUserId
    });
    prepared.metadata = {
      ...metadata,
      user_id: existingUserId
    };
  }
  if (countTokens) {
    const originalSystem = prepared.system;
    delete prepared.metadata;
    if (cloakEnabled && shouldTransform) delete prepared.system;
    delete prepared.context_management;
    delete prepared.diagnostics;
    delete prepared.thinking;
    delete prepared.output_config;
    delete prepared.max_tokens;
    if (!nativeClient && cloakEnabled && shouldTransform) relocateClaudeSystemPrompt(prepared, originalSystem);
    if (!nativeClient && cloakEnabled && shouldTransform && cloakSettings.sensitiveWords.length) {
      obfuscateClaudeSensitiveWords(prepared, cloakSettings.sensitiveWords);
    }
    prepared = applyPayloadConfig(prepared);
    sanitizeClaudeMessageHistory(prepared, { preserveEmptyThinking: modelAlias?.isCompat === true });
    enforceClaudeCacheControlLimit(prepared, 4);
    Object.defineProperty(prepared, CLAUDE_TOOL_ALIASES, { value: aliases, enumerable: false });
    return attachClaudeModelAlias(attachClaudeRequestProfile(prepared, nativeClient, helperProfile), modelAlias);
  }
  if (nativeClient) {
    prepared = applyPayloadConfig(prepared);
    sanitizeClaudeMessageHistory(prepared, { preserveEmptyThinking: modelAlias?.isCompat === true });
    ensureClaudeNativeBillingHeader(prepared, claudeConfig);
    Object.defineProperty(prepared, CLAUDE_TOOL_ALIASES, { value: aliases, enumerable: false });
    return attachClaudeModelAlias(attachClaudeRequestProfile(signClaudeOAuthBody(prepared), nativeClient, helperProfile), modelAlias);
  }
  if (!cloakEnabled) {
    prepared = applyPayloadConfig(prepared);
    sanitizeClaudeMessageHistory(prepared, { preserveEmptyThinking: modelAlias?.isCompat === true });
    ensureClaudeNativeBillingHeader(prepared, claudeConfig);
    if (!nativeClient && countClaudeCacheControls(prepared) === 0) ensureClaudeCacheControls(prepared, { ttl: oauth ? '1h' : '' });
    Object.defineProperty(prepared, CLAUDE_TOOL_ALIASES, { value: aliases, enumerable: false });
    return attachClaudeModelAlias(attachClaudeRequestProfile(signClaudeOAuthBody(prepared), nativeClient, helperProfile), modelAlias);
  }
  const workload = safeHeader(req, 'x-cpa-claude-workload');
  if (workload) prepared.__claudeWorkload = workload;
  const diagnosticsState = beginClaudeDiagnostics(upstream, credentials, sessionId);
  sanitizeClaudeMessageHistory(prepared, { preserveEmptyThinking: modelAlias?.isCompat === true });
  if (diagnosticsState) prepared.diagnostics = { previous_message_id: diagnosticsState.previousMessageId || null };
  let shaped = shapeClaudeOAuthBody(prepared, upstream, oauth || directAnthropic && cliProfile, claudeConfig, false);
  shaped = applyPayloadConfig(shaped);
  enforceClaudeCacheControlLimit(shaped, 4);
  if (oauth || directAnthropic && cliProfile) signClaudeOAuthBody(shaped);
  Object.defineProperty(shaped, CLAUDE_TOOL_ALIASES, { value: aliases, enumerable: false });
  attachClaudeModelAlias(shaped, modelAlias);
  if (diagnosticsState) {
    Object.defineProperty(shaped, CLAUDE_DIAGNOSTICS_STATE, { value: diagnosticsState, enumerable: false });
  }
  return attachClaudeRequestProfile(shaped, nativeClient, helperProfile);
}

// CPA's custom-origin count_tokens fallback is deliberately a local estimator.
// It runs the translated caller body through the same request-history cleanup,
// but does not apply OAuth cloaking, CLI billing text, metadata identity,
// cache-control markers, or generation-only defaults. Keeping this separate
// prevents an estimator from counting proxy-added protocol text.
export function prepareClaudeLocalCountTokensBody({ body, upstream = null, claudeConfig = null } = {}) {
  const prepared = plainObject(body) ? structuredClone(body) : body;
  if (!plainObject(prepared)) return prepared;
  const modelAlias = resolveClaudeModelAlias(prepared.model, upstream, claudeConfig);
  if (claudeCloakSettings(upstream, claudeConfig).rebuildMidSystemMessage) rebuildClaudeMidSystemMessages(prepared);
  sanitizeClaudeWebSearchTools(prepared);
  sanitizeClaudeMessageHistory(prepared, { preserveEmptyThinking: modelAlias?.isCompat === true });
  return prepared;
}

// CPA prepares one stable device/account identity before the first OAuth call.
// Keep the same behavior in Node: profile lookup is single-flight, and callers
// may explicitly refresh it for management/API lifecycle operations.
export async function ensureClaudeCredentialIdentity({ upstream, credentials, store = null, fetchImpl = globalThis.fetch, refreshProfile = false } = {}) {
  if (upstream?.type !== 'claude' || !isClaudeOAuthToken(credentials?.accessToken)) return upstream;
  const key = upstream.id || credentials.accessToken;
  let pending = claudeIdentityPrepares.get(key);
  if (!pending) {
    pending = prepareClaudeCredentialIdentity({ upstream, credentials, store, fetchImpl, refreshProfile });
    claudeIdentityPrepares.set(key, pending);
    void pending.finally(() => {
      if (claudeIdentityPrepares.get(key) === pending) claudeIdentityPrepares.delete(key);
    }).catch(() => {});
  }
  return pending;
}

async function prepareClaudeCredentialIdentity({ upstream, credentials, store, fetchImpl, refreshProfile = false }) {
  const expectedEpoch = Number(credentials?.credentialEpoch) || 0;
  const expectedAccessToken = String(credentials?.accessToken || '');
  const metadata = plainObject(upstream.metadata) ? upstream.metadata : {};
  const existingDeviceId = Array.isArray(metadata.claude_device_ids)
    ? metadata.claude_device_ids.find((value) => validDeviceId(value))
    : '';
  const deviceId = existingDeviceId || randomBytes(32).toString('hex');
  // A supplied account identity is authoritative even when it is an opaque
  // enterprise/setup identifier rather than a UUID. The wire metadata helper
  // still uses a canonical UUID-shaped value when Anthropic requires one.
  let accountId = String(upstream.accountId || '').trim();
  let email = upstream.email || '';
  let organizationId = credentials.organizationId || '';
  let organizationName = credentials.organizationName || '';
  if ((refreshProfile || !accountId) && !isClaudeSetupToken({ upstream, credentials })) {
    try {
      const profile = await fetchProfile(credentials.accessToken, fetchImpl, { proxyUrl: claudeProxyUrl(upstream) });
      const profileAccountId = String(profile?.account?.uuid || '').trim();
      if (profileAccountId) accountId = profileAccountId;
      email ||= String(profile?.account?.email || profile?.account?.email_address || '').trim();
      organizationId ||= String(profile?.organization?.uuid || '').trim();
      organizationName ||= String(profile?.organization?.name || '').trim();
    } catch (error) {
      if (Number(error?.statusCode) !== 403) throw error;
    }
  }
  if (!accountId) accountId = stableUuid(`claude-oauth-fallback|${credentials.accessToken}`);
  if (store?.persistClaudeIdentity) {
    const updated = store.persistClaudeIdentity(upstream.id, { accountId, email, organizationId, organizationName, deviceId }, { expectedEpoch, expectedAccessToken });
    if (updated === false) return upstream;
    // persistClaudeIdentity reloads the record from storage, so copy the
    // request-relevant identity back onto the object already held by the
    // dispatcher. Otherwise the first inference call after profile lookup
    // still emits the pre-profile fallback account UUID/device pool.
    if (updated && updated !== upstream) {
      upstream.accountId = updated.accountId || accountId;
      upstream.email = updated.email || email;
      upstream.metadata = plainObject(updated.metadata)
        ? { ...updated.metadata }
        : { ...metadata, claude_device_ids: [deviceId] };
    } else {
      Object.assign(upstream, { accountId, email, metadata: { ...metadata, claude_device_ids: [deviceId] } });
    }
    return upstream;
  }
  return Object.assign(upstream, { accountId, email, metadata: { ...metadata, claude_device_ids: [deviceId] } });
}

function isClaudeSetupToken({ upstream, credentials }) {
  const metadata = plainObject(upstream?.metadata) ? upstream.metadata : {};
  if (metadata.skip_account_profile === true || metadata.is_setup_token === true || metadata.setup_token === true) return true;
  const kind = String(metadata.auth_kind || '').toLowerCase();
  if (kind === 'setup_token' || kind === 'setup-token') return true;
  const scopes = String(metadata.scopes || metadata.scope || '').toLowerCase();
  return Boolean(scopes && !scopes.includes('user:profile') && !scopes.includes('user:office'));
}

function claudeProxyUrl(upstream) {
  const metadata = plainObject(upstream?.metadata) ? upstream.metadata : {};
  const value = metadata.proxy_url ?? metadata['proxy-url'];
  return typeof value === 'string' ? value : '';
}

function beginClaudeDiagnostics(upstream, credentials, sessionId) {
  const identity = String(upstream?.id || credentials?.accessToken || '').trim();
  const conversation = String(sessionId || '').trim();
  if (!identity || !conversation) return null;
  const key = createHash('sha256').update(`${identity}\0${conversation}`).digest('hex');
  const now = Date.now();
  pruneClaudeDiagnostics(now);
  let entry = claudeDiagnostics.get(key);
  if (!entry || entry.expiresAt <= now) {
    entry = { previousMessageId: '', minimumSequence: 0, committedSequence: 0, sequence: 0, expiresAt: now + 60 * 60_000 };
    claudeDiagnostics.set(key, entry);
  }
  entry.sequence += 1;
  return { key, sequence: entry.sequence, previousMessageId: entry.previousMessageId };
}

function pruneClaudeDiagnostics(now) {
  if (now - lastClaudeDiagnosticsPruneAt < CLAUDE_DIAGNOSTICS_PRUNE_INTERVAL_MS
    && claudeDiagnostics.size <= CLAUDE_DIAGNOSTICS_LIMIT) return;
  for (const [key, entry] of claudeDiagnostics) {
    if (entry.expiresAt <= now) claudeDiagnostics.delete(key);
  }
  while (claudeDiagnostics.size > CLAUDE_DIAGNOSTICS_LIMIT) {
    claudeDiagnostics.delete(claudeDiagnostics.keys().next().value);
  }
  lastClaudeDiagnosticsPruneAt = now;
}

export function claudeToolAliases(body) {
  return body?.[CLAUDE_TOOL_ALIASES] instanceof Map ? body[CLAUDE_TOOL_ALIASES] : new Map();
}

export function claudeModelAlias(body) {
  return body?.[CLAUDE_MODEL_ALIAS] || null;
}

export function claudeDiagnosticsState(body) {
  return body?.[CLAUDE_DIAGNOSTICS_STATE] || null;
}

export function claudeHelperProfile(body) {
  return body?.[CLAUDE_HELPER_PROFILE] || null;
}

export function commitClaudeDiagnostics(state, messageId) {
  const id = typeof messageId === 'string' ? messageId.trim() : '';
  if (!state?.key || !Number.isSafeInteger(state.sequence) || !id) return;
  const entry = claudeDiagnostics.get(state.key);
  if (!entry || state.sequence < entry.minimumSequence || state.sequence < entry.committedSequence) return;
  entry.previousMessageId = id;
  entry.committedSequence = state.sequence;
  entry.expiresAt = Date.now() + 60 * 60_000;
}

export function restoreClaudeToolAliases(value, aliases) {
  if (!(aliases instanceof Map) || !aliases.size) return value;
  if (Array.isArray(value)) return value.map((item) => restoreClaudeToolAliases(item, aliases));
  if (!plainObject(value)) return value;
  const restored = {};
  for (const [key, child] of Object.entries(value)) {
    restored[key] = ['name', 'tool_name'].includes(key) && typeof child === 'string' && aliases.has(child)
      ? aliases.get(child)
      : restoreClaudeToolAliases(child, aliases);
  }
  return restored;
}

export function restoreClaudeModelAlias(value, mapping) {
  if (!mapping?.forceMapping || typeof mapping.responseModel !== 'string' || !mapping.responseModel) return value;
  if (Array.isArray(value)) return value.map((item) => restoreClaudeModelAlias(item, mapping));
  if (!plainObject(value)) return value;
  const restored = {};
  for (const [key, child] of Object.entries(value)) {
    restored[key] = key === 'model' && typeof child === 'string'
      ? mapping.responseModel
      : restoreClaudeModelAlias(child, mapping);
  }
  return restored;
}

export function claudeRequestHeaders({ req, body, credentials, upstream = null, countTokens = false, sessionId = claudeSessionIdForRequest(req, body, countTokens), requestedBetas = [], claudeConfig = null }) {
  const incomingBetas = safeHeader(req, 'anthropic-beta');
  const requested = new Set([
    ...splitBetas(incomingBetas),
    ...splitBetas(body?.betas),
    ...requestedBetas.flatMap(splitBetas)
  ]);
  const oauth = isClaudeOAuthCredential(credentials, upstream);
  const cliProfile = isClaudeCliProfileCredential(credentials, upstream);
  const cloakSettings = claudeCloakSettings(upstream, claudeConfig);
  const headerDefaults = claudeHeaderDefaults(claudeConfig);
  const explicitCloak = cloakSettings.mode !== 'never' && (
    ['always', 'auto'].includes(cloakSettings.mode) || cloakSettings.strictMode ||
    cloakSettings.sensitiveWords.length > 0 || cloakSettings.rebuildMidSystemMessage || cloakSettings.cacheUserId || cloakSettings.configured
  );
  const cliWire = cliProfile || explicitCloak;
  const helperProfile = claudeHelperProfile(body);
  const callerOwnedBetas = uniqueBetas([
    ...splitBetas(incomingBetas),
    ...requestedBetas.flatMap(splitBetas)
  ]);
  const confirmedNative = body?.[CLAUDE_NATIVE_REQUEST] === true || isNativeClaudeCodeRequest(req, body, countTokens);
  let betas = !cliWire ? callerOwnedBetas : uniqueBetas(countTokens ? [
    CLAUDE_CODE_BETA,
    ...(cliProfile ? [CLAUDE_OAUTH_BETA] : []),
    CLAUDE_THINKING_BETA,
    CLAUDE_CONTEXT_BETA,
    CLAUDE_TOKEN_COUNTING_BETA,
    ...(requested.has(CLAUDE_ADVISOR_TOOL_BETA) || hasAdvisorTool(body) ? [CLAUDE_ADVISOR_TOOL_BETA] : [])
  ] : [
    CLAUDE_CODE_BETA,
    ...(cliProfile ? [CLAUDE_OAUTH_BETA] : []),
    ...(requested.has(CLAUDE_CONTEXT_1M_BETA) ? [CLAUDE_CONTEXT_1M_BETA] : []),
    CLAUDE_THINKING_BETA,
    ...(typeof body?.thinking?.display === 'string' && body.thinking.display.trim() ? [] : [CLAUDE_REDACT_THINKING_BETA]),
    CLAUDE_THINKING_TOKEN_COUNT_BETA,
    CLAUDE_CONTEXT_BETA,
    CLAUDE_CACHE_SCOPE_BETA,
    ...(usesLegacySystemReminder(body) ? [] : [CLAUDE_MID_SYSTEM_BETA]),
    ...(requested.has(CLAUDE_ADVISOR_TOOL_BETA) || hasAdvisorTool(body) ? [CLAUDE_ADVISOR_TOOL_BETA] : []),
    ...(Array.isArray(body?.tools) && body.tools.length ? [CLAUDE_TOOL_BETA] : []),
    CLAUDE_EFFORT_BETA,
    ...(cliProfile && !requested.has(CLAUDE_FALLBACK_CREDIT_BETA) ? [CLAUDE_FALLBACK_CREDIT_BETA] : []),
    ...[CLAUDE_SERVER_FALLBACK_BETA, CLAUDE_FALLBACK_CREDIT_BETA, CLAUDE_STRUCTURED_OUTPUTS_BETA].filter((beta) => requested.has(beta)),
    ...(requested.has(CLAUDE_FAST_MODE_BETA) || String(body?.speed || '').toLowerCase() === 'fast' ? [CLAUDE_FAST_MODE_BETA] : []),
    ...(oauth || cliProfile ? [CLAUDE_EXTENDED_CACHE_BETA] : []),
    ...(plainObject(body?.diagnostics) ? [CLAUDE_CACHE_DIAGNOSIS_BETA] : []),
    ...(countTokens ? [CLAUDE_TOKEN_COUNTING_BETA] : [])
  ]);
  if (confirmedNative && incomingBetas) {
    betas = uniqueBetas(splitBetas(incomingBetas));
    if (hasAdvisorTool(body) || requested.has(CLAUDE_ADVISOR_TOOL_BETA)) {
      betas = insertClaudeBetaBefore(betas, CLAUDE_ADVISOR_TOOL_BETA, CLAUDE_TOOL_BETA, CLAUDE_EFFORT_BETA);
    }
    if (oauth) {
      betas = insertClaudeBetaAfter(betas, CLAUDE_OAUTH_BETA, CLAUDE_CODE_BETA);
      if (!countTokens) betas = insertClaudeBetaAfter(betas, CLAUDE_EXTENDED_CACHE_BETA, betas.at(-1));
    }
  }
  const credential = credentials?.projectKey || credentials?.accessToken || '';
  const firstParty = isAnthropicClaudeBaseUrl(upstream?.baseUrl);
  const apiKeyCredential = isClaudeApiKeyCredential(credentials, upstream);
  const callerStream = body?.stream === true;
  const defaultAccept = callerStream && !firstParty ? 'text/event-stream' : 'application/json';
  const defaultAcceptEncoding = callerStream && !firstParty ? 'identity' : 'gzip, deflate, br, zstd';
  const headers = {
    ...(credential
      ? apiKeyCredential && firstParty
        ? { 'x-api-key': credential }
        : { authorization: `Bearer ${credential}` }
      : {}),
    'anthropic-version': safeHeader(req, 'anthropic-version') || DEFAULT_ANTHROPIC_VERSION,
    'anthropic-beta': betas.join(','),
    accept: safeHeader(req, 'accept') || defaultAccept,
    'accept-encoding': safeHeader(req, 'accept-encoding') || defaultAcceptEncoding
  };
  if (helperProfile) {
    for (const name of [
      'accept', 'accept-encoding', 'anthropic-version', 'anthropic-beta',
      'anthropic-dangerous-direct-browser-access', 'x-app', 'x-claude-code-session-id',
      'x-client-request-id', 'x-stainless-async', 'x-stainless-lang',
      'x-stainless-runtime', 'x-stainless-package-version', 'x-stainless-runtime-version',
      'x-stainless-os', 'x-stainless-arch', 'x-stainless-retry-count', 'x-stainless-timeout',
      'user-agent'
    ]) {
      const value = safeHeader(req, name);
      if (value) headers[name] = value;
    }
    applyClaudeConfiguredHeaders(headers, upstream, req);
    headers['anthropic-beta'] = safeHeader(req, 'anthropic-beta') || '';
    headers.accept = safeHeader(req, 'accept') || 'application/json';
    headers['accept-encoding'] = safeHeader(req, 'accept-encoding') || 'gzip';
    return headers;
  }
  if (cliWire) Object.assign(headers, {
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
    'x-client-request-id': randomUUID(),
    'x-claude-code-session-id': sessionId,
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-lang': 'js',
    ...(!countTokens || isNativeClaudeCodeRequest(req, body, countTokens) && safeHeader(req, 'x-stainless-timeout')
      ? { 'x-stainless-timeout': safeHeader(req, 'x-stainless-timeout') || headerDefaults.timeout }
      : {}),
    'x-stainless-package-version': headerDefaults.packageVersion,
    'x-stainless-runtime-version': headerDefaults.runtimeVersion,
    'x-stainless-os': headerDefaults.os,
    'x-stainless-arch': headerDefaults.arch,
    'user-agent': headerDefaults.userAgent,
    connection: 'keep-alive'
  });
  if (confirmedNative && cliWire) {
    for (const name of [
      'user-agent',
      'x-stainless-retry-count',
      'x-stainless-runtime',
      'x-stainless-lang',
      'x-stainless-package-version',
      'x-stainless-runtime-version',
      'x-stainless-os',
      'x-stainless-arch',
      'x-client-request-id'
    ]) {
      const value = safeHeader(req, name);
      if (!value) continue;
      if ((name === 'x-stainless-package-version' || name === 'x-stainless-runtime-version')
        && value !== (name === 'x-stainless-package-version' ? headerDefaults.packageVersion : headerDefaults.runtimeVersion)) {
        continue;
      }
      headers[name] = value;
    }
    applyConfirmedClaudeDeviceProfile(headers, req, upstream, headerDefaults);
  }
  for (const name of [
    'x-claude-code-agent-id',
    'x-claude-code-parent-agent-id',
    'x-claude-remote-container-id',
    'x-claude-remote-session-id',
    'x-client-app',
    'x-anthropic-additional-protection'
  ]) {
    const value = safeHeader(req, name);
    if (value) headers[name] = value;
  }
  // CPA only preserves this transport marker for a confirmed native client.
  // An OAuth credential alone must not let an arbitrary caller manufacture the
  // async SDK fingerprint; caller-owned mode already copied its headers above.
  if (confirmedNative && safeHeader(req, 'x-stainless-async') === 'async') headers['x-stainless-async'] = 'async';
  if (!cliWire) {
    for (const [name, value] of Object.entries(req?.headers || {})) {
      const lower = name.toLowerCase();
      if (!(
        lower === 'accept' || lower === 'accept-encoding' || lower === 'user-agent' ||
        lower === 'x-app' || lower === 'x-client-request-id' ||
        lower.startsWith('anthropic-') || lower.startsWith('x-stainless-') ||
        lower.startsWith('x-claude-code-') || lower.startsWith('x-claude-remote-') ||
        lower === 'x-client-app' || lower === 'x-anthropic-additional-protection'
      )) continue;
      if (typeof value === 'string' && Buffer.byteLength(value) <= 1_024) headers[lower] = value;
    }
    headers['anthropic-version'] = safeHeader(req, 'anthropic-version') || DEFAULT_ANTHROPIC_VERSION;
    if (betas.length) headers['anthropic-beta'] = betas.join(',');
    else delete headers['anthropic-beta'];
    headers['user-agent'] = safeHeader(req, 'user-agent') || 'codex-pooler-node/0.1.0';
  }
  applyClaudeConfiguredHeaders(headers, upstream, req);
  if (isAnthropicClaudeBaseUrl(upstream?.baseUrl)) {
    headers['anthropic-beta'] = betas.join(',');
    if (!cliWire) {
      headers['anthropic-version'] = safeHeader(req, 'anthropic-version') || DEFAULT_ANTHROPIC_VERSION;
      headers.accept = safeHeader(req, 'accept') || 'application/json';
      headers['accept-encoding'] = safeHeader(req, 'accept-encoding') || 'gzip, deflate, br, zstd';
    } else {
      headers.accept = 'application/json';
      headers['accept-encoding'] = 'gzip, deflate, br, zstd';
    }
  } else if (callerStream) {
    // CLIProxyAPI applies custom headers before restoring the transport
    // negotiation fields for every streaming Claude request. This prevents a
    // per-auth header rule from turning an SSE request into a JSON request or
    // enabling compressed streaming that the parser is not expecting.
    headers.accept = 'text/event-stream';
    headers['accept-encoding'] = 'identity';
  }
  return headers;
}

export function claudeRequestedBetas({ req, body }) {
  return [...new Set([
    ...splitBetas(safeHeader(req, 'anthropic-beta')),
    ...splitBetas(body?.betas)
  ])];
}

// CPA maps the downstream conversation identity to the UUID Claude expects in
// metadata.user_id and x-claude-code-session-id. Native Claude Code's UUID is
// preserved; generic stable IDs are deterministically canonicalized so they
// survive retries, credential rotation, and process-local request shaping.
export function claudeSessionIdForRequest(req, body, countTokens = false) {
  const native = isNativeClaudeCodeRequest(req, body, countTokens)
    || Boolean(isMeasuredClaudeHelper(req, body, countTokens));
  const claudeSignal = safeHeader(req, 'x-claude-code-session-id');
  const candidates = [];
  if (native) {
    candidates.push(claudeSignal);
    const userId = parseUserId(body?.metadata?.user_id);
    candidates.push(typeof userId.session_id === 'string' ? userId.session_id.trim() : '');
  }
  candidates.push(...SESSION_HEADERS.map((name) => safeHeader(req, name)));
  candidates.push(...claudeBodySessionCandidates(body));
  // An unconfirmed Claude header is never used as native identity or forwarded
  // as-is, but it remains a useful stable seed when the caller supplied no
  // other conversation signal. This keeps diagnostics/failover continuity
  // without trusting the header's native wire semantics.
  const identity = candidates.find((value) => value && value.length <= MAX_SESSION_ID_LENGTH)
    || (!native && claudeSignal && claudeSignal.length <= MAX_SESSION_ID_LENGTH ? claudeSignal : '');
  if (!identity) return randomUUID();
  const unprefixed = identity.toLowerCase().startsWith('claude:') ? identity.slice(7) : identity;
  return CANONICAL_UUID_SHAPE.test(unprefixed) ? unprefixed : stableUuid(`agent-conversation|${identity}`);
}

function parseUserId(value) {
  if (typeof value !== 'string' || value.length > 4_096) return {};
  try {
    const parsed = JSON.parse(value);
    return plainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function claudeBodySessionCandidates(body) {
  const roots = [body];
  if (plainObject(body?.request) && !Object.hasOwn(body, 'contents')) roots.push(body.request);
  const values = [];
  const add = (prefix, value) => {
    const candidate = safeSessionCandidate(value);
    if (candidate) values.push(`${prefix}:${candidate}`);
  };
  const addAcrossRoots = (prefix, paths) => {
    for (const path of paths) {
      for (const root of roots) add(prefix, readClaudePath(root, path));
    }
  };
  addAcrossRoots('geminicache', ['cachedContent', 'cached_content']);
  addAcrossRoots('thread', ['thread_id', 'threadId', 'metadata.thread_id']);
  addAcrossRoots('session', ['session_id', 'sessionId', 'sessionID', 'metadata.session_id', 'extra_body.session_id']);
  for (const root of roots) {
    for (const path of ['prompt_cache_key', 'promptCacheKey']) add('pck', root?.[path]);
    const conversation = root?.conversation;
    if (plainObject(conversation)) add('conv', conversation.id);
    else if (typeof conversation === 'string') add('conv', conversation);
    for (const path of ['conversation_id', 'conversationId', 'chat_id', 'chatId', 'metadata.conversation_id', 'extra_body.conversation_id']) {
      add('conv', readClaudePath(root, path));
    }
    const rawUserId = root?.metadata?.user_id;
    if (typeof rawUserId === 'string' && !rawUserId.trim().startsWith('{')) add('user', rawUserId);
  }
  return values;
}

function readClaudePath(root, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], root);
}

function safeSessionCandidate(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  return candidate && candidate.length <= MAX_SESSION_ID_LENGTH && !/[\x00-\x1f\x7f]/.test(candidate)
    ? candidate
    : '';
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDeviceId(value) {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}

function validUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validClaudeUserId(value) {
  if (!plainObject(value) || !validDeviceId(value.device_id) || !validUuid(value.session_id)) return false;
  return !value.account_uuid || validUuid(value.account_uuid);
}

function stableHex(seed) {
  return createHash('sha256').update(`codex-pooler-claude|${seed}`).digest('hex');
}

function stableUuid(seed) {
  const bytes = createHash('sha1').update(`codex-pooler-claude|${seed}`).digest('hex').slice(0, 32).split('');
  bytes[12] = '5';
  bytes[16] = ['8', '9', 'a', 'b'][parseInt(bytes[16], 16) % 4];
  const hex = bytes.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uniqueBetas(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter((value) => BETA_PATTERN.test(value)))];
}

function insertClaudeBetaAfter(values, beta, anchor) {
  if (values.includes(beta)) return values;
  const result = [...values];
  const index = result.indexOf(anchor);
  result.splice(index >= 0 ? index + 1 : result.length, 0, beta);
  return result;
}

function insertClaudeBetaBefore(values, beta, ...anchors) {
  if (values.includes(beta)) return values;
  const result = [...values];
  const index = anchors.map((anchor) => result.indexOf(anchor)).find((candidate) => candidate >= 0);
  result.splice(index === undefined ? result.length : index, 0, beta);
  return result;
}

function validClaudeAccountUuid(value) {
  return value === '' || validUuid(value);
}

function applyClaudeConfiguredHeaders(headers, upstream, req) {
  const metadata = plainObject(upstream?.metadata) ? upstream.metadata : {};
  const configured = [...Object.entries(metadata)];
  if (plainObject(metadata.headers)) {
    for (const [name, value] of Object.entries(metadata.headers)) configured.push([`header:${name}`, value]);
  }
  for (const [key, rawValue] of configured) {
    if (!key.startsWith('header:')) continue;
    const name = key.slice('header:'.length).trim().toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)) continue;
    let value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!value) continue;
    if (value.startsWith('$')) {
      const source = value.slice(1).trim().toLowerCase();
      if (!source) continue;
      value = incomingClaudeHeader(req, source);
    }
    if (!value || Buffer.byteLength(value) > 1_024 || /[\x00-\x1f\x7f]/.test(value)) continue;
    headers[name] = value;
  }
}

function safeHeader(req, name) {
  const value = incomingClaudeHeader(req, name);
  return value && Buffer.byteLength(value) <= 1_024 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
}

function incomingClaudeHeader(req, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return '';
  const entry = Object.entries(req?.headers || {}).find(([headerName]) => headerName.toLowerCase() === wanted);
  const value = Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1];
  return typeof value === 'string' ? value.trim() : '';
}

function isClaudeOAuthToken(token) {
  return typeof token === 'string' && token.startsWith('sk-ant-oat');
}

function isClaudeOAuthCredential(credentials, upstream = null) {
  if (isClaudeOAuthToken(credentials?.accessToken)) return true;
  if (credentials?.projectKey) return false;
  const metadata = plainObject(upstream?.metadata) ? upstream.metadata : {};
  const kind = String(credentials?.authKind || credentials?.auth_kind || metadata.auth_kind || metadata['auth-kind'] || '').trim().toLowerCase();
  if (['api_key', 'apikey', 'claude_api_key', 'claude-api-key'].includes(kind)) return false;
  return typeof credentials?.accessToken === 'string' && credentials.accessToken.length > 0;
}

function isClaudeApiKeyCredential(credentials, upstream = null) {
  if (credentials?.projectKey) return true;
  if (isClaudeOAuthToken(credentials?.accessToken)) return false;
  const metadata = plainObject(upstream?.metadata) ? upstream.metadata : {};
  const kind = String(credentials?.authKind || credentials?.auth_kind || metadata.auth_kind || metadata['auth-kind'] || '').trim().toLowerCase();
  return ['api_key', 'apikey', 'claude_api_key', 'claude-api-key'].includes(kind);
}

function isClaudeCliProfileCredential(credentials, upstream) {
  if (isClaudeOAuthCredential(credentials, upstream)) return true;
  const metadata = plainObject(upstream?.metadata) ? upstream.metadata : {};
  const raw = credentials?.fingerprintProfile
    || metadata.fingerprint_profile
    || metadata['fingerprint-profile'];
  return ['claude-code-cli', 'oauth-cli'].includes(String(raw || '').trim().toLowerCase());
}

export function isAnthropicClaudeBaseUrl(baseUrl) {
  const value = String(baseUrl || 'https://api.anthropic.com').trim().toLowerCase().replace(/\/+$/, '');
  return value === 'https://api.anthropic.com' || value === 'https://api.anthropic.com:443';
}

function splitBetas(value) {
  if (Array.isArray(value)) return value.flatMap(splitBetas);
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter((item) => BETA_PATTERN.test(item));
}

function hasAdvisorTool(body) {
  return Array.isArray(body?.tools) && body.tools.some((tool) => String(tool?.type || '').toLowerCase().startsWith('advisor_'));
}

function usesLegacySystemReminder(body) {
  const model = String(body?.model || '').toLowerCase().split('/').at(-1);
  return new Set([
    'claude-3-5-haiku-20241022',
    'claude-3-5-haiku-latest',
    'claude-3-7-sonnet-20250219',
    'claude-3-7-sonnet-latest',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4',
    'claude-opus-4-20250514',
    'claude-opus-4-1',
    'claude-opus-4-1-20250805',
    'claude-opus-4-5',
    'claude-opus-4-5-20251101',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-sonnet-4',
    'claude-sonnet-4-20250514',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-6',
  ]).has(model);
}

function hasClaudeMidSystemMessage(body) {
  return Array.isArray(body?.messages) && body.messages.some((message) => plainObject(message)
    && String(message.role || '').trim().toLowerCase() === 'system');
}

function isNativeClaudeCodeRequest(req, body = null, countTokens = false) {
  if (!isNativeClaudeCodeEnvelope(req)) return false;
  const beta = safeHeader(req, 'anthropic-beta').split(',').map((item) => item.trim());
  if (!beta.includes(CLAUDE_CODE_BETA)) return false;
  if (countTokens) return true;
  const userId = parseUserId(body?.metadata?.user_id);
  return validDeviceId(userId.device_id) && validClaudeAccountUuid(userId.account_uuid) && validUuid(userId.session_id)
    && userId.session_id === safeHeader(req, 'x-claude-code-session-id');
}

function isNativeClaudeCodeEnvelope(req) {
  const userAgent = safeHeader(req, 'user-agent');
  return /^claude-cli\/\d+\.\d+\.\d+ \(external, (?:cli|sdk-cli|claude-vscode)(?:, agent-sdk\/\d+\.\d+\.\d+)?\)$/.test(userAgent)
    && safeHeader(req, 'x-app') === 'cli';
}

function isNativeClaudeCliEnvelope(req) {
  return /^claude-cli\/\d+\.\d+\.\d+ \(external, cli(?:, agent-sdk\/\d+\.\d+\.\d+)?\)$/.test(safeHeader(req, 'user-agent'))
    && safeHeader(req, 'x-app') === 'cli';
}

function isMeasuredClaudeHelper(req, body, countTokens) {
  if (countTokens || !isNativeClaudeCliEnvelope(req)) return '';
  if (safeHeader(req, 'anthropic-beta').includes(CLAUDE_CODE_BETA)) return '';
  const beta = safeHeader(req, 'anthropic-beta');
  if (!new Set([
    `${CLAUDE_OAUTH_BETA},${CLAUDE_THINKING_BETA},${CLAUDE_REDACT_THINKING_BETA},${CLAUDE_THINKING_TOKEN_COUNT_BETA},${CLAUDE_CONTEXT_BETA},${CLAUDE_CACHE_SCOPE_BETA}`,
    `${CLAUDE_OAUTH_BETA},${CLAUDE_THINKING_BETA},${CLAUDE_REDACT_THINKING_BETA},${CLAUDE_THINKING_TOKEN_COUNT_BETA},${CLAUDE_CONTEXT_BETA},${CLAUDE_CACHE_SCOPE_BETA},${CLAUDE_ADVISOR_TOOL_BETA},${CLAUDE_STRUCTURED_OUTPUTS_BETA},${CLAUDE_CACHE_DIAGNOSIS_BETA}`,
    `${CLAUDE_OAUTH_BETA},${CLAUDE_THINKING_BETA},${CLAUDE_REDACT_THINKING_BETA},${CLAUDE_THINKING_TOKEN_COUNT_BETA},${CLAUDE_CONTEXT_BETA},${CLAUDE_CACHE_SCOPE_BETA},${CLAUDE_STRUCTURED_OUTPUTS_BETA},${CLAUDE_FALLBACK_CREDIT_BETA}`,
    `${CLAUDE_OAUTH_BETA},${CLAUDE_THINKING_BETA},${CLAUDE_REDACT_THINKING_BETA},${CLAUDE_THINKING_TOKEN_COUNT_BETA},${CLAUDE_CONTEXT_BETA},${CLAUDE_CACHE_SCOPE_BETA},${CLAUDE_STRUCTURED_OUTPUTS_BETA}`,
    `${CLAUDE_OAUTH_BETA},${CLAUDE_THINKING_BETA},${CLAUDE_THINKING_TOKEN_COUNT_BETA},${CLAUDE_CONTEXT_BETA},${CLAUDE_CACHE_SCOPE_BETA},${CLAUDE_STRUCTURED_OUTPUTS_BETA}`,
    `${CLAUDE_OAUTH_BETA},${CLAUDE_THINKING_BETA},${CLAUDE_THINKING_TOKEN_COUNT_BETA},${CLAUDE_CONTEXT_BETA},${CLAUDE_CACHE_SCOPE_BETA}`
  ]).has(beta)) return '';
  if (safeHeader(req, 'anthropic-version') !== DEFAULT_ANTHROPIC_VERSION || safeHeader(req, 'accept') !== 'application/json' || safeHeader(req, 'content-type') !== 'application/json') return '';
  if (safeHeader(req, 'anthropic-dangerous-direct-browser-access') !== 'true') return '';
  if (!/^claude-cli\/2\.1\.220 \(external, cli(?:, agent-sdk\/\d+\.\d+\.\d+)?\)$/.test(safeHeader(req, 'user-agent'))) return '';
  if (safeHeader(req, 'x-stainless-package-version') !== '0.94.0' || safeHeader(req, 'x-stainless-runtime-version') !== 'v26.3.0') return '';
  if (safeHeader(req, 'x-stainless-lang') !== 'js' || safeHeader(req, 'x-stainless-runtime') !== 'node' || safeHeader(req, 'x-stainless-retry-count') !== '0' || safeHeader(req, 'x-stainless-timeout') !== '600') return '';
  if (!safeHeader(req, 'x-stainless-package-version') || !safeHeader(req, 'x-stainless-runtime-version') || !safeHeader(req, 'x-stainless-os') || !safeHeader(req, 'x-stainless-arch') || !UUID_PATTERN.test(safeHeader(req, 'x-client-request-id'))) return '';
  const userId = parseUserId(body?.metadata?.user_id);
  if (!validDeviceId(userId.device_id) || !validClaudeAccountUuid(userId.account_uuid) || !validUuid(userId.session_id) || userId.session_id !== safeHeader(req, 'x-claude-code-session-id')) return '';
  const userIdKeys = Object.keys(userId).join(',');
  if (userIdKeys !== 'device_id,account_uuid,session_id' && userIdKeys !== 'device_id,account_uuid,session_id,parent_session_id') return '';
  if (helperMinimalBody(body)) return 'minimal';
  if (helperStructuredBody(body)) return 'structured';
  return '';
}

function helperMinimalBody(body) {
  return Object.keys(body || {}).join(',') === 'model,max_tokens,messages,metadata'
    && body.model === 'claude-haiku-4-5-20251001'
    && body.max_tokens === 1
    && Array.isArray(body.messages) && body.messages.length === 1
    && body.messages[0]?.role === 'user' && typeof body.messages[0]?.content === 'string';
}

function helperStructuredBody(body) {
  const schema = body?.output_config?.format?.schema;
  return Object.keys(body || {}).join(',') === 'model,messages,system,tools,metadata,max_tokens,thinking,temperature,output_config,stream'
    && body.model === 'claude-haiku-4-5-20251001'
    && Array.isArray(body.messages) && body.messages.length === 1
    && body.messages[0]?.role === 'user' && Array.isArray(body.messages[0]?.content) && body.messages[0].content.length === 1
    && body.messages[0].content[0]?.type === 'text'
    && Array.isArray(body.system) && body.system.length === 3
    && body.system.every((block) => plainObject(block) && Object.keys(block).join(',') === 'type,text' && block.type === 'text')
    && /^(?:x-anthropic-billing-header:).* cch=[0-9a-f]{5};/.test(body.system[0].text)
    && body.system[1]?.text?.startsWith('You are Claude Code')
    && Array.isArray(body.tools) && body.tools.length === 0
    && body.max_tokens === 32000 && body.thinking?.type === 'disabled' && body.temperature === 1 && body.stream === true
    && body.output_config?.format?.type === 'json_schema'
    && schema?.type === 'object' && schema?.properties?.title?.type === 'string'
    && Array.isArray(schema.required) && schema.required.length === 1 && schema.required[0] === 'title'
    && schema.additionalProperties === false;
}

function normalizeClaudeBody(body, { nativeClient = false, injectContextManagement = false } = {}) {
  let normalized = structuredClone(body);
  if (String(normalized.thinking?.type || '').toLowerCase() === 'enabled') {
    normalized.thinking = { ...normalized.thinking, type: 'adaptive' };
    delete normalized.thinking.budget_tokens;
    const outputConfig = plainObject(normalized.output_config) ? { ...normalized.output_config } : {};
    if (!String(outputConfig.effort || '').trim()) outputConfig.effort = String(normalized.thinking.effort || 'medium').trim() || 'medium';
    normalized.output_config = outputConfig;
  }
  const toolChoiceType = String(normalized.tool_choice?.type || '').toLowerCase();
  if (toolChoiceType === 'any' || toolChoiceType === 'tool') {
    delete normalized.thinking;
    if (plainObject(normalized.output_config)) {
      delete normalized.output_config.effort;
      if (!Object.keys(normalized.output_config).length) delete normalized.output_config;
    }
  }
  if (!nativeClient) {
    delete normalized.temperature;
    delete normalized.top_p;
    if (normalized.thinking?.type) delete normalized.top_k;
  } else if (['enabled', 'adaptive', 'auto'].includes(String(normalized.thinking?.type || '').toLowerCase())) {
    if (typeof normalized.temperature === 'number' && normalized.temperature !== 1) delete normalized.temperature;
    if (typeof normalized.top_p === 'number' && normalized.top_p < 0.95) delete normalized.top_p;
    delete normalized.top_k;
  } else if (Object.hasOwn(normalized, 'temperature') && Object.hasOwn(normalized, 'top_p')) {
    delete normalized.top_p;
  }
  const thinkingType = String(normalized.thinking?.type || '').toLowerCase();
  if (injectContextManagement && !normalized.context_management && ['enabled', 'adaptive'].includes(thinkingType)) {
    normalized.context_management = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] };
  }
  sanitizeClaudeWebSearchTools(normalized);
  if (!Object.hasOwn(normalized, 'max_tokens') && String(normalized.model || '').toLowerCase().includes('claude')) normalized.max_tokens = 1024;
  return normalized;
}

// CLIProxyAPI removes the trailing model suffix before dispatch and gives a
// valid suffix precedence over the request body's thinking controls. Keep the
// same native Messages shape here, including the max_tokens > budget_tokens
// constraint for numeric budgets.
function applyClaudeModelSuffix(body, rawSuffix, { hadExplicitMaxTokens = false } = {}) {
  const suffix = String(rawSuffix || '').trim().toLowerCase();
  const requestedDisplay = typeof body.thinking?.display === 'string' && body.thinking.display.trim()
    ? body.thinking.display
    : '';
  if (suffix === 'none' || suffix === '0') {
    body.thinking = { type: 'disabled' };
    if (plainObject(body.output_config)) {
      delete body.output_config.effort;
      if (!Object.keys(body.output_config).length) delete body.output_config;
    }
    return;
  }
  if (suffix === 'auto' || suffix === '-1') {
    body.thinking = { type: 'adaptive' };
    if (requestedDisplay) body.thinking.display = requestedDisplay;
    if (plainObject(body.output_config)) {
      delete body.output_config.effort;
      if (!Object.keys(body.output_config).length) delete body.output_config;
    }
    return;
  }
  if (/^(?:minimal|low|medium|high|xhigh|max)$/.test(suffix)) {
    body.thinking = { type: 'adaptive', ...(requestedDisplay ? { display: requestedDisplay } : {}) };
    body.output_config = plainObject(body.output_config) ? { ...body.output_config, effort: suffix } : { effort: suffix };
    delete body.thinking.budget_tokens;
    return;
  }
  if (!/^\d+$/.test(suffix)) return;
  const budget = Number(suffix);
  if (!Number.isSafeInteger(budget) || budget >= Number.MAX_SAFE_INTEGER - 1) return;
  if (budget === 0) return applyClaudeModelSuffix(body, 'none');
  body.thinking = { type: 'enabled', budget_tokens: budget, ...(requestedDisplay ? { display: requestedDisplay } : {}) };
  if (plainObject(body.output_config)) {
    delete body.output_config.effort;
    if (!Object.keys(body.output_config).length) delete body.output_config;
  }
  const maxTokens = Number(body.max_tokens);
  if (!hadExplicitMaxTokens) {
    body.max_tokens = budget + 1;
  } else if (Number.isSafeInteger(maxTokens) && maxTokens > 1 && budget >= maxTokens && maxTokens - 1 >= 1_024) {
    body.thinking.budget_tokens = maxTokens - 1;
  }
}

function sanitizeClaudeWebSearchTools(body) {
  if (!Array.isArray(body?.tools)) return;
  for (const tool of body.tools) {
    if (!plainObject(tool) || !String(tool.type || '').startsWith('web_search_')) continue;
    for (const field of ['allowed_domains', 'blocked_domains']) {
      if (Array.isArray(tool[field]) && tool[field].length === 0) delete tool[field];
    }
  }
}

function sanitizeClaudeMessageHistory(body, { preserveEmptyThinking = false } = {}) {
  if (!Array.isArray(body.messages)) return;
  for (const message of body.messages) {
    if (!Array.isArray(message?.content)) continue;
    message.content = message.content.filter((block) => {
      if (!plainObject(block)) return true;
      if (block.type === 'tool_use') {
        for (const key of ['signature', 'thoughtSignature', 'thought_signature', 'model']) delete block[key];
        if (plainObject(block.extra_content?.google)) delete block.extra_content.google.thought_signature;
        if (plainObject(block.extra_content?.google) && !Object.keys(block.extra_content.google).length) delete block.extra_content.google;
        if (plainObject(block.extra_content) && !Object.keys(block.extra_content).length) delete block.extra_content;
        return true;
      }
      const thinkingText = plainObject(block.thinking) ? block.thinking.text || block.thinking.thinking : block.thinking;
      if (block.type === 'thinking') {
        const signature = String(block.signature || '').trim();
        if (!signature) return preserveEmptyThinking;
        if (!isClaudeThinkingSignatureCompatible(signature)) return false;
        const normalized = normalizeClaudeThinkingSignature(signature);
        if (normalized) block.signature = normalized;
      }
      return true;
    });
  }
}

function stripClaudeSignaturePrefix(raw) {
  const value = String(raw || '').trim();
  const marker = value.indexOf('#');
  return marker >= 0 ? value.slice(marker + 1).trim() : value;
}

function decodeClaudeBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.toString('base64') === value ? decoded : null;
  } catch {
    return null;
  }
}

function readClaudeVarint(bytes, offset) {
  let value = 0n;
  for (let index = 0; index < 10 && offset + index < bytes.length; index += 1) {
    const byte = bytes[offset + index];
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if (!(byte & 0x80)) return { value, next: offset + index + 1 };
  }
  return null;
}

function walkClaudeProto(bytes, visit) {
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readClaudeVarint(bytes, offset);
    if (!tag || tag.value < 8n) return false;
    offset = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    let raw;
    if (wire === 0) {
      const value = readClaudeVarint(bytes, offset);
      if (!value) return false;
      raw = { type: 'varint', value: value.value, bytes: bytes.subarray(offset, value.next) };
      offset = value.next;
    } else if (wire === 1) {
      if (offset + 8 > bytes.length) return false;
      raw = { type: 'fixed64', bytes: bytes.subarray(offset, offset + 8) };
      offset += 8;
    } else if (wire === 2) {
      const length = readClaudeVarint(bytes, offset);
      if (!length || length.value > BigInt(bytes.length - length.next)) return false;
      const end = length.next + Number(length.value);
      raw = { type: 'bytes', value: bytes.subarray(length.next, end), bytes: bytes.subarray(offset, end) };
      offset = end;
    } else if (wire === 5) {
      if (offset + 4 > bytes.length) return false;
      raw = { type: 'fixed32', bytes: bytes.subarray(offset, offset + 4) };
      offset += 4;
    } else return false;
    if (visit(field, raw) === false) return false;
  }
  return true;
}

function firstClaudeProtoBytesField(bytes, fieldNumber) {
  let found = null;
  if (!walkClaudeProto(bytes, (field, raw) => {
    if (field === fieldNumber && raw.type === 'bytes') found = raw.value;
    return true;
  })) return null;
  return found;
}

function isClassicClaudeSignature(sig) {
  const outer = decodeClaudeBase64(sig);
  if (!outer || outer[0] !== 0x12) return false;
  const container = firstClaudeProtoBytesField(outer, 2);
  const channel = container && firstClaudeProtoBytesField(container, 1);
  if (!channel) return false;
  let channelID = false;
  return walkClaudeProto(channel, (field, raw) => {
    if (field === 1 && raw.type === 'varint') channelID = true;
    return true;
  }) && channelID;
}

function isClaudeCaisSignature(sig) {
  const decoded = decodeClaudeBase64(sig);
  if (!decoded || decoded[0] !== 0x08) return false;
  const container = firstClaudeProtoBytesField(decoded, 2);
  const channel = container && firstClaudeProtoBytesField(container, 1);
  if (!channel) return false;
  let channelID = false;
  let signatureBytes = false;
  let modelText = false;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    if (!walkClaudeProto(channel, (field, raw) => {
      if (field === 1 && raw.type === 'varint') channelID = true;
      if (field === 5 && raw.type === 'bytes' && raw.value.length) signatureBytes = true;
      if (field === 6 && raw.type === 'bytes') modelText = decoder.decode(raw.value).startsWith('claude-');
      if (field === 11 && raw.type === 'bytes' && !CANONICAL_UUID_SHAPE.test(decoder.decode(raw.value))) return false;
      return true;
    })) return false;
  } catch {
    return false;
  }
  return channelID && signatureBytes && modelText;
}

function isClaudeThinkingSignatureCompatible(raw) {
  const sig = stripClaudeSignaturePrefix(raw);
  if (!sig || sig.length > 32 * 1024 * 1024) return false;
  if (sig.startsWith('C')) return isClaudeCaisSignature(sig);
  if (sig.startsWith('E')) return isClassicClaudeSignature(sig);
  if (!sig.startsWith('R')) return false;
  const outer = decodeClaudeBase64(sig);
  return Boolean(outer && outer[0] === 0x45 && isClassicClaudeSignature(outer.toString('ascii')));
}

function normalizeClaudeThinkingSignature(raw) {
  const sig = stripClaudeSignaturePrefix(raw);
  if (sig.startsWith('R')) {
    const decoded = decodeClaudeBase64(sig);
    return decoded ? decoded.toString('ascii') : '';
  }
  return sig.startsWith('E') ? sig : '';
}

function validateClaudeSystemPrompt(system) {
  if (!Array.isArray(system)) return '';
  for (const [index, block] of system.entries()) {
    const type = String(block?.type || '').trim();
    if (type !== 'text') {
      return `invalid_request_error: system.${index}.type: Input should be 'text'. System instructions support text only, but this block has type "${type || 'unknown'}". Move non-text content into a user message.`;
    }
  }
  return '';
}

function forwardedClaudeSystemTexts(system) {
  const blocks = typeof system === 'string'
    ? [{ type: 'text', text: system }]
    : Array.isArray(system) ? system : [];
  return blocks
    .filter((block) => plainObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .filter((text) => text.trim() && !isClaudeAttributionSystemText(text));
}

function isClaudeAttributionSystemText(text) {
  return text.startsWith('x-anthropic-billing-header:')
    || text === 'You are Claude Code, Anthropic\'s official CLI for Claude.';
}

function claudeHeaderDefaults(claudeConfig) {
  const source = plainObject(claudeConfig?.claudeHeaderDefaults)
    ? claudeConfig.claudeHeaderDefaults
    : plainObject(claudeConfig?.['claude-header-defaults'])
      ? claudeConfig['claude-header-defaults']
      : {};
  const read = (camel, dashed, fallback) => {
    const value = source[camel] ?? source[dashed];
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };
  return {
    userAgent: read('userAgent', 'user-agent', 'claude-cli/2.1.220 (external, cli)'),
    packageVersion: read('packageVersion', 'package-version', '0.94.0'),
    runtimeVersion: read('runtimeVersion', 'runtime-version', 'v26.3.0'),
    os: read('os', 'os', 'MacOS'),
    arch: read('arch', 'arch', 'arm64'),
    timeout: read('timeout', 'timeout', '600'),
    timezone: read('timezone', 'timezone', ''),
    stabilizeDeviceProfile: readBoolean(source, 'stabilizeDeviceProfile', 'stabilize-device-profile', false)
  };
}

function readBoolean(source, camel, dashed, fallback) {
  const value = source[camel] ?? source[dashed];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function applyConfirmedClaudeDeviceProfile(headers, req, upstream, defaults) {
  const incoming = {
    userAgent: safeHeader(req, 'user-agent'),
    packageVersion: safeHeader(req, 'x-stainless-package-version'),
    runtimeVersion: safeHeader(req, 'x-stainless-runtime-version'),
    os: safeHeader(req, 'x-stainless-os'),
    arch: safeHeader(req, 'x-stainless-arch')
  };
  const plausibleUserAgent = /^claude-cli\/\d+\.\d+\.\d+ \(external, (?:cli|sdk-cli|claude-vscode)(?:, agent-sdk\/\d+\.\d+\.\d+)?\)$/.test(incoming.userAgent)
    && compareClaudeCliVersions(incoming.userAgent, defaults.userAgent) === 0;
  const baselineCompatible = plausibleUserAgent
    && incoming.packageVersion === defaults.packageVersion
    && incoming.runtimeVersion === defaults.runtimeVersion;
  const key = `${String(upstream?.id || upstream?.accountId || 'claude')}:${incoming.userAgent.includes('claude-vscode') ? 'vscode' : 'cli'}`;
  const persistedProfiles = plainObject(upstream?.claudeDeviceProfiles) ? upstream.claudeDeviceProfiles : {};
  const persisted = plainObject(persistedProfiles[incoming.userAgent.includes('claude-vscode') ? 'vscode' : 'cli'])
    ? persistedProfiles[incoming.userAgent.includes('claude-vscode') ? 'vscode' : 'cli']
    : null;
  if (defaults.stabilizeDeviceProfile && baselineCompatible) {
    const existing = claudeDeviceProfiles.get(key) || persisted;
    if (!existing || compareClaudeCliVersions(incoming.userAgent, existing.userAgent) >= 0) {
      claudeDeviceProfiles.set(key, incoming);
      if (upstream && plainObject(upstream)) {
        upstream.claudeDeviceProfiles = {
          ...persistedProfiles,
          [incoming.userAgent.includes('claude-vscode') ? 'vscode' : 'cli']: { ...incoming }
        };
      }
    }
  }
  const profile = defaults.stabilizeDeviceProfile
    ? claudeDeviceProfiles.get(key) || persisted
    : plausibleUserAgent ? incoming : null;
  if (!profile) return;
  headers['user-agent'] = profile.userAgent;
  headers['x-stainless-package-version'] = defaults.packageVersion;
  headers['x-stainless-runtime-version'] = defaults.runtimeVersion;
  // CPA pins the platform only for stabilized profiles. Legacy confirmed
  // clients retain their own OS/Arch values when they are present.
  headers['x-stainless-os'] = defaults.stabilizeDeviceProfile ? defaults.os : (profile.os || defaults.os);
  headers['x-stainless-arch'] = defaults.stabilizeDeviceProfile ? defaults.arch : (profile.arch || defaults.arch);
}

function compareClaudeCliVersions(left, right) {
  const parse = (value) => {
    const match = /claude-cli\/(\d+)\.(\d+)\.(\d+)/i.exec(value || '');
    return match ? match.slice(1).map(Number) : [0, 0, 0];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function claudeDefaultVersion(claudeConfig) {
  const userAgent = claudeHeaderDefaults(claudeConfig).userAgent;
  const match = /claude-cli\/(\d+\.\d+\.\d+)/i.exec(userAgent);
  return match?.[1] || '2.1.220';
}

function claudeCloakSettings(upstream, claudeConfig = null) {
  const metadata = plainObject(upstream?.metadata) ? upstream.metadata : {};
  const cloak = plainObject(metadata.cloak) ? metadata.cloak : {};
  const defaults = claudeHeaderDefaults(claudeConfig);
  const read = (...names) => {
    for (const name of names) {
      if (Object.hasOwn(metadata, name) && metadata[name] !== undefined && metadata[name] !== null) return metadata[name];
      if (Object.hasOwn(cloak, name) && cloak[name] !== undefined && cloak[name] !== null) return cloak[name];
    }
    return undefined;
  };
  const wordsValue = read('cloak_sensitive_words', 'sensitive_words', 'sensitive-words');
  const sensitiveWords = (Array.isArray(wordsValue) ? wordsValue : String(wordsValue || '').split(','))
    .map((word) => String(word).trim())
    .filter((word) => [...word].length >= 2 && !word.includes('\u200B'));
  const strictValue = read('cloak_strict_mode', 'strict_mode', 'strict-mode');
  const timezone = String(read('timezone', 'claude_timezone', 'claude-timezone') || defaults.timezone || '').trim();
  const rebuildValue = read('rebuild_mid_system_message', 'rebuild-mid-system-message');
  const cacheValue = read('cloak_cache_user_id', 'cache_user_id', 'cache-user-id', 'cloak-cache-user-id');
  const configuredMode = String(read('cloak_mode', 'mode') || '').trim().toLowerCase();
  const globallyDisabled = claudeConfig?.disableClaudeCloakMode === true || claudeConfig?.['disable-claude-cloak-mode'] === true;
  const mode = configuredMode || (globallyDisabled ? 'never' : '');
  return {
    strictMode: strictValue === true || String(strictValue || '').trim().toLowerCase() === 'true',
    sensitiveWords: [...new Set(sensitiveWords)],
    timezone,
    rebuildMidSystemMessage: rebuildValue === true || String(rebuildValue || '').trim().toLowerCase() === 'true',
    cacheUserId: cacheValue === true || String(cacheValue || '').trim().toLowerCase() === 'true',
    configured: Object.hasOwn(metadata, 'cloak') && plainObject(cloak),
    mode
  };
}

function createClaudeCloakUserId({ key, cached }) {
  const cacheKey = String(key || 'claude-cloak');
  const now = Date.now();
  if (cached) {
    const existing = claudeCloakUserIds.get(cacheKey);
    if (existing && existing.expiresAt > now && validClaudeUserId(existing.value)) {
      existing.expiresAt = now + CLAUDE_CLOAK_USER_ID_TTL_MS;
      return existing.serialized;
    }
  }
  const value = {
    device_id: randomBytes(32).toString('hex'),
    account_uuid: '',
    session_id: cachedClaudeCloakSessionId(cacheKey)
  };
  const serialized = JSON.stringify(value);
  if (cached) {
    claudeCloakUserIds.set(cacheKey, { value, serialized, expiresAt: now + CLAUDE_CLOAK_USER_ID_TTL_MS });
    while (claudeCloakUserIds.size > CLAUDE_CLOAK_USER_ID_LIMIT) claudeCloakUserIds.delete(claudeCloakUserIds.keys().next().value);
  }
  return serialized;
}

function cachedClaudeCloakSessionId(cacheKey) {
  const now = Date.now();
  const existing = claudeCloakSessions.get(cacheKey);
  if (existing && existing.expiresAt > now && validUuid(existing.value)) {
    existing.expiresAt = now + CLAUDE_CLOAK_USER_ID_TTL_MS;
    return existing.value;
  }
  const value = randomUUID();
  claudeCloakSessions.set(cacheKey, { value, expiresAt: now + CLAUDE_CLOAK_USER_ID_TTL_MS });
  while (claudeCloakSessions.size > CLAUDE_CLOAK_USER_ID_LIMIT) claudeCloakSessions.delete(claudeCloakSessions.keys().next().value);
  return value;
}

function obfuscateClaudeSensitiveWords(body, words) {
  if (!plainObject(body) || !Array.isArray(words) || !words.length) return body;
  const alternatives = [...new Set(words)]
    .sort((left, right) => Buffer.byteLength(right) - Buffer.byteLength(left))
    .map((word) => escapeRegExp(word));
  if (!alternatives.length) return body;
  const matcher = new RegExp(alternatives.join('|'), 'giu');
  const obfuscate = (value) => String(value).replace(matcher, (word) => {
    if (word.includes('\u200B')) return word;
    const characters = Array.from(word);
    return characters.length < 2 ? word : `${characters[0]}\u200B${characters.slice(1).join('')}`;
  });
  const textBlock = (block) => {
    if (plainObject(block) && block.type === 'text' && typeof block.text === 'string') block.text = obfuscate(block.text);
  };
  if (typeof body.system === 'string') body.system = obfuscate(body.system);
  else if (Array.isArray(body.system)) body.system.forEach(textBlock);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (typeof message?.content === 'string') message.content = obfuscate(message.content);
      else if (Array.isArray(message?.content)) message.content.forEach(textBlock);
    }
  }
  return body;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function claudeSystemReminder(text) {
  return `<system-reminder>\n${text}${text.endsWith('\n') ? '' : '\n'}</system-reminder>`;
}

function relocateClaudeSystemPrompt(body, originalSystem) {
  const texts = forwardedClaudeSystemTexts(originalSystem);
  if (!texts.length || !Array.isArray(body.messages)) return;
  const firstUser = body.messages.findIndex((message) => plainObject(message) && message.role === 'user');
  if (firstUser < 0) return;

  if (usesLegacySystemReminder(body)) {
    const reminders = texts.map(claudeSystemReminder);
    const message = body.messages[firstUser];
    if (typeof message.content === 'string') {
      message.content = [
        ...reminders.map((text) => ({ type: 'text', text })),
        { type: 'text', text: message.content }
      ];
      return;
    }
    if (!Array.isArray(message.content)) return;
    const existing = new Map();
    for (const block of message.content) {
      if (plainObject(block) && block.type === 'text' && typeof block.text === 'string') {
        existing.set(block.text, (existing.get(block.text) || 0) + 1);
      }
    }
    const newReminders = reminders.filter((text) => {
      const count = existing.get(text) || 0;
      if (count > 0) {
        existing.set(text, count - 1);
        return false;
      }
      return true;
    }).map((text) => ({ type: 'text', text }));
    if (!newReminders.length) return;
    let insertAt = 0;
    while (insertAt < message.content.length && message.content[insertAt]?.type === 'tool_result') insertAt += 1;
    message.content.splice(insertAt, 0, ...newReminders);
    return;
  }

  let insertAt = firstUser + 1;
  while (insertAt < body.messages.length && body.messages[insertAt]?.role === 'user') insertAt += 1;
  const systemMessages = texts.map((text) => ({
    role: 'system',
    content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
  }));
  body.messages.splice(insertAt, 0, ...systemMessages);
}

function aliasClaudeOAuthTools(body, secret) {
  const aliases = new Map();
  const forward = new Map();
  const reserved = new Set(['web_search', 'code_execution', 'text_editor', 'computer']);
  for (const name of Array.isArray(body.tools) ? body.tools.map((tool) => tool?.name).filter(Boolean) : []) reserved.add(name);
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!plainObject(tool) || typeof tool.name !== 'string' || !tool.name || isClaudeServerTool(tool) || isClaudeMCPToolName(tool.name)) continue;
    if (forward.has(tool.name)) continue;
    const digest = createHmac('sha256', secret).update(`cpa-claude-mcp-alias-v2\0tool\0${tool.name}`).digest();
    const serverDigest = createHmac('sha256', secret).update('cpa-claude-mcp-alias-v2\0server\0').digest();
    const server = `${claudeAliasWord(serverDigest, 0)}_${claudeAliasWord(serverDigest, 2)}`;
    const baseIndex = digest.readUInt16BE(0) % CLAUDE_BIP39_WORDS.length;
    let alias = '';
    for (let attempt = 0; attempt < CLAUDE_BIP39_WORDS.length; attempt += 1) {
      const toolId = CLAUDE_BIP39_WORDS[(baseIndex + attempt) % CLAUDE_BIP39_WORDS.length];
      const prefix = `mcp__${server}__${toolId}_`;
      const semantic = sanitizeToolName(tool.name).slice(0, Math.max(1, 64 - prefix.length));
      const candidate = `${prefix}${semantic}`;
      if (!reserved.has(candidate) && !aliases.has(candidate)) {
        alias = candidate;
        break;
      }
    }
    if (!alias) continue;
    reserved.add(alias);
    forward.set(tool.name, alias);
    aliases.set(alias, tool.name);
    tool.name = alias;
    if (typeof tool.type === 'string' && tool.type.trim()) delete tool.type;
  }
  if (!forward.size) return aliases;
  if (plainObject(body.tool_choice) && typeof body.tool_choice.name === 'string' && forward.has(body.tool_choice.name)) body.tool_choice.name = forward.get(body.tool_choice.name);
  for (const message of Array.isArray(body.messages) ? body.messages : []) rewriteClaudeToolReferences(message, forward);
  return aliases;
}

function rewriteClaudeToolReferences(value, forward) {
  if (Array.isArray(value)) {
    for (const item of value) rewriteClaudeToolReferences(item, forward);
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (['name', 'tool_name'].includes(key) && typeof child === 'string' && forward.has(child)) value[key] = forward.get(child);
    else rewriteClaudeToolReferences(child, forward);
  }
}

function isClaudeMCPToolName(name) {
  return /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(name) && name.length <= 64;
}

function isClaudeServerTool(tool) {
  const type = String(tool.type || '').toLowerCase();
  return ['advisor_', 'agent_toolset_', 'bash_', 'code_execution_', 'computer_', 'memory_', 'text_editor_', 'tool_search_tool_', 'web_fetch_', 'web_search_'].some((prefix) => type.startsWith(prefix));
}

function claudeAliasWord(digest, offset) {
  return CLAUDE_BIP39_WORDS[digest.readUInt16BE(offset) % CLAUDE_BIP39_WORDS.length];
}

function sanitizeToolName(name) {
  const result = String(name).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  return result || 'tool';
}

function attachClaudeModelAlias(body, mapping) {
  if (mapping && body && typeof body === 'object') {
    Object.defineProperty(body, CLAUDE_MODEL_ALIAS, { value: mapping, enumerable: false });
  }
  return body;
}

function attachClaudeRequestProfile(body, nativeClient, helperProfile) {
  if (!body || typeof body !== 'object') return body;
  if (nativeClient && body[CLAUDE_NATIVE_REQUEST] !== true) {
    Object.defineProperty(body, CLAUDE_NATIVE_REQUEST, { value: true, enumerable: false });
  }
  if (helperProfile && !body[CLAUDE_HELPER_PROFILE]) {
    Object.defineProperty(body, CLAUDE_HELPER_PROFILE, { value: helperProfile, enumerable: false });
  }
  return body;
}

// CLIProxyAPI accepts per-auth model aliases in imported OAuth metadata. The
// request-facing alias is resolved case-insensitively, while a thinking suffix
// such as `(8192)` is preserved on the provider model when the configured
// target does not already carry one.
function resolveClaudeModelAlias(requestedModel, upstream, claudeConfig = null) {
  const requested = typeof requestedModel === 'string' ? requestedModel.trim() : '';
  if (!requested) return null;
  const configured = isClaudeOAuthUpstream(upstream) ? globalClaudeModelAliases(claudeConfig) : [];
  const aliases = [
    ...parseClaudeModelAliases(upstream?.metadata?.model_aliases ?? upstream?.metadata?.['model-aliases']),
    ...parseClaudeModelAliases(upstream?.metadata?.models ?? upstream?.metadata?.['model-configs'] ?? upstream?.metadata?.model_configs),
    ...configured
  ]
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.alias.toLowerCase() === entry.alias.toLowerCase()) === index);
  if (!aliases.length) return null;
  const suffix = parseClaudeModelSuffix(requested);
  const candidates = suffix.base && suffix.base !== requested ? [requested, suffix.base] : [requested];
  for (const candidate of candidates) {
    const entry = aliases.find((item) => item.alias.toLowerCase() === candidate.toLowerCase());
    if (!entry) continue;
    // CPA treats a force-mapped request for the provider's own name as a
    // response-only mapping; without force-mapping it is a normal passthrough.
    if (entry.name.toLowerCase() === suffix.base.toLowerCase() && !entry.forceMapping) return null;
    const targetHasSuffix = parseClaudeModelSuffix(entry.name).hasSuffix;
    const upstreamModel = targetHasSuffix || !suffix.hasSuffix
      ? entry.name
      : `${entry.name}(${suffix.rawSuffix})`;
    return {
      requestedModel: requested,
      upstreamModel,
      forceMapping: entry.forceMapping,
      isCompat: entry.isCompat,
      responseModel: entry.forceMapping ? entry.alias : ''
    };
  }
  return null;
}

function globalClaudeModelAliases(claudeConfig) {
  const all = claudeConfig?.oauthModelAlias ?? claudeConfig?.['oauth-model-alias'];
  if (!all || typeof all !== 'object' || Array.isArray(all)) return [];
  return parseClaudeModelAliases(all.claude ?? all.anthropic);
}

function parseClaudeModelAliases(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value.slice(0, 128)) {
    if (!plainObject(item)) continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const alias = typeof item.alias === 'string' ? item.alias.trim() : '';
    if (!name || !alias || name.length > 128 || alias.length > 128 || name.toLowerCase() === alias.toLowerCase()) continue;
    const forceMapping = item['force-mapping'] === true || item.force_mapping === true || item.forceMapping === true;
    const isCompat = item['is-compat'] === true || item.is_compat === true || item.isCompat === true;
    if (result.some((entry) => entry.alias.toLowerCase() === alias.toLowerCase())) continue;
    result.push({ name, alias, forceMapping, isCompat });
  }
  return result;
}

function claudeThinkingReplayScope({ req, body, credentials, upstream, sessionId, claudeConfig }) {
  if (!upstream || upstream.type !== 'claude' || !credentials?.projectKey || isClaudeOAuthToken(credentials.projectKey)) return null;
  if (req?.proxyAuth?.kind === 'personal_share') return null;
  const callerId = String(req?.proxyAuth?.id || req?.proxyAuth?.apiKeyId || '').trim();
  if (!callerId) return null;
  const sessionSignal = claudeReplaySessionSignal(req, body);
  if (!sessionSignal) return null;
  const requestedModel = stripClaudeModelPrefix(body?.model, upstream);
  const requestedModelBase = parseClaudeModelSuffix(requestedModel).base;
  const mapping = resolveClaudeModelAlias(requestedModel, upstream, claudeConfig);
  const modelConfig = claudeMetadataModelConfigs(upstream).find((entry) => (
    [entry.name, entry.alias].filter(Boolean).some((value) => [requestedModel, requestedModelBase]
      .some((candidate) => String(value).toLowerCase() === String(candidate).toLowerCase()))
  ));
  if (!mapping?.isCompat && !modelConfig?.isCompat) return null;
  const model = String(mapping?.upstreamModel || modelConfig?.name || requestedModel).replace(/\([^()]*\)$/, '').trim();
  if (!model || !sessionId) return null;
  const modelFamily = createHash('sha256').update(`${upstream.id || upstream.accountId || upstream.baseUrl || 'claude'}\0${model.toLowerCase()}`).digest('hex').slice(0, 16);
  const sessionKey = createHash('sha256').update(`${callerId}\0${sessionSignal}`).digest('hex').slice(0, 32);
  return { key: `claude-thinking-replay:${modelFamily}:${sessionKey}`, modelFamily, sessionKey, replayApplied: false };
}

function claudeReplaySessionSignal(req, body) {
  const headers = [
    'x-claude-code-session-id', 'session-id', 'session_id', 'x-codex-window-id',
    'x-codex-session-id', 'x-session-id', 'x-http-session-id', 'x-session-affinity',
    'x-slot-session-id', 'x-conversation-id', 'x-thread-id', 'thread-id',
    'x-client-request-id'
  ];
  for (const name of headers) {
    const value = safeHeader(req, name);
    if (value && value.length <= MAX_SESSION_ID_LENGTH) return value;
  }
  const userId = parseUserId(body?.metadata?.user_id);
  if (typeof userId.session_id === 'string' && userId.session_id.trim()) return userId.session_id.trim();
  for (const root of [body, plainObject(body?.request) ? body.request : null]) {
    for (const value of [root?.thread_id, root?.threadId, root?.session_id, root?.sessionId, root?.prompt_cache_key, root?.promptCacheKey, root?.conversation_id, root?.conversationId, root?.chat_id, root?.chatId]) {
      if (typeof value === 'string' && value.trim() && value.length <= MAX_SESSION_ID_LENGTH) return value.trim();
    }
    const conversation = root?.conversation;
    if (typeof conversation === 'string' && conversation.trim()) return conversation.trim();
    if (plainObject(conversation) && typeof conversation.id === 'string' && conversation.id.trim()) return conversation.id.trim();
  }
  return '';
}

function stripClaudeModelPrefix(model, upstream) {
  const requested = typeof model === 'string' ? model.trim() : '';
  const prefix = claudeMetadataModelPrefix(upstream);
  const marker = prefix ? `${prefix}/` : '';
  return marker && requested.toLowerCase().startsWith(marker.toLowerCase())
    ? requested.slice(marker.length)
    : model;
}

function parseClaudeModelSuffix(value) {
  const match = /^(.*)\(([^()]*)\)$/.exec(value);
  if (!match || !match[1] || !match[2]) return { base: value, rawSuffix: '', hasSuffix: false };
  return { base: match[1], rawSuffix: match[2], hasSuffix: true };
}

function shapeClaudeOAuthBody(body, upstream = null, cchSigning = true, claudeConfig = null, sign = true) {
  const messageText = claudeBillingFingerprintMessageText(body);
  const workload = typeof body.__claudeWorkload === 'string' && body.__claudeWorkload ? ` cc_workload=${body.__claudeWorkload};` : '';
  delete body.__claudeWorkload;
  const billing = `x-anthropic-billing-header: cc_version=${claudeDefaultVersion(claudeConfig)}.${claudeFingerprint(messageText)}; cc_entrypoint=cli;${cchSigning ? ' cch=00000;' : ''}${workload}`;
  const originalSystem = body.system;
  const shaped = {
    ...body,
    system: [
      { type: 'text', text: billing },
      { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.', cache_control: { type: 'ephemeral' } }
    ]
  };
  const cloakSettings = claudeCloakSettings(upstream, claudeConfig);
  if (!cloakSettings.strictMode) appendClaudeCallerSystemMessage(shaped, originalSystem);
  injectClaudeCurrentDate(shaped, cloakSettings.timezone);
  obfuscateClaudeSensitiveWords(shaped, cloakSettings.sensitiveWords);
  ensureClaudeCacheControls(shaped, { ttl: cchSigning ? '1h' : '' });
  enforceClaudeCacheControlLimit(shaped, 4);
  return cchSigning && sign ? signClaudeOAuthBody(shaped) : shaped;
}

function ensureClaudeNativeBillingHeader(body, claudeConfig = null) {
  if (body.system === undefined || body.system === null) return body;
  const existing = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : body.system;
  if (!Array.isArray(existing) || existing.some((block) => plainObject(block) && typeof block.text === 'string' && block.text.startsWith('x-anthropic-billing-header:'))) return body;
  const billing = `x-anthropic-billing-header: cc_version=${claudeDefaultVersion(claudeConfig)}.${claudeFingerprint(claudeBillingFingerprintMessageText(body))}; cc_entrypoint=cli; cch=00000;`;
  body.system = [{ type: 'text', text: billing }, ...existing];
  return body;
}

function claudeBillingFingerprintMessageText(body) {
  if (!Array.isArray(body.messages)) return '';
  let messageText = '';
  for (const message of body.messages) {
    if (!plainObject(message) || message.role !== 'user') continue;
    if (typeof message.content === 'string' && message.content) {
      messageText = message.content;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (plainObject(block) && block.type === 'text' && typeof block.text === 'string' && block.text) messageText = block.text;
    }
  }
  return messageText;
}

function claudeFingerprint(messageText) {
  const characters = Array.from(messageText);
  const selected = [4, 7, 20].map((index) => characters[index] || '0').join('');
  return createHash('sha256').update(`59cf53e54c78${selected}2.1.220`).digest('hex').slice(0, 3);
}

function appendClaudeCallerSystemMessage(body, originalSystem) {
  relocateClaudeSystemPrompt(body, originalSystem);
}

function rebuildClaudeMidSystemMessages(body) {
  if (!Array.isArray(body.messages)) return;
  const moved = [];
  const kept = [];
  for (const message of body.messages) {
    if (plainObject(message) && String(message.role || '').trim().toLowerCase() === 'system') {
      moved.push(...claudeSystemTextParts(message.content));
    } else {
      kept.push(message);
    }
  }
  if (!moved.length) return;
  const existing = claudeSystemTextParts(body.system);
  body.system = [...existing, ...moved];
  body.messages = kept;
}

function claudeSystemTextParts(content) {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (typeof block === 'string') return block.trim() ? [{ type: 'text', text: block }] : [];
    return plainObject(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim() ? [block] : [];
  });
}

function injectClaudeCurrentDate(body, timezone = '') {
  if (!Array.isArray(body.messages)) return;
  const message = body.messages.find((candidate) => plainObject(candidate) && candidate.role === 'user');
  if (!message) return;
  const dateText = `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is ${localDate(timezone)}.\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n\n`;
  const dateBlock = { type: 'text', text: dateText };
  if (typeof message.content === 'string') {
    message.content = [dateBlock, { type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }];
    return;
  }
  if (!Array.isArray(message.content)) return;
  let cached = false;
  for (const block of message.content) {
    if (!plainObject(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    if (block.text.startsWith('<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n# currentDate\n')) continue;
    if (!cached && !block.text.startsWith('<system-reminder>')) {
      block.cache_control = { type: 'ephemeral' };
      cached = true;
    }
  }
  let insertAt = 0;
  while (insertAt < message.content.length && message.content[insertAt]?.type === 'tool_result') insertAt += 1;
  message.content.splice(insertAt, 0, dateBlock);
}

function ensureClaudeCacheControls(body, { ttl = '' } = {}) {
  const mark = (block) => {
    if (!plainObject(block)) return;
    if (!plainObject(block.cache_control)) block.cache_control = { type: 'ephemeral' };
    if (ttl && !block.cache_control.ttl) block.cache_control.ttl = ttl;
  };
  const system = Array.isArray(body.system) ? body.system : [];
  const hasSystem = system.length > 0 || typeof body.system === 'string' && body.system.trim().length > 0;
  if (!hasSystem && Array.isArray(body.tools)) {
    for (let index = body.tools.length - 1; index >= 0; index -= 1) {
      const tool = body.tools[index];
      if (plainObject(tool) && tool.defer_loading !== true) {
        if (!body.tools.some((candidate) => plainObject(candidate) && candidate.cache_control)) mark(tool);
        break;
      }
    }
  }
  if (typeof body.system === 'string' && body.system.trim()) body.system = [{ type: 'text', text: body.system }];
  const normalizedSystem = Array.isArray(body.system) ? body.system : [];
  if (!normalizedSystem.some((block) => plainObject(block) && block.cache_control)) mark(normalizedSystem.at(-1));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let lastEligible = null;
  let lastEligibleIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (!plainObject(message) || !['user', 'assistant'].includes(message.role)) continue;
    const content = message.content;
    if (typeof content === 'string') {
      lastEligible = message;
      lastEligibleIndex = index;
    } else if (Array.isArray(content) && content.length && !(message.role === 'assistant' && ['thinking', 'redacted_thinking'].includes(content.at(-1)?.type))) {
      lastEligible = message;
      lastEligibleIndex = index;
    }
  }
  const finalMessage = messages.at(-1);
  if (lastEligibleIndex >= 0 && finalMessage?.role === 'system' && typeof finalMessage.content === 'string' && finalMessage.content.trim()) {
    finalMessage.content = [{ type: 'text', text: finalMessage.content, cache_control: { type: 'ephemeral' } }];
    if (ttl) finalMessage.content[0].cache_control.ttl = ttl;
    return;
  }
  if (lastEligible) {
    const content = lastEligible.content;
    if (typeof content === 'string') lastEligible.content = [{ type: 'text', text: content }];
    const blocks = Array.isArray(lastEligible.content) ? lastEligible.content : [];
    if (!blocks.some((block) => plainObject(block) && block.cache_control)) mark(blocks.at(-1));
  }
  const ordered = [
    ...(body.tools || []),
    ...normalizedSystem,
    ...messages.flatMap((message) => Array.isArray(message?.content) ? message.content : [])
  ];
  let seenShort = false;
  for (const block of ordered) {
    const cache = block?.cache_control;
    if (!plainObject(cache)) continue;
    if (ttl && !cache.ttl) cache.ttl = ttl;
    if (ttl && cache.ttl !== ttl) {
      seenShort = true;
    } else if (ttl && seenShort) {
      delete cache.ttl;
    }
  }
}

function countClaudeCacheControls(body) {
  let count = 0;
  const countBlock = (block) => {
    if (plainObject(block) && plainObject(block.cache_control)) count += 1;
  };
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) countBlock(tool);
  for (const block of Array.isArray(body?.system) ? body.system : []) countBlock(block);
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) countBlock(block);
  }
  return count;
}

function enforceClaudeCacheControlLimit(body, maxBlocks) {
  const blocks = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...(Array.isArray(body.system) ? body.system : []),
    ...(Array.isArray(body.messages) ? body.messages.flatMap((message) => Array.isArray(message?.content) ? message.content : []) : [])
  ];
  let excess = blocks.filter((block) => plainObject(block?.cache_control)).length - maxBlocks;
  if (excess <= 0) return;
  const removeAllButLast = (items) => {
    const marked = items.filter((item) => plainObject(item?.cache_control));
    const last = marked.at(-1);
    for (const item of marked) {
      if (excess <= 0) break;
      if (item === last) continue;
      delete item.cache_control;
      excess -= 1;
    }
  };
  removeAllButLast(Array.isArray(body.system) ? body.system : []);
  removeAllButLast(Array.isArray(body.tools) ? body.tools : []);
  const messageBlocks = Array.isArray(body.messages)
    ? body.messages.flatMap((message) => Array.isArray(message?.content) ? message.content : [])
    : [];
  for (const block of messageBlocks) {
    if (excess <= 0) break;
    if (!plainObject(block?.cache_control)) continue;
    delete block.cache_control;
    excess -= 1;
  }
  for (const items of [Array.isArray(body.system) ? body.system : [], Array.isArray(body.tools) ? body.tools : []]) {
    for (const item of items) {
      if (excess <= 0) break;
      if (!plainObject(item?.cache_control)) continue;
      delete item.cache_control;
      excess -= 1;
    }
  }
}

function localDate(timezone = '') {
  const date = new Date();
  if (timezone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(date);
    } catch {
      // CPA falls back to the process-local timezone when the configured IANA
      // name is invalid. Keep the same safe fallback in Node.
    }
  }
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function signClaudeOAuthBody(body) {
  const system = Array.isArray(body.system) ? body.system : [];
  const billing = plainObject(system[0]) && typeof system[0].text === 'string' ? system[0] : null;
  if (!billing || !billing.text.includes('cch=00000;')) return body;
  const serialized = Buffer.from(JSON.stringify(body), 'utf8');
  const encodedBilling = Buffer.from(JSON.stringify(billing.text), 'utf8');
  const billingStart = serialized.indexOf(encodedBilling);
  const marker = Buffer.from('cch=00000;');
  const relativeMarker = encodedBilling.indexOf(marker);
  if (billingStart < 0 || relativeMarker < 0) return body;
  const cchOffset = billingStart + relativeMarker + Buffer.byteLength('cch=');
  const unsigned = Buffer.from(serialized);
  unsigned.fill(0x30, cchOffset, cchOffset + 5);
  const normalized = normalizeClaudeCCHInput(unsigned);
  const hash = xxHash64(normalized, 0x4D659218E32A3268n) & 0xFFFFFn;
  billing.text = billing.text.replace('cch=00000;', `cch=${hash.toString(16).padStart(5, '0')};`);
  return body;
}

function normalizeClaudeCCHInput(body) {
  JSON.parse(body.toString('utf8'));
  const scanner = new ClaudeCCHScanner(body);
  scanner.parseValue(true);
  scanner.skipWhitespace();
  if (scanner.pos !== body.length) throw new Error(`unexpected JSON data at byte ${scanner.pos}`);
  scanner.edits.sort((left, right) => left.start - right.start);
  const chunks = [];
  let last = 0;
  for (const edit of scanner.edits) {
    if (edit.start < last || edit.end > body.length) throw new Error(`overlapping CCH normalization edit at byte ${edit.start}`);
    chunks.push(body.subarray(last, edit.start));
    last = edit.end;
  }
  chunks.push(body.subarray(last));
  return Buffer.concat(chunks);
}

class ClaudeCCHScanner {
  constructor(body) {
    this.body = body;
    this.pos = 0;
    this.edits = [];
  }

  parseValue(collect) {
    this.skipWhitespace();
    if (this.pos >= this.body.length) throw new Error(`missing JSON value at byte ${this.pos}`);
    switch (this.body[this.pos]) {
      case 0x7b: return this.parseObject(collect);
      case 0x5b: return this.parseArray(collect);
      case 0x22: this.parseString(); return;
      default: {
        const start = this.pos;
        while (this.pos < this.body.length && ![0x2c, 0x7d, 0x5d, 0x20, 0x09, 0x0d, 0x0a].includes(this.body[this.pos])) this.pos += 1;
        if (this.pos === start) throw new Error(`missing JSON value at byte ${start}`);
      }
    }
  }

  parseObject(collect) {
    this.pos += 1;
    this.skipWhitespace();
    if (this.consume(0x7d)) return;
    const members = [];
    let commaBefore = -1;
    while (true) {
      this.skipWhitespace();
      const memberStart = this.pos;
      const [keyStart, keyEnd] = this.parseString();
      this.skipWhitespace();
      if (!this.consume(0x3a)) throw new Error(`missing object colon at byte ${this.pos}`);
      this.skipWhitespace();
      const key = this.body.subarray(keyStart, keyEnd).toString('utf8');
      const excluded = collect && ['"max_tokens"', '"fallbacks"', '"fallback_credit_token"'].includes(key);
      if (collect && key === '"model"' && this.body[this.pos] === 0x22) {
        const [valueStart, valueEnd] = this.parseString();
        this.addEdit(valueStart + 1, valueEnd - 1);
      } else {
        this.parseValue(collect && !excluded);
      }
      const memberEnd = this.pos;
      this.skipWhitespace();
      let commaAfter = -1;
      if (this.consume(0x2c)) commaAfter = this.pos - 1;
      members.push({ start: memberStart, end: memberEnd, commaBefore, commaAfter, excluded });
      if (commaAfter >= 0) {
        commaBefore = commaAfter;
        continue;
      }
      if (!this.consume(0x7d)) throw new Error(`missing object end at byte ${this.pos}`);
      break;
    }
    if (collect) this.addExcludedMemberEdits(members);
  }

  parseArray(collect) {
    this.pos += 1;
    this.skipWhitespace();
    if (this.consume(0x5d)) return;
    while (true) {
      this.parseValue(collect);
      this.skipWhitespace();
      if (this.consume(0x2c)) continue;
      if (!this.consume(0x5d)) throw new Error(`missing array end at byte ${this.pos}`);
      return;
    }
  }

  parseString() {
    if (this.body[this.pos] !== 0x22) throw new Error(`missing JSON string at byte ${this.pos}`);
    const start = this.pos;
    this.pos += 1;
    while (this.pos < this.body.length) {
      if (this.body[this.pos] === 0x5c) this.pos += 2;
      else if (this.body[this.pos] === 0x22) {
        this.pos += 1;
        return [start, this.pos];
      } else this.pos += 1;
    }
    throw new Error(`unterminated JSON string at byte ${start}`);
  }

  addExcludedMemberEdits(members) {
    for (let start = 0; start < members.length;) {
      if (!members[start].excluded) {
        start += 1;
        continue;
      }
      let end = start;
      while (end + 1 < members.length && members[end + 1].excluded) end += 1;
      if (end + 1 < members.length) this.addEdit(members[start].start, members[end].commaAfter + 1);
      else if (start > 0 && end > start) this.addEdit(members[start].start, members[end].end);
      else if (start > 0) this.addEdit(members[start].commaBefore, members[end].end);
      else this.addEdit(members[start].start, members[end].end);
      start = end + 1;
    }
  }

  addEdit(start, end) {
    if (start < end) this.edits.push({ start, end });
  }

  skipWhitespace() {
    while ([0x20, 0x09, 0x0d, 0x0a].includes(this.body[this.pos])) this.pos += 1;
  }

  consume(character) {
    if (this.body[this.pos] !== character) return false;
    this.pos += 1;
    return true;
  }
}

function xxHash64(input, seed) {
  const bytes = Buffer.from(input, 'utf8');
  const mask = 0xFFFFFFFFFFFFFFFFn;
  const prime1 = 11400714785074694791n;
  const prime2 = 14029467366897019727n;
  const prime3 = 1609587929392839161n;
  const prime4 = 9650029242287828579n;
  const prime5 = 2870177450012600261n;
  const rotate = (value, bits) => ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & mask;
  const round = (accumulator, value) => (rotate((accumulator + value * prime2) & mask, 31) * prime1) & mask;
  const mergeRound = (accumulator, value) => ((accumulator ^ round(0n, value)) * prime1 + prime4) & mask;
  const read64 = (offset) => {
    let value = 0n;
    for (let index = 0; index < 8; index += 1) value |= BigInt(bytes[offset + index]) << BigInt(index * 8);
    return value;
  };
  const read32 = (offset) => BigInt(bytes[offset]) | (BigInt(bytes[offset + 1]) << 8n) | (BigInt(bytes[offset + 2]) << 16n) | (BigInt(bytes[offset + 3]) << 24n);
  let offset = 0;
  let hash;
  if (bytes.length >= 32) {
    let v1 = (seed + prime1 + prime2) & mask;
    let v2 = (seed + prime2) & mask;
    let v3 = seed & mask;
    let v4 = (seed - prime1) & mask;
    const limit = bytes.length - 32;
    while (offset <= limit) {
      v1 = round(v1, read64(offset)); offset += 8;
      v2 = round(v2, read64(offset)); offset += 8;
      v3 = round(v3, read64(offset)); offset += 8;
      v4 = round(v4, read64(offset)); offset += 8;
    }
    hash = (rotate(v1, 1) + rotate(v2, 7) + rotate(v3, 12) + rotate(v4, 18)) & mask;
    hash = mergeRound(hash, v1);
    hash = mergeRound(hash, v2);
    hash = mergeRound(hash, v3);
    hash = mergeRound(hash, v4);
  } else {
    hash = (seed + prime5) & mask;
  }
  hash = (hash + BigInt(bytes.length)) & mask;
  while (offset + 8 <= bytes.length) {
    const value = round(0n, read64(offset));
    hash = (rotate(hash ^ value, 27) * prime1 + prime4) & mask;
    offset += 8;
  }
  if (offset + 4 <= bytes.length) {
    hash = (rotate(hash ^ (read32(offset) * prime1 & mask), 23) * prime2 + prime3) & mask;
    offset += 4;
  }
  while (offset < bytes.length) {
    hash = (rotate(hash ^ (BigInt(bytes[offset]) * prime5 & mask), 11) * prime1) & mask;
    offset += 1;
  }
  hash ^= hash >> 33n;
  hash = (hash * prime2) & mask;
  hash ^= hash >> 29n;
  hash = (hash * prime3) & mask;
  hash ^= hash >> 32n;
  return hash & mask;
}
