import { createHash } from 'node:crypto';
import {
  DEFAULT_CODEX_BASE_URL,
  STATIC_MODEL_CATALOG,
  normalizeBaseUrl
} from './domain.js';
import { captureCodexCookies, codexCookieHeaders } from './codex-cookies.js';
import { ensureProviderCredentials, refreshProviderCredentials } from './providers.js';
import { codexProtocolHeaders, codexProtocolVersion } from './protocol-compat.js';
import { fetchWithHeaderDeadline, readWithIdleDeadline } from './upstream-deadlines.js';
import { codexHostHealthForStore, withCodexHostHealth } from './codex-host-health.js';
import { PacingError, upstreamPacerForStore } from './upstream-pacer.js';

const DEFAULT_SCOPE_ID = 'default';
const FRESH_TTL_MS = 5 * 60_000;
const FAILURE_SUPPRESSION_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 512;
const MAX_ACCOUNT_CATALOGS = 512;
const MAX_NEGATIVE_MODELS = 128;
const DISCOVERY_CONCURRENCY = 3;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_KEYS = 64;
const MAX_METADATA_ARRAY = 64;
const MAX_METADATA_STRING_BYTES = 8 * 1024;
const SENSITIVE_KEYS = new Set([
  'authorization',
  'auth',
  'token',
  'cookie',
  'cookies',
  'secret',
  'credential',
  'credentials',
  'password',
  'api_key',
  'apikey',
  'session',
  'session_id'
]);
const OMIT = Symbol('omit');
const catalogsByStore = new WeakMap();

export function modelCatalogForStore(store) {
  let catalog = catalogsByStore.get(store);
  if (!catalog) {
    catalog = new CodexModelCatalog(store);
    catalogsByStore.set(store, catalog);
  }
  return catalog;
}

export class CodexModelCatalog {
  constructor(store, {
    now = () => Date.now(),
    freshTtlMs = FRESH_TTL_MS,
    failureSuppressionMs = FAILURE_SUPPRESSION_MS,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    maxModels = MAX_MODELS,
    concurrency = DISCOVERY_CONCURRENCY
  } = {}) {
    this.store = store;
    this.now = now;
    this.freshTtlMs = freshTtlMs;
    this.failureSuppressionMs = failureSuppressionMs;
    this.maxResponseBytes = maxResponseBytes;
    this.maxModels = maxModels;
    this.concurrency = concurrency;
    this.entries = new Map();
    this.inflight = new Map();
  }

  async resolve(scopeId = DEFAULT_SCOPE_ID, options = {}) {
    const candidates = this.discoveryCandidates(scopeId);
    await mapConcurrent(candidates, this.concurrency, ({ id }) => this.discoverAccount(id, options));
    return this.snapshot(scopeId);
  }

  snapshot(scopeId = DEFAULT_SCOPE_ID) {
    this.reconcile();
    const candidates = this.discoveryCandidates(scopeId);
    const now = this.now();
    const accountEntries = candidates.flatMap(({ id }) => {
      const entry = this.currentEntry(id);
      if (!entry) return [];
      entry.lastUsedAt = now;
      return [{ id, entry }];
    });
    const accountCatalogs = accountEntries.filter(({ entry }) => entry.hasCatalog);
    const aggregated = aggregateCatalog(accountCatalogs.map(({ entry }) => entry.models), (id) => this.store.modelAllowed(scopeId, id));
    const status = catalogStatus(
      accountEntries.map(({ entry }) => entry),
      accountCatalogs.length,
      aggregated.publicModels.length,
      now,
      this.freshTtlMs
    );
    return {
      ...aggregated,
      etag: modelCatalogEtag({ models: aggregated.nativeModels }),
      publicEtag: modelCatalogEtag({ object: 'list', data: aggregated.publicModels }),
      status
    };
  }

  scopedAccountCatalog(upstreamId, scopeId = DEFAULT_SCOPE_ID) {
    this.reconcile();
    const upstream = this.store.get(upstreamId, scopeId);
    if (!upstream) return null;
    const entry = this.currentEntry(upstreamId);
    const accountModels = entry?.hasCatalog ? [entry.models] : [];
    const providerAllowed = (id) => this.store.modelAllowed(scopeId, id)
      && (upstream.type !== 'codex' || STATIC_MODEL_CATALOG.find((row) => row.id === id)?.owned_by !== 'compass');
    const aggregated = aggregateCatalog(accountModels, providerAllowed);
    const status = catalogStatus(entry ? [entry] : [], entry?.hasCatalog ? 1 : 0, aggregated.publicModels.length, this.now(), this.freshTtlMs);
    return {
      ...aggregated,
      etag: modelCatalogEtag({ models: aggregated.nativeModels }),
      publicEtag: modelCatalogEtag({ object: 'list', data: aggregated.publicModels }),
      status
    };
  }

