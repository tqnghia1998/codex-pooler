import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  createUpstream,
  defaultBaseUrl,
  deriveUpstreamName,
  dollarsToCredits,
  ensureSpending,
  filterSpendCapEligible,
  isAiswitchUpstream,
  number,
  publicUpstream,
  recordUsage,
  setSpendingCap,
  spendingSummary,
  updateUpstream
} from './domain.js';
import { codexRefreshFailureCode } from './providers.js';

const SESSION_LIMIT = 1_000;
const SESSION_ID_MAX_LENGTH = 200;
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const RESPONSE_PIN_LIMIT = 1_000;
const RESPONSE_PIN_TTL_MS = 24 * 60 * 60 * 1_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;
const CIRCUIT_LIMIT = 100;
const MONTH_SECONDS = 27 * 24 * 60 * 60;
const GATEWAY_ERROR_HISTORY_LIMIT = 100;
const GATEWAY_USAGE_DAYS = 90;
const GATEWAY_USAGE_ATTEMPT_LIMIT = 100;
export const DEFAULT_SCOPE_ID = 'default';

export class Store {
  constructor(dataDir = process.env.CODEX_POOLER_NODE_DATA_DIR || resolve(process.cwd(), '.data')) {
    this.dataDir = resolve(dataDir);
    this.dbPath = join(this.dataDir, 'db.sqlite');
    this.legacyDbPath = join(this.dataDir, 'db.json');
    this.keyPath = join(this.dataDir, '.key');
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(this.dataDir, 0o700);
    this.key = this.loadKey(existsSync(this.dbPath) || existsSync(this.legacyDbPath));
    this.sqlite = new Database(this.dbPath);
    chmodSync(this.dbPath, 0o600);
    this.sqlite.pragma('journal_mode = DELETE');
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection, key))');
    this.events = new EventEmitter();
    if (this.sqlite.prepare('SELECT COUNT(*) AS count FROM records').get().count || !existsSync(this.legacyDbPath)) this.db = this.load();
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
    const db = this.load();
    let changed = false;
    for (const upstream of db.upstreams) {
      const before = JSON.stringify(upstream.spending);
      ensureSpending(upstream);
      changed ||= before !== JSON.stringify(upstream.spending);
    }
    if (changed) this.save(db);
    return scoped(db.upstreams, scopeId).map(publicUpstream);
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

  create(input, { scopeId = input?.scopeId || DEFAULT_SCOPE_ID } = {}) {
    const upstream = createUpstream(input);
    const db = this.load();
    activeScope(db, scopeId);

    const isDuplicate = db.upstreams.some((item) => (item.scopeId || DEFAULT_SCOPE_ID) === scopeId && item.type === upstream.type && (upstream.type === 'codex'
      ? (upstream.accountId && item.accountId === upstream.accountId) || (upstream.email && item.email === upstream.email)
      : item.projectId === upstream.projectId));
    if (isDuplicate) throw new Error(`${upstream.type} upstream already exists`);

    upstream.scopeId = scopeId;
    upstream.routing = normalizeRouting(input.routing);
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
    if (upstream.type === 'codex' && (input.authJson || input.accessToken)) {
      upstream.credentialEpoch = (Number(upstream.credentialEpoch) || 0) + 1;
      delete upstream.tokenRefresh;
    }
    if (input.routing !== undefined) upstream.routing = normalizeRouting(input.routing);
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

  remove(id) {
    const db = this.load();
    const index = db.upstreams.findIndex((upstream) => upstream.id === id);
    if (index === -1) throw notFound();
    db.upstreams.splice(index, 1);
    for (const [sessionId, entry] of Object.entries(db.sessions)) {
      if (entry === id || entry?.upstreamId === id) delete db.sessions[sessionId];
    }
    this.save(db);
    this.notifyUpstreamsChange();
  }

  credentials(id) {
    const upstream = this.get(id);
    if (!upstream) throw notFound();
    const credentials = decryptCredentials(upstream.credentials, this.key);
    if (upstream.type === 'codex') {
      Object.defineProperties(credentials, {
        credentialEpoch: { value: Number(upstream.credentialEpoch) || 0, enumerable: false },
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
    const status = codexRefreshFailureCode(error);
    upstream.tokenRefresh = { status, finishedAt: new Date().toISOString(), trigger: 'runtime', errorCode: status };
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

  setQuota(id, quota) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    ensureSpending(upstream);
    upstream.quota = quota;
    upstream.quotaSource = quota?.source || null;
    upstream.updatedAt = new Date().toISOString();
    this.save(db);
    this.notifyUpstreamsChange();
    return publicUpstream(upstream);
  }

  persistCredentials(id, credentials, accessTokenExpiresAt = null) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    const expectedEpoch = credentials?.credentialEpoch;
    if (expectedEpoch !== undefined && expectedEpoch !== (Number(upstream.credentialEpoch) || 0)) return false;
    upstream.credentials = encryptCredentials(credentials, this.key);
    if (accessTokenExpiresAt !== upstream.accessTokenExpiresAt) delete upstream.tokenRefresh;
    upstream.accessTokenExpiresAt = accessTokenExpiresAt;
    upstream.credentialEpoch = (Number(upstream.credentialEpoch) || 0) + 1;
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
    return { ...attempt };
  }

  retryGatewayAttempt(requestId, attemptId, { responseStatusCode = null, errorCode = null, completedAt = new Date().toISOString() } = {}) {
    const db = this.load();
    const request = findGatewayRequest(db, requestId);
    const attempt = findGatewayAttempt(db, requestId, attemptId);
    if (request.completedAt || attempt.status !== 'in_progress') throw new Error('attempt is already finalized');
    Object.assign(attempt, { status: 'retryable_failed', retryable: true, responseStatusCode, errorCode, completedAt });
    request.status = 'in_progress';
    request.retryCount += 1;
    return { ...attempt };
  }

  finalizeGatewayRequest({ requestId, attemptId = null, status, responseStatusCode = null, errorCode = null, usage = null, settledCostMicros = null, costSource = null, completedAt = new Date().toISOString() } = {}) {
    if (!['succeeded', 'failed'].includes(status)) throw new Error('request status must be succeeded or failed');
    const db = this.load();
    const request = findGatewayRequest(db, requestId);
    if (request.completedAt) throw new Error('request is already finalized');
    const attempt = attemptId ? findGatewayAttempt(db, requestId, attemptId) : null;
    if (attempt && attempt.status !== 'in_progress') throw new Error('attempt is already finalized');
    if (status === 'succeeded' && !attempt) throw new Error('successful request requires an attempt');
    if (attempt) Object.assign(attempt, { status: status === 'succeeded' ? 'succeeded' : 'failed', retryable: false, responseStatusCode, errorCode, completedAt });
    Object.assign(request, {
      status, usageStatus: usage ? 'usage_known' : status === 'succeeded' ? 'usage_unknown' : 'not_applicable',
      responseStatusCode, lastErrorCode: errorCode, completedAt
    });
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
    const result = eligibilityFromUpstreams(scoped(this.load().upstreams, scopeId), continuationId);
    return { ...result, eligible: result.eligible.map(publicUpstream), reserved: result.reserved.map(publicUpstream) };
  }

  candidatePlan({ pinnedId = null, requestedId = '', requestedType = '', preferredType = '', requiredType = '', model = '', requirements = {}, routeClass = 'proxy_http', now = Date.now(), scopeId = null } = {}) {
    const db = this.load();
    const scope = scopeId ? activeScope(db, scopeId, false) : null;
    if (scopeId && model && (!scope || scope.models.length && !scope.models.includes(String(model).toLowerCase()))) return [];
    let candidates = eligibilityFromUpstreams(scoped(db.upstreams, scopeId), pinnedId).eligible;
    if (requestedId) candidates = candidates.filter((upstream) => upstream.id === requestedId);
    else if (requestedType) candidates = candidates.filter((upstream) => upstream.type === requestedType);
    else if (pinnedId) candidates = candidates.filter((upstream) => upstream.id === pinnedId);
    else {
      const preferred = candidates.filter((upstream) => upstream.type === preferredType);
      candidates = [...leastRecentlySuccessful(preferred), ...leastRecentlySuccessful(candidates.filter((upstream) => upstream.type !== preferredType))];
    }
    if (requiredType) candidates = candidates.filter((upstream) => upstream.type === requiredType);
    return candidates.filter((upstream) => candidateEligible(upstream, model, requirements) && circuitEligible(upstream, { model, routeClass }, now)).map(publicUpstream);
  }

  beginCircuit(id, scope, now = Date.now()) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    const circuits = upstream.circuits ||= {};
    const key = circuitKey(scope);
    const state = circuits[key];
    if (!state || state.status === 'closed') return true;
    if (state.status === 'open') {
      if (!Number.isFinite(Date.parse(state.nextProbeAt)) || Date.parse(state.nextProbeAt) > now) return false;
      circuits[key] = { ...state, status: 'half_open', probeInFlight: 1, updatedAt: new Date(now).toISOString() };
      this.save(db);
      return true;
    }
    if (state.status === 'half_open') {
      const stale = !Number.isFinite(Date.parse(state.updatedAt)) || Date.parse(state.updatedAt) + CIRCUIT_COOLDOWN_MS <= now;
      if (state.probeInFlight && !stale) return false;
      circuits[key] = { ...state, probeInFlight: 1, updatedAt: new Date(now).toISOString() };
      this.save(db);
      return true;
    }
    return true;
  }

  recordCircuitFailure(id, scope, now = Date.now()) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    const circuits = upstream.circuits ||= {};
    const key = circuitKey(scope);
    const prior = circuits[key] || {};
    const failures = Math.max(0, Number(prior.failures) || 0) + 1;
    circuits[key] = {
      status: failures >= CIRCUIT_FAILURE_THRESHOLD ? 'open' : 'closed',
      failures,
      probeInFlight: 0,
      updatedAt: new Date(now).toISOString(),
      ...(failures >= CIRCUIT_FAILURE_THRESHOLD ? { nextProbeAt: new Date(now + CIRCUIT_COOLDOWN_MS).toISOString() } : {})
    };
    pruneCircuits(circuits);
    this.save(db);
  }

  completeCircuit(id, scope, success, now = Date.now()) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    const circuits = upstream.circuits ||= {};
    const key = circuitKey(scope);
    if (success) {
      delete circuits[key];
      upstream.lastSuccessfulAt = new Date(now).toISOString();
      return;
    } else {
      const state = circuits[key] || {};
      const failures = Math.max(0, Number(state.failures) || 0) + 1;
      circuits[key] = { status: 'open', failures, probeInFlight: 0, updatedAt: new Date(now).toISOString(), nextProbeAt: new Date(now + CIRCUIT_COOLDOWN_MS).toISOString() };
    }
    this.save(db);
  }

  releaseCircuit(id, scope, now = Date.now()) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    const circuits = upstream.circuits ||= {};
    const key = circuitKey(scope);
    if (circuits[key]?.status === 'half_open') circuits[key] = { ...circuits[key], probeInFlight: 0, updatedAt: new Date(now).toISOString() };
    this.save(db);
  }

  sessionUpstream(sessionId, scopeId = DEFAULT_SCOPE_ID, apiKeyId = null) {
    if (!sessionId || sessionId.length > SESSION_ID_MAX_LENGTH) return null;
    const sessions = this.load().sessions;
    const entry = sessions[sessionKey(scopeId, apiKeyId, sessionId)];
    if (!entry || entry.scopeId !== scopeId || (entry.apiKeyId ?? null) !== apiKeyId || Date.now() - Date.parse(entry.lastUsedAt) > SESSION_TTL_MS) return null;
    return entry.upstreamId || null;
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
    db.sessions[sessionKey(scopeId, apiKeyId, sessionId)] = { upstreamId, scopeId, apiKeyId, lastUsedAt: now };
    const overflow = Object.entries(db.sessions).sort(([, a], [, b]) => Date.parse(a.lastUsedAt || 0) - Date.parse(b.lastUsedAt || 0)).slice(0, Math.max(0, Object.keys(db.sessions).length - SESSION_LIMIT));
    for (const [id] of overflow) delete db.sessions[id];
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
    activeScope(db, scopeId);
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
      this.db = normalizeDatabase(db);
      this.persisted = structuredClone(this.db);
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
  return { upstreams: [], files: [], sessions: {}, responsePins: {}, scopes: [{ id: DEFAULT_SCOPE_ID, status: 'active', models: [] }], apiKeys: [], gatewayUsage: [], gatewayRequests: [], gatewayAttempts: [] };
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
  if (!Array.isArray(parsed.files) || !Array.isArray(parsed.scopes) || !Array.isArray(parsed.apiKeys) || !Array.isArray(parsed.gatewayUsage) || !Array.isArray(parsed.gatewayRequests) || !Array.isArray(parsed.gatewayAttempts)) throw new Error('invalid scoped database');
  parsed.gatewayUsage = compactGatewayUsage(parsed.gatewayUsage);
  pruneGatewayHistory(parsed);
  if (!parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions) || !parsed.responsePins || typeof parsed.responsePins !== 'object' || Array.isArray(parsed.responsePins)) throw new Error('invalid session database');
  if (!parsed.scopes.some((scope) => scope.id === DEFAULT_SCOPE_ID)) parsed.scopes.push({ id: DEFAULT_SCOPE_ID, status: 'active', models: [] });
  for (const scope of parsed.scopes) scope.models = normalizeModels(scope.models || []);
  for (const upstream of parsed.upstreams) {
    upstream.scopeId ||= DEFAULT_SCOPE_ID;
    upstream.routing = normalizeRouting(upstream.routing);
    upstream.baseUrl = defaultBaseUrl(upstream.type);
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
  return records;
}

