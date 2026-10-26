import { normalizeUpstreamDeadlines, readWithIdleDeadline } from './upstream-deadlines.js';

const WEBSOCKET_OPEN = 1;

// Keep disconnect ownership until the provider body is consumed or cancelled.
export function downstreamAbortSignal(req, res, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Upstream request timed out', 'TimeoutError')), timeoutMs);
  const abort = () => controller.abort(Object.assign(new DOMException('Downstream request closed', 'AbortError'), { upstreamFailureKind: 'cancelled' }));
  req?.once('aborted', abort);
  res?.once('close', abort);
  if (req?.aborted || res?.destroyed || res?.readyState !== undefined && res.readyState !== WEBSOCKET_OPEN) abort();
  return {
    signal: controller.signal,
    headersReceived() { clearTimeout(timeout); },
    cleanup() {
      clearTimeout(timeout);
      req?.removeListener('aborted', abort);
      res?.removeListener('close', abort);
    }
  };
}

export function responseWithDownstreamAbort(response, abort) {
  const reader = response.body.getReader();
  let finished = false;
  const cleanup = () => {
    finished = true;
    abort.signal.removeEventListener('abort', cancelled);
    abort.cleanup();
    reader.releaseLock();
  };
  const cancel = (reason) => {
    // A tee branch may wait for its sibling; never block cleanup on cancel.
    void reader.cancel(reason).catch(() => {});
    cleanup();
  };
  let controller;
  const cancelled = () => {
    if (finished) return;
    controller.error(abort.signal.reason);
    cancel(abort.signal.reason);
  };
  const body = new ReadableStream({
    start(value) {
      controller = value;
      abort.signal.addEventListener('abort', cancelled, { once: true });
      if (abort.signal.aborted) cancelled();
    },
    async pull(value) {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) { value.close(); cleanup(); }
        else value.enqueue(next.value);
      } catch (error) {
        if (!finished) { value.error(error); cancel(error); }
      }
    },
    cancel(reason) { if (!finished) cancel(reason); }
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}


// Authentication errors are normally tiny JSON bodies. Bound both size and
// total time before releasing the connection; retain a complete body so its
// reported spend can be settled rather than discarded by a retry.
export async function collectRejectedResponse(response, deadlines = {}) {
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  let complete = !reader;
  const expiresAt = Date.now() + 1_000;
  const { bodyIdleMs } = normalizeUpstreamDeadlines(deadlines);
  try {
    while (reader && Date.now() < expiresAt) {
      const read = await readWithIdleDeadline(reader, { bodyIdleMs: Math.min(bodyIdleMs, Math.max(1, expiresAt - Date.now())) });
      if (read.done) { complete = true; break; }
      size += read.value.byteLength;
      if (size > 1024 * 1024) break;
      chunks.push(Buffer.from(read.value));
    }
  } catch (error) {
    if (error?.upstreamFailureKind === 'cancelled') throw error;
    // The HTTP rejection remains authoritative if its body is truncated.
  } finally {
    void reader?.cancel('Rejected response inspection finished').catch(() => {});
    reader?.releaseLock();
  }
  const bytes = complete ? Buffer.concat(chunks, size) : Buffer.alloc(0);
  return {
    bytes,
    response: new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
  };
}
