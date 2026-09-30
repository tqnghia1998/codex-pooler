import { createHash } from 'node:crypto';
import {
  isCompatibilityOptionalField,
  validCompatibilityFeature
} from './compatibility-policy.js';
import { compatibilityProtocolFingerprint, defaultProtocolFingerprints, PROTOCOL_FINGERPRINT_VERSION } from './protocol-compat.js';

const FACT_TTL_MS = 24 * 60 * 60_000;
const OBSERVATION_LIMIT = 256;
const PROMOTION_COUNT = 2;
const DEFAULT_OBSERVATION_GAP_MS = 1_000;
const servicesByStore = new WeakMap();

export function compatibilityLearningForStore(store, options = {}) {
  let service = servicesByStore.get(store);
  if (!service) {
    service = new CompatibilityLearning(store, options);
    servicesByStore.set(store, service);
  }
  return service;
}

export function compatibilityContext(upstream, {
  req = null,
  inheritClient = false,
  websocket = false,
  sourcePath = '',
  model = '',
  anthropicVersion = '',
  anthropicBeta = ''
} = {}) {
  const fingerprint = compatibilityProtocolFingerprint(upstream?.type, {
    req,
    inheritClient,
    websocket,
    anthropicVersion,
    anthropicBeta
  });
  const capabilityHash = hash(String(model || '').trim().toLowerCase());
  const routeClass = routeClassFor(sourcePath);
  const protocolScope = inheritClient || anthropicVersion || anthropicBeta ? 'client' : 'default';
  const protocolProfile = upstream.type === 'codex' && websocket ? 'codexWebsocket' : upstream.type;
  return {
    key: `${upstream.type}:${fingerprint.hash}:${routeClass}:${capabilityHash}`,
    providerType: upstream.type,
    routeClass,
    capabilityHash,
    protocolScope,
    protocolProfile,
    protocolFingerprintVersion: fingerprint.version,
    protocolFingerprintHash: fingerprint.hash,
    generation: generationFor(upstream)
  };
}

export function compatibilityEvidenceFeature(current = {}, next = {}) {
  if (current.adaptiveThinking !== true && next.adaptiveThinking === true) return 'adaptive_thinking';
  const currentFields = new Set(current.unsupportedFields || []);
  const field = (next.unsupportedFields || []).find((name) => !currentFields.has(name));
  return field ? `unsupported_field:${field}` : '';
}

export class CompatibilityLearning {
  constructor(store, options = {}) {
    this.store = store;
    this.now = options.now || (() => Date.now());
    this.observationGapMs = options.observationGapMs ?? DEFAULT_OBSERVATION_GAP_MS;
    this.observations = new Map();
    this.counters = { observations: 0, promotions: 0 };
    this.fingerprints = options.fingerprints || defaultProtocolFingerprints();
    this.passiveEnabled = options.passiveEnabled ?? envBoolean(
      process.env.CODEX_POOLER_COMPATIBILITY_PASSIVE_ENABLED,
      true
    );
  }

  activeFact(upstreamId, context, { now = this.now() } = {}) {
    if (context.protocolScope === 'default'
      && this.fingerprints[context.protocolProfile]?.hash !== context.protocolFingerprintHash) return null;
    return this.store.compatibilityFactRecord(upstreamId, context.key, {
      now,
      protocolFingerprintHash: context.protocolFingerprintHash,
      generation: context.generation
    })?.value || null;
  }

