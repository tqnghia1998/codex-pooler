import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-'));
  return { dir, store: new Store(dir) };
}

test('persists CRUD while keeping credentials out of public records', () => {
  const { dir, store } = tempStore();
  try {
    const created = store.create({ type: 'compass', name: 'Compass one', projectId: 'project-1', projectKey: 'secret-key' });
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].hasCredentials, true);
    assert.equal(store.list()[0].projectId, 'project-1');
    assert.equal(store.credentials(created.id).projectKey, 'secret-key');
    assert.match(readFileSync(join(dir, 'db.json'), 'utf8'), /v1:/);
    assert.doesNotMatch(readFileSync(join(dir, 'db.json'), 'utf8'), /secret-key/);
    store.update(created.id, { name: 'Renamed', projectId: 'project-2' });
    assert.equal(store.credentials(created.id).projectKey, 'secret-key');
    store.persistCredentials(created.id, { projectKey: 'rotated-key' }, '2030-01-01T00:00:00.000Z');
    assert.equal(store.credentials(created.id).projectKey, 'rotated-key');
    assert.equal(store.getPublic(created.id).accessTokenExpiresAt, '2030-01-01T00:00:00.000Z');
    store.remove(created.id);
    assert.equal(store.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps routing within one loaded database snapshot', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({ type: 'compass', projectId: 'snapshot', projectKey: 'secret' });
    store.setCap(upstream.id, { capDollars: 1 });
    let reads = 0;
    const load = store.load.bind(store);
    store.load = () => { reads += 1; return load(); };
    assert.deepEqual(store.candidatePlan({ scopeId: 'default', preferredType: 'compass' }).map(({ id }) => id), [upstream.id]);
    assert.equal(reads, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bounds completed gateway history while retaining in-progress requests', () => {
  const { dir, store } = tempStore();
  try {
    const db = store.load();
    db.gatewayRequests = Array.from({ length: 1_002 }, (_, index) => ({ id: `done-${index}`, completedAt: '2026-01-01T00:00:00.000Z' }));
    db.gatewayRequests.push({ id: 'active', completedAt: null });
    db.gatewayAttempts = db.gatewayRequests.map(({ id }) => ({ id: `attempt-${id}`, requestId: id }));
    db.gatewayUsage = db.gatewayAttempts.map(({ id }) => ({ attemptId: id }));
    store.save(db);
    const reopened = new Store(dir).load();
    assert.equal(reopened.gatewayRequests.length, 1_001);
    assert.equal(reopened.gatewayRequests.at(-1).id, 'active');
    assert.equal(reopened.gatewayAttempts.length, 1_001);
    assert.equal(reopened.gatewayUsage.length, 1_001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to replace a missing key for an existing database', () => {
  const { dir } = tempStore();
  try {
    unlinkSync(join(dir, '.key'));
    assert.throws(() => new Store(dir), /Stored credential key is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persists file metadata and upstream session pins', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({ type: 'compass', projectId: 'project-files', projectKey: 'secret' });
    store.pinSession('session-1', upstream.id);
    assert.throws(() => store.pinSession('x'.repeat(201), upstream.id), /at most 200/);
    store.saveFile({ id: 'file-1', object: 'file', bytes: 3, filename: 'a.txt', purpose: 'user_data', status: 'uploaded' });

    const reopened = new Store(dir);
    assert.equal(reopened.sessionUpstream('session-1'), upstream.id);
    assert.deepEqual(reopened.getFile('file-1'), { id: 'file-1', object: 'file', bytes: 3, filename: 'a.txt', purpose: 'user_data', status: 'uploaded' });
    assert.equal(reopened.listFiles().length, 1);
    reopened.remove(upstream.id);
    assert.equal(reopened.sessionUpstream('session-1'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prevents creating duplicate upstreams within the same scope', () => {
  const { dir, store } = tempStore();
  try {
    store.create({ type: 'compass', name: 'First', projectId: 'p1', projectKey: 'k1' });
    assert.throws(
      () => store.create({ type: 'compass', name: 'Duplicate', projectId: 'p1', projectKey: 'k2' }),
      /compass upstream already exists/
    );

    store.create({ type: 'codex', accountId: 'acc1', email: 'user@example.com', accessToken: 'token1' });
    assert.throws(
      () => store.create({ type: 'codex', accountId: 'acc1', email: 'user@example.com', accessToken: 'token2' }),
      /codex upstream already exists/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sets caps in dollars, records priced usage, and applies bulk quota rules', () => {
  const { dir, store } = tempStore();
  try {
    const first = store.create({ type: 'compass', name: 'First', projectId: 'p1', projectKey: 'k1' });
    const second = store.create({ type: 'compass', name: 'Second', projectId: 'p2', projectKey: 'k2' });
    const aiswitch = store.create({ type: 'compass', name: 'AISwitch', projectId: 'p3', projectKey: 'k3', quotaSource: 'aiswitch' });
    store.setCap(first.id, { capDollars: 100 });
    const usage = store.addUsage(first.id, {
      attemptId: 'attempt-1',
      startedAt: new Date(Date.now() + 1).toISOString(),
      settledCostMicros: 1_000_000,
      costSource: 'upstream_reported'
    });
    assert.equal(usage.upstream.spending.capCredits, 2500);
    assert.equal(usage.upstream.spending.spentDollars, 1);

    store.setQuota(first.id, { remainingUnits: 15_000, remainingDollars: 1_500, remainingPercent: 75 });
    store.setQuota(second.id, { remainingUnits: 500, remainingDollars: 500, remainingPercent: 25 });
    const bulk = store.bulkCaps({ rules: [{ minQuotaLeft: 1_000, capDollars: 30 }, { minQuotaLeft: 0, capDollars: 10 }] });
    assert.equal(bulk.updated.length, 2);
    assert.equal(store.get(aiswitch.id).spending.capCredits, 0);
    assert.equal(store.getPublic(first.id).spending.capDollars, 30);
    assert.equal(store.getPublic(first.id).spending.spentDollars, 0);
    assert.equal(store.getPublic(first.id).spending.settlementCount, 0);
    assert.equal(store.getPublic(second.id).spending.capDollars, 10);
    const all = store.bulkCaps({ target: 'all', capDollars: 999 });
    assert.equal(all.updated.some((item) => item.id === aiswitch.id), false);
    assert.equal(store.get(aiswitch.id).spending.capCredits, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
