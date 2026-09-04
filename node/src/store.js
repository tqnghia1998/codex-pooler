import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  createUpstream,
  claudeModelNameVariants,
  claudeMetadataModelExcluded,
  claudeMetadataModelPrefix,
  defaultBaseUrl,
  deriveUpstreamName,
  dollarsToCredits,
  ensureSpending,
  filterSpendCapEligible,
  isAiswitchUpstream,
  isClaudeOAuthUpstream,
  number,
  normalizeClaudeBaseUrl,
  publicUpstream,
  recordUsage,
  setSpendingCap,
  spendingSummary,
  updateUpstream
} from './domain.js';
import { providerRefreshFailureCode, providerRefreshFailureDetail } from './providers.js';
import { safeCompatibilityValue, validCompatibilityFeature } from './compatibility-policy.js';
import { claudeCoolingDisabled, quotaCooldown } from './upstream-outcomes.js';
import { normalizePacingPolicy } from './upstream-pacer.js';
import { gatewayDiagnosticsForStore, sanitizeAttemptTimings, sanitizeExclusionReasons } from './gateway-diagnostics.js';

const SESSION_LIMIT = 1_000;
const SESSION_ID_MAX_LENGTH = 200;
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const SESSION_ROTATION_SPEND_MICROS = 5_000_000;
const RESPONSE_PIN_LIMIT = 1_000;
const RESPONSE_PIN_TTL_MS = 24 * 60 * 60 * 1_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;
const CIRCUIT_LIMIT = 100;
const RESET_COOLDOWN_PROBE_INTERVAL_MS = 5 * 60_000;
const COMPATIBILITY_FACT_LIMIT = 100;
const COMPATIBILITY_FACT_SCHEMA_VERSION = 3;
const COMPATIBILITY_FACT_ID_PATTERN = /^cf_[A-Za-z0-9_-]{20,64}$/;
const MONTH_SECONDS = 27 * 24 * 60 * 60;
const GATEWAY_ERROR_HISTORY_LIMIT = 100;
const GATEWAY_DIAGNOSTIC_ATTEMPT_LIMIT = 8;
const GATEWAY_USAGE_DAYS = 90;
const GATEWAY_USAGE_ATTEMPT_LIMIT = 100;
const ROUTING_STRATEGIES = new Set(['least-recent-success', 'most-remaining-quota']);
export const ROUTING_QUOTA_FRESHNESS_MS = 5 * 60_000;
export const DEFAULT_SCOPE_ID = 'default';

