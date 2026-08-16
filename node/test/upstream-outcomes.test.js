import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHttpResponse,
  classifySseEvent,
  classifyTransportError,
  parseResetCooldownMs,
  parseRetryAfterMs,
  quotaCooldown
} from '../src/upstream-outcomes.js';

const NOW = Date.parse('2026-08-15T00:00:00Z');

test('classifies HTTP statuses without trusting contradictory body text', () => {
  const cases = [
    [200, { error: { code: 'rate_limit_exceeded' } }, 'success', false],
    [302, { error: { code: 'rate_limit_exceeded' } }, 'neutral', false],
    [400, { error: { code: 'rate_limit_exceeded' } }, 'caller', false],
    [400, { error: { code: 'model_not_found' } }, 'caller', true],
    [401, null, 'credential', true],
    [403, null, 'credential', true],
    [402, null, 'quota', true],
    [429, null, 'quota', true],
    [500, null, 'transient', true]
  ];
  for (const [status, body, expectedClass, retryable] of cases) {
    const outcome = classifyHttpResponse(new Response(null, { status }), body);
    assert.equal(outcome.class, expectedClass, `status ${status}`);
    assert.equal(outcome.retryable, retryable, `status ${status}`);
  }
});

test('classifies structured SSE and WebSocket terminal frames', () => {
  assert.equal(classifySseEvent({ type: 'response.completed' }).class, 'success');
  assert.equal(classifySseEvent({ type: 'response.failed', error: { code: 'rate_limit_exceeded' } }).class, 'quota');
  assert.equal(classifySseEvent({ type: 'error', error: { code: 'invalid_token' } }).class, 'credential');
  assert.equal(classifySseEvent({ type: 'response.failed', error: { code: 'model_not_found' } }).modelNotFound, true);
  assert.equal(classifySseEvent({ type: 'response.failed', error: { type: 'invalid_request_error' } }).class, 'caller');
  assert.equal(classifySseEvent({ type: 'response.output_text.delta' }).class, 'neutral');
});

test('keeps eligible misalignment policy failures non-retryable and health-neutral', () => {
  assert.deepEqual(classifyHttpResponse(new Response(null, { status: 403 }), {
    error: { code: 'misalignment_policy_violation', message: 'blocked' }
  }, {
    allowMisalignmentPolicy: true
  }), {
    class: 'neutral',
    retryable: false,
    status: 403,
    errorCode: 'misalignment_policy_violation'
  });
  assert.deepEqual(classifySseEvent({
    type: 'response.failed',
    response: { error: { code: 'misalignment_policy_violation' } }
  }, {
    allowMisalignmentPolicy: true
  }), {
    class: 'neutral',
    retryable: false,
    errorCode: 'misalignment_policy_violation'
  });
  assert.equal(classifyHttpResponse(new Response(null, { status: 403 }), {
    error: { code: 'misalignment_policy_violation' }
  }).class, 'credential');
  assert.equal(classifySseEvent({
    type: 'response.failed',
    response: { error: { code: 'misalignment_policy_violation' } }
  }).class, 'transient');
});

test('classifies bounded transport failures and cancellation', () => {
  assert.deepEqual(classifyTransportError(Object.assign(new Error('cancelled'), { upstreamFailureKind: 'cancelled' })), {
    class: 'neutral', retryable: false, transport: 'cancelled'
  });
  assert.equal(classifyTransportError(Object.assign(new Error('timeout'), { upstreamFailureKind: 'timeout' })).transport, 'timeout');
  const nested = new Error('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  assert.equal(classifyTransportError(nested).transport, 'ECONNRESET');
});

test('parses and clamps Retry-After values', () => {
  assert.equal(parseRetryAfterMs('1.25', NOW), 1_250);
  assert.equal(parseRetryAfterMs('0', NOW), 0);
  assert.equal(parseRetryAfterMs(new Date(NOW + 5_000).toUTCString(), NOW), 5_000);
  assert.equal(parseRetryAfterMs('-1', NOW), null);
  assert.equal(parseRetryAfterMs('not-a-date', NOW), null);
  assert.equal(parseRetryAfterMs('999999999', NOW), 24 * 60 * 60 * 1_000);
});

test('parses seconds and milliseconds reset timestamps with a tighter cap', () => {
  assert.equal(parseResetCooldownMs(String((NOW + 30_000) / 1_000), NOW), 30_000);
  assert.equal(parseResetCooldownMs(String(NOW + 45_000), NOW), 45_000);
  assert.equal(parseResetCooldownMs(String(NOW - 1), NOW), null);
  assert.equal(parseResetCooldownMs(String(NOW + 60 * 60 * 1_000), NOW), 15 * 60 * 1_000);
});

test('prefers explicit Retry-After, then reset metadata, then the default', () => {
  assert.deepEqual(quotaCooldown({ retryAfter: '2', resetAt: String(NOW + 10_000) }, NOW), {
    cooldownSource: 'retry-after', cooldownMs: 2_000, nextEligibleAt: NOW + 2_000
  });
  assert.deepEqual(quotaCooldown({ resetAt: String(NOW + 10_000) }, NOW), {
    cooldownSource: 'reset-derived', cooldownMs: 10_000, nextEligibleAt: NOW + 10_000
  });
  assert.deepEqual(quotaCooldown({}, NOW), {
    cooldownSource: 'default', cooldownMs: 60_000, nextEligibleAt: NOW + 60_000
  });
});
