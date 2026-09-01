import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp as createRelaydeckApp } from '../../src/server.js';
import { Store } from '../../src/store.js';
import { createApp as createPoolApp, start as startPool } from '../src/server.js';
import { ProductStore } from '../src/product-store.js';

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('Codex Pool routes, cookies, and data stay isolated from Relaydeck', async () => {
  const relaydeckDir = mkdtempSync(join(tmpdir(), 'relaydeck-isolation-'));
  const poolDir = mkdtempSync(join(tmpdir(), 'codex-pool-isolation-'));
  try {
    const relaydeckStore = new Store(relaydeckDir);
    relaydeckStore.create({ type: 'compass', projectId: 'relaydeck-only', projectKey: 'secret' });
    const relaydeckDefaultDataDir = resolve(fileURLToPath(new URL('../../.data', import.meta.url)));
    assert.throws(() => startPool(0, { dataDir: relaydeckDefaultDataDir }), /must not point to Relaydeck/);
    const relaydeckApp = createRelaydeckApp({ store: relaydeckStore, apiKey: 'relaydeck-key' });
    const relaydeckDigest = digest(relaydeckStore.dbPath);
    const relaydeck = await listen(relaydeckApp);

    const poolStore = new Store(poolDir);
    const productStore = new ProductStore(poolDir);
    const account = productStore.upsertCodexAccount({
      subject: 'pool-user',
      issuer: 'https://auth.openai.com',
      email: 'pool@example.com',
      name: 'Pool User'
    });
    const manager = {
      start() {
        const attempt = productStore.createCodexLoginAttempt();
        productStore.updateCodexLoginAttempt(attempt.login.id, { accountId: account.id, status: 'completed' });
        return { ...attempt, login: productStore.codexLoginAttemptById(attempt.login.id) };
      },
      status: (token) => productStore.codexLoginAttemptByToken(token),
      cancel: () => null
    };
    const pool = await listen(createPoolApp({ store: poolStore, productStore, codexLoginManager: manager }));
    try {
      let response = await fetch(`${relaydeck.base}/auth/codex/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 404);

      response = await fetch(`${relaydeck.base}/api/sharing/offers`);
      assert.equal(response.status, 404);
      assert.equal(existsSync(join(relaydeckDir, 'pool.sqlite')), false);
      assert.equal(existsSync(join(relaydeckDir, 'sharing.sqlite')), false);

      response = await fetch(`${pool.base}/auth/codex/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 201);
      const cookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      assert.equal(cookies.some((value) => value.startsWith('codex_pool_login=')), true);
      assert.equal(cookies.some((value) => value.startsWith('relaydeck_')), false);

      productStore.createAccountSession(account.id);
      assert.equal(digest(relaydeckStore.dbPath), relaydeckDigest);
      assert.equal(existsSync(join(poolDir, 'db.sqlite')), true);
      assert.equal(existsSync(join(poolDir, 'pool.sqlite')), true);
      assert.notEqual(poolStore.dbPath, relaydeckStore.dbPath);
    } finally {
      await pool.close();
      await relaydeck.close();
    }
  } finally {
    rmSync(relaydeckDir, { recursive: true, force: true });
    rmSync(poolDir, { recursive: true, force: true });
  }
});