export class Store {
  constructor(dataDir = process.env.CODEX_POOLER_NODE_DATA_DIR || resolve(process.cwd(), '.data'), { encryptionKey = null, inMemory = false } = {}) {
    this.dataDir = inMemory ? null : resolve(dataDir);
    this.dbPath = inMemory ? ':memory:' : join(this.dataDir, 'db.sqlite');
    this.legacyDbPath = inMemory ? null : join(this.dataDir, 'db.json');
    this.keyPath = inMemory ? null : join(this.dataDir, '.key');
    if (!inMemory) {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      chmodSync(this.dataDir, 0o700);
    }
    if (inMemory && !encryptionKey) throw new Error('In-memory Store requires an encryption key');
    this.key = encryptionKey ? normalizeEncryptionKey(encryptionKey) : this.loadKey(existsSync(this.dbPath) || existsSync(this.legacyDbPath));
    this.sqlite = new Database(this.dbPath);
    if (!inMemory) chmodSync(this.dbPath, 0o600);
    this.sqlite.pragma('journal_mode = DELETE');
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection, key))');
    this.events = new EventEmitter();
    this.claudeRuntimeConfig = {};
    if (inMemory || this.sqlite.prepare('SELECT COUNT(*) AS count FROM records').get().count || !existsSync(this.legacyDbPath)) this.db = this.load();
    else {
      this.db = normalizeDatabase(JSON.parse(readFileSync(this.legacyDbPath, 'utf8')));
      this.save(this.db);
      unlinkSync(this.legacyDbPath);
    }
  }

  onUpstreamsChange(listener) {
    this.events.on('upstreams', listener);
    return () => this.events.off('upstreams', listener);
  }

  configureClaudeRuntime(config = {}) {
    this.claudeRuntimeConfig = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    return this.claudeRuntimeConfig;
  }

  notifyUpstreamsChange() {
    this.events.emit('upstreams');
  }

  createScope({ id = randomUUID(), status = 'active', models = [] } = {}) {
    if (!['active', 'disabled'].includes(status)) throw new Error('scope status must be active or disabled');
    const db = this.load();
    if (db.scopes.some((scope) => scope.id === id)) throw new Error('scope already exists');
    const scope = { id, status, models: normalizeModels(models) };
    db.scopes.push(scope);
    this.save(db);
    return publicScope(scope);
  }

  updateScope(id, { status, models } = {}) {
    const db = this.load();
    const scope = activeScope(db, id);
    if (status !== undefined) {
      if (!['active', 'disabled'].includes(status)) throw new Error('scope status must be active or disabled');
      scope.status = status;
    }
    if (models !== undefined) scope.models = normalizeModels(models);
    this.save(db);
    return publicScope(scope);
  }

  modelAllowed(scopeId, model) {
    const scope = activeScope(this.load(), scopeId, false);
    return Boolean(scope) && (!scope.models?.length || scope.models.includes(String(model || '').toLowerCase()));
  }

  createApiKey({ key, scopeId = DEFAULT_SCOPE_ID, status = 'active' } = {}) {
    if (typeof key !== 'string' || !key.trim()) throw new Error('key is required');
    if (!['active', 'disabled'].includes(status)) throw new Error('api key status must be active or disabled');
    const db = this.load();
    activeScope(db, scopeId);
    const keyHash = apiKeyHash(key);
    if (db.apiKeys.some((item) => item.keyHash === keyHash)) throw new Error('api key already exists');
    const record = { id: randomUUID(), scopeId, status, keyHash, createdAt: new Date().toISOString() };
    db.apiKeys.push(record);
    this.save(db);
    return publicApiKey(record);
  }

  configureApiKey(key) {
    if (!key) return null;
    const db = this.load();
    const keyHash = apiKeyHash(key);
    const existing = db.apiKeys.find((item) => item.keyHash === keyHash);
    if (existing) return publicApiKey(existing);
    const record = { id: randomUUID(), scopeId: DEFAULT_SCOPE_ID, status: 'active', keyHash, createdAt: new Date().toISOString() };
    db.apiKeys.push(record);
    this.save(db);
    return publicApiKey(record);
  }

  authenticateApiKey(key) {
    if (typeof key !== 'string' || !key) return null;
    const db = this.load();
    const keyHash = apiKeyHash(key);
    const record = db.apiKeys.find((item) => constantHashEqual(item.keyHash, keyHash));
    if (!record || record.status !== 'active' || activeScope(db, record.scopeId, false)?.status !== 'active') return null;
    return publicApiKey(record);
  }

  updateApiKey(id, { status }) {
    if (!['active', 'disabled'].includes(status)) throw new Error('api key status must be active or disabled');
    const db = this.load();
    const record = db.apiKeys.find((item) => item.id === id);
    if (!record) throw notFound();
    record.status = status;
    this.save(db);
    return publicApiKey(record);
  }

  listApiKeys(scopeId = null) {
    return scoped(this.load().apiKeys, scopeId).map(publicApiKey);
  }

  list(scopeId = null) {
    return this.listForModelCatalog(scopeId).map(publicUpstream);
  }

  // Internal model/routing consumers need the full sanitized upstream record,
  // but should not repeatedly project and rescan the same collection.
  listForModelCatalog(scopeId = null) {
    const db = this.load();
    let changed = false;
    for (const upstream of db.upstreams) {
      const before = JSON.stringify(upstream.spending);
      ensureSpending(upstream);
      changed ||= before !== JSON.stringify(upstream.spending);
    }
    if (changed) this.save(db);
    return scoped(db.upstreams, scopeId);
  }

  get(id, scopeId = null) {
    const upstream = scoped(this.load().upstreams, scopeId).find((item) => item.id === id) || null;
    if (upstream) ensureSpending(upstream);
    return upstream;
  }

  getPublic(id, scopeId = null) {
    const upstream = this.get(id, scopeId);
    return upstream ? publicUpstream(upstream) : null;
  }

  create(input, { scopeId = input?.scopeId || DEFAULT_SCOPE_ID, allowDuplicateCodexIdentity = false } = {}) {
    const upstream = createUpstream(input);
    const db = this.load();
    activeScope(db, scopeId);

    const isDuplicate = db.upstreams.some((item) => (item.scopeId || DEFAULT_SCOPE_ID) === scopeId && item.type === upstream.type && (upstream.type === 'codex'
      ? (upstream.email ? item.email === upstream.email : upstream.accountId && item.accountId === upstream.accountId)
      : upstream.type === 'compass'
        ? item.projectId === upstream.projectId
        : upstream.email && item.email === upstream.email || upstream.accountId && item.accountId === upstream.accountId));
    if (isDuplicate && !(allowDuplicateCodexIdentity && upstream.type === 'codex')) {
      throw new Error(`${upstream.type} upstream already exists`);
    }

    upstream.scopeId = scopeId;
    upstream.routing = normalizeRouting(input.routing);
    upstream.pacing = normalizePacingPolicy(input.pacing);
    upstream.credentials = encryptCredentials(upstream.credentials, this.key);
    db.upstreams.push(upstream);
    this.save(db);
    this.notifyUpstreamsChange();
    return publicUpstream(upstream);
  }

  update(id, input) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    ensureSpending(upstream);
    const previousCredentials = decryptCredentials(upstream.credentials, this.key);
    upstream.credentials = previousCredentials;
    updateUpstream(upstream, input);
    if (['codex', 'claude'].includes(upstream.type) && (input.authJson || input.accessToken || input.projectKey !== undefined)) {
      upstream.quota = null;
      upstream.credentialEpoch = (Number(upstream.credentialEpoch) || 0) + 1;
      upstream.compatibilityEpoch = (Number(upstream.compatibilityEpoch) || 0) + 1;
      if (upstream.type === 'codex') upstream.modelCatalogEpoch = (Number(upstream.modelCatalogEpoch) || 0) + 1;
      delete upstream.tokenRefresh;
      clearHealthAfterCredentialReplacement(upstream);
      delete upstream.compatibility;
    } else if (upstream.type === 'compass') {
      const quotaIdentityChanged = input.projectId !== undefined
        || input.projectKey !== undefined
        || input.quotaSource !== undefined
        || input.metadata?.quota_type !== undefined
        || input.metadata?.quotaType !== undefined;
      if (quotaIdentityChanged) upstream.quota = null;
      if (input.projectKey !== undefined) {
        upstream.credentialEpoch = (Number(upstream.credentialEpoch) || 0) + 1;
        upstream.compatibilityEpoch = (Number(upstream.compatibilityEpoch) || 0) + 1;
        clearHealthAfterCredentialReplacement(upstream);
        delete upstream.compatibility;
      }
    }
    if (input.routing !== undefined) upstream.routing = normalizeRouting(input.routing);
    if (input.pacing !== undefined) upstream.pacing = normalizePacingPolicy(input.pacing);
    this.saveCredentials(upstream);
    this.save(db);
    this.notifyUpstreamsChange();
    return publicUpstream(upstream);
  }

  setPriorityList(ids) {
    if (!Array.isArray(ids)) throw new Error('ids must be an array');
    const db = this.load();
    const ordered = [];
    for (const id of ids) {
      const upstream = db.upstreams.find((item) => item.id === id);
      if (!upstream) throw new Error(`unknown upstream ${id}`);
      if (!ordered.includes(upstream)) ordered.push(upstream);
    }
    for (const upstream of db.upstreams) upstream.priority = null;
    ordered.forEach((upstream, index) => { upstream.priority = index; });
    this.save(db);
    this.notifyUpstreamsChange();
    return ordered.map(publicUpstream);
  }

  routingPolicy() {
    const policy = normalizeRoutingPolicy(this.load().routingPolicy);
    return { ...policy, quotaFreshnessMs: ROUTING_QUOTA_FRESHNESS_MS };
  }

  setRoutingPolicy(input = {}) {
    const db = this.load();
    db.routingPolicy = normalizeRoutingPolicy(input);
    this.save(db);
    this.notifyUpstreamsChange();
    return { ...db.routingPolicy, quotaFreshnessMs: ROUTING_QUOTA_FRESHNESS_MS };
  }

  remove(id) {
    const db = this.load();
    const index = db.upstreams.findIndex((upstream) => upstream.id === id);
    if (index === -1) throw notFound();
    db.upstreams.splice(index, 1);
    for (const [sessionId, entry] of Object.entries(db.sessions)) {
      if (entry === id || entry?.upstreamId === id || entry?.rotationUpstreamId === id) delete db.sessions[sessionId];
    }
    this.save(db);
    this.notifyUpstreamsChange();
  }

  credentials(id) {
    const upstream = this.get(id);
    if (!upstream) throw notFound();
    const credentials = decryptCredentials(upstream.credentials, this.key);
    if (['codex', 'claude'].includes(upstream.type)) {
      Object.defineProperties(credentials, {
        credentialEpoch: { value: Number(upstream.credentialEpoch) || 0, enumerable: false },
        modelCatalogEpoch: { value: Number(upstream.modelCatalogEpoch) || 0, enumerable: false },
        onTokenRefreshFailure: { value: (error) => this.recordTokenRefreshFailure(id, error, Number(upstream.credentialEpoch) || 0), enumerable: false },
        onTokenRefreshSuccess: { value: () => this.clearTokenRefresh(id, Number(upstream.credentialEpoch) || 0), enumerable: false }
      });
    }
    return credentials;
  }

  setTokenRefreshFailureHandler(handler) {
    this.tokenRefreshFailureHandler = typeof handler === 'function' ? handler : null;
  }

  recordTokenRefreshFailure(id, error, expectedEpoch = null) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    if (expectedEpoch !== null && expectedEpoch !== (Number(upstream.credentialEpoch) || 0)) return null;
    const status = providerRefreshFailureCode(upstream.type, error);
    upstream.tokenRefresh = { status, finishedAt: new Date().toISOString(), trigger: 'runtime', errorCode: status, errorDetail: providerRefreshFailureDetail(upstream.type, error) };
    upstream.updatedAt = new Date().toISOString();
    this.save(db);
    this.notifyUpstreamsChange();
    this.tokenRefreshFailureHandler?.(id, 'runtime');
    return publicUpstream(upstream);
  }

  clearTokenRefresh(id, expectedEpoch = null) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    if (expectedEpoch !== null && expectedEpoch !== (Number(upstream.credentialEpoch) || 0)) return;
    if (!upstream.tokenRefresh) return;
    delete upstream.tokenRefresh;
    upstream.updatedAt = new Date().toISOString();
    this.save(db);
    this.notifyUpstreamsChange();
  }

  setQuota(id, quota, { notify = true } = {}) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    ensureSpending(upstream);
    upstream.quota = quota;
    upstream.quotaSource = quota?.source || null;
    if (upstream.health?.status === 'reauth_required') {
      upstream.healthGeneration = Math.max(0, Number(upstream.health.generation ?? upstream.healthGeneration) || 0) + 1;
      delete upstream.health;
    }
    upstream.updatedAt = new Date().toISOString();
    this.save(db);
    if (notify) this.notifyUpstreamsChange();
    return publicUpstream(upstream);
  }

  persistCredentials(id, credentials, accessTokenExpiresAt = null) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    const expectedEpoch = credentials?.credentialEpoch;
    const previousCredentials = decryptCredentials(upstream.credentials, this.key);
    if (expectedEpoch !== undefined && expectedEpoch !== (Number(upstream.credentialEpoch) || 0)) {
      if (!sameAuthentication(upstream.type, previousCredentials, credentials)) return false;
      for (const key of Object.keys(credentials)) delete credentials[key];
      Object.assign(credentials, previousCredentials);
      return true;
    }
    const accessTokenChanged = ['codex', 'claude'].includes(upstream.type)
      && String(previousCredentials.accessToken || '') !== String(credentials?.accessToken || '');
    const authenticationChanged = ['codex', 'claude'].includes(upstream.type)
      ? ['accessToken', 'refreshToken', 'idToken', 'projectKey'].some((name) => String(previousCredentials[name] || '') !== String(credentials?.[name] || ''))
      : String(previousCredentials.projectKey || '') !== String(credentials?.projectKey || '');
    upstream.credentials = encryptCredentials(credentials, this.key);
    if (accessTokenExpiresAt !== upstream.accessTokenExpiresAt) delete upstream.tokenRefresh;
    upstream.accessTokenExpiresAt = accessTokenExpiresAt;
    upstream.credentialEpoch = (Number(upstream.credentialEpoch) || 0) + 1;
    if (accessTokenChanged) upstream.modelCatalogEpoch = (Number(upstream.modelCatalogEpoch) || 0) + 1;
    if (authenticationChanged) {
      upstream.compatibilityEpoch = (Number(upstream.compatibilityEpoch) || 0) + 1;
      clearHealthAfterCredentialReplacement(upstream);
      delete upstream.compatibility;
    }
    upstream.updatedAt = new Date().toISOString();
    this.save(db);
    this.notifyUpstreamsChange();
    return true;
  }

  persistClaudeIdentity(id, { accountId = '', email = '', organizationId = '', organizationName = '', deviceId = '' } = {}, { expectedEpoch = null, expectedAccessToken = null } = {}) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    if (upstream.type !== 'claude') throw new Error('upstream is not Claude');
    const credentials = decryptCredentials(upstream.credentials, this.key);
    if (expectedEpoch !== null && (Number(upstream.credentialEpoch) || 0) !== Number(expectedEpoch)) return false;
    if (expectedAccessToken !== null && String(credentials.accessToken || '') !== String(expectedAccessToken || '')) return false;
    let changed = false;
    if (accountId && upstream.accountId !== String(accountId)) {
      upstream.accountId = String(accountId);
      changed = true;
    }
    if (email && upstream.email !== String(email)) {
      upstream.email = String(email);
      changed = true;
    }
    if (organizationId && credentials.organizationId !== String(organizationId)) {
      credentials.organizationId = String(organizationId);
      changed = true;
    }
    if (organizationName && credentials.organizationName !== String(organizationName)) {
      credentials.organizationName = String(organizationName);
      changed = true;
    }
    if (deviceId) {
      const metadata = upstream.metadata && typeof upstream.metadata === 'object' ? upstream.metadata : {};
      const devices = Array.isArray(metadata.claude_device_ids) ? metadata.claude_device_ids : [];
      if (devices[0] !== deviceId || devices.length !== 1) {
        upstream.metadata = { ...metadata, claude_device_ids: [deviceId] };
        changed = true;
      }
    }
    if (!changed) return upstream;
    upstream.name = deriveUpstreamName(upstream.type, upstream);
    upstream.credentials = encryptCredentials(credentials, this.key);
    upstream.updatedAt = new Date().toISOString();
    this.save(db);
    this.notifyUpstreamsChange();
    return upstream;
  }

  persistClaudeDeviceProfiles(id, profiles) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    if (upstream.type !== 'claude' || !profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return false;
    const sanitized = {};
    for (const name of ['cli', 'vscode']) {
      const profile = profiles[name];
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
      const values = {};
      for (const field of ['userAgent', 'packageVersion', 'runtimeVersion', 'os', 'arch']) {
        if (typeof profile[field] === 'string' && profile[field].length <= 256) values[field] = profile[field];
      }
      if (values.userAgent && values.packageVersion && values.runtimeVersion) sanitized[name] = values;
    }
    if (!Object.keys(sanitized).length) return false;
    const previous = this.persisted?.upstreams?.find((item) => item.id === id)?.claudeDeviceProfiles || null;
    if (JSON.stringify(previous) === JSON.stringify(sanitized)) return false;
    upstream.claudeDeviceProfiles = sanitized;
    upstream.updatedAt = new Date().toISOString();
    this.save(db);
    this.notifyUpstreamsChange();
    return true;
  }

  setTokenRefresh(id, tokenRefresh) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    upstream.tokenRefresh = tokenRefresh;
    upstream.updatedAt = new Date().toISOString();
    this.save(db);
    this.notifyUpstreamsChange();
    return publicUpstream(upstream);
  }

  setCap(id, input) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    ensureSpending(upstream);
    setSpendingCap(upstream, capCreditsFromInput(input));
    this.save(db);
    this.notifyUpstreamsChange();
    return publicUpstream(upstream);
  }

  addUsage(id, input) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    ensureSpending(upstream);
    const settlement = recordUsage(upstream, input);
    this.save(db);
    if (settlement.appliedDeltaMicros) this.notifyUpstreamsChange();
    return { upstream: publicUpstream(upstream), settlement };
  }

  recordGatewayUsage({ scopeId = DEFAULT_SCOPE_ID, apiKeyId = null, attemptId, startedAt, usage = null, settledCostMicros = null } = {}) {
    if (!attemptId) return;
    const db = this.load();
    if (addGatewayUsage(db, { scopeId, apiKeyId, attemptId, startedAt, usage, settledCostMicros })) this.save(db);
  }

  reserveGatewayRequest({ scopeId = DEFAULT_SCOPE_ID, apiKeyId, endpoint, model = '', transport = 'http_json', admittedAt = new Date().toISOString() } = {}) {
    if (typeof apiKeyId !== 'string' || !apiKeyId) throw new Error('apiKeyId is required');
    const db = this.load();
    activeScope(db, scopeId);
    if (!db.apiKeys.some((key) => key.id === apiKeyId && key.scopeId === scopeId)) throw new Error('api key not found');
    const request = {
      id: randomUUID(), scopeId, apiKeyId, endpoint: String(endpoint || ''), model: String(model || ''), transport,
      status: 'accepted', usageStatus: 'usage_pending', admittedAt, completedAt: null,
      responseStatusCode: null, lastErrorCode: null, retryCount: 0
    };
    db.gatewayRequests.push(request);
    return { ...request };
  }

  beginGatewayAttempt(requestId, upstreamId, startedAt = new Date().toISOString()) {
    const db = this.load();
    const request = findGatewayRequest(db, requestId);
    if (request.completedAt || !['accepted', 'in_progress'].includes(request.status)) throw new Error('request is already finalized');
    if (!scoped(db.upstreams, request.scopeId).some((upstream) => upstream.id === upstreamId)) throw notFound();
    request.status = 'in_progress';
    const attempt = {
      id: randomUUID(), requestId, upstreamId, attemptNumber: db.gatewayAttempts.filter((item) => item.requestId === requestId).length + 1,
      transport: request.transport, status: 'in_progress', retryable: false, startedAt, completedAt: null,
      responseStatusCode: null, errorCode: null
    };
    db.gatewayAttempts.push(attempt);
    gatewayDiagnosticsForStore(this).beginAttempt(attempt.id, {
      endpoint: request.endpoint,
      transport: request.transport,
      startedAt
    });
    return { ...attempt };
  }

  retryGatewayAttempt(requestId, attemptId, { responseStatusCode = null, errorCode = null, timings = null, completedAt = new Date().toISOString() } = {}) {
    const db = this.load();
    const request = findGatewayRequest(db, requestId);
    const attempt = findGatewayAttempt(db, requestId, attemptId);
    if (request.completedAt || attempt.status !== 'in_progress') throw new Error('attempt is already finalized');
    const measured = gatewayDiagnosticsForStore(this).finishAttempt(attemptId, { status: 'failed', errorCode });
    Object.assign(attempt, {
      status: 'retryable_failed',
      retryable: true,
      responseStatusCode: safeStatusCode(responseStatusCode),
      errorCode: safeDiagnosticCode(errorCode),
      timings: sanitizeAttemptTimings(timings || measured),
      completedAt
    });
    delete attempt.upstreamId;
    request.status = 'in_progress';
    request.retryCount += 1;
    return { ...attempt };
  }

  finalizeGatewayRequest({ requestId, attemptId = null, status, responseStatusCode = null, errorCode = null, exclusionReasons = [], timings = null, usage = null, settledCostMicros = null, costSource = null, completedAt = new Date().toISOString() } = {}) {
    if (!['succeeded', 'failed'].includes(status)) throw new Error('request status must be succeeded or failed');
    const db = this.load();
    const request = findGatewayRequest(db, requestId);
    if (request.completedAt) throw new Error('request is already finalized');
    const attempt = attemptId ? findGatewayAttempt(db, requestId, attemptId) : null;
    if (attempt && attempt.status !== 'in_progress') throw new Error('attempt is already finalized');
    if (status === 'succeeded' && !attempt) throw new Error('successful request requires an attempt');
    if (attempt) {
      const measured = gatewayDiagnosticsForStore(this).finishAttempt(attemptId, { status, errorCode });
      Object.assign(attempt, {
        status: status === 'succeeded' ? 'succeeded' : 'failed',
        retryable: false,
        responseStatusCode: safeStatusCode(responseStatusCode),
        errorCode: safeDiagnosticCode(errorCode),
        timings: sanitizeAttemptTimings(timings || measured),
        completedAt
      });
      if (status === 'failed') delete attempt.upstreamId;
    }
    const attemptReasons = db.gatewayAttempts
      .filter((item) => item.requestId === requestId)
      .map((item) => item.errorCode)
      .filter(Boolean);
    Object.assign(request, {
      status, usageStatus: usage ? 'usage_known' : status === 'succeeded' ? 'usage_unknown' : 'not_applicable',
      responseStatusCode: safeStatusCode(responseStatusCode),
      lastErrorCode: safeDiagnosticCode(errorCode),
      exclusionReasons: sanitizeExclusionReasons([...exclusionReasons, ...attemptReasons]),
      completedAt
    });
    if (status === 'failed') {
      delete request.scopeId;
      delete request.apiKeyId;
      delete request.model;
    }
    if (status === 'succeeded') {
      addGatewayUsage(db, { scopeId: request.scopeId, apiKeyId: request.apiKeyId, attemptId: attempt.id, startedAt: attempt.startedAt, usage, settledCostMicros });
      if (Number.isSafeInteger(settledCostMicros)) {
        const upstream = findOrThrow(db, attempt.upstreamId);
        ensureSpending(upstream);
        recordUsage(upstream, { attemptId: attempt.id, startedAt: attempt.startedAt, settledCostMicros, costSource });
      }
      deleteGatewayRequest(db, requestId);
    }
    pruneGatewayHistory(db, true);
    this.save(db);
    this.notifyUpstreamsChange();
    return { request: { ...request }, attempt: attempt && { ...attempt } };
  }

  gatewayRequest(id) {
    const request = this.load().gatewayRequests.find((item) => item.id === id);
    return request ? { ...request } : null;
  }

  gatewayAttempts(requestId) {
    return this.load().gatewayAttempts.filter((item) => item.requestId === requestId).map((item) => ({ ...item }));
  }

  gatewayDiagnostics() {
    const db = this.load();
    const failures = db.gatewayRequests
      .filter((request) => request.status === 'failed' && request.completedAt)
      .slice(-GATEWAY_ERROR_HISTORY_LIMIT)
      .reverse()
      .map((request) => {
        const attempts = db.gatewayAttempts.filter((attempt) => attempt.requestId === request.id);
        const retryCount = attempts.filter((attempt) => attempt.status === 'retryable_failed').length;
        const visibleAttempts = attempts.slice(-GATEWAY_DIAGNOSTIC_ATTEMPT_LIMIT);
        return {
          endpoint: safeEndpoint(request.endpoint),
          transport: safeTransport(request.transport),
          responseStatusCode: safeStatusCode(request.responseStatusCode),
          errorCode: safeDiagnosticCode(request.lastErrorCode),
          exclusionReasons: sanitizeExclusionReasons(request.exclusionReasons),
          retryCount,
          attemptCount: attempts.length,
          omittedAttemptCount: attempts.length - visibleAttempts.length,
          completedAt: safeTimestamp(request.completedAt),
          attempts: visibleAttempts.map((attempt) => ({
            attemptNumber: Math.max(1, Math.min(100, Number(attempt.attemptNumber) || 1)),
            status: ['retryable_failed', 'failed'].includes(attempt.status) ? attempt.status : 'failed',
            responseStatusCode: safeStatusCode(attempt.responseStatusCode),
            errorCode: safeDiagnosticCode(attempt.errorCode),
            timings: diagnosticAttemptTimings(attempt)
          }))
        };
      });
    return {
      retainedFailureCount: failures.length,
      retentionLimit: GATEWAY_ERROR_HISTORY_LIMIT,
      failures,
      runtime: gatewayDiagnosticsForStore(this).status()
    };
  }

  gatewayUsage(scopeId = DEFAULT_SCOPE_ID, apiKeyId = null) {
    const db = this.load();
    const today = new Date().toISOString().slice(0, 10);
    const entries = db.gatewayUsage.filter((item) => item.scopeId === scopeId && item.apiKeyId === apiKeyId && item.day === today);
    const totals = entries.reduce((result, item) => ({
      request_count: result.request_count + item.requestCount,
      total_tokens: result.total_tokens + item.totalTokens,
      cached_input_tokens: result.cached_input_tokens + item.cachedInputTokens,
      total_cost_micros: result.total_cost_micros + item.totalCostMicros,
      priced: result.priced || item.priced
    }), { request_count: 0, total_tokens: 0, cached_input_tokens: 0, total_cost_micros: 0, priced: false });
    const upstream_limits = dbUpstreamLimits(db.upstreams, scopeId);
    return { request_count: totals.request_count, total_tokens: totals.total_tokens, cached_input_tokens: totals.cached_input_tokens, total_cost_usd: totals.total_cost_micros / 1_000_000, total_cost_status: totals.priced ? 'priced' : 'unpriced', limits: [], upstream_limits };
  }

  spending(id) {
    const upstream = this.get(id);
    if (!upstream) throw notFound();
    return spendingSummary(upstream.spending);
  }

  eligibility(continuationId = null, scopeId = null) {
    const result = eligibilityFromUpstreams(scoped(this.load().upstreams, scopeId), continuationId, Date.now());
    return { ...result, eligible: result.eligible.map(publicUpstream), reserved: result.reserved.map(publicUpstream) };
  }

  candidatePlan(options = {}) {
    return this.candidatePlanDetails(options).candidates;
  }

  routingDryRun(options = {}) {
    const { candidates, diagnostics } = this.candidatePlanDetails(options);
    return {
      policy: { strategy: diagnostics.strategy, quotaFreshnessMs: ROUTING_QUOTA_FRESHNESS_MS },
      candidates: diagnostics.candidates,
      exclusions: diagnostics.exclusions,
      candidateCount: candidates.length
    };
  }

  candidatePlanDetails({ affinityId = '', pinnedId = null, requestedId = '', requestedType = '', preferredType = '', requiredType = '', rotateFromId = '', model = '', requirements = {}, modelSupport = null, ignoreModelRestrictions = false, routeClass = 'proxy_http', strategy = null, now = Date.now(), scopeId = null } = {}) {
    const db = this.load();
    const selectedStrategy = normalizeRoutingStrategy(strategy ?? db.routingPolicy?.strategy);
    const upstreams = scoped(db.upstreams, scopeId);
    const exclusions = new Map();
    const exclude = (upstream, code) => {
      if (upstream && !exclusions.has(upstream.id)) exclusions.set(upstream.id, routingDiagnostic(upstream, now, { code }));
    };
    const scope = scopeId ? activeScope(db, scopeId, false) : null;
    if (scopeId && model && (!scope || scope.models.length && !configuredClaudeModelMatches(scope.models, model, null, this.claudeRuntimeConfig))) {
      for (const upstream of upstreams) exclude(upstream, 'scope_model_not_allowed');
      return routingPlanResult([], selectedStrategy, exclusions, now);
    }
    const eligibility = eligibilityFromUpstreams(upstreams, pinnedId, now);
    for (const item of eligibility.exclusions) {
      exclude(upstreams.find((upstream) => upstream.id === item.id), item.code);
    }
    let candidates = eligibility.eligible;
    const automatic = !requestedId && !pinnedId;
    if (requestedId) candidates = filterRoutingCandidates(candidates, (upstream) => upstream.id === requestedId, exclude, 'not_explicitly_selected');
    else if (requestedType) candidates = filterRoutingCandidates(candidates, (upstream) => upstream.type === requestedType, exclude, 'upstream_type_not_selected');
    else if (pinnedId) candidates = filterRoutingCandidates(candidates, (upstream) => upstream.id === pinnedId, exclude, 'not_affinity_selected');
    if (requiredType) candidates = filterRoutingCandidates(candidates, (upstream) => upstream.type === requiredType, exclude, 'required_type_mismatch');
    candidates = candidates.filter((upstream) => {
      const code = candidateExclusionCode(upstream, model, requirements, { ignoreModelRestrictions, modelSupport, routeClass, now, claudeConfig: this.claudeRuntimeConfig });
      if (code) exclude(upstream, code);
      return !code;
    });
    // A session past its rotation threshold skips its previous upstream unless nothing else is eligible.
    if (rotateFromId && candidates.some((upstream) => upstream.id !== rotateFromId)) {
      candidates = filterRoutingCandidates(candidates, (upstream) => upstream.id !== rotateFromId, exclude, 'session_rotation');
    }
    if (automatic) {
      const preferred = candidates.filter((upstream) => upstream.type === preferredType);
      candidates = [
        ...orderRoutingCandidates(preferred, selectedStrategy, now),
        ...orderRoutingCandidates(candidates.filter((upstream) => upstream.type !== preferredType), selectedStrategy, now)
      ];
      if (affinityId) {
        candidates = [
          ...candidates.filter((upstream) => upstream.id === affinityId),
          ...candidates.filter((upstream) => upstream.id !== affinityId)
        ];
      }
    }
    return routingPlanResult(candidates, selectedStrategy, exclusions, now);
  }

  beginUpstreamAttempt(id, scope, now = Date.now()) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    let health = upstream.health || {};
    let generation = Math.max(0, Number(health.generation ?? upstream.healthGeneration) || 0);
    const nextEligibleAt = Date.parse(health.nextEligibleAt);
    let accountProbe = false;
    if (health.status === 'reauth_required') return null;
    if (health.status === 'cooldown' && Number.isFinite(nextEligibleAt) && nextEligibleAt <= now) {
      generation += 1;
      upstream.healthGeneration = generation;
      delete upstream.health;
      health = {};
    }
    if (Number.isFinite(nextEligibleAt) && nextEligibleAt > now) {
      const lastProbeAt = Date.parse(health.lastProbeAt || health.cooldownStartedAt);
      const probeDue = health.cooldownSource === 'reset-derived'
        && !health.probeInFlight
        && Number.isFinite(lastProbeAt)
        && lastProbeAt + RESET_COOLDOWN_PROBE_INTERVAL_MS <= now;
      if (!probeDue) return null;
      accountProbe = true;
      upstream.health = { ...health, probeInFlight: true, lastProbeAt: new Date(now).toISOString() };
    }
    if (upstream.type === 'claude' && !claudeCoolingDisabled(upstream, this.claudeRuntimeConfig) && modelCooldownBlocks(upstream, scope?.model, now)) return null;
    const circuitLease = beginCircuitLease(upstream, scope, now);
    if (!circuitLease) return null;
    this.save(db);
    return {
      accountGeneration: generation,
      accountProbe,
      circuitGeneration: circuitLease.generation,
      scope: { ...scope }
    };
  }

  settleUpstreamAttempt(id, admission, outcome, now = Date.now()) {
    if (!admission || !outcome) return false;
    const db = this.load();
    const upstream = findOrThrow(db, id);
    const health = upstream.health || {};
    const accountGeneration = Math.max(0, Number(health.generation ?? upstream.healthGeneration) || 0);
    const accountCurrent = admission.accountGeneration === accountGeneration;
    const model = normalizeModelKey(outcome.model || admission.scope?.model);
    if (outcome.modelScoped && upstream.type === 'claude' && model) {
      if (claudeCoolingDisabled(upstream, this.claudeRuntimeConfig)) deleteModelCooldown(upstream, model);
      else setModelCooldown(upstream, model, quotaCooldown(outcome, now), now);
      if (admission.accountProbe && accountCurrent && upstream.health) upstream.health.probeInFlight = false;
      releaseCircuitLease(upstream, admission, now);
    } else if (outcome.class === 'quota') {
      if (accountCurrent && !claudeCoolingDisabled(upstream, this.claudeRuntimeConfig)) {
        const cooldown = quotaCooldown(outcome, now);
        upstream.health = {
          status: 'cooldown',
          failureClass: 'quota',
          generation: accountGeneration + 1,
          cooldownSource: cooldown.cooldownSource,
          cooldownStartedAt: new Date(now).toISOString(),
          nextEligibleAt: new Date(cooldown.nextEligibleAt).toISOString(),
          probeInFlight: false
        };
        upstream.healthGeneration = accountGeneration + 1;
        clearSessionPinsForUpstream(db, id);
      } else if (accountCurrent && upstream.health?.status === 'cooldown') {
        // CPA's per-credential disable_cooling override also clears a probe
        // that was already in flight when the override became active.
        upstream.healthGeneration = accountGeneration + 1;
        delete upstream.health;
      }
      releaseCircuitLease(upstream, admission, now);
    } else if (outcome.class === 'credential') {
      if (accountCurrent) {
        upstream.health = {
          status: 'reauth_required',
          failureClass: 'credential',
          generation: accountGeneration + 1,
          cooldownSource: null,
          cooldownStartedAt: new Date(now).toISOString(),
          nextEligibleAt: null,
          probeInFlight: false
        };
        upstream.healthGeneration = accountGeneration + 1;
        if (upstream.type === 'codex') {
          upstream.tokenRefresh = { status: 'reauth_required', finishedAt: new Date(now).toISOString(), trigger: 'runtime', errorCode: 'reauth_required' };
        }
        clearSessionPinsForUpstream(db, id);
      }
      releaseCircuitLease(upstream, admission, now);
    } else if (outcome.class === 'transient') {
      if (claudeCoolingDisabled(upstream, this.claudeRuntimeConfig)) releaseCircuitLease(upstream, admission, now);
      else recordCircuitLeaseFailure(upstream, admission, now, 'transient');
      if (admission.accountProbe && accountCurrent && upstream.health) upstream.health.probeInFlight = false;
    } else if (outcome.class === 'success') {
      completeCircuitLease(upstream, admission, now);
      if (upstream.type === 'claude' && model) deleteModelCooldown(upstream, model);
      if (accountCurrent && upstream.health && (admission.accountProbe || Date.parse(health.nextEligibleAt) <= now)) {
        upstream.healthGeneration = accountGeneration + 1;
        delete upstream.health;
      }
      upstream.lastSuccessfulAt = new Date(now).toISOString();
    } else {
      releaseCircuitLease(upstream, admission, now);
      if (admission.accountProbe && accountCurrent && upstream.health) upstream.health.probeInFlight = false;
    }
    upstream.updatedAt = new Date(now).toISOString();
    this.save(db);
    this.notifyUpstreamsChange();
    return true;
  }

  clearUpstreamCooldown(id) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    if (upstream.health?.status !== 'cooldown') return publicUpstream(upstream);
    const generation = Math.max(0, Number(upstream.health?.generation ?? upstream.healthGeneration) || 0);
    delete upstream.health;
    upstream.healthGeneration = generation + 1;
    upstream.updatedAt = new Date().toISOString();
    this.save(db);
    this.notifyUpstreamsChange();
    return publicUpstream(upstream);
  }

  compatibilityFactRecord(id, key, {
    now = Date.now(),
    protocolFingerprintHash = null,
    generation = null
  } = {}) {
    const upstream = this.get(id);
    if (!upstream || typeof key !== 'string' || !key || key.length > 160) return null;
    const fact = upstream.compatibility?.facts?.[key];
    if (!fact) return null;
    const expiresAt = Date.parse(fact.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
    if (protocolFingerprintHash && fact.protocolFingerprintHash !== protocolFingerprintHash) return null;
    if (!sameCompatibilityGeneration(upstream, fact.generation)) return null;
    if (generation && !sameCompatibilityGeneration(upstream, generation)) return null;
    return structuredClone(fact);
  }

  promoteCompatibilityFact(id, key, record, expectedGeneration = null) {
    if (typeof key !== 'string' || !key || key.length > 160) throw new Error('compatibility key is invalid');
    const db = this.load();
    const upstream = findOrThrow(db, id);
    if (expectedGeneration && !sameCompatibilityGeneration(upstream, expectedGeneration)) return null;
    const compatibility = upstream.compatibility ||= { facts: {} };
    const facts = compatibility.facts ||= {};
    const normalized = normalizeCompatibilityFactRecord({
      ...record,
      id: compatibilityFactId(id, key),
      schemaVersion: COMPATIBILITY_FACT_SCHEMA_VERSION,
      status: 'active'
    }, key);
    if (!normalized) throw new Error('compatibility fact is invalid');
    const current = facts[key];
    facts[key] = current
      ? {
          ...current,
          ...normalized,
          id: current.id,
          createdAt: current.createdAt || normalized.createdAt,
          evidenceCount: Math.max(Number(current.evidenceCount) || 0, normalized.evidenceCount)
        }
      : normalized;
    pruneCompatibility(compatibility);
    this.save(db);
    return { status: 'active', fact: structuredClone(facts[key]), replaced: Boolean(current) };
  }

  removeCompatibilityFact(factId) {
    if (!COMPATIBILITY_FACT_ID_PATTERN.test(String(factId || ''))) return false;
    const db = this.load();
    for (const upstream of db.upstreams) {
      const compatibility = upstream.compatibility;
      if (!compatibility) continue;
      const entry = Object.entries(compatibility.facts || {}).find(([, fact]) => fact?.id === factId);
      if (!entry) continue;
      const [key, fact] = entry;
      delete compatibility.facts[key];
      this.save(db);
      return { upstreamId: upstream.id, key, fact: structuredClone(fact) };
    }
    return false;
  }

  clearCompatibilityFacts() {
    const db = this.load();
    let removed = 0;
    for (const upstream of db.upstreams) {
      const compatibility = upstream.compatibility;
      if (!compatibility) continue;
      removed += Object.keys(compatibility.facts || {}).length;
      delete upstream.compatibility;
    }
    if (removed) this.save(db);
    return removed;
  }

  compatibilityRecords({ now = Date.now(), fingerprints = {} } = {}) {
    const active = [];
    const stale = [];
    for (const upstream of this.load().upstreams) {
      for (const fact of Object.values(upstream.compatibility?.facts || {})) {
        if (!fact) continue;
        const expectedHash = fact.protocolScope === 'default'
          ? fingerprints[fact.protocolProfile]?.hash
          : null;
        const expired = Number.isFinite(Date.parse(fact.expiresAt)) && Date.parse(fact.expiresAt) <= now;
        const generationChanged = !sameCompatibilityGeneration(upstream, fact.generation);
        if (expired || generationChanged || expectedHash && fact.protocolFingerprintHash !== expectedHash) stale.push(structuredClone(fact));
        else active.push(structuredClone(fact));
      }
    }
    return { active, stale };
  }

  sessionUpstream(sessionId, scopeId = DEFAULT_SCOPE_ID, apiKeyId = null) {
    return this.sessionEntry(sessionId, scopeId, apiKeyId)?.upstreamId || null;
  }

  sessionRotationUpstream(sessionId, scopeId = DEFAULT_SCOPE_ID, apiKeyId = null) {
    return this.sessionEntry(sessionId, scopeId, apiKeyId)?.rotationUpstreamId || null;
  }

  sessionEntry(sessionId, scopeId, apiKeyId) {
    if (!sessionId || sessionId.length > SESSION_ID_MAX_LENGTH) return null;
    const entry = this.load().sessions[sessionKey(scopeId, apiKeyId, sessionId)];
    return entry && entry.scopeId === scopeId && (entry.apiKeyId ?? null) === apiKeyId && Date.now() - Date.parse(entry.lastUsedAt) <= SESSION_TTL_MS ? entry : null;
  }

  pinResponse(responseId, upstreamId, scopeId = DEFAULT_SCOPE_ID, apiKeyId = null) {
    if (!validResponseId(responseId) || !apiKeyId) return;
    const db = this.load();
    if (!scoped(db.upstreams, scopeId).some((upstream) => upstream.id === upstreamId)) throw notFound();
    const now = new Date().toISOString();
    for (const [key, entry] of Object.entries(db.responsePins)) {
      if (!entry || Date.now() - Date.parse(entry.lastUsedAt) > RESPONSE_PIN_TTL_MS) delete db.responsePins[key];
    }
    db.responsePins[responsePinKey(scopeId, apiKeyId, responseId)] = { upstreamId, scopeId, apiKeyId, lastUsedAt: now };
    const overflow = Object.entries(db.responsePins).sort(([, a], [, b]) => Date.parse(a.lastUsedAt || 0) - Date.parse(b.lastUsedAt || 0)).slice(0, Math.max(0, Object.keys(db.responsePins).length - RESPONSE_PIN_LIMIT));
    for (const [key] of overflow) delete db.responsePins[key];
    this.save(db);
  }

  responseUpstream(responseId, scopeId = DEFAULT_SCOPE_ID, apiKeyId = null) {
    if (!validResponseId(responseId) || !apiKeyId) return null;
    const db = this.load();
    const key = responsePinKey(scopeId, apiKeyId, responseId);
    const entry = db.responsePins[key];
    if (!entry || entry.scopeId !== scopeId || entry.apiKeyId !== apiKeyId || Date.now() - Date.parse(entry.lastUsedAt) > RESPONSE_PIN_TTL_MS) return null;
    if (!scoped(db.upstreams, scopeId).some((upstream) => upstream.id === entry.upstreamId)) return null;
    entry.lastUsedAt = new Date().toISOString();
    this.save(db);
    return entry.upstreamId;
  }

  pinSession(sessionId, upstreamId, scopeId = DEFAULT_SCOPE_ID, apiKeyId = null) {
    if (!sessionId) return;
    if (sessionId.length > SESSION_ID_MAX_LENGTH) throw Object.assign(new Error(`x-codex-session-id must be at most ${SESSION_ID_MAX_LENGTH} characters`), { statusCode: 400 });
    const db = this.load();
    if (!scoped(db.upstreams, scopeId).some((upstream) => upstream.id === upstreamId)) throw notFound();
    const now = new Date().toISOString();
    for (const [id, entry] of Object.entries(db.sessions)) {
      if (typeof entry !== 'string' && Date.now() - Date.parse(entry.lastUsedAt) > SESSION_TTL_MS) delete db.sessions[id];
    }
    const key = sessionKey(scopeId, apiKeyId, sessionId);
    const previous = db.sessions[key];
    db.sessions[key] = { upstreamId, scopeId, apiKeyId, lastUsedAt: now, spentCostMicros: previous?.upstreamId === upstreamId ? previous.spentCostMicros || 0 : 0 };
    const overflow = Object.entries(db.sessions).sort(([, a], [, b]) => Date.parse(a.lastUsedAt || 0) - Date.parse(b.lastUsedAt || 0)).slice(0, Math.max(0, Object.keys(db.sessions).length - SESSION_LIMIT));
    for (const [id] of overflow) delete db.sessions[id];
    this.save(db);
  }

  addSessionUsage(sessionId, upstreamId, settledCostMicros, scopeId = DEFAULT_SCOPE_ID, apiKeyId = null) {
    if (!sessionId || !Number.isSafeInteger(settledCostMicros) || settledCostMicros <= 0) return;
    const db = this.load();
    const key = sessionKey(scopeId, apiKeyId, sessionId);
    const entry = db.sessions[key];
    if (!entry || entry.upstreamId !== upstreamId) return;
    entry.spentCostMicros = (Number.isSafeInteger(entry.spentCostMicros) ? entry.spentCostMicros : 0) + settledCostMicros;
    entry.lastUsedAt = new Date().toISOString();
    if (entry.spentCostMicros >= SESSION_ROTATION_SPEND_MICROS) db.sessions[key] = { scopeId, apiKeyId, rotationUpstreamId: upstreamId, lastUsedAt: entry.lastUsedAt };
    this.save(db);
  }

  listFiles(scopeId = null) {
    return scoped(this.load().files, scopeId).map(publicFile);
  }

  getFile(id, scopeId = null) {
    const file = scoped(this.load().files, scopeId).find((item) => item.id === id) || null;
    return file && publicFile(file);
  }

  saveFile(file, scopeId = file.scopeId || DEFAULT_SCOPE_ID) {
    const db = this.load();
    if (!activeScope(db, scopeId, false) && !privateFileScope(scopeId)) throw new Error('scope not found');
    file = { ...file, scopeId };
    const index = db.files.findIndex((item) => item.id === file.id && item.scopeId === scopeId);
    if (index === -1) db.files.push(file);
    else db.files[index] = file;
    this.save(db);
    return publicFile(file);
  }

  bulkCaps(input) {
    const db = this.load();
    const upstreams = db.upstreams;
    if (input.target && input.capDollars === undefined && input.capCredits === undefined) throw new Error('capDollars or capCredits is required for a bulk target');
    const selected = selectBulkTargets(upstreams, input);
    const updated = [];
    const skipped = [];
    for (const item of selected) {
      if (!item.capDollars && item.capDollars !== 0 && input.capCredits === undefined) {
        skipped.push({ id: item.upstream.id, reason: 'missing_cap' });
        continue;
      }
      setSpendingCap(item.upstream, input.capCredits === undefined ? dollarsToCredits(item.capDollars) : number(input.capCredits, 'capCredits', { integer: true }));
      updated.push(publicUpstream(item.upstream));
    }
    if (updated.length) {
      this.save(db);
      this.notifyUpstreamsChange();
    }
    return { updated, skipped };
  }

  load() {
    if (this.db) return this.db;
    try {
      const db = emptyDatabase();
      for (const { collection, key, value } of this.sqlite.prepare('SELECT collection, key, value FROM records ORDER BY rowid').all()) {
        const target = db[collection];
        if (Array.isArray(target)) target.push(JSON.parse(value));
        else target[key] = JSON.parse(value);
      }
      const persisted = structuredClone(db);
      this.db = normalizeDatabase(db);
      this.persisted = persisted;
      this.save(this.db);
      return this.db;
    } catch (error) {
      throw new Error(`Could not read ${this.dbPath}: ${error.message}`);
    }
  }

  save(db) {
    this.db = db;
    const persisted = structuredClone(db);
    persisted.gatewayUsage = compactGatewayUsage(persisted.gatewayUsage);
    pruneGatewayHistory(persisted);
    const previous = databaseRecords(this.persisted || emptyDatabase());
    const next = databaseRecords(persisted);
    const upsert = this.sqlite.prepare('INSERT INTO records (collection, key, value) VALUES (?, ?, ?) ON CONFLICT (collection, key) DO UPDATE SET value = excluded.value');
    const remove = this.sqlite.prepare('DELETE FROM records WHERE collection = ? AND key = ?');
    this.sqlite.transaction(() => {
      for (const [id, value] of next) if (previous.get(id) !== value) {
        const [collection, key] = JSON.parse(id);
        upsert.run(collection, key, value);
      }
      for (const id of previous.keys()) if (!next.has(id)) {
        const [collection, key] = JSON.parse(id);
        remove.run(collection, key);
      }
    })();
    this.persisted = persisted;
  }

  saveCredentials(upstream) {
    upstream.credentials = encryptCredentials(upstream.credentials, this.key);
  }

  loadKey(databaseExists) {
    if (existsSync(this.keyPath)) {
      const key = readFileSync(this.keyPath);
      if (key.length !== 32) throw new Error('Stored credential key is invalid');
      return key;
    }
    if (databaseExists) throw new Error('Stored credential key is missing; restore .data/.key before starting');
    const key = randomBytes(32);
    writeFileSync(this.keyPath, key, { mode: 0o600 });
    chmodSync(this.keyPath, 0o600);
    return key;
  }
}

