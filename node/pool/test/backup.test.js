import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshotBackup, SNAPSHOT_BACKUP_INTERVAL_MS, snapshotBackupPath } from '../src/backup.js';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';

test('hourly snapshot backup keeps one replaceable QuotaHub snapshot on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-backup-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'compass', projectId: 'backup-project', projectKey: 'secret' });
    const productStore = new ProductStore(dir);
    const admin = productStore.upsertAccount({ email: 'quangnghia.trinh@shopee.com', name: 'Backup Admin' });
    productStore.linkUpstream(admin.id, upstream.id);
    const filePath = snapshotBackupPath(dir);
    const backup = createSnapshotBackup({ store, productStore, filePath });
    try {
      const pending = backup.run();
      assert.equal(backup.run(), pending);
      const first = await pending;
      assert.equal(typeof first.exportedAt, 'string');
      assert.equal(first.filePath, filePath);
      assert.deepEqual(backup.status().enabled, true);
      assert.equal(typeof backup.status().lastBackupAt, 'string');
      const firstData = JSON.parse(readFileSync(filePath, 'utf8'));
      assert.equal(firstData.format, 'quotahub-export');
      assert.equal(firstData.product.accounts.length, 1);
      assert.equal(firstData.product.account_upstreams.length, 1);
      assert.equal(statSync(filePath).mode & 0o777, 0o600);

      productStore.upsertAccount({ email: 'member@example.com', name: 'Backup Member' });
      await backup.run();
      const replaced = JSON.parse(readFileSync(filePath, 'utf8'));
      assert.equal(replaced.product.accounts.length, 2);
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.startsWith('quotahub-snapshot')),
        ['quotahub-snapshot.json']
      );
    } finally {
      await backup.close();
      productStore.sqlite.close();
      store.sqlite.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot backup defaults to a one-hour interval', () => {
  assert.equal(SNAPSHOT_BACKUP_INTERVAL_MS, 60 * 60 * 1_000);
});

test('worker backup captures both WAL stores before later writes and drains on close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-backup-snapshot-'));
  const store = new Store(dir);
  const productStore = new ProductStore(dir);
  const filePath = snapshotBackupPath(dir);
  const backup = createSnapshotBackup({ store, productStore, filePath });
  try {
    productStore.upsertAccount({ email: 'before@example.test' });
    const pending = backup.run();
    await Promise.resolve();
    // The buffers have been captured, but the worker has not finished its export.
    store.create({ type: 'compass', projectId: 'after', projectKey: 'synthetic' });
    productStore.upsertAccount({ email: 'after@example.test' });
    let ticked = false;
    setImmediate(() => { ticked = true; });
    await backup.close();
    assert.ok(await pending);
    assert.equal(ticked, true);
    assert.equal(await backup.run(), null);
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.deepEqual(data.product.accounts.map(({ email }) => email), ['before@example.test']);
    assert.equal(data.gateway.records.some(({ collection }) => collection === 'upstreams'), false);
    assert.equal(store.sqlite.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(productStore.sqlite.pragma('journal_mode', { simple: true }), 'wal');
  } finally {
    await backup.close();
    productStore.sqlite.close();
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup status reports failures without exposing the error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-backup-failure-'));
  const backup = createSnapshotBackup({
    store: {}, productStore: {}, filePath: join(dir, 'snapshot.json'),
    logger: { error: () => {} }
  });
  try {
    assert.equal(await backup.run(), null);
    assert.equal(backup.status().lastBackupAt, null);
    assert.equal(typeof backup.status().lastAttemptAt, 'string');
    assert.equal(backup.status().lastFailureAt, backup.status().lastAttemptAt);
    assert.equal(JSON.stringify(backup.status()).includes('error'), false);
  } finally {
    await backup.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
