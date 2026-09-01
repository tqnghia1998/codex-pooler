import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from 'redis';

const PRODUCT_TABLES = [
  ['accounts', 'id'], ['account_sessions', 'id'], ['account_upstreams', 'upstream_id'], ['codex_login_attempts', 'id'],
  ['sharing_offers', 'id'], ['sharing_tickets', 'id'], ['sharing_sessions', 'id'], ['sharing_session_keys', 'id'],
  ['personal_api_keys', 'id'], ["personal_api_key_routes", "key_id || ':' || route_key"],
  ["sharing_session_settlements", "session_id || ':' || attempt_id"], ['sharing_reservations', 'id'],
  ["sharing_activity", "subject_type || ':' || subject_id"], ['quota_requests', 'id'], ['provider_observations', 'upstream_id'],
  ['email_outbox', 'id'], ['sharing_events', 'id']
];

export async function openRedisDocumentPersistence({ url, prefix = 'codex-share', client = null, logger = console } = {}) {
  const persistence = new RedisDocumentPersistence({ url, prefix, client, logger });
  await persistence.open();
  return persistence;
}

export class RedisDocumentPersistence {
  constructor({ url, prefix, client, logger }) {
    this.client = client || createClient({ url });
    this.prefix = String(prefix || 'codex-share').trim() || 'codex-share';
    this.logger = logger;
    this.pending = Promise.resolve();
    this.runtimeDir = null;
    this.databases = new Map();
  }

  async open() {
    this.client.on?.('error', (error) => this.logger?.error?.(`Codex Share Redis error: ${error.message}`));
    if (!this.client.isOpen) await this.client.connect();
    if (!await this.client.exists(this.key('manifest'))) throw new Error('POOL_REDIS_URL has no Redis-native Codex Share data; migrate it before starting');
  }

  async restore() {
    this.runtimeDir = await mkdtemp(join(tmpdir(), 'codex-share-redis-'));
    for (const [name, file] of [['gateway', '.key'], ['product', '.pool-key']]) {
      const encoded = await this.client.get(this.key(`encryption:${name}`));
      if (!encoded) throw new Error(`Redis-native Codex Share data is missing encryption:${name}`);
      await writeFile(join(this.runtimeDir, file), Buffer.from(encoded, 'base64'), { mode: 0o600 });
    }
    return this.runtimeDir;
  }

  async hydrate(gateway, product) {
    const gatewayRows = await this.records('gateway-records');
    gateway.exec('DELETE FROM records');
    const gatewayInsert = gateway.prepare('INSERT INTO records (collection, key, value) VALUES (?, ?, ?)');
    const insertGateway = gateway.transaction(() => {
      for (const { collection, key, value } of gatewayRows) gatewayInsert.run(collection, key, value);
    });
    insertGateway();

    product.pragma('foreign_keys = OFF');
    try {
      for (const [table] of PRODUCT_TABLES) {
        product.prepare(`DELETE FROM ${table}`).run();
        const rows = await this.records(table);
        if (!rows.length) continue;
        const allowedColumns = new Set(product.pragma(`table_info(${table})`).map(({ name }) => name));
        const columns = Object.keys(rows[0]).filter((column) => allowedColumns.has(column));
        if (!columns.length) continue;
        const insert = product.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
        const insertRows = product.transaction(() => {
          for (const row of rows) insert.run(...columns.map((column) => row[column]));
        });
        insertRows();
      }
    } finally {
      product.pragma('foreign_keys = ON');
    }
  }

  attach(name, database) {
    this.databases.set(name, database);
    return trackSqliteWrites(database, () => this.schedule(name));
  }

  schedule(name) {
    this.pending = this.pending.catch(() => {}).then(() => this.persist(name));
    this.pending.catch((error) => this.logger?.error?.(`Codex Share Redis persistence failed: ${error.message}`));
  }

  async flush() {
    await this.pending;
    await Promise.all([...this.databases.keys()].map((name) => this.persist(name)));
  }

  async close() {
    try {
      await this.flush();
    } finally {
      if (this.client.isOpen) await this.client.close();
      if (this.runtimeDir) await rm(this.runtimeDir, { recursive: true, force: true });
    }
  }

  async persist(name) {
    const database = this.databases.get(name);
    if (!database) return;
    if (name === 'gateway') {
      const rows = database.prepare('SELECT collection, key, value FROM records').all();
      await this.sync('gateway-records', rows.map((row) => ({ id: `${row.collection}:${row.key}`, value: row })));
      return;
    }
    for (const [table, identity] of PRODUCT_TABLES) {
      const rows = database.prepare(`SELECT *, ${identity} AS redis_id FROM ${table}`).all();
      await this.sync(table, rows.map(({ redis_id: id, ...value }) => ({ id, value })));
    }
  }

  async records(collection) {
    const ids = await this.client.sMembers(this.key(`index:${collection}`));
    if (!ids.length) return [];
    const values = await this.client.mGet(ids.map((id) => this.key(`record:${collection}:${id}`)));
    return values.flatMap((value) => value ? [JSON.parse(value)] : []);
  }

  async sync(collection, rows) {
    const index = this.key(`index:${collection}`);
    const existing = await this.client.sMembers(index);
    const current = new Set(rows.map(({ id }) => id));
    const batch = this.client.multi();
    for (const { id, value } of rows) {
      batch.set(this.key(`record:${collection}:${id}`), JSON.stringify(value));
      batch.sAdd(index, id);
    }
    for (const id of existing) {
      if (!current.has(id)) {
        batch.del(this.key(`record:${collection}:${id}`));
        batch.sRem(index, id);
      }
    }
    await batch.exec();
  }

  key(name) {
    return `${this.prefix}:${name}`;
  }
}

function trackSqliteWrites(database, persist) {
  let transactionDepth = 0;
  let transactionDirty = false;
  const markDirty = () => {
    if (transactionDepth) transactionDirty = true;
    else persist();
  };
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (source) => trackStatement(target.prepare(source), markDirty);
      if (property === 'transaction') return (fn) => {
        const transaction = target.transaction(fn);
        return (...args) => {
          const outermost = transactionDepth === 0;
          transactionDepth += 1;
          try {
            const result = transaction(...args);
            if (outermost && transactionDirty) {
              transactionDirty = false;
              persist();
            }
            return result;
          } catch (error) {
            if (outermost) transactionDirty = false;
            throw error;
          } finally {
            transactionDepth -= 1;
          }
        };
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function trackStatement(statement, markDirty) {
  return new Proxy(statement, {
    get(target, property) {
      if (property === 'run') return (...args) => {
        const result = target.run(...args);
        markDirty();
        return result;
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