function emptyDatabase() {
  return { upstreams: [], files: [], sessions: {}, responsePins: {}, scopes: [], apiKeys: [], gatewayUsage: [], gatewayRequests: [], gatewayAttempts: [], routingPolicy: { strategy: 'least-recent-success' } };
}

function normalizeDatabase(parsed) {
  if (!parsed || !Array.isArray(parsed.upstreams)) throw new Error('invalid database');
  parsed.files ||= [];
  parsed.sessions ||= {};
  parsed.scopes ||= [{ id: DEFAULT_SCOPE_ID, status: 'active' }];
  parsed.apiKeys ||= [];
  parsed.gatewayUsage ||= [];
  parsed.gatewayRequests ||= [];
  parsed.gatewayAttempts ||= [];
  parsed.responsePins ||= {};
  parsed.routingPolicy = normalizeRoutingPolicy(parsed.routingPolicy);
  if (!Array.isArray(parsed.files) || !Array.isArray(parsed.scopes) || !Array.isArray(parsed.apiKeys) || !Array.isArray(parsed.gatewayUsage) || !Array.isArray(parsed.gatewayRequests) || !Array.isArray(parsed.gatewayAttempts)) throw new Error('invalid scoped database');
  parsed.gatewayUsage = compactGatewayUsage(parsed.gatewayUsage);
  for (const request of parsed.gatewayRequests) {
    request.responseStatusCode = safeStatusCode(request.responseStatusCode);
    request.lastErrorCode = safeDiagnosticCode(request.lastErrorCode);
    request.exclusionReasons = sanitizeExclusionReasons(request.exclusionReasons);
    if (request.status === 'failed' && request.completedAt) {
      delete request.scopeId;
      delete request.apiKeyId;
      delete request.model;
    }
  }
  for (const attempt of parsed.gatewayAttempts) {
    attempt.responseStatusCode = safeStatusCode(attempt.responseStatusCode);
    attempt.errorCode = safeDiagnosticCode(attempt.errorCode);
    attempt.timings = sanitizeAttemptTimings(attempt.timings);
    if (['failed', 'retryable_failed'].includes(attempt.status)) delete attempt.upstreamId;
  }
  pruneGatewayHistory(parsed);
  if (!parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions) || !parsed.responsePins || typeof parsed.responsePins !== 'object' || Array.isArray(parsed.responsePins)) throw new Error('invalid session database');
  if (!parsed.scopes.some((scope) => scope.id === DEFAULT_SCOPE_ID)) parsed.scopes.push({ id: DEFAULT_SCOPE_ID, status: 'active', models: [] });
  for (const scope of parsed.scopes) scope.models = normalizeModels(scope.models || []);
  for (const upstream of parsed.upstreams) {
    upstream.scopeId ||= DEFAULT_SCOPE_ID;
    upstream.credentialEpoch = Math.max(1, Number(upstream.credentialEpoch) || 1);
    upstream.compatibilityEpoch = Math.max(1, Number(upstream.compatibilityEpoch) || 1);
    upstream.modelCatalogEpoch = Math.max(1, Number(upstream.modelCatalogEpoch) || 1);
    upstream.routing = normalizeRouting(upstream.routing);
    upstream.pacing = normalizePacingPolicy(upstream.pacing);
    upstream.compatibility = normalizeCompatibilityState(upstream.compatibility);
    if (!Object.keys(upstream.compatibility.facts).length) delete upstream.compatibility;
    upstream.modelHealth = normalizeModelHealth(upstream.modelHealth);
    if (!Object.keys(upstream.modelHealth).length) delete upstream.modelHealth;
    upstream.baseUrl = upstream.type === 'claude'
      ? normalizeClaudeBaseUrl(upstream.baseUrl)
      : defaultBaseUrl(upstream.type);
    upstream.name = deriveUpstreamName(upstream.type, upstream);
  }
  for (const file of parsed.files) file.scopeId ||= DEFAULT_SCOPE_ID;
  return parsed;
}

