import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const FIRST_KEY = 'scope-first-key';
const SECOND_KEY = 'scope-second-key';

async function app() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-scopes-'));
  const store = new Store(dir);
  const secondScope = store.createScope();
  const secondKey = store.createApiKey({ key: SECOND_KEY, scopeId: secondScope.id });
  const server = createServer(createApp({ store, apiKey: FIRST_KEY }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    store, secondScope, secondKey,
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function bearer(key, options = {}) {
  return { ...options, headers: { authorization: `Bearer ${key}`, ...(options.headers || {}) } };
}

test('persists scoped keys without exposing hashes and isolates files and session pins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-scope-store-'));
  try {
    const store = new Store(dir);
    const other = store.createScope();
    const key = store.createApiKey({ key: SECOND_KEY, scopeId: other.id });
    const first = store.create({ type: 'compass', projectId: 'first', projectKey: 'first-secret' });
    const second = store.create({ type: 'compass', projectId: 'second', projectKey: 'second-secret' }, { scopeId: other.id });
    store.saveFile({ id: 'same-id', object: 'file', bytes: 1 }, 'default');
    store.saveFile({ id: 'same-id', object: 'file', bytes: 2 }, other.id);
    store.pinSession('same-session', first.id);
    store.pinSession('same-session', second.id, other.id);

    assert.equal(store.authenticateApiKey(SECOND_KEY).id, key.id);
    assert.equal(store.listApiKeys().some((item) => JSON.stringify(item).includes('keyHash')), false);
    assert.equal(store.getFile('same-id').bytes, 1);
    assert.equal(store.getFile('same-id', other.id).bytes, 2);
    assert.equal(store.sessionUpstream('same-session'), first.id);
    assert.equal(store.sessionUpstream('same-session', other.id), second.id);
    assert.equal(store.list('default').length, 1);
    assert.equal(store.list(other.id).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requires Bearer auth except Messages x-api-key and hides scoped files from other keys', async (t) => {
  const fixture = await app();
  t.after(fixture.close);
  fixture.store.saveFile({ id: 'first-file', object: 'file', bytes: 1, filename: 'first.txt', purpose: 'user_data', status: 'uploaded' });
  fixture.store.saveFile({ id: 'second-file', object: 'file', bytes: 1, filename: 'second.txt', purpose: 'user_data', status: 'uploaded' }, fixture.secondScope.id);

  let response = await fetch(`${fixture.base}/v1/files`, bearer(FIRST_KEY));
  assert.deepEqual((await response.json()).data.map((file) => file.id), ['first-file']);
  response = await fetch(`${fixture.base}/v1/files`, bearer(SECOND_KEY));
  assert.deepEqual((await response.json()).data.map((file) => file.id), ['second-file']);
  response = await fetch(`${fixture.base}/v1/files/first-file`, bearer(SECOND_KEY));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'file_not_found');

  response = await fetch(`${fixture.base}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': FIRST_KEY }, body: '{}'
  });
  assert.equal(response.status, 401);
  response = await fetch(`${fixture.base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': FIRST_KEY }, body: '{}'
  });
  assert.notEqual(response.status, 401);

  fixture.store.updateApiKey(fixture.secondKey.id, { status: 'disabled' });
  response = await fetch(`${fixture.base}/v1/files`, bearer(SECOND_KEY));
  assert.equal(response.status, 401);
});