  async discoverAccount(upstreamId, options = {}) {
    this.reconcile();
    const upstream = this.store.get(upstreamId);
    if (!upstream || upstream.type !== 'codex') return null;
    const generation = catalogGeneration(upstream);
    const existing = this.entryFor(upstreamId, generation);
    const now = this.now();
    existing.lastUsedAt = now;
    if (existing.hasCatalog && existing.lastSuccessAt && now - existing.lastSuccessAt < this.freshTtlMs) return accountResult(existing, true);
    if (existing.lastFailureAt && now - existing.lastFailureAt < this.failureSuppressionMs) {
      return existing.hasCatalog ? accountResult(existing, false) : null;
    }
    const inflightKey = `${upstreamId}:${generation}`;
    if (this.inflight.has(inflightKey)) return this.inflight.get(inflightKey);

    const discovery = this.fetchAccount(upstreamId, options)
      .finally(() => {
        if (this.inflight.get(inflightKey) === discovery) this.inflight.delete(inflightKey);
      });
    this.inflight.set(inflightKey, discovery);
    return discovery;
  }

  supports(upstreamId, model, expectedGeneration = null) {
    const normalized = normalizeModelId(model);
    if (!normalized) return null;
    const entry = expectedGeneration !== null
      ? this.entryMatchingGeneration(upstreamId, expectedGeneration)
      : this.currentEntry(upstreamId);
    if (!entry) return null;
    entry.lastUsedAt = this.now();
    if (entry.negativeModels.has(normalized)) return false;
    if (!entry.hasCatalog) return null;
    return entry.modelIds.has(normalized);
  }

  supportsServiceTier(upstreamId, model, tier, expectedGeneration = null) {
    const normalized = normalizeModelId(model);
    if (!normalized || tier !== 'ultrafast') return null;
    const entry = expectedGeneration !== null
      ? this.entryMatchingGeneration(upstreamId, expectedGeneration)
      : this.currentEntry(upstreamId);
    if (!entry?.hasCatalog) return false;
    const row = entry.models.find(({ id }) => id === normalized)?.native;
    return advertisedServiceTiers(row).includes(tier);
  }

  markUnsupported(upstreamId, model) {
    const normalized = normalizeModelId(model);
    const upstream = this.store.get(upstreamId);
    if (!normalized || !upstream || upstream.type !== 'codex') return;
    const entry = this.entryFor(upstreamId, catalogGeneration(upstream));
    entry.negativeModels.add(normalized);
    while (entry.negativeModels.size > MAX_NEGATIVE_MODELS) {
      entry.negativeModels.delete(entry.negativeModels.values().next().value);
    }
    entry.models = entry.models.filter(({ id }) => id !== normalized);
    entry.modelIds.delete(normalized);
    entry.lastSuccessAt = 0;
    entry.lastFailureAt = 0;
    entry.lastFailureClass = null;
    entry.lastUsedAt = this.now();
  }

  async imageModel(upstreamId, options = {}) {
    const discovered = await this.discoverAccount(upstreamId, options);
    if (discovered?.authoritative) {
      if (!discovered.models.length) return null;
      const image = discovered.models.find(({ native }) => Array.isArray(native.input_modalities)
        && native.input_modalities.some((modality) => String(modality).toLowerCase() === 'image'));
      if (image) return image.id;
      const unknown = discovered.models.find(({ native }) => !Array.isArray(native.input_modalities));
      return unknown?.id || null;
    }
    return staticImageFallback();
  }

  status(scopeId = DEFAULT_SCOPE_ID) {
    return this.snapshot(scopeId).status;
  }

  invalidate(upstreamId = null) {
    if (upstreamId) {
      this.entries.delete(upstreamId);
      return;
    }
    this.entries.clear();
  }

