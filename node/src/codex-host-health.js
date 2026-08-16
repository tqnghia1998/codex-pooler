const PRECONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH'
]);
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_FAILURE_WINDOW_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 15_000;
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_CAUSE_DEPTH = 5;
const hostHealthByStore = new WeakMap();

export class CodexHostHealth {
  constructor({
    enabled = true,
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    failureWindowMs = DEFAULT_FAILURE_WINDOW_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxCauseDepth = DEFAULT_MAX_CAUSE_DEPTH,
    now = () => Date.now()
  } = {}) {
    this.enabled = Boolean(enabled);
    this.failureThreshold = boundedInteger(failureThreshold, DEFAULT_FAILURE_THRESHOLD, 1, 10);
    this.failureWindowMs = boundedInteger(failureWindowMs, DEFAULT_FAILURE_WINDOW_MS, 1_000, 5 * 60_000);
    this.cooldownMs = boundedInteger(cooldownMs, DEFAULT_COOLDOWN_MS, 1_000, 5 * 60_000);
    this.maxEntries = boundedInteger(maxEntries, DEFAULT_MAX_ENTRIES, 1, 256);
    this.maxCauseDepth = boundedInteger(maxCauseDepth, DEFAULT_MAX_CAUSE_DEPTH, 1, 10);
    this.now = now;
    this.entries = new Map();
    this.nextGeneration = 1;
  }

  begin(url, now = this.now()) {
    if (!this.enabled) return { admitted: true, lease: null };
    const origin = normalizeCodexOrigin(url);
    if (!origin) return { admitted: true, lease: null };
    const entry = this.entryFor(origin, now);
    this.trimFailures(entry, now);
    entry.lastUsedAt = now;

    if (entry.state === 'open') {
      if (entry.openUntil > now || entry.probeInFlight) {
        return blockedAdmission(entry, now);
      }
      entry.probeInFlight = true;
      return {
        admitted: true,
        lease: leaseFor(entry, true)
      };
    }
    return {
      admitted: true,
      lease: leaseFor(entry, false)
    };
  }

  settleResponse(lease, now = this.now()) {
    if (!this.currentLease(lease)) return false;
    const entry = this.entries.get(lease.origin);
    lease.settled = true;
    entry.state = 'closed';
    entry.failures = [];
    entry.openUntil = 0;
    entry.probeInFlight = false;
    entry.generation = this.nextGeneration++;
    entry.lastUsedAt = now;
    return true;
  }

  settleError(lease, error, now = this.now()) {
    if (!lease) return { preconnect: false, open: false, retryAfterSeconds: null };
    const code = provenPreconnectCode(error, this.maxCauseDepth);
    if (!code) {
      this.release(lease, now);
      return { preconnect: false, open: false, retryAfterSeconds: null };
    }
    if (!this.currentLease(lease)) {
      return { preconnect: true, code, open: false, stale: true, retryAfterSeconds: null };
    }

    const entry = this.entries.get(lease.origin);
    lease.settled = true;
    entry.lastUsedAt = now;
    this.trimFailures(entry, now);
    entry.failures.push(now);
    if (entry.failures.length > this.failureThreshold) {
      entry.failures = entry.failures.slice(-this.failureThreshold);
    }
    if (lease.probe) {
      entry.generation = this.nextGeneration++;
      entry.state = 'open';
      entry.openUntil = now + this.cooldownMs;
      entry.probeInFlight = false;
    } else if (entry.failures.length >= this.failureThreshold) {
      entry.state = 'open';
      entry.openUntil = now + this.cooldownMs;
      entry.probeInFlight = false;
    }
    this.prune();
    return {
      preconnect: true,
      code,
      open: entry.state === 'open',
      retryAfterSeconds: entry.state === 'open' ? retryAfterSeconds(entry, now) : null
    };
  }

  release(lease, now = this.now()) {
    if (!this.currentLease(lease)) return false;
    const entry = this.entries.get(lease.origin);
    lease.settled = true;
    if (lease.probe) entry.probeInFlight = false;
    entry.lastUsedAt = now;
    return true;
  }

  status(now = this.now()) {
    this.reconcile(now);
    const entries = [...this.entries.values()];
    const open = entries.filter((entry) => entry.state === 'open');
    const nextRetryAt = open
      .map((entry) => entry.openUntil)
      .filter((timestamp) => timestamp > now)
      .sort((left, right) => left - right)[0];
    return {
      enabled: this.enabled,
      failureThreshold: this.failureThreshold,
      failureWindowMs: this.failureWindowMs,
      cooldownMs: this.cooldownMs,
      maxEntries: this.maxEntries,
      trackedOriginCount: entries.length,
      openOriginCount: open.length,
      halfOpenProbeCount: open.filter((entry) => entry.probeInFlight).length,
      nextRetryAt: nextRetryAt ? new Date(nextRetryAt).toISOString() : null
    };
  }

