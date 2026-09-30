import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const KEY = 'routing-policy-key';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-routing-'));
  const store = new Store(dir);
  store.updateScope('default', { models: ['allowed-model'] });
  const upstream = store.create({
    type: 'compass', projectId: 'project', projectKey: 'project-key',
    routing: { models: ['allowed-model'], tools: false, imageInput: false, reasoning: false, serviceTiers: ['default'] }
  });
  store.setCap(upstream.id, { capDollars: 10 });
  return { dir, store, upstream };
}

test('filters candidates by scope model policy, capabilities, tiers, and known exhausted quota', () => {
  const { dir, store, upstream } = fixture();
  try {
    assert.equal(store.modelAllowed('default', 'allowed-model'), true);
    assert.equal(store.modelAllowed('default', 'other-model'), false);
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model', requirements: { tools: true } }).length, 0);
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model', requirements: { imageInput: true } }).length, 0);
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model', requirements: { reasoning: true } }).length, 0);
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model', requirements: { serviceTier: 'priority' } }).length, 0);
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model', requirements: { serviceTier: 'default' } }).length, 1);
    store.setQuota(upstream.id, { remainingPercent: 0 });
    assert.equal(store.candidatePlan({ scopeId: 'default', model: 'allowed-model' }).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects unavailable models before dispatch and reports incompatible candidates', async (t) => {
  const { dir, store } = fixture();
  const server = createServer(createApp({ store, apiKey: KEY, fetchImpl: async () => { throw new Error('must not dispatch'); } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (body) => fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  let response = await request({ model: 'other-model', input: 'hello' });
  assert.equal(response.status, 400);
  assert.deepEqual((await response.json()).error, {
    type: 'invalid_request_error', code: 'invalid_model', message: 'Model other-model is not available', param: 'model'
  });
  response = await request({ model: 'allowed-model', input: 'hello', tools: [{ type: 'function', name: 'lookup', parameters: {} }] });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'no_compatible_backend');

  response = await fetch(`${base}/backend-api/codex/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'allowed-model', input: 'hello' })
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'no_compatible_backend');
});
