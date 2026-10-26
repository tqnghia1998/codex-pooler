import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'relaydeck-reauth-cleanup-'));
  const store = new Store(dir);
  const server = createServer(createApp({ store, apiKey: 'cleanup-test', ingress: { allowedHosts: ['127.0.0.1', 'relaydeck.test'] } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (payload, headers = {}) => new Promise((resolve, reject) => {
    const req = request(`${base}/api/upstreams/remove-reauth-required`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
  const account = (name, state = {}) => {
    const row = store.create({ type: 'codex', name, accessToken: `synthetic-${name}`, accountId: name });
    Object.assign(store.get(row.id), state);
    store.save(store.load());
    return row.id;
  };
  return { dir, store, post, account };
}

test('bulk reauth removal rechecks confirmed accounts and persists only matching deletions', async (t) => {
  const { dir, store, post, account } = await fixture(t);
  const refresh = account('refresh', { tokenRefresh: { status: 'reauth_required' } });
  const health = account('health', { health: { status: 'reauth_required' } });
  const recovered = account('recovered', { tokenRefresh: { status: 'reauth_required' } });
  const failed = account('failed', { tokenRefresh: { status: 'failed' } });
  const cooling = account('cooling', { health: { status: 'cooldown' } });
  const healthy = account('healthy');
  const unconfirmed = account('unconfirmed', { tokenRefresh: { status: 'reauth_required' } });
  // The operator opened the dialog before this account was reauthenticated.
  store.clearTokenRefresh(recovered);
  const ids = [refresh, health, recovered, failed, cooling, healthy, 'missing', refresh];
  const response = await post({ ids });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    removed: [refresh, health], skipped: [recovered, failed, cooling, healthy, 'missing']
  });
  assert.deepEqual(store.list().map(({ id }) => id).sort(), [recovered, failed, cooling, healthy, unconfirmed].sort());
  const reopened = new Store(dir);
  assert.equal(reopened.get(refresh), null);
  assert.equal(reopened.get(health), null);
  assert.ok(reopened.get(recovered));
  assert.ok(reopened.get(unconfirmed));
  const retry = await post({ ids });
  assert.deepEqual(await retry.json(), { removed: [], skipped: [...new Set(ids)] });
});

test('bulk reauth removal validates the entire selection before deleting anything', async (t) => {
  const { store, post, account } = await fixture(t);
  const id = account('reauth', { tokenRefresh: { status: 'reauth_required' } });
  for (const payload of [null, {}, { ids: [] }, { ids: 'all' }, { ids: [id, 5] }, { ids: [id, ' '] }]) {
    const response = await post(payload);
    assert.equal(response.status, 400);
    assert.ok(store.get(id));
  }
});

test('bulk reauth removal keeps management authentication and origin checks', async (t) => {
  const { store, post, account } = await fixture(t);
  const id = account('reauth', { health: { status: 'reauth_required' } });
  const unauthenticated = await post({ ids: [id] }, { host: 'relaydeck.test' });
  assert.equal(unauthenticated.status, 401);
  const crossOrigin = await post({ ids: [id] }, { origin: 'https://untrusted.test' });
  assert.equal(crossOrigin.status, 403);
  assert.ok(store.get(id));
});
