import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ProductStore } from '../pool/src/product-store.js';
import { openRedisDocumentPersistence } from '../src/redis-document-persistence.js';

class MemoryRedis {
  constructor() {
    this.isOpen = false;
    this.values = new Map();
    this.members = new Map();
  }

  on() {}
  async connect() { this.isOpen = true; }
  async close() { this.isOpen = false; }
  async exists(key) { return this.values.has(key) ? 1 : 0; }
  async get(key) { return this.values.get(key) ?? null; }
  async mGet(keys) { return keys.map((key) => this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, value); return 'OK'; }
  async sMembers(key) { return [...(this.members.get(key) || [])]; }
  multi() {
    const commands = [];
    const transaction = {
      set: (key, value) => { commands.push(() => this.set(key, value)); return transaction; },
      sAdd: (key, value) => { commands.push(() => (this.members.get(key) || this.members.set(key, new Set()).get(key)).add(value)); return transaction; },
      del: (key) => { commands.push(() => this.values.delete(key)); return transaction; },
      sRem: (key, value) => { commands.push(() => this.members.get(key)?.delete(value)); return transaction; },
      exec: async () => { for (const command of commands) await command(); }
    };
    return transaction;
  }
}

test('hydrates and writes Redis records without using the configured data directory', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'codex-share-redis-source-'));
  const redis = new MemoryRedis();
  let sourceStore;
  let sourceProductStore;
  let persistence;
  try {
    sourceStore = new Store(sourceDir);
    sourceStore.createScope({ id: 'seed-scope' });
    const upstream = sourceStore.create({ type: 'compass', projectId: 'seed-project', projectKey: 'seed-key' });
    sourceProductStore = new ProductStore(sourceDir);
    const account = sourceProductStore.upsertCodexAccount({ subject: 'seed', email: 'seed@example.com', name: 'Seed' });
    sourceProductStore.linkUpstream(account.id, upstream.id);
    await redis.set('test:manifest', JSON.stringify({ version: 1 }));
    await redis.set('test:encryption:gateway', readFileSync(sourceStore.keyPath).toString('base64'));
    await redis.set('test:encryption:product', readFileSync(sourceProductStore.keyPath).toString('base64'));
    persistence = await openRedisDocumentPersistence({ client: redis, prefix: 'test' });
    persistence.databases.set('gateway', sourceStore.sqlite);
    persistence.databases.set('product', sourceProductStore.sqlite);
    await persistence.flush();

    const runtimeDir = await persistence.restore();
    const runtimeStore = new Store(runtimeDir);
    const runtimeProductStore = new ProductStore(runtimeDir);
    await persistence.hydrate(runtimeStore.sqlite, runtimeProductStore.sqlite);
    runtimeStore.db = null;
    runtimeStore.load();
    runtimeStore.sqlite = persistence.attach('gateway', runtimeStore.sqlite);
    assert.equal(runtimeStore.listApiKeys().length, sourceStore.listApiKeys().length);
    assert.equal(runtimeStore.db.scopes.some((scope) => scope.id === 'seed-scope'), true);
    assert.equal(runtimeStore.get(upstream.id).projectId, 'seed-project');
    assert.equal(runtimeProductStore.account(account.id).email, 'seed@example.com');
    assert.equal(runtimeProductStore.listAccountUpstreamLinks(account.id)[0].upstreamId, upstream.id);

    runtimeStore.createScope({ id: 'persisted-scope' });
    await persistence.flush();
    assert.equal((await persistence.records('gateway-records')).some(({ collection, key }) => collection === 'scopes' && key === 'persisted-scope'), true);
  } finally {
    await persistence?.close();
    sourceStore?.sqlite.close();
    sourceProductStore?.sqlite.close();
    rmSync(sourceDir, { recursive: true, force: true });
  }
});
