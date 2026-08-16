import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompatibilityLearning,
  compatibilityLearningForStore,
  compatibilityContext
} from '../src/compatibility-learning.js';
import {
  compatibilityProtocolFingerprint,
  defaultProtocolFingerprints
} from '../src/protocol-compat.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compatibility-learning-'));
  return { dir, store: new Store(dir) };
}

function evidence(service, upstream, context, field, observationId, now) {
  return service.observe({
    upstream,
    context,
    value: { unsupportedFields: [field] },
    feature: `unsupported_field:${field}`,
    observationId,
    now
  });
}

test('normalizes public protocol fingerprints without secrets or unstable beta ordering', () => {
  const codex = compatibilityProtocolFingerprint('codex', {
    req: {
      headers: {
        version: '9.99.0',
        originator: 'future_codex',
        'openai-beta': 'zeta=1,alpha=1,zeta=1',
        authorization: 'Bearer sensitive-token',
        cookie: 'session=sensitive-cookie'
      }
    },
    inheritClient: true
  });
  assert.deepEqual(codex.values, {
    'user-agent': 'future_codex/9.99.0',
    originator: 'future_codex',
    version: '9.99.0',
    'openai-beta': 'alpha=1,zeta=1'
  });

  const compass = compatibilityProtocolFingerprint('compass', {
    anthropicVersion: '2026-08-01',
    anthropicBeta: 'zeta-beta,alpha-beta,zeta-beta'
  });
  assert.deepEqual(compass.values, {
    version: '2026-08-01',
    beta: ['alpha-beta', 'zeta-beta']
  });
  const invalid = compatibilityProtocolFingerprint('codex', {
    req: { headers: { version: 'bad\nvalue', originator: 'bad\u0000value' } },
    inheritClient: true
  });
  assert.notEqual(invalid.values.version, 'bad\nvalue');
  assert.notEqual(invalid.values.originator, 'bad\u0000value');
  assert.equal(codex.hash.length, 32);
  assert.equal(JSON.stringify({ codex, compass, invalid }).includes('sensitive-token'), false);
  assert.equal(JSON.stringify({ codex, compass, invalid }).includes('sensitive-cookie'), false);
});

