import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayDiagnostics, sanitizeAttemptTimings, sanitizeExclusionReasons } from '../src/gateway-diagnostics.js';

test('records sanitized attempt phase durations and keeps successes in memory only', () => {
  let now = 10;
  const diagnostics = new GatewayDiagnostics({ now: () => now });
  diagnostics.beginAttempt('attempt', { endpoint: '/v1/responses', transport: 'http_sse' });
  diagnostics.credentialStarted('attempt');
  now = 15;
  diagnostics.credentialPrepared('attempt');
  diagnostics.queueWaited('attempt', 7.8);
  diagnostics.connectionStarted('attempt');
  now = 31;
  diagnostics.responseHeaders('attempt');
  now = 45;
  diagnostics.firstSseEvent('attempt');
  now = 70;
  assert.deepEqual(diagnostics.finishAttempt('attempt', { status: 'succeeded' }), {
    queueWaitMs: 8,
    credentialPreparationMs: 5,
    connectionMs: 16,
    firstResponseHeaderMs: 21,
    firstSseEventMs: 35,
    terminalCompletionMs: 60
  });
  assert.equal(diagnostics.status().activeAttemptCount, 0);
  assert.equal(diagnostics.status().recentSuccesses.length, 1);
});

test('sanitizes timings and exclusion reason codes', () => {
  assert.deepEqual(sanitizeAttemptTimings({
    queueWaitMs: 2.4,
    connectionMs: -1,
    terminalCompletionMs: Infinity,
    hostname: 'sensitive.example'
  }), { queueWaitMs: 2 });
  assert.deepEqual(sanitizeExclusionReasons([
    'quota_exhausted',
    'quota_exhausted',
    'bad token value',
    'model_not_supported'
  ]), ['quota_exhausted', 'model_not_supported']);
});