function databaseRecords(db) {
  const records = new Map();
  const add = (collection, key, value) => records.set(JSON.stringify([collection, key]), JSON.stringify(value));
  for (const upstream of db.upstreams) add('upstreams', upstream.id, upstream);
  for (const file of db.files) add('files', JSON.stringify([file.scopeId, file.id]), file);
  for (const scope of db.scopes) add('scopes', scope.id, scope);
  for (const apiKey of db.apiKeys) add('apiKeys', apiKey.id, apiKey);
  for (const usage of db.gatewayUsage) add('gatewayUsage', JSON.stringify([usage.scopeId, usage.apiKeyId, usage.day]), usage);
  for (const request of db.gatewayRequests) add('gatewayRequests', request.id, request);
  for (const attempt of db.gatewayAttempts) add('gatewayAttempts', attempt.id, attempt);
  for (const [key, value] of Object.entries(db.sessions)) add('sessions', key, value);
  for (const [key, value] of Object.entries(db.responsePins)) add('responsePins', key, value);
  for (const [key, value] of Object.entries(normalizeRoutingPolicy(db.routingPolicy))) add('routingPolicy', key, value);
  return records;
}

function scoped(items, scopeId) {
  return scopeId ? items.filter((item) => item.scopeId === scopeId) : items;
}