  observe({
    upstream,
    context,
    value,
    feature,
    responseClass = 'structured_rejection',
    observationId = '',
    now = this.now()
  }) {
    if (!this.passiveEnabled || !validEvidence(upstream, context, value, feature, responseClass)) {
      return { status: 'ignored' };
    }
    const generation = generationFor(upstream);
    if (context.generation && !sameGeneration(context.generation, generation)) {
      return { status: 'stale_generation' };
    }
    const observationKey = `${upstream.id}:${context.key}:${feature}:${hash(canonicalJson(value))}`;
    let entry = this.observations.get(observationKey);
    if (!entry) {
      entry = {
        observationKey,
        value: structuredClone(value),
        count: 0,
        firstObservedAt: now,
        lastObservedAt: 0,
        lastObservationId: '',
        lastGeneration: null,
        lastUsedAt: now
      };
      this.observations.set(observationKey, entry);
    }
    if (entry.lastGeneration && !sameGeneration(entry.lastGeneration, generation)) {
      entry.count = 0;
      entry.firstObservedAt = now;
      entry.lastObservedAt = 0;
      entry.lastObservationId = '';
      entry.lastGeneration = null;
    }
    const independent = entry.count === 0
      || observationId && observationId !== entry.lastObservationId
      || now - entry.lastObservedAt >= this.observationGapMs;
    entry.lastUsedAt = now;
    if (independent) {
      entry.count += 1;
      entry.lastObservedAt = now;
      entry.lastObservationId = observationId;
      entry.lastGeneration = generation;
      this.counters.observations += 1;
    }
    this.pruneObservations();
    if (entry.count < PROMOTION_COUNT) return { status: 'observed', evidenceCount: entry.count };

    const result = this.store.promoteCompatibilityFact(upstream.id, context.key, {
      protocolFingerprintVersion: context.protocolFingerprintVersion,
      protocolFingerprintHash: context.protocolFingerprintHash,
      providerType: context.providerType,
      routeClass: context.routeClass,
      capabilityHash: context.capabilityHash,
      protocolScope: context.protocolScope,
      protocolProfile: context.protocolProfile,
      feature,
      evidenceCount: entry.count,
      createdAt: new Date(entry.firstObservedAt).toISOString(),
      lastValidatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + FACT_TTL_MS).toISOString(),
      generation,
      value: entry.value
    }, generation);
    if (result?.status === 'active') this.counters.promotions += 1;
    if (result) this.store.notifyUpstreamsChange();
    return result || { status: 'stale_generation' };
  }

  resetFact(factId) {
    const removed = this.store.removeCompatibilityFact(factId);
    if (!removed) return false;
    this.clearObservations(removed.upstreamId, removed.key);
    this.store.notifyUpstreamsChange();
    return true;
  }

  reset() {
    const removed = this.store.clearCompatibilityFacts();
    this.observations.clear();
    if (removed) this.store.notifyUpstreamsChange();
    return removed;
  }

  status() {
    const records = this.store.compatibilityRecords({
      now: this.now(),
      fingerprints: this.fingerprints
    });
    return {
      passiveEnabled: this.passiveEnabled,
      fingerprints: Object.fromEntries(Object.entries(this.fingerprints).map(([provider, value]) => [
        provider,
        { version: value.version, hash: value.hash }
      ])),
      counts: {
        active: records.active.length,
        stale: records.stale.length,
        observations: this.observations.size
      },
      facts: records.active.map(sanitizeFact),
      counters: { ...this.counters }
    };
  }

  pruneObservations() {
    if (this.observations.size <= OBSERVATION_LIMIT) return;
    const overflow = [...this.observations.values()]
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .slice(OBSERVATION_LIMIT);
    for (const entry of overflow) this.observations.delete(entry.observationKey);
  }

  clearObservations(upstreamId, contextKey) {
    const prefix = `${upstreamId}:${contextKey}:`;
    for (const key of this.observations.keys()) {
      if (key.startsWith(prefix)) this.observations.delete(key);
    }
  }
}

function validEvidence(upstream, context, value, feature, responseClass) {
  if (!upstream || !['codex', 'compass'].includes(upstream.type) || context?.providerType !== upstream.type) return false;
  if (responseClass !== 'structured_rejection') return false;
  if (context.protocolFingerprintVersion !== PROTOCOL_FINGERPRINT_VERSION || !/^[a-f0-9]{32}$/.test(context.protocolFingerprintHash || '')) return false;
  if (feature?.startsWith('unsupported_field:')) {
    const field = feature.slice('unsupported_field:'.length);
    if (!isCompatibilityOptionalField(upstream.type, field, context.routeClass)) return false;
  }
  return validCompatibilityFeature(upstream.type, feature, value, context.routeClass);
}

function generationFor(upstream) {
  return {
    compatibilityEpoch: Math.max(1, Number(upstream?.compatibilityEpoch) || 1),
    modelCatalogEpoch: Math.max(1, Number(upstream?.modelCatalogEpoch) || 1)
  };
}

function sameGeneration(left, right) {
  return left?.compatibilityEpoch === right?.compatibilityEpoch
    && left?.modelCatalogEpoch === right?.modelCatalogEpoch;
}

function routeClassFor(sourcePath) {
  if (sourcePath === '/v1/messages') return 'messages';
  if (sourcePath === '/v1/responses/compact') return 'responses_compact';
  if (sourcePath === '/v1/chat/completions') return 'chat_completions';
  return 'responses';
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function sanitizeFact(record) {
  return {
    id: record.id,
    provider: record.providerType,
    route: record.routeClass,
    features: [
      ...(record.value?.adaptiveThinking === true ? ['adaptive_thinking'] : []),
      ...(record.value?.unsupportedFields || []).map((field) => `unsupported_field:${field}`)
    ],
    evidenceCount: record.evidenceCount,
    lastValidatedAt: record.lastValidatedAt,
    expiresAt: record.expiresAt,
    fingerprintHash: record.protocolFingerprintHash
  };
}

function envBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