function scoped(items, scopeId) {
  return scopeId ? items.filter((item) => item.scopeId === scopeId) : items;
}

function eligibilityFromUpstreams(upstreams, continuationId) {
  for (const upstream of upstreams) ensureSpending(upstream);
  const blocked = upstreams.filter((upstream) => ['failed', 'reauth_required'].includes(upstream.tokenRefresh?.status));
  const result = filterSpendCapEligible(upstreams.filter((upstream) => !blocked.includes(upstream)), { continuationId });
  return {
    ...result,
    exclusions: [...result.exclusions, ...blocked.map((upstream) => ({ id: upstream.id, name: upstream.name, code: `token_refresh_${upstream.tokenRefresh.status}` }))]
  };
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

function leastRecentlySuccessful(upstreams) {
  const rank = (upstream) => Number.isInteger(upstream.priority) ? upstream.priority : Infinity;
  return [...upstreams].sort((left, right) => rank(left) - rank(right) || (Date.parse(left.lastSuccessfulAt) || 0) - (Date.parse(right.lastSuccessfulAt) || 0));
}

function candidateEligible(upstream, model, requirements) {
  if (!upstream) return false;
  const routing = normalizeRouting(upstream.routing);
  if (routing.models.length && !routing.models.includes(String(model || '').toLowerCase())) return false;
  if (!isAiswitchUpstream(upstream) && Number.isFinite(Number(upstream.quota?.remainingPercent)) && Number(upstream.quota.remainingPercent) <= 0) return false;
  if (requirements.responses && !routing.responses || requirements.streaming && !routing.streaming || requirements.tools && !routing.tools || requirements.imageInput && !routing.imageInput || requirements.reasoning && !routing.reasoning) return false;
  return !requirements.serviceTier || !routing.serviceTiers.length || routing.serviceTiers.includes(requirements.serviceTier);
}

function activeScope(db, scopeId, required = true) {
  const scope = db.scopes.find((item) => item.id === scopeId) || null;
  if (!scope && required) throw new Error('scope not found');
  return scope;
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