function eligibilityFromUpstreams(upstreams, continuationId, now = Date.now()) {
  for (const upstream of upstreams) ensureSpending(upstream);
  const blocked = upstreams.filter((upstream) => ['failed', 'reauth_required'].includes(upstream.tokenRefresh?.status)
    || upstream.health?.status === 'reauth_required'
    || accountCooldownBlocks(upstream.health, now));
  const result = filterSpendCapEligible(upstreams.filter((upstream) => !blocked.includes(upstream)), { continuationId });
  return {
    ...result,
    exclusions: [...result.exclusions, ...blocked.map((upstream) => ({
      id: upstream.id,
      name: upstream.name,
      code: upstream.health?.status === 'reauth_required' ? 'upstream_reauth_required'
        : Number.isFinite(Date.parse(upstream.health?.nextEligibleAt)) && Date.parse(upstream.health.nextEligibleAt) > now ? 'upstream_cooldown'
          : `token_refresh_${upstream.tokenRefresh.status}`,
      nextEligibleAt: upstream.health?.nextEligibleAt || null
    }))]
  };
}

function accountCooldownBlocks(health, now) {
  const nextEligibleAt = Date.parse(health?.nextEligibleAt);
  if (!Number.isFinite(nextEligibleAt) || nextEligibleAt <= now) return false;
  if (health.cooldownSource !== 'reset-derived' || health.probeInFlight) return true;
  const lastProbeAt = Date.parse(health.lastProbeAt || health.cooldownStartedAt);
  return !Number.isFinite(lastProbeAt) || lastProbeAt + RESET_COOLDOWN_PROBE_INTERVAL_MS > now;
}