  async fetchAccount(upstreamId, { fetchImpl = globalThis.fetch, upstreamDeadlines = {}, codexHostHealth = codexHostHealthForStore(this.store) } = {}) {
    let generation = null;
    try {
      let upstream = this.store.get(upstreamId);
      if (!upstream || upstream.type !== 'codex') return null;
      let credentials = this.store.credentials(upstreamId);
      await ensureProviderCredentials(upstream, credentials, {
        fetchImpl,
        saveCredentials: (updated, expiresAt) => this.store.persistCredentials(upstreamId, updated, expiresAt)
      });
      upstream = this.store.get(upstreamId);
      if (!upstream || upstream.type !== 'codex') return null;
      credentials = this.store.credentials(upstreamId);
      generation = catalogGeneration(upstream);

      let response = await requestModels(this.store, upstream, credentials, { fetchImpl, upstreamDeadlines, codexHostHealth });
      if ((response.status === 401 || response.status === 403) && credentials.refreshToken) {
        await response.body?.cancel('Retrying model discovery after credential refresh').catch(() => {});
        await refreshProviderCredentials(upstream, credentials, {
          fetchImpl,
          saveCredentials: (updated, expiresAt) => this.store.persistCredentials(upstreamId, updated, expiresAt)
        });
        upstream = this.store.get(upstreamId);
        if (!upstream || upstream.type !== 'codex') return null;
        credentials = this.store.credentials(upstreamId);
        generation = catalogGeneration(upstream);
        response = await requestModels(this.store, upstream, credentials, { fetchImpl, upstreamDeadlines, codexHostHealth });
      }
      if (captureCodexCookies(response, credentials)) {
        this.store.persistCredentials(upstreamId, credentials, upstream.accessTokenExpiresAt);
      }
      if (!response.ok) {
        await response.body?.cancel('Model discovery returned an error').catch(() => {});
        throw discoveryError(response.status);
      }

      const body = parseDiscoveryBody(await readResponseBytes(response, this.maxResponseBytes, upstreamDeadlines));
      const models = parseModels(body, this.maxModels);
      const current = this.store.get(upstreamId);
      if (!current || current.type !== 'codex' || catalogGeneration(current) !== generation) return this.accountSnapshot(upstreamId);

      const entry = this.entryFor(upstreamId, generation);
      const now = this.now();
      entry.hasCatalog = true;
      entry.models = models;
      entry.modelIds = new Set(models.map(({ id }) => id));
      entry.negativeModels.clear();
      entry.lastSuccessAt = now;
      entry.lastAttemptAt = now;
      entry.lastFailureAt = 0;
      entry.lastFailureClass = null;
      entry.lastUsedAt = now;
      this.prune();
      return accountResult(entry, true);
    } catch (error) {
      if (error instanceof PacingError) return this.accountSnapshot(upstreamId);
      const current = this.store.get(upstreamId);
      if (generation !== null && current?.type === 'codex' && catalogGeneration(current) === generation) {
        const entry = this.entryFor(upstreamId, generation);
        const now = this.now();
        entry.lastAttemptAt = now;
        entry.lastFailureAt = now;
        entry.lastFailureClass = failureClass(error);
        entry.lastUsedAt = now;
        return entry.hasCatalog ? accountResult(entry, false) : null;
      }
      return this.accountSnapshot(upstreamId);
    }
  }

  accountSnapshot(upstreamId) {
    const entry = this.currentEntry(upstreamId);
    return entry?.hasCatalog ? accountResult(entry, this.now() - entry.lastSuccessAt < this.freshTtlMs) : null;
  }

  discoveryCandidates(scopeId) {
    return this.store.candidatePlan({
      preferredType: 'codex',
      requiredType: 'codex',
      scopeId,
      ignoreModelRestrictions: true,
      routeClass: 'model_discovery'
    });
  }

  currentEntry(upstreamId) {
    const upstream = this.store.get(upstreamId);
    if (!upstream || upstream.type !== 'codex') {
      this.entries.delete(upstreamId);
      return null;
    }
    const entry = this.entries.get(upstreamId);
    if (!entry || entry.generation !== catalogGeneration(upstream)) {
      this.entries.delete(upstreamId);
      return null;
    }
    return entry;
  }

  entryMatchingGeneration(upstreamId, generation) {
    const entry = this.entries.get(upstreamId);
    if (!entry || entry.generation !== generation) return null;
    return entry;
  }

  entryFor(upstreamId, generation) {
    let entry = this.entries.get(upstreamId);
    if (!entry || entry.generation !== generation) {
      entry = {
        generation,
        hasCatalog: false,
        models: [],
        modelIds: new Set(),
        negativeModels: new Set(),
        lastSuccessAt: 0,
        lastAttemptAt: 0,
        lastFailureAt: 0,
        lastFailureClass: null,
        lastUsedAt: this.now()
      };
      this.entries.set(upstreamId, entry);
    }
    return entry;
  }

  reconcile() {
    for (const upstreamId of this.entries.keys()) this.currentEntry(upstreamId);
    this.prune();
  }

