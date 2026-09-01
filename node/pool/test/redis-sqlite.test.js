import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { openRedisSqlitePersistence } from '../../src/redis-sqlite.js';
import { ProductStore } from '../src/product-store.js';

class MemoryRedis {
  constructor() {
    this.values = new Map();
    this.isOpen = false;
  }

  on() {}

  async connect() {
    this.isOpen = true;
  }

  async close() {
    this.isOpen = false;
  }

  async set(key, value, options = {}) {
    if (options.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async exists(key) {
    return this.values.has(key) ? 1 : 0;
  }

  multi() {
    const commands = [];
    const transaction = {
      set: (key, value) => {
        commands.push([key, value]);
        return transaction;
      },
      exec: async () => {
        for (const [key, value] of commands) this.values.set(key, value);
      }
    };
    return transaction;
  }

  async eval(script, { keys, arguments: args }) {
    const [key] = keys;
    if (this.values.get(key) !== args[0]) return 0;
    if (script.includes('PEXPIRE')) return 1;
    this.values.delete(key);
    return 1;
  }
}

test('restores both SQLite stores and encryption keys from Redis', async () => {
  const redis = new MemoryRedis();
  const firstDir = mkdtempSync(join(tmpdir(), 'codex-share-redis-first-'));
  const secondDir = mkdtempSync(join(tmpdir(), 'codex-share-redis-second-'));
  let first;
  let second;
  let firstStore;
  let firstProductStore;
  let secondStore;
  let secondProductStore;
  try {
    first = await openRedisSqlitePersistence({ client: redis });
    await first.restore(firstDir);
    firstStore = new Store(firstDir);
    firstProductStore = new ProductStore(firstDir);
    firstStore.sqlite = first.attach('db.sqlite', firstStore.sqlite, firstStore.keyPath);
    firstProductStore.sqlite = first.attach('pool.sqlite', firstProductStore.sqlite, firstProductStore.keyPath);

    firstStore.createScope({ id: 'redis-scope' });
    const account = firstProductStore.upsertCodexAccount({
      subject: 'redis-user',
      issuer: 'https://auth.openai.com',
      email: 'redis@example.com',
      name: 'Redis User'
    });
    const productKey = readFileSync(firstProductStore.keyPath);
    await first.flush();
    await first.close();
    firstStore.sqlite.close();
    firstProductStore.sqlite.close();

    second = await openRedisSqlitePersistence({ client: redis });
    await second.restore(secondDir);
    secondStore = new Store(secondDir);
    secondProductStore = new ProductStore(secondDir);

    assert.equal(secondStore.sqlite.prepare('SELECT 1 FROM records WHERE collection = ? AND key = ?').get('scopes', 'redis-scope')['1'], 1);
    assert.equal(secondProductStore.account(account.id).email, 'redis@example.com');
    assert.deepEqual(readFileSync(secondProductStore.keyPath), productKey);
  } finally {
    await second?.close();
    secondStore?.sqlite.close();
    secondProductStore?.sqlite.close();
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});
