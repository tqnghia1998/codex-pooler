import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeChunk } from '../src/http-stream.js';

test('repeated streaming backpressure leaves no drain, close, or error listeners', async () => {
  const res = new EventEmitter();
  res.write = () => false;
  for (let index = 0; index < 100; index++) {
    const pending = writeChunk(res, 'chunk');
    res.emit('drain');
    await pending;
    for (const event of ['drain', 'close', 'error']) assert.equal(res.listenerCount(event), 0);
  }
});

test('closing or failing a blocked stream cleans up all waiters', async () => {
  for (const event of ['close', 'error']) {
    const res = new EventEmitter();
    res.write = () => false;
    const pending = writeChunk(res, 'chunk');
    const error = new Error('synthetic stream failure');
    res.emit(event, error);
    if (event === 'error') await assert.rejects(pending, error);
    else await pending;
    for (const name of ['drain', 'close', 'error']) assert.equal(res.listenerCount(name), 0);
  }
});

test('unblocked and already closed streams do not install waiters', async () => {
  const res = new EventEmitter();
  let writes = 0;
  res.write = () => { writes++; return true; };
  await writeChunk(res, 'chunk');
  res.destroyed = true;
  await writeChunk(res, 'ignored');
  assert.equal(writes, 1);
  assert.deepEqual(res.eventNames(), []);
});
