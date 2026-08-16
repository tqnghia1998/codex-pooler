const TRACE_LIMIT = 100;
const SUCCESS_LIMIT = 20;
const TIMING_NAMES = Object.freeze([
  'queueWaitMs',
  'credentialPreparationMs',
  'connectionMs',
  'firstResponseHeaderMs',
  'firstSseEventMs',
  'terminalCompletionMs'
]);
const diagnosticsByStore = new WeakMap();

export function gatewayDiagnosticsForStore(store) {
  let diagnostics = diagnosticsByStore.get(store);
  if (!diagnostics) {
    diagnostics = new GatewayDiagnostics();
    diagnosticsByStore.set(store, diagnostics);
  }
  return diagnostics;
}

export class GatewayDiagnostics {
  constructor({ now = () => performance.now(), traceLimit = TRACE_LIMIT, successLimit = SUCCESS_LIMIT } = {}) {
    this.now = now;
    this.traceLimit = traceLimit;
    this.successLimit = successLimit;
    this.traces = new Map();
    this.successes = [];
  }

  beginAttempt(attemptId, { endpoint = '', transport = '', startedAt = null } = {}) {
    if (!attemptId) return;
    this.traces.set(attemptId, {
      attemptId,
      endpoint: safeLabel(endpoint),
      transport: safeLabel(transport),
      startedAt,
      started: this.now(),
      credentialStarted: null,
      connectionStarted: null,
      timings: {}
    });
    while (this.traces.size > this.traceLimit) this.traces.delete(this.traces.keys().next().value);
  }

  credentialStarted(attemptId) {
    const trace = this.traces.get(attemptId);
    if (trace && trace.credentialStarted === null) trace.credentialStarted = this.now();
  }

  credentialPrepared(attemptId) {
    const trace = this.traces.get(attemptId);
    if (!trace || trace.credentialStarted === null) return;
    const elapsed = duration(this.now() - trace.credentialStarted);
    trace.timings.credentialPreparationMs = duration((trace.timings.credentialPreparationMs || 0) + elapsed);
    trace.credentialStarted = null;
  }

  queueWaited(attemptId, waitedMs) {
    const trace = this.traces.get(attemptId);
    if (trace) trace.timings.queueWaitMs = duration((trace.timings.queueWaitMs || 0) + duration(waitedMs));
  }

  connectionStarted(attemptId) {
    const trace = this.traces.get(attemptId);
    if (trace && trace.connectionStarted === null) trace.connectionStarted = this.now();
  }

  responseHeaders(attemptId) {
    const trace = this.traces.get(attemptId);
    if (!trace) return;
    if (trace.connectionStarted !== null && trace.timings.connectionMs === undefined) {
      trace.timings.connectionMs = duration(this.now() - trace.connectionStarted);
    }
    trace.timings.firstResponseHeaderMs ??= duration(this.now() - trace.started);
  }

  firstSseEvent(attemptId) {
    const trace = this.traces.get(attemptId);
    if (trace) trace.timings.firstSseEventMs ??= duration(this.now() - trace.started);
  }

  finishAttempt(attemptId, { status = 'failed', errorCode = null } = {}) {
    const trace = this.traces.get(attemptId);
    if (!trace) return {};
    this.credentialPrepared(attemptId);
    if (trace.connectionStarted !== null && trace.timings.connectionMs === undefined) {
      trace.timings.connectionMs = duration(this.now() - trace.connectionStarted);
    }
    trace.timings.terminalCompletionMs = duration(this.now() - trace.started);
    const timings = sanitizeAttemptTimings(trace.timings);
    this.traces.delete(attemptId);
    if (status === 'succeeded') {
      this.successes.push({
        endpoint: trace.endpoint,
        transport: trace.transport,
        completedAt: new Date().toISOString(),
        timings
      });
      this.successes = this.successes.slice(-this.successLimit);
    }
    return timings;
  }

  status() {
    return {
      activeAttemptCount: this.traces.size,
      recentSuccesses: this.successes.map((item) => ({ ...item, timings: { ...item.timings } }))
    };
  }
}

export function sanitizeAttemptTimings(value = {}) {
  return Object.fromEntries(TIMING_NAMES.flatMap((name) => {
    const timing = Number(value?.[name]);
    return Number.isFinite(timing) && timing >= 0 ? [[name, duration(timing)]] : [];
  }));
}

export function sanitizeExclusionReasons(value = []) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === 'string' && /^[a-z0-9][a-z0-9_.-]{0,79}$/.test(item))
    .slice(0, 32))];
}

function duration(value) {
  return Math.min(86_400_000, Math.max(0, Math.round(Number(value) || 0)));
}

function safeLabel(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9_./:-]{0,160}$/.test(text) ? text : '';
}
