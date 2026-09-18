import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  let running = false;
  let closed = false;
  let lastBackupAt = backupTimestamp(resolvedFilePath);
  const run = () => {
    if (running || closed) return null;
    running = true;
    try {
      const result = writeSnapshotBackup({ store, productStore, filePath: resolvedFilePath });
      lastBackupAt = backupTimestamp(resolvedFilePath);
      return result;
    } catch (error) {
      logger?.error?.(`QuotaHub automatic backup failed: ${error?.message || 'unknown error'}`);
      return null;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return {
    filePath: resolvedFilePath,
    run,
    status() {
      return { enabled: true, lastBackupAt };
    },
    close() {
      closed = true;
      clearInterval(timer);
    }
  };
}
