import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshQueue } from '../ui/refresh-queue.js';

test('background refreshes share one pending operation', async () => {
  const refresh = createRefreshQueue();
  let release;
  let calls = 0;
  const task = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  const pending = refresh(task);
  assert.equal(refresh(task, { background: true }), pending);
  await Promise.resolve();
  await Promise.resolve();
  release('done');
  assert.equal(await pending, 'done');
  assert.equal(calls, 1);
});

test('an explicit refresh after a mutation waits then reads fresh data', async () => {
  const refresh = createRefreshQueue();
  let release;
  const order = [];
  const before = refresh(() => new Promise((resolve) => {
    release = () => { order.push('before'); resolve(); };
  }));
  const after = refresh(() => { order.push('after'); return 'fresh'; });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, []);
  release();
  await before;
  assert.equal(await after, 'fresh');
  assert.deepEqual(order, ['before', 'after']);
});

test('failed work does not block subsequent refreshes', async () => {
  const refresh = createRefreshQueue();
  const failed = refresh(() => { throw new Error('synthetic failure'); });
  const recovered = refresh(() => 'recovered');
  await assert.rejects(failed, /synthetic failure/);
  assert.equal(await recovered, 'recovered');
  assert.equal(await refresh(() => 'next'), 'next');
});
