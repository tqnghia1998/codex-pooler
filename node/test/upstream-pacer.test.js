import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { PacingError, UpstreamPacer, normalizePacingPolicy } from '../src/upstream-pacer.js';

function fixture(policy = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relaydeck-pacer-'));
  const store = new Store(dir);
  const upstream = store.create({
    type: 'compass',
    projectId: 'paced',
    projectKey: 'secret',
    pacing: { enabled: true, minStartIntervalMs: 100, maxQueueDepth: 2, maxQueueAgeMs: 500, ...policy }
  });
  return { dir, store, upstream };
}

test('normalizes bounded opt-in pacing policies', () => {
  assert.deepEqual(normalizePacingPolicy(), {
    enabled: false,
    minStartIntervalMs: 0,
    modelIntervals: [],
    maxQueueDepth: 20,
    maxQueueAgeMs: 30_000
  });
  assert.deepEqual(normalizePacingPolicy({
    enabled: true,
    minStartIntervalMs: 20,
    modelIntervals: [{ model: 'GPT-X', minStartIntervalMs: 50 }],
    maxQueueDepth: 3,
    maxQueueAgeMs: 1_000
  }).modelIntervals, [{ model: 'gpt-x', minStartIntervalMs: 50 }]);
  assert.throws(() => normalizePacingPolicy({ maxQueueDepth: 0 }), /maxQueueDepth/);
  assert.throws(() => normalizePacingPolicy({ modelIntervals: [{ model: 'bad model', minStartIntervalMs: 1 }] }), /valid model ID/);
});

test('spaces starts, avoids model head-of-line blocking, and reports sanitized status', async () => {
  const { dir, store, upstream } = fixture({
    minStartIntervalMs: 0,
    modelIntervals: [{ model: 'slow', minStartIntervalMs: 100 }]
  });
  let now = 1_000;
  const timers = [];
  const pacer = new UpstreamPacer(store, {
    now: () => now,
    setTimer: (callback, delay) => {
      const timer = { callback, at: now + delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index !== -1) timers.splice(index, 1);
    }
  });
  try {
    await pacer.acquire(upstream.id, { model: 'slow' });
    const slow = pacer.acquire(upstream.id, { model: 'slow' });
    const fast = pacer.acquire(upstream.id, { model: 'fast' });
    await fast;
    assert.equal(pacer.status()[0].queueDepth, 1);
    assert.deepEqual(Object.keys(pacer.status()[0]).sort(), ['lastStartAt', 'nextSlotAt', 'queueDepth', 'upstreamId']);
    now = 1_100;
    timers.splice(0).forEach(({ callback }) => callback());
    await slow;
  } finally {
    pacer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bounds queues, expires waits, and cancels without recording an upstream outcome', async () => {
  const { dir, store, upstream } = fixture({ maxQueueDepth: 1, maxQueueAgeMs: 100 });
  try {
    const pacer = new UpstreamPacer(store);
    await pacer.acquire(upstream.id);
    const controller = new AbortController();
    const queued = pacer.acquire(upstream.id, { signal: controller.signal });
    await assert.rejects(pacer.acquire(upstream.id), (error) => error instanceof PacingError && error.code === 'queue_full' && error.statusCode === 429);
    controller.abort();
    await assert.rejects(queued, (error) => error.code === 'aborted');
    assert.equal(store.get(upstream.id).health, undefined);
    pacer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expires queued work at the configured age with a computed retry delay', async () => {
  const { dir, store, upstream } = fixture({ minStartIntervalMs: 500, maxQueueAgeMs: 100 });
  let now = 1_000;
  const timers = [];
  const pacer = new UpstreamPacer(store, {
    now: () => now,
    setTimer: (callback, delay) => {
      const timer = { callback, at: now + delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index !== -1) timers.splice(index, 1);
    }
  });
  try {
    await pacer.acquire(upstream.id);
    const queued = pacer.acquire(upstream.id);
    now = 1_100;
    timers.splice(0).forEach(({ callback }) => callback());
    await assert.rejects(queued, (error) => (
      error instanceof PacingError
      && error.code === 'queue_expired'
      && error.statusCode === 429
      && error.retryAfterSeconds === 1
    ));
    assert.equal(store.get(upstream.id).health, undefined);
  } finally {
    pacer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wakes queued work on config changes and rejects it on account deletion', async () => {
  const { dir, store, upstream } = fixture();
  const pacer = new UpstreamPacer(store);
  try {
    await pacer.acquire(upstream.id);
    const released = pacer.acquire(upstream.id);
    store.update(upstream.id, { pacing: { enabled: false } });
    await released;

    store.update(upstream.id, { pacing: { enabled: true, minStartIntervalMs: 100, maxQueueDepth: 2, maxQueueAgeMs: 500 } });
    await pacer.acquire(upstream.id);
    const removed = pacer.acquire(upstream.id);
    store.remove(upstream.id);
    await assert.rejects(removed, (error) => error.code === 'account_removed');
  } finally {
    pacer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
