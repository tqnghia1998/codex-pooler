import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

function codexInput(email) {
  const token = `header.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.signature`;
  return { type: 'codex', authJson: JSON.stringify({ tokens: { access_token: token, id_token: token } }) };
}

function upstreams(store) {
  const first = store.create(codexInput('first@example.com'));
  const second = store.create(codexInput('second@example.com'));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  return { first, second };
}

test('balances automatic candidates by least recent success and preserves pins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-routing-plan-'));
  const store = new Store(dir);
  try {
    const { first, second } = upstreams(store);
    const scope = { model: 'gpt-5.6-sol', routeClass: 'proxy_http' };
    assert.deepEqual(store.candidatePlan({ preferredType: 'codex', ...scope }).map((item) => item.id), [first.id, second.id]);
    store.completeCircuit(first.id, scope, true, Date.parse('2026-08-04T00:00:00Z'));
    assert.deepEqual(store.candidatePlan({ preferredType: 'codex', ...scope }).map((item) => item.id), [second.id, first.id]);
    store.completeCircuit(second.id, scope, true, Date.parse('2026-08-04T00:01:00Z'));
    assert.deepEqual(store.candidatePlan({ preferredType: 'codex', ...scope }).map((item) => item.id), [first.id, second.id]);
    assert.deepEqual(store.candidatePlan({ requestedId: second.id, preferredType: 'codex', ...scope }).map((item) => item.id), [second.id]);
    store.pinSession('pinned', first.id);
    assert.deepEqual(store.candidatePlan({ pinnedId: store.sessionUpstream('pinned'), preferredType: 'codex', ...scope }).map((item) => item.id), [first.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opens durable circuits, permits one half-open probe, and resets on success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-routing-circuit-'));
  const store = new Store(dir);
  const now = Date.parse('2026-08-04T00:00:00Z');
  try {
    const { first, second } = upstreams(store);
    const scope = { model: 'gpt-5.6-sol', routeClass: 'proxy_http' };
    for (let failure = 0; failure < 3; failure += 1) store.recordCircuitFailure(first.id, scope, now);
    const restarted = new Store(dir);
    assert.deepEqual(restarted.candidatePlan({ preferredType: 'codex', ...scope, now }).map((item) => item.id), [second.id]);
    assert.equal(restarted.beginCircuit(first.id, scope, now + 60_000), true);
    assert.equal(restarted.beginCircuit(first.id, scope, now + 60_001), false);
    restarted.completeCircuit(first.id, scope, false, now + 60_002);
    assert.equal(restarted.beginCircuit(first.id, scope, now + 60_003), false);
    assert.equal(restarted.beginCircuit(first.id, scope, now + 120_002), true);
    restarted.completeCircuit(first.id, scope, true, now + 120_003);
    assert.deepEqual(restarted.candidatePlan({ preferredType: 'codex', ...scope, now: now + 120_004 }).map((item) => item.id), [second.id, first.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