  prune() {
    if (this.entries.size <= MAX_ACCOUNT_CATALOGS) return;
    const removable = [...this.entries.entries()]
      .filter(([id]) => ![...this.inflight.keys()].some((key) => key.startsWith(`${id}:`)))
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt);
    for (const [id] of removable.slice(0, this.entries.size - MAX_ACCOUNT_CATALOGS)) this.entries.delete(id);
  }
}

function catalogGeneration(upstream) {
  return upstream ? Math.max(1, Number(upstream.modelCatalogEpoch) || 1) : 0;
}

function accountResult(entry, fresh) {
  return {
    authoritative: true,
    fresh,
    models: entry.models,
    lastSuccessAt: entry.lastSuccessAt ? new Date(entry.lastSuccessAt).toISOString() : null,
    lastFailureAt: entry.lastFailureAt ? new Date(entry.lastFailureAt).toISOString() : null,
    lastFailureClass: entry.lastFailureClass
  };
}

function staticImageFallback() {
  return STATIC_MODEL_CATALOG.find(({ owned_by }) => owned_by === 'codex')?.id || null;
}

async function requestModels(store, upstream, credentials, { fetchImpl, upstreamDeadlines, codexHostHealth }) {
  const version = codexProtocolVersion();
  const url = `${normalizeBaseUrl(upstream.baseUrl, DEFAULT_CODEX_BASE_URL)}/backend-api/codex/models?client_version=${encodeURIComponent(version)}`;
  await upstreamPacerForStore(store).acquire(upstream.id);
  return withCodexHostHealth(codexHostHealth, url, () => fetchWithHeaderDeadline(fetchImpl, url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      accept: 'application/json',
      ...codexProtocolHeaders(),
      ...codexCookieHeaders(credentials),
      ...(upstream.accountId ? { 'chatgpt-account-id': upstream.accountId } : {})
    }
  }, upstreamDeadlines));
}

async function readResponseBytes(response, maxBytes, upstreamDeadlines) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readWithIdleDeadline(reader, upstreamDeadlines);
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel('Model catalog response exceeded limit');
        throw taggedError('oversized');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

function parseDiscoveryBody(bytes) {
  try {
    const body = JSON.parse(bytes.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw taggedError('malformed');
  }
}

function parseModels(body, maxModels) {
  const rows = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : null;
  if (!rows) throw taggedError('malformed');
  if (rows.length > maxModels) throw taggedError('oversized');
  const models = rows.flatMap((row) => {
    const parsed = sanitizeModel(row);
    return parsed ? [parsed] : [];
  });
  if (rows.length && !models.length) throw taggedError('malformed');
  const deduplicated = new Map();
  for (const model of models) {
    const prior = deduplicated.get(model.id);
    if (!prior || compareNativeRows(model.native, prior.native) < 0) deduplicated.set(model.id, model);
  }
  return [...deduplicated.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sanitizeModel(row) {
  if (!plainObject(row)) return null;
  const id = normalizeModelId(row.slug || row.id);
  if (!id) return null;
  const native = sanitizeValue(row, 0);
  if (!plainObject(native)) return null;
  native.id = id;
  native.slug = id;
  return { id, native };
}

function sanitizeValue(value, depth) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : OMIT;
  if (typeof value === 'string') return Buffer.byteLength(value) <= MAX_METADATA_STRING_BYTES ? value : OMIT;
  if (depth >= MAX_METADATA_DEPTH) return OMIT;
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_METADATA_ARRAY).map((entry) => sanitizeValue(entry, depth + 1)).filter((entry) => entry !== OMIT);
    return result;
  }
  if (!plainObject(value)) return OMIT;
  const result = {};
  let accepted = 0;
  for (const key of Object.keys(value).sort()) {
    if (accepted >= MAX_METADATA_KEYS || !safeMetadataKey(key)) continue;
    const sanitized = sanitizeValue(value[key], depth + 1);
    if (sanitized === OMIT) continue;
    result[key] = sanitized;
    accepted += 1;
  }
  return result;
}

function safeMetadataKey(key) {
  const normalized = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replaceAll('-', '_');
  return typeof key === 'string'
    && key.length <= 128
    && !['__proto__', 'constructor', 'prototype'].includes(key)
    && !SENSITIVE_KEYS.has(normalized)
    && !/(?:^|_)(?:authorization|cookie|cookies|secret|credential|credentials|password)(?:_|$)/.test(normalized)
    && !/(?:^|_)(?:access|refresh|id|oauth|bearer|api)_?token$/.test(normalized)
    && !/(?:^|_)(?:client|api)_?secret$/.test(normalized)
    && !/(?:^|_)api_?key(?:_|$)/.test(normalized)
    && !/(?:^|_)session(?:_id|_key|_token)?(?:_|$)/.test(normalized);
}

