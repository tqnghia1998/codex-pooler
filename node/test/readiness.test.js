import test from 'node:test';
import assert from 'node:assert/strict';
import { Readiness, readyReadiness } from '../src/readiness.js';

test('readiness reports pending, ready, and failed without details', () => {
  const readiness = new Readiness({ storage: 'ready', apiKey: 'ready' });
  assert.deepEqual(readiness.status(), {
    status: 'pending',
    checks: {
      storage: 'ready',
      apiKey: 'ready',
      tokenRecovery: 'pending',
      quotaRefresh: 'pending',
      modelCatalog: 'pending'
    }
  });
  readiness.set('tokenRecovery', 'degraded');
  readiness.set('quotaRefresh', 'ready');
  readiness.set('modelCatalog', 'degraded');
  assert.equal(readiness.status().status, 'ready');
  readiness.set('storage', 'failed');
  assert.equal(readiness.status().status, 'failed');
  assert.throws(() => readiness.set('storage', 'secret path'), /Invalid readiness state/);
});

test('readyReadiness is immediately ready for directly constructed apps', () => {
  assert.equal(readyReadiness().status().status, 'ready');
});