function pruneGatewayHistory(db, keepActive = false) {
  // ponytail: keep only 100 terminal failures; add a diagnostic query path if a longer window is needed.
  const requests = [
    ...(keepActive ? db.gatewayRequests.filter(({ completedAt }) => !completedAt) : []),
    ...db.gatewayRequests.filter((item) => item.status === 'failed' && item.completedAt).slice(-GATEWAY_ERROR_HISTORY_LIMIT)
  ];
  const requestIds = new Set(requests.map(({ id }) => id));
  db.gatewayRequests = requests;
  db.gatewayAttempts = db.gatewayAttempts.filter(({ requestId, status }) => requestIds.has(requestId) && (keepActive || !['in_progress', 'succeeded'].includes(status)));
}

function deleteGatewayRequest(db, requestId) {
  db.gatewayRequests = db.gatewayRequests.filter((item) => item.id !== requestId);
  db.gatewayAttempts = db.gatewayAttempts.filter((item) => item.requestId !== requestId);
}

function compactGatewayUsage(entries) {
  const earliestDay = new Date(Date.now() - GATEWAY_USAGE_DAYS * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const compacted = new Map();
  for (const item of entries || []) {
    const day = String(item.day || item.startedAt || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < earliestDay) continue;
    const key = `${item.scopeId || DEFAULT_SCOPE_ID}\u0000${item.apiKeyId || ''}\u0000${day}`;
    const entry = compacted.get(key) || { scopeId: item.scopeId || DEFAULT_SCOPE_ID, apiKeyId: item.apiKeyId || null, day, requestCount: 0, totalTokens: 0, cachedInputTokens: 0, totalCostMicros: 0, priced: false, attemptIds: [] };
    const usage = item.usage || item;
    entry.requestCount += Number.isSafeInteger(item.requestCount) ? item.requestCount : 1;
    entry.totalTokens += Number.isSafeInteger(item.totalTokens) ? item.totalTokens : usage?.totalTokens ?? (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
    entry.cachedInputTokens += Number.isSafeInteger(item.cachedInputTokens) ? item.cachedInputTokens : usage?.cachedInputTokens || 0;
    entry.totalCostMicros += Number.isSafeInteger(item.totalCostMicros) ? item.totalCostMicros : Number.isSafeInteger(item.settledCostMicros) ? item.settledCostMicros : 0;
    entry.priced ||= item.priced || Number.isSafeInteger(item.settledCostMicros);
    entry.attemptIds = [...new Set([...entry.attemptIds, ...(item.attemptIds || []), ...(item.attemptId ? [item.attemptId] : [])])].slice(-GATEWAY_USAGE_ATTEMPT_LIMIT);
    compacted.set(key, entry);
  }
  return [...compacted.values()];
}

function addGatewayUsage(db, { scopeId, apiKeyId, attemptId, startedAt, usage, settledCostMicros }) {
  db.gatewayUsage = compactGatewayUsage(db.gatewayUsage);
  const day = String(startedAt || new Date().toISOString()).slice(0, 10);
  const entry = db.gatewayUsage.find((item) => item.scopeId === scopeId && item.apiKeyId === apiKeyId && item.day === day)
    || (db.gatewayUsage[db.gatewayUsage.length] = { scopeId, apiKeyId, day, requestCount: 0, totalTokens: 0, cachedInputTokens: 0, totalCostMicros: 0, priced: false, attemptIds: [] });
  if (entry.attemptIds.includes(attemptId)) return false;
  entry.attemptIds = [...entry.attemptIds, attemptId].slice(-GATEWAY_USAGE_ATTEMPT_LIMIT);
  entry.requestCount += 1;
  entry.totalTokens += usage?.totalTokens ?? (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
  entry.cachedInputTokens += usage?.cachedInputTokens || 0;
  if (Number.isSafeInteger(settledCostMicros)) {
    entry.totalCostMicros += settledCostMicros;
    entry.priced = true;
  }
  return true;
}

function findGatewayRequest(db, requestId) {
  const request = db.gatewayRequests.find((item) => item.id === requestId);
  if (!request) throw new Error('request not found');
  return request;
}

function findGatewayAttempt(db, requestId, attemptId) {
  const attempt = db.gatewayAttempts.find((item) => item.id === attemptId && item.requestId === requestId);
  if (!attempt) throw new Error('attempt not found');
  return attempt;
}

function safeStatusCode(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function safeDiagnosticCode(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,79}$/.test(value) ? value : null;
}

function safeEndpoint(value) {
  return typeof value === 'string' && /^\/[A-Za-z0-9_./:-]{0,159}$/.test(value) ? value : '';
}

function safeTransport(value) {
  return typeof value === 'string' && /^[a-z0-9_]{1,40}$/.test(value) ? value : '';
}

function safeTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function diagnosticAttemptTimings(attempt) {
  const timings = sanitizeAttemptTimings(attempt?.timings);
  if (Object.keys(timings).length) return timings;
  const startedAt = Date.parse(attempt?.startedAt);
  const completedAt = Date.parse(attempt?.completedAt);
  return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
    ? { terminalCompletionMs: Math.min(86_400_000, Math.round(completedAt - startedAt)) }
    : {};
}

function dbUpstreamLimits(upstreams, scopeId) {
  return scoped(upstreams, scopeId).flatMap(({ quota }) => {
    if (!quota || typeof quota !== 'object') return [];
    const limit = Number(quota.limitUnits);
    const remaining = Number(quota.remainingUnits);
    const knownLimit = Number.isFinite(limit);
    const knownRemaining = Number.isFinite(remaining);
    return [{
      limit_type: knownLimit ? 'credits' : 'percent',
      limit_window: quota.windowSeconds && quota.windowSeconds >= MONTH_SECONDS ? '30d' : quota.windowSeconds ? `${Math.round(quota.windowSeconds / 3600)}h` : 'unknown',
      max_value: knownLimit ? limit : null,
      current_value: knownLimit && knownRemaining ? Math.max(0, limit - remaining) : null,
      remaining_value: knownRemaining ? remaining : Number.isFinite(Number(quota.remainingPercent)) ? Number(quota.remainingPercent) : null,
      model_filter: null,
      source: 'upstream_usage'
    }];
  });
}

function normalizeModels(models) {
  if (!Array.isArray(models) || models.some((model) => typeof model !== 'string' || !model.trim())) throw new Error('models must be an array of model IDs');
  return [...new Set(models.map((model) => model.trim().toLowerCase()))];
}

function normalizeRouting(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('routing must be an object');
  const boolean = (name, fallback = true) => value[name] === undefined ? fallback : Boolean(value[name]);
  const serviceTiers = value.serviceTiers === undefined ? [] : normalizeModels(value.serviceTiers);
  return { models: normalizeModels(value.models || []), responses: boolean('responses'), streaming: boolean('streaming'), tools: boolean('tools'), imageInput: boolean('imageInput'), reasoning: boolean('reasoning'), serviceTiers };
}

function normalizeRoutingPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('routing policy must be an object');
  return { strategy: normalizeRoutingStrategy(value.strategy) };
}

function normalizeRoutingStrategy(value) {
  const strategy = value === undefined || value === null ? 'least-recent-success' : value;
  if (!ROUTING_STRATEGIES.has(strategy)) throw new Error(`strategy must be one of ${[...ROUTING_STRATEGIES].join(', ')}`);
  return strategy;
}

function priorityTier(upstream) {
  return Number.isInteger(upstream.priority) ? upstream.priority : Infinity;
}

function leastRecentRank(upstream) {
  return Date.parse(upstream.lastSuccessfulAt) || 0;
}

function orderRoutingCandidates(upstreams, strategy, now) {
  const stableOrder = new Map(upstreams.map((upstream, index) => [upstream.id, index]));
  const tieBreak = (left, right) => leastRecentRank(left) - leastRecentRank(right)
    || stableOrder.get(left.id) - stableOrder.get(right.id);
  if (strategy === 'least-recent-success') {
    return [...upstreams].sort((left, right) => priorityTier(left) - priorityTier(right) || tieBreak(left, right));
  }
  const medians = new Map();
  for (const tier of new Set(upstreams.map(priorityTier))) {
    const known = upstreams
      .filter((upstream) => priorityTier(upstream) === tier)
      .map((upstream) => quotaOrderingMetadata(upstream, now))
      .filter(({ status }) => status === 'known')
      .map(({ remainingPercent }) => remainingPercent)
      .sort((left, right) => left - right);
    const middle = Math.floor(known.length / 2);
    medians.set(tier, !known.length ? 50 : known.length % 2 ? known[middle] : (known[middle - 1] + known[middle]) / 2);
  }
  const score = (upstream) => {
    const quota = quotaOrderingMetadata(upstream, now);
    return quota.status === 'known' ? quota.remainingPercent : medians.get(priorityTier(upstream));
  };
  return [...upstreams].sort((left, right) => (
    priorityTier(left) - priorityTier(right)
    || score(right) - score(left)
    || tieBreak(left, right)
  ));
}

function quotaOrderingMetadata(upstream, now) {
  const raw = Number(upstream.quota?.remainingPercent);
  if (!Number.isFinite(raw)) return { status: 'unknown', remainingPercent: null, observedAt: null };
  const observedAt = Date.parse(upstream.quota?.observedAt);
  const remainingPercent = Math.max(0, Math.min(100, raw));
  if (!Number.isFinite(observedAt) || observedAt + ROUTING_QUOTA_FRESHNESS_MS <= now) {
    return { status: 'stale', remainingPercent, observedAt: upstream.quota?.observedAt || null };
  }
  return { status: 'known', remainingPercent, observedAt: upstream.quota.observedAt };
}

function filterRoutingCandidates(candidates, predicate, exclude, code) {
  const kept = [];
  for (const upstream of candidates) {
    if (predicate(upstream)) kept.push(upstream);
    else exclude(upstream, code);
  }
  return kept;
}

function candidateExclusionCode(upstream, model, requirements, { ignoreModelRestrictions, modelSupport, routeClass, now, claudeConfig = null }) {
  if (upstream.type === 'claude' && !ignoreModelRestrictions && claudeModelPrefixMismatch(upstream, model)) return 'upstream_model_prefix_mismatch';
  if (!claudeCoolingDisabled(upstream, claudeConfig) && modelCooldownBlocks(upstream, model, now)) return 'upstream_model_cooldown';
  if (!candidateEligible(upstream, model, requirements, { ignoreModelRestrictions, claudeConfig })) {
    const routing = normalizeRouting(upstream.routing);
    const modelNotAllowed = routing.models.length && !(upstream.type === 'claude'
      ? configuredClaudeModelMatches(routing.models, model, upstream, claudeConfig)
      : routing.models.includes(String(model || '').toLowerCase()));
    if (!ignoreModelRestrictions && (modelNotAllowed || claudeMetadataModelExcluded(upstream, model, claudeConfig))) return 'upstream_model_not_allowed';
    if (!isAiswitchUpstream(upstream) && Number.isFinite(Number(upstream.quota?.remainingPercent)) && Number(upstream.quota.remainingPercent) <= 0) return 'quota_exhausted';
    return 'capability_not_supported';
  }
  if (!dynamicallySupportsModel(upstream, model, modelSupport)) return 'model_not_supported';
  if (!circuitEligible(upstream, { model, routeClass }, now)) return 'circuit_open';
  return null;
}

function claudeModelPrefixMismatch(upstream, model) {
  const requested = typeof model === 'string' ? model.trim() : '';
  const separator = requested.indexOf('/');
  if (separator <= 0) return false;
  const requestedPrefix = requested.slice(0, separator);
  return claudeMetadataModelPrefix(upstream) !== requestedPrefix;
}

function routingDiagnostic(upstream, now, extra = {}) {
  const quota = quotaOrderingMetadata(upstream, now);
  return {
    id: upstream.id,
    name: upstream.name,
    type: upstream.type,
    priority: Number.isInteger(upstream.priority) ? upstream.priority : null,
    priorityTier: Number.isInteger(upstream.priority) ? upstream.priority : 'unlisted',
    lastSuccessfulAt: upstream.lastSuccessfulAt || null,
    quota,
    ...extra
  };
}

function routingPlanResult(upstreams, strategy, exclusions, now) {
  return {
    candidates: upstreams.map(publicUpstream),
    diagnostics: {
      strategy,
      candidates: upstreams.map((upstream, index) => ({
        ...routingDiagnostic(upstream, now),
        order: index + 1,
        reason: strategy === 'most-remaining-quota' && quotaOrderingMetadata(upstream, now).status !== 'known'
          ? 'quota_unknown_fairness'
          : strategy
      })),
      exclusions: [...exclusions.values()].sort((left, right) => left.id.localeCompare(right.id))
    }
  };
}

function candidateEligible(upstream, model, requirements, { ignoreModelRestrictions = false, claudeConfig = null } = {}) {
  if (!upstream) return false;
  const routing = normalizeRouting(upstream.routing);
  if (!ignoreModelRestrictions && routing.models.length && !(upstream.type === 'claude' ? configuredClaudeModelMatches(routing.models, model, upstream, claudeConfig) : routing.models.includes(String(model || '').toLowerCase()))) return false;
  if (!ignoreModelRestrictions && claudeMetadataModelExcluded(upstream, model, claudeConfig)) return false;
  if (!isAiswitchUpstream(upstream) && Number.isFinite(Number(upstream.quota?.remainingPercent)) && Number(upstream.quota.remainingPercent) <= 0) return false;
  if (requirements.responses && !routing.responses || requirements.streaming && !routing.streaming || requirements.tools && !routing.tools || requirements.imageInput && !routing.imageInput || requirements.reasoning && !routing.reasoning) return false;
  return !requirements.serviceTier || !routing.serviceTiers.length || routing.serviceTiers.includes(requirements.serviceTier);
}

function configuredClaudeModelMatches(models, model, upstream = null, claudeConfig = null) {
  const variants = new Set(claudeModelNameVariants(model));
  for (const alias of claudeRoutingAliases(upstream, claudeConfig)) {
    if (claudeModelNameVariants(alias.alias).some((variant) => variants.has(variant))) {
      for (const variant of claudeModelNameVariants(alias.name)) variants.add(variant);
    }
  }
  return models.some((candidate) => claudeModelNameVariants(candidate).some((variant) => variants.has(variant)));
}

function claudeRoutingAliases(upstream, claudeConfig) {
  const values = [];
  const add = (raw) => {
    let entries = raw;
    if (typeof entries === 'string') {
      try { entries = JSON.parse(entries); } catch { entries = []; }
    }
    if (!Array.isArray(entries)) return;
    for (const entry of entries.slice(0, 128)) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      const alias = typeof entry?.alias === 'string' ? entry.alias.trim() : '';
      if (name && alias) values.push({ name, alias });
    }
  };
  add(upstream?.metadata?.model_aliases ?? upstream?.metadata?.['model-aliases']);
  add(upstream?.metadata?.models ?? upstream?.metadata?.['model-configs'] ?? upstream?.metadata?.model_configs);
  if (isClaudeOAuthUpstream(upstream)) {
    const global = claudeConfig?.oauthModelAlias ?? claudeConfig?.['oauth-model-alias'];
    if (global && typeof global === 'object' && !Array.isArray(global)) add(global.claude ?? global.anthropic);
  }
  return values;
}

function dynamicallySupportsModel(upstream, model, modelSupport) {
  if (upstream?.type !== 'codex' || !model || typeof modelSupport !== 'function') return true;
  return modelSupport(
    upstream.id,
    String(model).toLowerCase(),
    Math.max(1, Number(upstream.modelCatalogEpoch) || 1)
  ) !== false;
}

function activeScope(db, scopeId, required = true) {
  const scope = db.scopes.find((item) => item.id === scopeId) || null;
  if (!scope && required) throw new Error('scope not found');
  return scope;
}

function privateFileScope(scopeId) {
  return typeof scopeId === 'string' && /^share-session:[A-Za-z0-9-]{1,128}$/.test(scopeId);
}

function sessionKey(scopeId, apiKeyId, sessionId) {
  return `${scopeId}:${apiKeyId || ''}:${sessionId}`;
}

function responsePinKey(scopeId, apiKeyId, responseId) {
  return createHash('sha256').update(`${scopeId}\u0000${apiKeyId}\u0000${responseId}`).digest('base64url');
}

function validResponseId(value) {
  return typeof value === 'string' && /^resp_[A-Za-z0-9_-]{1,250}$/.test(value) && Buffer.byteLength(value) <= 255;
}

function apiKeyHash(key) {
  return createHash('sha256').update(key.trim()).digest('hex');
}

function constantHashEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicScope({ id, status, models }) {
  return { id, status, models };
}

function publicApiKey({ id, scopeId, status, createdAt }) {
  return { id, scopeId, status, createdAt };
}

function publicFile({ scopeId: _scopeId, ...file }) {
  return file;
}

function circuitKey({ model = '', routeClass = 'proxy_http' } = {}) {
  return `${routeClass}:${createHash('sha256').update(String(model).trim().toLowerCase()).digest('hex')}`;
}

function circuitEligible(upstream, scope, now) {
  const state = upstream?.circuits?.[circuitKey(scope)];
  if (!state || state.status === 'closed') return true;
  if (state.status === 'open') return Number.isFinite(Date.parse(state.nextProbeAt)) && Date.parse(state.nextProbeAt) <= now;
  if (state.status === 'half_open') {
    const updatedAt = Date.parse(state.updatedAt);
    return !state.probeInFlight || !Number.isFinite(updatedAt) || updatedAt + CIRCUIT_COOLDOWN_MS <= now;
  }
  return false;
}

function beginCircuitLease(upstream, scope, now) {
  const circuits = upstream.circuits ||= {};
  const key = circuitKey(scope);
  const state = circuits[key] || {};
  const generation = Math.max(0, Number(state.generation) || 0);
  if (!state.status || state.status === 'closed') return { generation };
  if (state.status === 'open') {
    if (!Number.isFinite(Date.parse(state.nextProbeAt)) || Date.parse(state.nextProbeAt) > now) return null;
    circuits[key] = { ...state, status: 'half_open', probeInFlight: 1, generation, updatedAt: new Date(now).toISOString() };
    return { generation };
  }
  if (state.status === 'half_open') {
    const stale = !Number.isFinite(Date.parse(state.updatedAt)) || Date.parse(state.updatedAt) + CIRCUIT_COOLDOWN_MS <= now;
    if (state.probeInFlight && !stale) return null;
    circuits[key] = { ...state, probeInFlight: 1, generation, updatedAt: new Date(now).toISOString() };
    return { generation };
  }
  return { generation };
}

function recordCircuitLeaseFailure(upstream, admission, now, failureClass) {
  const circuits = upstream.circuits ||= {};
  const key = circuitKey(admission.scope);
  const prior = circuits[key] || {};
  if (Math.max(0, Number(prior.generation) || 0) !== admission.circuitGeneration) return;
  const failures = Math.max(0, Number(prior.failures) || 0) + 1;
  const open = failures >= CIRCUIT_FAILURE_THRESHOLD;
  circuits[key] = {
    status: open ? 'open' : 'closed',
    failures,
    failureClass,
    generation: admission.circuitGeneration + (open ? 1 : 0),
    probeInFlight: 0,
    updatedAt: new Date(now).toISOString(),
    ...(open ? { nextProbeAt: new Date(now + CIRCUIT_COOLDOWN_MS).toISOString() } : {})
  };
  pruneCircuits(circuits);
}

function completeCircuitLease(upstream, admission, now) {
  const circuits = upstream.circuits ||= {};
  const key = circuitKey(admission.scope);
  const state = circuits[key];
  if (!state) return;
  if (Math.max(0, Number(state.generation) || 0) !== admission.circuitGeneration) return;
  delete circuits[key];
}

function releaseCircuitLease(upstream, admission, now) {
  const circuits = upstream.circuits ||= {};
  const key = circuitKey(admission.scope);
  const state = circuits[key];
  if (!state || Math.max(0, Number(state.generation) || 0) !== admission.circuitGeneration) return;
  if (state.status === 'half_open') circuits[key] = { ...state, probeInFlight: 0, updatedAt: new Date(now).toISOString() };
}

function clearSessionPinsForUpstream(db, upstreamId) {
  for (const [key, entry] of Object.entries(db.sessions)) {
    if (entry === upstreamId || entry?.upstreamId === upstreamId || entry?.rotationUpstreamId === upstreamId) delete db.sessions[key];
  }
}

function clearHealthAfterCredentialReplacement(upstream) {
  const generation = Math.max(0, Number(upstream.health?.generation ?? upstream.healthGeneration) || 0);
  delete upstream.health;
  delete upstream.modelHealth;
  upstream.healthGeneration = generation + 1;
}

function normalizeModelKey(value) {
  const model = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return model && model.length <= 256 ? model : '';
}

function normalizeModelHealth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [rawModel, state] of Object.entries(value).slice(0, 256)) {
    const model = normalizeModelKey(rawModel);
    if (!model || !state || typeof state !== 'object' || Array.isArray(state)) continue;
    const nextEligibleAt = Date.parse(state.nextEligibleAt);
    if (state.status !== 'cooldown' || !Number.isFinite(nextEligibleAt)) continue;
    normalized[model] = {
      status: 'cooldown',
      failureClass: 'quota',
      cooldownSource: typeof state.cooldownSource === 'string' ? state.cooldownSource.slice(0, 32) : 'default',
      cooldownStartedAt: typeof state.cooldownStartedAt === 'string' ? state.cooldownStartedAt : null,
      nextEligibleAt: new Date(nextEligibleAt).toISOString()
    };
  }
  return normalized;
}

