const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  minStartIntervalMs: 0,
  modelIntervals: [],
  maxQueueDepth: 20,
  maxQueueAgeMs: 30_000
});
const MAX_MODEL_INTERVALS = 64;
const MAX_INTERVAL_MS = 5 * 60_000;
const MIN_QUEUE_AGE_MS = 100;
const MAX_QUEUE_AGE_MS = 10 * 60_000;
const MAX_QUEUE_DEPTH = 100;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const pacersByStore = new WeakMap();

export class PacingError extends Error {
  constructor(code, retryAfterSeconds = 1) {
    super(code === 'queue_full'
      ? 'Local pacing queue is full'
      : code === 'queue_expired'
        ? 'Local pacing queue wait expired'
        : code === 'account_removed'
          ? 'Upstream was removed while waiting for local pacing'
          : 'Local pacing wait was cancelled');
    this.name = 'PacingError';
    this.code = code;
    this.statusCode = code === 'aborted' ? 499 : 429;
    this.retryAfterSeconds = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 1));
  }
}

export function normalizePacingPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pacing must be an object');
  const enabled = value.enabled === undefined ? DEFAULT_POLICY.enabled : Boolean(value.enabled);
  const minStartIntervalMs = boundedInteger(value.minStartIntervalMs, DEFAULT_POLICY.minStartIntervalMs, 0, MAX_INTERVAL_MS, 'minStartIntervalMs');
  const maxQueueDepth = boundedInteger(value.maxQueueDepth, DEFAULT_POLICY.maxQueueDepth, 1, MAX_QUEUE_DEPTH, 'maxQueueDepth');
  const maxQueueAgeMs = boundedInteger(value.maxQueueAgeMs, DEFAULT_POLICY.maxQueueAgeMs, MIN_QUEUE_AGE_MS, MAX_QUEUE_AGE_MS, 'maxQueueAgeMs');
  const inputIntervals = value.modelIntervals === undefined ? [] : value.modelIntervals;
  if (!Array.isArray(inputIntervals) || inputIntervals.length > MAX_MODEL_INTERVALS) {
    throw new Error(`modelIntervals must be an array with at most ${MAX_MODEL_INTERVALS} entries`);
  }
  const models = new Map();
  for (const entry of inputIntervals) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('modelIntervals entries must be objects');
    const model = String(entry.model || '').trim().toLowerCase();
    if (!MODEL_PATTERN.test(model)) throw new Error('pacing model must be a valid model ID');
    const interval = boundedInteger(entry.minStartIntervalMs, 0, 0, MAX_INTERVAL_MS, 'model minStartIntervalMs');
    models.set(model, interval);
  }
  return {
    enabled,
    minStartIntervalMs,
    modelIntervals: [...models.entries()].map(([model, interval]) => ({ model, minStartIntervalMs: interval })),
    maxQueueDepth,
    maxQueueAgeMs
  };
}

export function upstreamPacerForStore(store) {
  let pacer = pacersByStore.get(store);
  if (!pacer || pacer.closed) {
    pacer = new UpstreamPacer(store);
    pacersByStore.set(store, pacer);
  }
  return pacer;
}

