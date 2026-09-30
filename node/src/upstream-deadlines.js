export const DEFAULT_UPSTREAM_DEADLINES = Object.freeze({
  headersMs: 15_000,
  bodyIdleMs: 5 * 60_000
});

export function normalizeUpstreamDeadlines(value = {}) {
  return {
    headersMs: positiveTimeout(value.headersMs, DEFAULT_UPSTREAM_DEADLINES.headersMs),
    bodyIdleMs: positiveTimeout(value.bodyIdleMs, DEFAULT_UPSTREAM_DEADLINES.bodyIdleMs)
  };
}

export async function fetchWithHeaderDeadline(fetchImpl, url, options = {}, deadlines = {}) {
  const { headersMs } = normalizeUpstreamDeadlines(deadlines);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason || new DOMException('Upstream request aborted', 'AbortError'));
  const timer = setTimeout(() => controller.abort(new DOMException('Upstream headers timed out', 'TimeoutError')), headersMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function readWithIdleDeadline(reader, deadlines = {}) {
  const { bodyIdleMs } = normalizeUpstreamDeadlines(deadlines);
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          void Promise.resolve(reader.cancel?.('Upstream response body timed out')).catch(() => {});
          reject(new DOMException('Upstream response body timed out', 'TimeoutError'));
        }, bodyIdleMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function positiveTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