function modelCooldownBlocks(upstream, model, now) {
  if (upstream?.type !== 'claude') return false;
  return claudeModelHealthKeys(upstream, model).some((key) => {
    const nextEligibleAt = Date.parse(upstream.modelHealth?.[key]?.nextEligibleAt);
    return Number.isFinite(nextEligibleAt) && nextEligibleAt > now;
  });
}

function setModelCooldown(upstream, model, cooldown, now) {
  upstream.modelHealth ||= {};
  for (const key of claudeModelHealthKeys(upstream, model)) upstream.modelHealth[key] = {
      status: 'cooldown',
      failureClass: 'quota',
      cooldownSource: cooldown.cooldownSource,
      cooldownStartedAt: new Date(now).toISOString(),
      nextEligibleAt: new Date(cooldown.nextEligibleAt).toISOString()
    };
}

function deleteModelCooldown(upstream, model) {
  for (const key of claudeModelHealthKeys(upstream, model)) delete upstream.modelHealth?.[key];
  if (upstream.modelHealth && !Object.keys(upstream.modelHealth).length) delete upstream.modelHealth;
}

function claudeModelHealthKeys(upstream, model) {
  const key = normalizeModelKey(model);
  if (upstream?.type !== 'claude' || !key) return [];
  const keys = new Set([key, ...claudeModelNameVariants(key)]);
  const prefix = claudeMetadataModelPrefix(upstream);
  for (const variant of [...keys]) {
    if (prefix && variant.startsWith(`${prefix.toLowerCase()}/`)) keys.add(variant.slice(prefix.length + 1));
  }
  let aliases = upstream.metadata?.model_aliases ?? upstream.metadata?.['model-aliases'];
  if (typeof aliases === 'string') {
    try { aliases = JSON.parse(aliases); } catch { aliases = []; }
  }
  if (Array.isArray(aliases)) {
    for (const alias of aliases.slice(0, 128)) {
      const aliasKey = normalizeModelKey(alias?.alias);
      const nameKey = normalizeModelKey(alias?.name);
      if ([...keys].some((candidate) => claudeModelNameVariants(candidate).includes(aliasKey) || claudeModelNameVariants(candidate).includes(nameKey))) {
        for (const value of [aliasKey, nameKey]) {
          if (!value) continue;
          for (const variant of claudeModelNameVariants(value)) keys.add(variant);
        }
      }
    }
  }
  return [...keys];
}

