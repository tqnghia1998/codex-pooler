import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithHeaderDeadline, readWithIdleDeadline } from '../src/upstream-deadlines.js';

test('aborts a header wait at an injected deadline', async () => {
  let aborted = false;
  await assert.rejects(
    fetchWithHeaderDeadline(async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
    }), 'https://example.invalid', {}, { headersMs: 5 }),
    (error) => error?.name === 'TimeoutError'
  );
  assert.equal(aborted, true);
});

test('aborts a stalled body read at an injected idle deadline', async () => {
  let cancelled = false;
  const reader = {
    read: () => new Promise(() => {}),
    cancel: () => { cancelled = true; }
  };
  await assert.rejects(readWithIdleDeadline(reader, { bodyIdleMs: 5 }), (error) => error?.name === 'TimeoutError');
  assert.equal(cancelled, true);
});

test('uses defaults for invalid injectable deadline values', async () => {
  const reader = { read: async () => ({ done: true }) };
  assert.deepEqual(await readWithIdleDeadline(reader, { bodyIdleMs: 0 }), { done: true });
});