function normalizeModelId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  return MODEL_ID_PATTERN.test(id) ? id.toLowerCase() : '';
}

function advertisedServiceTiers(row) {
  if (!plainObject(row)) return [];
  return ['service_tiers', 'additional_speed_tiers'].flatMap((key) => {
    const values = Array.isArray(row[key]) ? row[key] : [];
    return values.flatMap((value) => {
      const tier = typeof value === 'string' ? value : plainObject(value) ? value.id : null;
      return typeof tier === 'string' && tier === tier.trim().toLowerCase() ? [tier] : [];
    });
  });
}

function aggregateCatalog(accountModels, modelAllowed) {
  const liveById = new Map();
  for (const models of accountModels) {
    for (const model of models) {
      if (!modelAllowed(model.id)) continue;
      const candidates = liveById.get(model.id) || [];
      candidates.push(model.native);
      liveById.set(model.id, candidates);
    }
  }

  const staticById = new Map(STATIC_MODEL_CATALOG.map((row) => [row.id, row]));
  const orderedIds = [
    ...STATIC_MODEL_CATALOG.map(({ id }) => id).filter(modelAllowed),
    ...[...liveById.keys()].filter((id) => !staticById.has(id)).sort((left, right) => left.localeCompare(right))
  ];
  const nativeModels = orderedIds.map((id) => {
    const live = chooseNativeRow(liveById.get(id) || []);
    const fallback = staticById.get(id);
    return live
      ? { ...(fallback || { object: 'model', owned_by: 'codex' }), ...live, id }
      : fallback;
  });
  const publicModels = nativeModels.map(({ id }) => ({
    id,
    object: 'model',
    owned_by: staticById.get(id)?.owned_by === 'compass' ? 'compass' : 'codex'
  }));
  return { publicModels, nativeModels };
}

function chooseNativeRow(rows) {
  return [...rows].sort(compareNativeRows)[0] || null;
}

function compareNativeRows(left, right) {
  const leftJson = canonicalJson(left);
  const rightJson = canonicalJson(right);
  return Buffer.byteLength(rightJson) - Buffer.byteLength(leftJson) || leftJson.localeCompare(rightJson);
}

function catalogStatus(entries, authoritativeAccountCount, modelCount, now, freshTtlMs) {
  const fresh = entries.filter((entry) => entry.hasCatalog && entry.lastSuccessAt && now - entry.lastSuccessAt < freshTtlMs);
  const successes = entries.map(({ lastSuccessAt }) => lastSuccessAt).filter(Boolean);
  const failures = entries.filter(({ lastFailureAt }) => lastFailureAt).sort((left, right) => right.lastFailureAt - left.lastFailureAt);
  return {
    source: authoritativeAccountCount ? fresh.length === authoritativeAccountCount && !failures.length ? 'live' : fresh.length ? 'mixed' : 'stale' : 'static',
    freshness: authoritativeAccountCount ? fresh.length ? 'fresh' : 'stale' : 'fallback',
    accountCount: authoritativeAccountCount,
    attemptedAccountCount: entries.filter(({ lastAttemptAt }) => lastAttemptAt).length,
    freshAccountCount: fresh.length,
    modelCount,
    lastSuccessAt: successes.length ? new Date(Math.max(...successes)).toISOString() : null,
    lastFailureAt: failures[0]?.lastFailureAt ? new Date(failures[0].lastFailureAt).toISOString() : null,
    lastFailureClass: failures[0]?.lastFailureClass || null
  };
}

function modelCatalogEtag(body) {
  const digest = createHash('sha256').update(canonicalJson(body)).digest('hex');
  return `W/"cp-models-v1-${digest}"`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function discoveryError(status) {
  const error = taggedError(status === 401 || status === 403
    ? 'authentication'
    : status === 429
      ? 'rate_limited'
      : status >= 500
        ? 'upstream_5xx'
        : 'upstream_4xx');
  error.statusCode = status;
  return error;
}

function taggedError(code) {
  return Object.assign(new Error(`Codex model discovery failed: ${code}`), { catalogFailureClass: code });
}

function failureClass(error) {
  if (error?.catalogFailureClass) return error.catalogFailureClass;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'timeout';
  return 'transport';
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function mapConcurrent(values, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await worker(values[index]);
    }
  });
  await Promise.all(runners);
}
