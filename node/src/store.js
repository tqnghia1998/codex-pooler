import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createUpstream,
  defaultBaseUrl,
  deriveUpstreamName,
  dollarsToCredits,
  ensureSpending,
  filterSpendCapEligible,
  number,
  publicUpstream,
  recordUsage,
  setSpendingCap,
  spendingSummary,
  updateUpstream
} from './domain.js';

const SESSION_LIMIT = 1_000;
const SESSION_ID_MAX_LENGTH = 200;
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;
const CIRCUIT_LIMIT = 100;
const MONTH_SECONDS = 27 * 24 * 60 * 60;
export const DEFAULT_SCOPE_ID = 'default';

export class Store {
  constructor(dataDir = process.env.CODEX_POOLER_NODE_DATA_DIR || resolve(process.cwd(), '.data')) {
    this.dataDir = resolve(dataDir);
    this.dbPath = join(this.dataDir, 'db.json');
    this.keyPath = join(this.dataDir, '.key');
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(this.dataDir, 0o700);
    const databaseExists = existsSync(this.dbPath);
    this.key = this.loadKey(databaseExists);
    if (!databaseExists) this.save(emptyDatabase());
    else this.save(this.load());
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

  upstreamModelAllowed(id, scopeId, model) {
    const upstream = this.get(id, scopeId);
    const models = normalizeRouting(upstream?.routing).models;
    return Boolean(upstream) && (!models.length || models.includes(String(model || '').toLowerCase()));
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
    upstream.scopeId = scopeId;
    upstream.routing = normalizeRouting(input.routing);
    upstream.credentials = encryptCredentials(upstream.credentials, this.key);
    db.upstreams.push(upstream);
    this.save(db);
    return publicUpstream(upstream);
  }

  update(id, input) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    ensureSpending(upstream);
    const previousCredentials = decryptCredentials(upstream.credentials, this.key);
    upstream.credentials = previousCredentials;
    updateUpstream(upstream, input);
    if (input.routing !== undefined) upstream.routing = normalizeRouting(input.routing);
    this.saveCredentials(upstream);
    this.save(db);
    return publicUpstream(upstream);
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
  }

  credentials(id) {
    const upstream = this.get(id);
    if (!upstream) throw notFound();
    return decryptCredentials(upstream.credentials, this.key);
  }