function normalizeCompatibilityState(value) {
  const result = { facts: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, fact] of Object.entries(value.facts || {})) {
    if (typeof key !== 'string' || !key || key.length > 160) continue;
    const normalized = normalizeCompatibilityFactRecord(fact, key);
    if (normalized) result.facts[key] = normalized;
  }
  pruneCompatibility(result);
  return result;
}

function normalizeCompatibilityFactRecord(record, key) {
  if (!record || record.schemaVersion !== COMPATIBILITY_FACT_SCHEMA_VERSION || !safeCompatibilityValue(record.value)) return null;
  if (typeof key !== 'string' || !key || key.length > 160) return null;
  if (!COMPATIBILITY_FACT_ID_PATTERN.test(String(record.id || ''))) return null;
  if (!['codex', 'compass'].includes(record.providerType)) return null;
  if (!['responses', 'responses_compact', 'chat_completions', 'messages'].includes(record.routeClass)) return null;
  if (!['default', 'client'].includes(record.protocolScope)) return null;
  if (!['codex', 'codexWebsocket', 'compass'].includes(record.protocolProfile)) return null;
  if (!/^[a-f0-9]{24}$/.test(record.capabilityHash || '')) return null;
  if (!/^[a-f0-9]{32}$/.test(record.protocolFingerprintHash || '')) return null;
  if (!Number.isInteger(record.protocolFingerprintVersion) || record.protocolFingerprintVersion < 1) return null;
  if (record.status !== 'active') return null;
  if (!validCompatibilityFeature(record.providerType, record.feature, record.value, record.routeClass)) return null;
  const createdAt = Date.parse(record.createdAt);
  const lastValidatedAt = Date.parse(record.lastValidatedAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (![createdAt, lastValidatedAt, expiresAt].every(Number.isFinite) || expiresAt <= createdAt) return null;
  const evidenceCount = Number(record.evidenceCount);
  const generation = record.generation;
  if (!Number.isInteger(evidenceCount) || evidenceCount < 1) return null;
  if (!generation || !Number.isInteger(generation.compatibilityEpoch) || generation.compatibilityEpoch < 1
    || !Number.isInteger(generation.modelCatalogEpoch) || generation.modelCatalogEpoch < 1) return null;
  return {
    id: record.id,
    key,
    schemaVersion: COMPATIBILITY_FACT_SCHEMA_VERSION,
    status: record.status,
    protocolFingerprintVersion: record.protocolFingerprintVersion,
    protocolFingerprintHash: record.protocolFingerprintHash,
    providerType: record.providerType,
    routeClass: record.routeClass,
    capabilityHash: record.capabilityHash,
    protocolScope: record.protocolScope,
    protocolProfile: record.protocolProfile,
    feature: record.feature,
    evidenceCount,
    createdAt: new Date(createdAt).toISOString(),
    lastValidatedAt: new Date(lastValidatedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    generation: {
      compatibilityEpoch: generation.compatibilityEpoch,
      modelCatalogEpoch: generation.modelCatalogEpoch
    },
    value: structuredClone(record.value)
  };
}

function compatibilityFactId(upstreamId, key) {
  return `cf_${createHash('sha256').update(`${upstreamId}\u0000${key}`).digest('base64url').slice(0, 32)}`;
}

function sameCompatibilityGeneration(upstream, generation) {
  return Math.max(1, Number(upstream.compatibilityEpoch) || 1) === generation.compatibilityEpoch
    && Math.max(1, Number(upstream.modelCatalogEpoch) || 1) === generation.modelCatalogEpoch;
}

function sameAuthentication(type, left, right) {
  const fields = type === 'codex' ? ['accessToken', 'refreshToken', 'idToken'] : type === 'claude' ? ['accessToken', 'refreshToken', 'idToken', 'projectKey'] : ['projectKey'];
  return fields.every((field) => String(left?.[field] || '') === String(right?.[field] || ''));
}

function pruneCompatibility(compatibility) {
  const facts = compatibility.facts ||= {};
  const overflow = Object.entries(facts)
    .sort(([, left], [, right]) => Date.parse(right.lastValidatedAt || 0) - Date.parse(left.lastValidatedAt || 0))
    .slice(COMPATIBILITY_FACT_LIMIT);
  for (const [key] of overflow) delete facts[key];
}

function pruneCircuits(circuits) {
  // ponytail: bound untrusted model-derived lanes; increase only if a real catalog exceeds 100 active failures.
  const entries = Object.entries(circuits);
  if (entries.length <= CIRCUIT_LIMIT) return;
  entries.sort(([, left], [, right]) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
  for (const [key] of entries.slice(0, entries.length - CIRCUIT_LIMIT)) delete circuits[key];
}

function capCreditsFromInput(input = {}) {
  if (input.capDollars !== undefined) return dollarsToCredits(input.capDollars);
  return number(input.capCredits, 'capCredits', { integer: true });
}

function selectBulkTargets(upstreams, input = {}) {
  const target = input.target;
  const eligible = (upstream) => !isAiswitchUpstream(upstream);
  if (target) {
    if (!['all', 'cap_reached', 'uncapped'].includes(target)) throw new Error('target must be all, cap_reached, or uncapped');
    return upstreams
      .filter((upstream) => eligible(upstream) && (target === 'all' || (target === 'uncapped' && spendingSummary(upstream.spending).capCredits <= 0) || (target === 'cap_reached' && spendingSummary(upstream.spending).status === 'reached')))
      .map((upstream) => ({ upstream, capDollars: input.capDollars }));
  }

  if (!Array.isArray(input.rules) || input.rules.length === 0) throw new Error('rules must contain at least one quota rule');
  const rules = input.rules.map((rule) => ({
    minQuotaLeft: number(rule.minQuotaLeft, 'minQuotaLeft'),
    capDollars: number(rule.capDollars, 'capDollars')
  }));
  return upstreams.flatMap((upstream) => {
    if (!eligible(upstream)) return [];
    const quotaLeft = Number(upstream.quota?.remainingDollars ?? upstream.quota?.remainingUnits);
    if (!Number.isFinite(quotaLeft)) return [];
    const matching = rules.filter((rule) => quotaLeft > rule.minQuotaLeft).sort((a, b) => b.minQuotaLeft - a.minQuotaLeft)[0];
    return matching ? [{ upstream, capDollars: matching.capDollars }] : [];
  });
}

export function notFound() {
  return Object.assign(new Error('Upstream not found'), { statusCode: 404 });
}

function findOrThrow(db, id) {
  const upstream = db.upstreams.find((item) => item.id === id);
  if (!upstream) throw notFound();
  return upstream;
}

function encryptCredentials(credentials, key) {
  return Object.fromEntries(Object.entries(credentials || {}).filter(([, value]) => value).map(([name, value]) => [name, encrypt(value, key)]));
}

function decryptCredentials(credentials, key) {
  return Object.fromEntries(Object.entries(credentials || {}).filter(([, value]) => value).map(([name, value]) => [name, decrypt(value, key)]));
}

function normalizeEncryptionKey(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error('Store encryption key must be exactly 32 bytes');
  const key = Buffer.from(value);
  if (key.length !== 32) throw new Error('Store encryption key must be exactly 32 bytes');
  return key;
}

function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decrypt(value, key) {
  try {
    const [version, ivText, tagText, dataText] = String(value).split(':');
    if (version !== 'v1') throw new Error('unsupported secret version');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt stored credentials; restore the original .data/.key pair');
  }
}