  entryFor(origin, now) {
    let entry = this.entries.get(origin);
    if (!entry) {
      entry = {
        origin,
        generation: this.nextGeneration++,
        state: 'closed',
        failures: [],
        openUntil: 0,
        probeInFlight: false,
        lastUsedAt: now
      };
      this.entries.set(origin, entry);
      this.prune();
    }
    return entry;
  }

  currentLease(lease) {
    if (!lease || lease.settled) return false;
    const entry = this.entries.get(lease.origin);
    return Boolean(entry && entry.generation === lease.generation);
  }

  trimFailures(entry, now) {
    const cutoff = now - this.failureWindowMs;
    entry.failures = entry.failures.filter((timestamp) => timestamp >= cutoff && timestamp <= now);
  }

  reconcile(now) {
    for (const entry of this.entries.values()) this.trimFailures(entry, now);
    this.prune();
  }

  prune() {
    if (this.entries.size <= this.maxEntries) return;
    const removable = [...this.entries.values()]
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.origin.localeCompare(right.origin));
    for (const entry of removable.slice(0, this.entries.size - this.maxEntries)) {
      this.entries.delete(entry.origin);
    }
  }
}

export class CodexHostUnavailableError extends Error {
  constructor(retryAfterSeconds, cause = null) {
    super('Codex host is temporarily unreachable', cause ? { cause } : undefined);
    this.name = 'CodexHostUnavailableError';
    this.statusCode = 503;
    this.code = 'codex_host_unavailable';
    this.retryAfterSeconds = Math.max(1, Number(retryAfterSeconds) || 1);
    this.codexHostCircuitOpen = true;
  }
}

export function codexHostHealthForStore(store) {
  let health = hostHealthByStore.get(store);
  if (!health) {
    health = new CodexHostHealth();
    hostHealthByStore.set(store, health);
  }
  return health;
}

export function codexHostHealthOptionsFromEnv(env = process.env) {
  return {
    enabled: envBoolean(env.CODEX_POOLER_CODEX_HOST_CIRCUIT_ENABLED, true),
    failureThreshold: envInteger(env.CODEX_POOLER_CODEX_HOST_FAILURE_THRESHOLD),
    failureWindowMs: envInteger(env.CODEX_POOLER_CODEX_HOST_FAILURE_WINDOW_MS),
    cooldownMs: envInteger(env.CODEX_POOLER_CODEX_HOST_COOLDOWN_MS),
    maxEntries: envInteger(env.CODEX_POOLER_CODEX_HOST_MAX_ENTRIES)
  };
}

export function normalizeCodexOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function provenPreconnectCode(error, maxDepth = DEFAULT_MAX_CAUSE_DEPTH) {
  let current = error;
  const seen = new Set();
  for (let depth = 0; current && depth < maxDepth && !seen.has(current); depth += 1) {
    seen.add(current);
    const code = typeof current.code === 'string' && current.code.length <= 64
      ? current.code.toUpperCase()
      : '';
    if (PRECONNECT_CODES.has(code)) return code;
    current = current.cause;
  }
  return null;
}

export async function withCodexHostHealth(health, url, operation) {
  if (!health) return operation();
  const admission = health.begin(url);
  if (!admission.admitted) throw new CodexHostUnavailableError(admission.retryAfterSeconds);
  try {
    const response = await operation();
    health.settleResponse(admission.lease);
    return response;
  } catch (error) {
    const result = health.settleError(admission.lease, error);
    if (result.preconnect) {
      if (result.open) {
        throw new CodexHostUnavailableError(result.retryAfterSeconds, error);
      }
      const tagged = new Error('Codex host pre-connect attempt failed', { cause: error });
      tagged.codexHostPreconnect = true;
      tagged.codexHostPreconnectCode = result.code;
      throw tagged;
    }
    throw error;
  }
}

function leaseFor(entry, probe) {
  return {
    origin: entry.origin,
    generation: entry.generation,
    probe,
    settled: false
  };
}

function blockedAdmission(entry, now) {
  return {
    admitted: false,
    lease: null,
    retryAfterSeconds: retryAfterSeconds(entry, now)
  };
}

function retryAfterSeconds(entry, now) {
  return Math.max(1, Math.ceil(Math.max(0, entry.openUntil - now) / 1_000));
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function envInteger(value) {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function envBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())) return false;
  return fallback;
}