  setQuota(id, quota) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    ensureSpending(upstream);
    upstream.quota = quota;
    upstream.updatedAt = new Date().toISOString();
    this.save(db);
    return publicUpstream(upstream);
  }

  persistCredentials(id, credentials, accessTokenExpiresAt = null) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    upstream.credentials = encryptCredentials(credentials, this.key);
    upstream.accessTokenExpiresAt = accessTokenExpiresAt;
    upstream.updatedAt = new Date().toISOString();
    this.save(db);
  }

  setCap(id, input) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    ensureSpending(upstream);
    setSpendingCap(upstream, capCreditsFromInput(input));
    this.save(db);
    return publicUpstream(upstream);
  }

  addUsage(id, input) {
    const db = this.load();
    const upstream = findOrThrow(db, id);
    ensureSpending(upstream);
    const settlement = recordUsage(upstream, input);
    this.save(db);
    return { upstream: publicUpstream(upstream), settlement };
  }

  recordGatewayUsage({ scopeId = DEFAULT_SCOPE_ID, apiKeyId = null, attemptId, startedAt, usage = null, settledCostMicros = null } = {}) {
    if (!attemptId) return;
    const db = this.load();
    db.gatewayUsage ||= [];
    const entry = { scopeId, apiKeyId, attemptId, startedAt: startedAt || new Date().toISOString(), usage, settledCostMicros };
    const index = db.gatewayUsage.findIndex((item) => item.scopeId === scopeId && item.apiKeyId === apiKeyId && item.attemptId === attemptId);
    if (index === -1) db.gatewayUsage.push(entry);
    else db.gatewayUsage[index] = entry;
    this.save(db);
  }

  gatewayUsage(scopeId = DEFAULT_SCOPE_ID, apiKeyId = null) {
    const today = new Date().toISOString().slice(0, 10);
    const entries = (this.load().gatewayUsage || []).filter((item) => item.scopeId === scopeId && item.apiKeyId === apiKeyId && String(item.startedAt).slice(0, 10) === today);
    const totals = entries.reduce((result, { usage, settledCostMicros }) => ({
      request_count: result.request_count + 1,
      total_tokens: result.total_tokens + (usage?.totalTokens ?? (usage?.inputTokens || 0) + (usage?.outputTokens || 0)),
      cached_input_tokens: result.cached_input_tokens + (usage?.cachedInputTokens || 0),
      total_cost_micros: result.total_cost_micros + (Number.isSafeInteger(settledCostMicros) ? settledCostMicros : 0),
      priced: result.priced || Number.isSafeInteger(settledCostMicros)
    }), { request_count: 0, total_tokens: 0, cached_input_tokens: 0, total_cost_micros: 0, priced: false });
    const upstream_limits = dbUpstreamLimits(this.load().upstreams, scopeId);
    return { request_count: totals.request_count, total_tokens: totals.total_tokens, cached_input_tokens: totals.cached_input_tokens, total_cost_usd: totals.total_cost_micros / 1_000_000, total_cost_status: totals.priced ? 'priced' : 'unpriced', limits: [], upstream_limits };
  }

  spending(id) {
    const upstream = this.get(id);
    if (!upstream) throw notFound();
    return spendingSummary(upstream.spending);
  }

  eligibility(continuationId = null, scopeId = null) {
    const db = this.load();
    const upstreams = scoped(db.upstreams, scopeId);
    for (const upstream of upstreams) ensureSpending(upstream);
    const result = filterSpendCapEligible(upstreams, { continuationId });
    return {
      eligible: result.eligible.map(publicUpstream),
      reserved: result.reserved.map(publicUpstream),
      exclusions: result.exclusions,
      error: result.error
    };
  }

  candidatePlan({ pinnedId = null, requestedId = '', requestedType = '', preferredType = '', requiredType = '', model = '', requirements = {}, routeClass = 'proxy_http', now = Date.now(), scopeId = null } = {}) {
    if (scopeId && model && !this.modelAllowed(scopeId, model)) return [];
    let candidates = this.eligibility(pinnedId, scopeId).eligible;
    if (requestedId) candidates = candidates.filter((upstream) => upstream.id === requestedId);
    else if (requestedType) candidates = candidates.filter((upstream) => upstream.type === requestedType);
    else if (pinnedId) candidates = candidates.filter((upstream) => upstream.id === pinnedId);
    else {
      const preferred = candidates.filter((upstream) => upstream.type === preferredType);
      candidates = [...preferred, ...candidates.filter((upstream) => upstream.type !== preferredType)];
    }
    if (requiredType) candidates = candidates.filter((upstream) => upstream.type === requiredType);
    return candidates.filter((upstream) => candidateEligible(this.get(upstream.id), model, requirements) && circuitEligible(this.get(upstream.id), { model, routeClass }, now));
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
    if (success) delete circuits[key];
    else {
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

  sessionUpstream(sessionId, scopeId = DEFAULT_SCOPE_ID) {
    if (!sessionId || sessionId.length > SESSION_ID_MAX_LENGTH) return null;
    const sessions = this.load().sessions;
    const entry = sessions[sessionKey(scopeId, sessionId)] || (scopeId === DEFAULT_SCOPE_ID ? sessions[sessionId] : null);
    if (typeof entry === 'string') return scopeId === DEFAULT_SCOPE_ID ? entry : null;
    if (!entry || entry.scopeId !== scopeId || Date.now() - Date.parse(entry.lastUsedAt) > SESSION_TTL_MS) return null;
    return entry.upstreamId || null;
  }

  pinSession(sessionId, upstreamId, scopeId = DEFAULT_SCOPE_ID) {
    if (!sessionId) return;
    if (sessionId.length > SESSION_ID_MAX_LENGTH) throw Object.assign(new Error(`x-codex-session-id must be at most ${SESSION_ID_MAX_LENGTH} characters`), { statusCode: 400 });
    const db = this.load();
    if (!scoped(db.upstreams, scopeId).some((upstream) => upstream.id === upstreamId)) throw notFound();
    const now = new Date().toISOString();
    for (const [id, entry] of Object.entries(db.sessions)) {
      if (typeof entry !== 'string' && Date.now() - Date.parse(entry.lastUsedAt) > SESSION_TTL_MS) delete db.sessions[id];
    }
    db.sessions[sessionKey(scopeId, sessionId)] = { upstreamId, scopeId, lastUsedAt: now };
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
      this.save(db);
      updated.push(publicUpstream(item.upstream));
    }
    return { updated, skipped };
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.dbPath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.upstreams)) throw new Error('invalid database');
      parsed.files ||= [];
      parsed.sessions ||= {};
      parsed.scopes ||= [{ id: DEFAULT_SCOPE_ID, status: 'active' }];
      parsed.apiKeys ||= [];
      parsed.gatewayUsage ||= [];
      if (!Array.isArray(parsed.files) || !Array.isArray(parsed.scopes) || !Array.isArray(parsed.apiKeys) || !Array.isArray(parsed.gatewayUsage)) throw new Error('invalid scoped database');
      if (!parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) throw new Error('invalid sessions database');
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
    } catch (error) {
      throw new Error(`Could not read ${this.dbPath}: ${error.message}`);
    }
  }

  save(db) {
    const tempPath = `${this.dbPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, this.dbPath);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
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
  return { upstreams: [], files: [], sessions: {}, scopes: [{ id: DEFAULT_SCOPE_ID, status: 'active', models: [] }], apiKeys: [], gatewayUsage: [] };
}

function scoped(items, scopeId) {
  return scopeId ? items.filter((item) => item.scopeId === scopeId) : items;
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

function candidateEligible(upstream, model, requirements) {
  if (!upstream) return false;
  const routing = normalizeRouting(upstream.routing);
  if (routing.models.length && !routing.models.includes(String(model || '').toLowerCase())) return false;
  if (Number.isFinite(Number(upstream.quota?.remainingPercent)) && Number(upstream.quota.remainingPercent) <= 0) return false;
  if (requirements.responses && !routing.responses || requirements.streaming && !routing.streaming || requirements.tools && !routing.tools || requirements.imageInput && !routing.imageInput || requirements.reasoning && !routing.reasoning) return false;
  return !requirements.serviceTier || !routing.serviceTiers.length || routing.serviceTiers.includes(requirements.serviceTier);
}

function activeScope(db, scopeId, required = true) {
  const scope = db.scopes.find((item) => item.id === scopeId) || null;
  if (!scope && required) throw new Error('scope not found');
  return scope;
}

function sessionKey(scopeId, sessionId) {
  return `${scopeId}:${sessionId}`;
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
  if (target) {
    if (!['all', 'cap_reached', 'uncapped'].includes(target)) throw new Error('target must be all, cap_reached, or uncapped');
    return upstreams
      .filter((upstream) => target === 'all' || (target === 'uncapped' && spendingSummary(upstream.spending).capCredits <= 0) || (target === 'cap_reached' && spendingSummary(upstream.spending).status === 'reached'))
      .map((upstream) => ({ upstream, capDollars: input.capDollars }));
  }

  if (!Array.isArray(input.rules) || input.rules.length === 0) throw new Error('rules must contain at least one quota rule');
  const rules = input.rules.map((rule) => ({
    minQuotaLeft: number(rule.minQuotaLeft, 'minQuotaLeft'),
    capDollars: number(rule.capDollars, 'capDollars')
  }));
  return upstreams.flatMap((upstream) => {
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
