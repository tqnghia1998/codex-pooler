import { workerData, parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { writeSnapshotBackup } from './backup.js';

function openSnapshot(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // SQLite deserialize requires rollback-mode header bytes, even for WAL snapshots.
  // https://www.sqlite.org/c3ref/deserialize.html
  buffer[18] = 1;
  buffer[19] = 1;
  return new Database(buffer);
}

const gateway = openSnapshot(workerData.gateway);
let product;
try {
  product = openSnapshot(workerData.product);
  parentPort.postMessage(writeSnapshotBackup({
    store: { sqlite: gateway },
    productStore: { sqlite: product },
    filePath: workerData.filePath
  }));
} finally {
  product?.close();
  gateway.close();
}
