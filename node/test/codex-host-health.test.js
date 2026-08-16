import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodexHostHealth,
  normalizeCodexOrigin,
  provenPreconnectCode,
  withCodexHostHealth
} from '../src/codex-host-health.js';

const ORIGIN = 'https://chatgpt.com/backend-api/codex/responses';

function codedError(code, cause = null) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

test('normalizes HTTP and WebSocket Codex origins', () => {
  assert.equal(normalizeCodexOrigin('https://chatgpt.com/backend-api/codex/responses'), 'https://chatgpt.com');
  assert.equal(normalizeCodexOrigin('wss://chatgpt.com/backend-api/codex/responses'), 'https://chatgpt.com');
  assert.equal(normalizeCodexOrigin('ws://localhost:8080/path'), 'http://localhost:8080');
  assert.equal(normalizeCodexOrigin('file:///tmp/socket'), null);
  assert.equal(normalizeCodexOrigin('not a url'), null);
});

test('recognizes only bounded proven pre-connect cause codes', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH']) {
    assert.equal(provenPreconnectCode(codedError(code)), code);
    assert.equal(provenPreconnectCode(new Error('outer', { cause: codedError(code) })), code);
  }
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'CERT_HAS_EXPIRED', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.equal(provenPreconnectCode(codedError(code)), null);
  }
  const tooDeep = new Error('0', {
    cause: new Error('1', {
      cause: new Error('2', {
        cause: new Error('3', {
          cause: new Error('4', { cause: codedError('ENOTFOUND') })
        })
      })
    })
  });
  assert.equal(provenPreconnectCode(tooDeep), null);
  const cyclic = codedError('UNKNOWN');
  cyclic.cause = cyclic;
  assert.equal(provenPreconnectCode(cyclic), null);
  assert.equal(provenPreconnectCode(Object.assign(new Error('misleading ENOTFOUND text'), { code: 123 })), null);
});

test('opens after bounded failures and admits one generation-fenced half-open probe', () => {
  let now = 1_000;
  const health = new CodexHostHealth({
    now: () => now,
    failureThreshold: 2,
    failureWindowMs: 1_000,
    cooldownMs: 1_000
  });
  const first = health.begin(ORIGIN).lease;
  assert.deepEqual(health.settleError(first, codedError('ENOTFOUND')), {
    preconnect: true,
    code: 'ENOTFOUND',
    open: false,
    retryAfterSeconds: null
  });
  now += 100;
  const second = health.begin(ORIGIN).lease;
  const opened = health.settleError(second, codedError('EAI_AGAIN'));
  assert.equal(opened.open, true);
  assert.equal(opened.retryAfterSeconds, 1);
  assert.deepEqual(health.begin(ORIGIN), { admitted: false, lease: null, retryAfterSeconds: 1 });

  now += 1_000;
  const probe = health.begin(ORIGIN);
  assert.equal(probe.admitted, true);
  assert.equal(probe.lease.probe, true);
  assert.equal(health.begin(ORIGIN).admitted, false);
  health.settleError(probe.lease, codedError('ENETUNREACH'));
  assert.equal(health.begin(ORIGIN).admitted, false);

  now += 1_000;
  const recovery = health.begin(ORIGIN);
  assert.equal(recovery.lease.probe, true);
  assert.equal(health.settleResponse(recovery.lease), true);
  assert.equal(health.begin(ORIGIN).admitted, true);
  assert.equal(health.status().openOriginCount, 0);
});

test('an HTTP response clears reachability evidence and fences stale sibling leases', () => {
  let now = 10_000;
  const health = new CodexHostHealth({
    now: () => now,
    failureThreshold: 2,
    failureWindowMs: 10_000,
    cooldownMs: 1_000
  });
  const failed = health.begin(ORIGIN).lease;
  health.settleError(failed, codedError('ENOTFOUND'));

  const responseLease = health.begin(ORIGIN).lease;
  const staleFailure = health.begin(ORIGIN).lease;
  assert.equal(health.settleResponse(responseLease), true);
  assert.deepEqual(health.settleError(staleFailure, codedError('ENOTFOUND')), {
    preconnect: true,
    code: 'ENOTFOUND',
    open: false,
    stale: true,
    retryAfterSeconds: null
  });
  now += 1;
  const next = health.begin(ORIGIN).lease;
  assert.equal(health.settleError(next, codedError('ENOTFOUND')).open, false);
});

test('any real HTTP response closes host evidence, including an error status', async () => {
  const health = new CodexHostHealth({ failureThreshold: 2 });
  health.settleError(health.begin(ORIGIN).lease, codedError('ENOTFOUND'));
  const response = await withCodexHostHealth(health, ORIGIN, async () => new Response('unavailable', { status: 500 }));
  assert.equal(response.status, 500);
  const failure = health.settleError(health.begin(ORIGIN).lease, codedError('ENOTFOUND'));
  assert.equal(failure.open, false);
});

test('expires failure windows, ignores neutral transport failures, and bounds entries', () => {
  let now = 0;
  const health = new CodexHostHealth({
    now: () => now,
    failureThreshold: 2,
    failureWindowMs: 1_000,
    cooldownMs: 1_000,
    maxEntries: 2
  });
  let lease = health.begin('https://one.example/path').lease;
  health.settleError(lease, codedError('ENOTFOUND'));
  now = 1_001;
  lease = health.begin('https://one.example/path').lease;
  assert.equal(health.settleError(lease, codedError('ENOTFOUND')).open, false);
  lease = health.begin('https://two.example/path').lease;
  assert.deepEqual(health.settleError(lease, codedError('ECONNRESET')), {
    preconnect: false,
    open: false,
    retryAfterSeconds: null
  });
  health.begin('https://three.example/path');
  assert.equal(health.status().trackedOriginCount, 2);
});

test('disabled host health preserves admission without retaining entries', () => {
  const health = new CodexHostHealth({ enabled: false });
  assert.deepEqual(health.begin(ORIGIN), { admitted: true, lease: null });
  assert.deepEqual(health.settleError(null, codedError('ENOTFOUND')), {
    preconnect: false,
    open: false,
    retryAfterSeconds: null
  });
  assert.equal(health.status().trackedOriginCount, 0);
});