export class UpstreamPacer {
  constructor(store, {
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer)
  } = {}) {
    this.store = store;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.states = new Map();
    this.sequence = 1;
    this.closed = false;
    this.unsubscribe = store.onUpstreamsChange(() => this.reconcile());
  }

  acquire(upstreamId, { model = '', signal = null, queue = true } = {}) {
    if (this.closed) return Promise.reject(new PacingError('aborted'));
    const upstream = this.store.get(upstreamId);
    if (!upstream) return Promise.reject(new PacingError('account_removed'));
    const policy = normalizePacingPolicy(upstream.pacing);
    if (!policy.enabled) return Promise.resolve(this.started(upstreamId, model, policy));
    if (signal?.aborted) return Promise.reject(new PacingError('aborted'));

    const state = this.stateFor(upstreamId);
    const now = this.now();
    this.expire(state, policy, now);
    const eligibleAt = this.eligibleAt(state, policy, model);
    if (!state.queue.length && eligibleAt <= now) return Promise.resolve(this.started(upstreamId, model, policy, now));
    if (!queue) return Promise.reject(new PacingError('would_wait', retryAfterSeconds(eligibleAt, now)));
    if (state.queue.length >= policy.maxQueueDepth) {
      return Promise.reject(new PacingError('queue_full', retryAfterSeconds(this.nextSlotAt(state, policy, now), now)));
    }

    return new Promise((resolve, reject) => {
      const entry = {
        sequence: this.sequence++,
        model: normalizeModel(model),
        enqueuedAt: now,
        signal,
        resolve,
        reject,
        abort: null
      };
      if (signal) {
        entry.abort = () => {
          this.removeEntry(state, entry);
          reject(new PacingError('aborted'));
          this.schedule(state);
        };
        signal.addEventListener('abort', entry.abort, { once: true });
      }
      state.queue.push(entry);
      this.schedule(state);
    });
  }

  status() {
    this.reconcile();
    const now = this.now();
    return [...this.states.entries()].flatMap(([upstreamId, state]) => {
      const upstream = this.store.get(upstreamId);
      if (!upstream) return [];
      const policy = normalizePacingPolicy(upstream.pacing);
      if (!policy.enabled && !state.queue.length && state.lastStartAt === null) return [];
      return [{
        upstreamId,
        queueDepth: state.queue.length,
        nextSlotAt: state.queue.length ? new Date(this.nextSlotAt(state, policy, now)).toISOString() : null,
        lastStartAt: state.lastStartAt === null ? null : new Date(state.lastStartAt).toISOString()
      }];
    }).sort((left, right) => left.upstreamId.localeCompare(right.upstreamId));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    for (const state of this.states.values()) {
      if (state.timer) this.clearTimer(state.timer);
      for (const entry of state.queue.splice(0)) this.rejectEntry(entry, new PacingError('aborted'));
    }
    this.states.clear();
  }

  reconcile() {
    if (this.closed) return;
    const ids = new Set(this.store.list().map(({ id }) => id));
    for (const [upstreamId, state] of this.states) {
      if (!ids.has(upstreamId)) {
        if (state.timer) this.clearTimer(state.timer);
        for (const entry of state.queue.splice(0)) this.rejectEntry(entry, new PacingError('account_removed'));
        this.states.delete(upstreamId);
        continue;
      }
      this.schedule(state);
    }
  }

  stateFor(upstreamId) {
    let state = this.states.get(upstreamId);
    if (!state) {
      state = { upstreamId, queue: [], lastStartAt: null, modelStarts: new Map(), timer: null };
      this.states.set(upstreamId, state);
    }
    return state;
  }

  started(upstreamId, model, policy, now = this.now()) {
    if (!policy.enabled) return { startedAt: new Date(now).toISOString(), waitedMs: 0 };
    const state = this.stateFor(upstreamId);
    state.lastStartAt = now;
    const normalizedModel = normalizeModel(model);
    if (modelInterval(policy, normalizedModel) > 0) state.modelStarts.set(normalizedModel, now);
    return { startedAt: new Date(now).toISOString(), waitedMs: 0 };
  }

  eligibleAt(state, policy, model) {
    const accountAt = state.lastStartAt === null ? 0 : state.lastStartAt + policy.minStartIntervalMs;
    const normalizedModel = normalizeModel(model);
    const lastModelStart = state.modelStarts.get(normalizedModel);
    const modelAt = lastModelStart === undefined ? 0 : lastModelStart + modelInterval(policy, normalizedModel);
    return Math.max(accountAt, modelAt);
  }

  nextSlotAt(state, policy, now) {
    if (!state.queue.length) return Math.max(now, state.lastStartAt === null ? now : state.lastStartAt + policy.minStartIntervalMs);
    return Math.max(now, Math.min(...state.queue.map((entry) => this.eligibleAt(state, policy, entry.model))));
  }

  schedule(state) {
    if (state.timer) {
      this.clearTimer(state.timer);
      state.timer = null;
    }
    const upstream = this.store.get(state.upstreamId);
    if (!upstream) return this.reconcile();
    const policy = normalizePacingPolicy(upstream.pacing);
    const now = this.now();
    this.pruneModelStarts(state, policy);
    if (!policy.enabled) {
      for (const entry of state.queue.splice(0)) {
        this.resolveEntry(entry, { startedAt: new Date(now).toISOString(), waitedMs: now - entry.enqueuedAt });
      }
      this.states.delete(state.upstreamId);
      return;
    }
    this.expire(state, policy, now);
    if (!state.queue.length) return;
    const ready = state.queue
      .map((entry) => ({ entry, eligibleAt: this.eligibleAt(state, policy, entry.model) }))
      .filter(({ eligibleAt }) => eligibleAt <= now)
      .sort((left, right) => left.eligibleAt - right.eligibleAt || left.entry.sequence - right.entry.sequence)[0];
    if (ready) {
      this.removeEntry(state, ready.entry);
      state.lastStartAt = now;
      if (modelInterval(policy, ready.entry.model) > 0) state.modelStarts.set(ready.entry.model, now);
      this.resolveEntry(ready.entry, { startedAt: new Date(now).toISOString(), waitedMs: now - ready.entry.enqueuedAt });
      queueMicrotask(() => this.schedule(state));
      return;
    }
    const nextAt = Math.min(
      ...state.queue.map((entry) => Math.min(entry.enqueuedAt + policy.maxQueueAgeMs, this.eligibleAt(state, policy, entry.model)))
    );
    state.timer = this.setTimer(() => {
      state.timer = null;
      this.schedule(state);
    }, Math.max(0, nextAt - now));
    state.timer?.unref?.();
  }

  expire(state, policy, now) {
    for (const entry of [...state.queue]) {
      if (entry.enqueuedAt + policy.maxQueueAgeMs > now) continue;
      this.removeEntry(state, entry);
      this.rejectEntry(entry, new PacingError('queue_expired', retryAfterSeconds(this.eligibleAt(state, policy, entry.model), now)));
    }
  }

  pruneModelStarts(state, policy) {
    const configured = new Set(policy.modelIntervals.filter(({ minStartIntervalMs }) => minStartIntervalMs > 0).map(({ model }) => model));
    for (const model of state.modelStarts.keys()) {
      if (!configured.has(model)) state.modelStarts.delete(model);
    }
  }

  removeEntry(state, entry) {
    const index = state.queue.indexOf(entry);
    if (index !== -1) state.queue.splice(index, 1);
    if (entry.abort) entry.signal?.removeEventListener('abort', entry.abort);
  }

  resolveEntry(entry, value) {
    if (entry.abort) entry.signal?.removeEventListener('abort', entry.abort);
    entry.resolve(value);
  }

  rejectEntry(entry, error) {
    if (entry.abort) entry.signal?.removeEventListener('abort', entry.abort);
    entry.reject(error);
  }
}

function modelInterval(policy, model) {
  return policy.modelIntervals.find((entry) => entry.model === model)?.minStartIntervalMs || 0;
}

function normalizeModel(model) {
  return String(model || '').trim().toLowerCase();
}

function retryAfterSeconds(eligibleAt, now) {
  return Math.max(1, Math.ceil(Math.max(0, eligibleAt - now) / 1_000));
}

function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return number;
}
