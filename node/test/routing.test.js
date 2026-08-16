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

function settle(store, id, scope, outcome, now) {
  const admission = store.beginUpstreamAttempt(id, scope, now);
  assert.ok(admission);
  store.settleUpstreamAttempt(id, admission, outcome, now);
}

test('balances automatic candidates by least recent success and preserves pins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-routing-plan-'));
  const store = new Store(dir);
  try {
    const { first, second } = upstreams(store);
    const scope = { model: 'gpt-5.6-sol', routeClass: 'proxy_http' };
    assert.deepEqual(store.candidatePlan({ preferredType: 'codex', ...scope }).map((item) => item.id), [first.id, second.id]);
    settle(store, first.id, scope, { class: 'success', retryable: false }, Date.parse('2026-08-04T00:00:00Z'));
    assert.deepEqual(store.candidatePlan({ preferredType: 'codex', ...scope }).map((item) => item.id), [second.id, first.id]);
    settle(store, second.id, scope, { class: 'success', retryable: false }, Date.parse('2026-08-04T00:01:00Z'));
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
    for (let failure = 0; failure < 3; failure += 1) {
      settle(store, first.id, scope, { class: 'transient', retryable: true }, now);
    }
    const restarted = new Store(dir);
    assert.deepEqual(restarted.candidatePlan({ preferredType: 'codex', ...scope, now }).map((item) => item.id), [second.id]);
    const firstProbe = restarted.beginUpstreamAttempt(first.id, scope, now + 60_000);
    assert.ok(firstProbe);
    assert.equal(restarted.beginUpstreamAttempt(first.id, scope, now + 60_001), null);
    restarted.settleUpstreamAttempt(first.id, firstProbe, { class: 'transient', retryable: true }, now + 60_002);
    assert.equal(restarted.beginUpstreamAttempt(first.id, scope, now + 60_003), null);
    const secondProbe = restarted.beginUpstreamAttempt(first.id, scope, now + 120_002);
    assert.ok(secondProbe);
    restarted.settleUpstreamAttempt(first.id, secondProbe, { class: 'success', retryable: false }, now + 120_003);
    assert.deepEqual(restarted.candidatePlan({ preferredType: 'codex', ...scope, now: now + 120_004 }).map((item) => item.id), [second.id, first.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('priority list members are routed before unlisted upstreams until their cap is reached', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-routing-priority-'));
  const store = new Store(dir);
  try {
    const { first, second } = upstreams(store);
    const scope = { model: 'gpt-5.6-sol', routeClass: 'proxy_http' };
    assert.deepEqual(store.list().map((item) => item.priority), [null, null]);
    settle(store, second.id, scope, { class: 'success', retryable: false }, Date.parse('2026-08-04T00:00:00Z'));
    assert.deepEqual(store.candidatePlan({ preferredType: 'codex', ...scope }).map((item) => item.id), [first.id, second.id]);
    store.setPriorityList([second.id]);
    assert.deepEqual(store.candidatePlan({ preferredType: 'codex', ...scope }).map((item) => item.id), [second.id, first.id]);
    store.addUsage(second.id, { attemptId: 'a1', costSource: 'pricing_snapshot', settledCostMicros: 100 * 1_000_000, startedAt: new Date().toISOString() });
    assert.deepEqual(store.candidatePlan({ preferredType: 'codex', ...scope }).map((item) => item.id), [first.id]);
    store.setPriorityList([first.id, second.id]);
    assert.deepEqual(store.list().map((item) => item.priority), [0, 1]);
    store.setPriorityList([]);
    assert.deepEqual(store.list().map((item) => item.priority), [null, null]);
    assert.throws(() => store.setPriorityList(['missing']), /unknown upstream/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orders fresh quota within priority tiers and treats stale or unknown quota fairly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-routing-quota-'));
  const store = new Store(dir);
  const now = Date.parse('2026-08-16T08:00:00Z');
  try {
    const first = store.create(codexInput('first@example.com'));
    const second = store.create(codexInput('second@example.com'));
    const unknown = store.create(codexInput('unknown@example.com'));
    const stale = store.create(codexInput('stale@example.com'));
    for (const upstream of [first, second, unknown, stale]) store.setCap(upstream.id, { capDollars: 100 });
    store.setQuota(first.id, { remainingPercent: 10, observedAt: new Date(now).toISOString() });
    store.setQuota(second.id, { remainingPercent: 90, observedAt: new Date(now).toISOString() });
    store.setQuota(stale.id, { remainingPercent: 100, observedAt: new Date(now - 6 * 60_000).toISOString() });
    store.setRoutingPolicy({ strategy: 'most-remaining-quota' });

    assert.deepEqual(
      store.candidatePlan({ preferredType: 'codex', now }).map((item) => item.id),
      [second.id, unknown.id, stale.id, first.id]
    );

    store.setPriorityList([first.id, second.id]);
    assert.deepEqual(
      store.candidatePlan({ preferredType: 'codex', now }).map((item) => item.id),
      [first.id, second.id, unknown.id, stale.id]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uses least recent success for equal quota and preserves explicit and affinity selection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-routing-quota-ties-'));
  const store = new Store(dir);
  const now = Date.parse('2026-08-16T08:00:00Z');
  try {
    const { first, second } = upstreams(store);
    store.setQuota(first.id, { remainingPercent: 50, observedAt: new Date(now).toISOString() });
    store.setQuota(second.id, { remainingPercent: 50, observedAt: new Date(now).toISOString() });
    store.setRoutingPolicy({ strategy: 'most-remaining-quota' });
    settle(store, first.id, { model: 'gpt-5.6-sol', routeClass: 'proxy_http' }, { class: 'success', retryable: false }, now - 1_000);

    assert.deepEqual(store.candidatePlan({ preferredType: 'codex', now }).map((item) => item.id), [second.id, first.id]);
    assert.deepEqual(store.candidatePlan({ requestedId: first.id, preferredType: 'codex', now }).map((item) => item.id), [first.id]);
    assert.deepEqual(store.candidatePlan({ affinityId: first.id, preferredType: 'codex', now }).map((item) => item.id), [first.id, second.id]);
    assert.deepEqual(store.candidatePlan({ pinnedId: second.id, preferredType: 'codex', now }).map((item) => item.id), [second.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quota routing excludes cooldowns and restores recovered accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-routing-quota-cooldown-'));
  const store = new Store(dir);
  const now = Date.parse('2026-08-16T08:00:00Z');
  try {
    const { first, second } = upstreams(store);
    store.setQuota(first.id, { remainingPercent: 90, observedAt: new Date(now).toISOString() });
    store.setQuota(second.id, { remainingPercent: 10, observedAt: new Date(now).toISOString() });
    store.setRoutingPolicy({ strategy: 'most-remaining-quota' });
    settle(store, first.id, { model: 'gpt-5.6-sol', routeClass: 'proxy_http' }, { class: 'quota', retryable: true, retryAfter: '60' }, now);

    assert.deepEqual(store.candidatePlan({ preferredType: 'codex', now: now + 30_000 }).map((item) => item.id), [second.id]);
    assert.deepEqual(store.candidatePlan({ preferredType: 'codex', now: now + 60_001 }).map((item) => item.id), [first.id, second.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
