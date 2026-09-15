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
    const backup = createSnapshotBackup({ store, productStore, filePath, intervalMs: 20 });
    try {
      const first = backup.run();
      assert.equal(typeof first.exportedAt, 'string');
      assert.equal(first.filePath, filePath);
      const firstData = JSON.parse(readFileSync(filePath, 'utf8'));
      assert.equal(firstData.format, 'quotahub-export');
      assert.equal(firstData.product.accounts.length, 1);
      assert.equal(firstData.product.account_upstreams.length, 1);
      assert.equal(statSync(filePath).mode & 0o777, 0o600);

      productStore.upsertAccount({ email: 'member@example.com', name: 'Backup Member' });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const replaced = JSON.parse(readFileSync(filePath, 'utf8'));
      assert.equal(replaced.product.accounts.length, 2);
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.startsWith('quotahub-snapshot')),
        ['quotahub-snapshot.json']
      );
    } finally {
      backup.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot backup defaults to a one-hour interval', () => {
  assert.equal(SNAPSHOT_BACKUP_INTERVAL_MS, 60 * 60 * 1_000);
});