test('promotes independent allowlisted evidence and fences credential generations', () => {
  const { dir, store } = tempStore();
  let now = Date.parse('2026-08-16T08:00:00Z');
  try {
    const created = store.create({ type: 'compass', projectId: 'private-project', projectKey: 'private-key' });
    const service = new CompatibilityLearning(store, { now: () => now });
    const upstream = store.get(created.id);
    const context = compatibilityContext(upstream, { sourcePath: '/v1/messages', model: 'private-model' });

    assert.equal(evidence(service, upstream, context, 'temperature', 'attempt-one', now).status, 'observed');
    assert.equal(evidence(service, upstream, context, 'temperature', 'attempt-one', now).evidenceCount, 1);
    now += 1;
    assert.equal(evidence(service, upstream, context, 'temperature', 'attempt-two', now).status, 'active');
    assert.deepEqual(service.activeFact(created.id, context), { unsupportedFields: ['temperature'] });
    now += 24 * 60 * 60_000;
    assert.equal(service.activeFact(created.id, context), null);
    now -= 24 * 60 * 60_000;

    const staleUpstream = store.get(created.id);
    store.update(created.id, { projectKey: 'rotated-private-key' });
    assert.equal(service.activeFact(created.id, context), null);
    assert.equal(evidence(service, staleUpstream, context, 'top_p', 'stale-one', now + 2).status, 'stale_generation');
    assert.equal(evidence(service, staleUpstream, context, 'top_p', 'stale-two', now + 3).status, 'stale_generation');
    assert.equal(store.get(created.id).compatibility, undefined);

    assert.equal(service.observe({
      upstream: store.get(created.id),
      context,
      value: { unsupportedFields: ['authorization'] },
      feature: 'unsupported_field:authorization',
      observationId: 'unsafe'
    }).status, 'ignored');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not reuse facts or combine evidence across persisted credential identities', () => {
  const { dir, store } = tempStore();
  try {
    const created = store.create({ type: 'compass', projectId: 'generation-project', projectKey: 'first-key' });
    const service = new CompatibilityLearning(store);
    const firstUpstream = store.get(created.id);
    const firstContext = compatibilityContext(firstUpstream, { sourcePath: '/v1/messages', model: 'generation-model' });

    assert.equal(evidence(service, firstUpstream, firstContext, 'temperature', 'first-one', 1_000).status, 'observed');
    assert.equal(evidence(service, firstUpstream, firstContext, 'temperature', 'first-two', 1_001).status, 'active');
    assert.deepEqual(service.activeFact(created.id, firstContext, { now: 1_002 }), { unsupportedFields: ['temperature'] });

    store.persistCredentials(created.id, { projectKey: 'second-key' });
    assert.equal(service.activeFact(created.id, firstContext, { now: 1_003 }), null);
    assert.equal(store.get(created.id).compatibility, undefined);

    const secondUpstream = store.get(created.id);
    const secondContext = compatibilityContext(secondUpstream, { sourcePath: '/v1/messages', model: 'fresh-model' });
    assert.equal(evidence(service, secondUpstream, secondContext, 'top_p', 'second-one', 2_000).status, 'observed');
    store.persistCredentials(created.id, { projectKey: 'third-key' });

    const thirdUpstream = store.get(created.id);
    const thirdContext = compatibilityContext(thirdUpstream, { sourcePath: '/v1/messages', model: 'fresh-model' });
    assert.equal(evidence(service, thirdUpstream, thirdContext, 'top_p', 'third-one', 2_001).status, 'observed');
    assert.equal(service.activeFact(created.id, thirdContext, { now: 2_002 }), null);
    assert.equal(evidence(service, thirdUpstream, thirdContext, 'top_p', 'third-two', 2_002).status, 'active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reset clears retained evidence before a fact can be promoted again', () => {
  const { dir, store } = tempStore();
  try {
    const created = store.create({ type: 'compass', projectId: 'reset-project', projectKey: 'reset-key' });
    const service = new CompatibilityLearning(store);
    const upstream = store.get(created.id);
    const context = compatibilityContext(upstream, { sourcePath: '/v1/messages', model: 'reset-model' });

    evidence(service, upstream, context, 'temperature', 'one', 1_000);
    const promoted = evidence(service, upstream, context, 'temperature', 'two', 1_001);
    assert.equal(service.resetFact(promoted.fact.id), true);
    assert.equal(evidence(service, upstream, context, 'temperature', 'three', 1_002).status, 'observed');
    assert.equal(service.activeFact(created.id, context, { now: 1_003 }), null);

    assert.equal(evidence(service, upstream, context, 'temperature', 'four', 1_003).status, 'active');
    assert.equal(service.reset(), 1);
    assert.equal(service.status().counts.observations, 0);
    assert.equal(evidence(service, upstream, context, 'temperature', 'five', 1_004).status, 'observed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts fixed allowlisted facts and rejects unrelated failure classes', () => {
  const { dir, store } = tempStore();
  try {
    const codex = store.create({
      type: 'codex',
      authJson: JSON.stringify({ tokens: { access_token: 'codex-token', account_id: 'codex-account' } })
    });
    const compass = store.create({ type: 'compass', projectId: 'allowlist-project', projectKey: 'secret' });
    const service = new CompatibilityLearning(store, { observationGapMs: 0 });
    const cases = [
      ...['max_output_tokens', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_p']
        .map((field) => ({ upstream: store.get(codex.id), field })),
      ...['temperature', 'top_k', 'top_p']
        .map((field) => ({ upstream: store.get(compass.id), field }))
    ];
    for (const [index, item] of cases.entries()) {
      const context = compatibilityContext(item.upstream, {
        sourcePath: item.upstream.type === 'codex' ? '/v1/responses' : '/v1/messages',
        model: `allowlisted-${index}`
      });
      assert.equal(evidence(service, item.upstream, context, item.field, `${index}-one`, index * 2).status, 'observed');
      assert.equal(evidence(service, item.upstream, context, item.field, `${index}-two`, index * 2 + 1).status, 'active');
    }

    const adaptiveContext = compatibilityContext(store.get(compass.id), {
      sourcePath: '/v1/messages',
      model: 'adaptive-model'
    });
    for (const responseClass of ['transport', 'quota', 'authentication', 'pacing', 'host_unavailable', 'timeout']) {
      assert.equal(service.observe({
        upstream: store.get(compass.id),
        context: adaptiveContext,
        value: { adaptiveThinking: true },
        feature: 'adaptive_thinking',
        responseClass,
        observationId: responseClass
      }).status, 'ignored');
    }
    assert.equal(service.observe({
      upstream: store.get(compass.id),
      context: adaptiveContext,
      value: { adaptiveThinking: true },
      feature: 'adaptive_thinking',
      observationId: 'adaptive-one',
      now: 100
    }).status, 'observed');
    assert.equal(service.observe({
      upstream: store.get(compass.id),
      context: adaptiveContext,
      value: { adaptiveThinking: true },
      feature: 'adaptive_thinking',
      observationId: 'adaptive-two',
      now: 101
    }).status, 'active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bounds observations and reports fingerprint-stale facts', () => {
  const { dir, store } = tempStore();
  try {
    const created = store.create({ type: 'compass', projectId: 'bounded-project', projectKey: 'secret' });
    const service = new CompatibilityLearning(store);
    const upstream = store.get(created.id);
    const contexts = [];
    for (let index = 0; index < 300; index += 1) {
      const context = compatibilityContext(upstream, { sourcePath: '/v1/messages', model: `model-${index}` });
      contexts.push(context);
      evidence(service, upstream, context, 'temperature', `attempt-${index}`, Date.now() + index);
    }
    assert.equal(service.status().counts.observations, 256);

    for (let index = 44; index < 149; index += 1) {
      evidence(service, upstream, contexts[index], 'temperature', `promotion-${index}`, Date.now() + 500 + index);
    }
    assert.equal(service.status().counts.active, 100);
    assert.equal(service.activeFact(created.id, contexts[44]), null);
    assert.deepEqual(service.activeFact(created.id, contexts[148]), { unsupportedFields: ['temperature'] });

    const context = compatibilityContext(upstream, { sourcePath: '/v1/messages', model: 'stale-model' });
    evidence(service, upstream, context, 'temperature', 'stale-one', Date.now() + 1_000);
    evidence(service, upstream, context, 'temperature', 'stale-two', Date.now() + 1_001);
    service.fingerprints = {
      ...defaultProtocolFingerprints(),
      compass: { ...defaultProtocolFingerprints().compass, hash: 'f'.repeat(32) }
    };
    assert.equal(service.activeFact(created.id, context), null);
    assert.equal(service.status().counts.stale, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serves sanitized compatibility status and reset APIs', async () => {
  const { dir, store } = tempStore();
  const created = store.create({ type: 'compass', projectId: 'api-private-project', projectKey: 'api-private-secret' });
  const service = compatibilityLearningForStore(store);
  const upstream = store.get(created.id);
  const context = compatibilityContext(upstream, { sourcePath: '/v1/messages', model: 'api-private-model' });
  evidence(service, upstream, context, 'temperature', 'api-one', Date.now());
  const promoted = evidence(service, upstream, context, 'temperature', 'api-two', Date.now() + 1);
  const server = createServer(createApp({ store, apiKey: 'management-key' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/compatibility`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.compatibility.counts.active, 1);
    assert.equal(data.compatibility.facts[0].id, promoted.fact.id);
    assert.deepEqual(data.compatibility.facts[0].features, ['unsupported_field:temperature']);
    const encoded = JSON.stringify(data);
    for (const secret of [
      created.id,
      'api-private-project',
      'api-private-secret',
      'api-private-model',
      'management-key'
    ]) assert.equal(encoded.includes(secret), false);

    const removed = await fetch(`${base}/api/compatibility/facts/${promoted.fact.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 204);
    const missing = await fetch(`${base}/api/compatibility/facts/${promoted.fact.id}`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
