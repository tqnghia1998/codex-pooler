import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { exportAllData } from '../../src/data-portability.js';

export const SNAPSHOT_BACKUP_INTERVAL_MS = 60 * 60 * 1_000;
export const SNAPSHOT_BACKUP_FILENAME = 'quotahub-snapshot.json';

export function snapshotBackupPath(dataDir) {
  return join(resolve(dataDir), SNAPSHOT_BACKUP_FILENAME);
}

export function writeSnapshotBackup({ store, productStore, filePath }) {
  const data = exportAllData({ store, productStore });
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${filePath}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(data), { mode: 0o600 });
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return { exportedAt: data.exportedAt, filePath };
}

function writeSnapshotInWorker({ store, productStore, filePath }) {
  // Capture both stores in one event-loop turn. The worker never opens live files.
  const gateway = Uint8Array.from(store.sqlite.serialize());
  const product = Uint8Array.from(productStore.sqlite.serialize());
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./backup-worker.js', import.meta.url), {
      workerData: { gateway, product, filePath },
      transferList: [gateway.buffer, product.buffer]
    });
    let result = null;
    worker.once('message', (message) => { result = message; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0 && result) resolve(result);
      else reject(new Error('Snapshot worker failed'));
    });
  });
}

function backupTimestamp(filePath) {
  try {
    const stat = statSync(filePath);
    return stat.isFile() ? stat.mtime.toISOString() : null;
  } catch {
    return null;
  }
}

export function createSnapshotBackup({
  store,
  productStore,
  filePath = snapshotBackupPath(process.env.POOL_DATA_DIR || resolve(process.cwd(), 'pool/.data')),
  intervalMs = Number(process.env.POOL_BACKUP_INTERVAL_MS) || SNAPSHOT_BACKUP_INTERVAL_MS,
  logger = console
} = {}) {
  const resolvedFilePath = resolve(filePath);
  let running = null;
  let closed = false;
  let lastBackupAt = backupTimestamp(resolvedFilePath);
  let lastAttemptAt = null;
  let lastFailureAt = null;
  const run = () => {
    if (closed) return Promise.resolve(null);
    if (running) return running;
    lastAttemptAt = new Date().toISOString();
    running = Promise.resolve()
      .then(() => writeSnapshotInWorker({ store, productStore, filePath: resolvedFilePath }))
      .then((result) => {
        lastBackupAt = backupTimestamp(resolvedFilePath);
        lastFailureAt = null;
        return result;
      })
      .catch((error) => {
        lastFailureAt = lastAttemptAt;
        logger?.error?.(`QuotaHub automatic backup failed: ${error?.message || 'unknown error'}`);
        return null;
      })
      .finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return {
    filePath: resolvedFilePath,
    run,
    status() {
      return { enabled: true, lastBackupAt, lastAttemptAt, lastFailureAt };
    },
    close() {
      closed = true;
      clearInterval(timer);
      return running || Promise.resolve();
    }
  };
}
