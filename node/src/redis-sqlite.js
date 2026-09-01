import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createClient } from 'redis';

const LOCK_TTL_MS = 60_000;
const LOCK_RENEWAL_MS = 20_000;

export async function openRedisSqlitePersistence({ url, prefix = 'codex-share', client = null, logger = console } = {}) {
  if (!url && !client) return null;
  const persistence = new RedisSqlitePersistence({ url, prefix, client, logger });
  await persistence.open();
  return persistence;
}

export class RedisSqlitePersistence {
  constructor({ url, prefix, client, logger }) {
    this.client = client || createClient({ url });
    this.prefix = String(prefix || 'codex-share').trim() || 'codex-share';
    this.logger = logger;
    this.instanceId = randomUUID();
    this.databases = new Map();
    this.pending = Promise.resolve();
    this.lockTimer = null;
    this.closePromise = null;
  }

  async open() {
    this.client.on?.('error', (error) => this.logger?.error?.(`Codex Share Redis error: ${error.message}`));
    if (!this.client.isOpen) await this.client.connect();
    const acquired = await this.client.set(this.lockKey(), this.instanceId, { NX: true, PX: LOCK_TTL_MS });
    if (acquired !== 'OK') {
      await this.client.close?.();
      throw new Error('POOL_REDIS_URL supports one Codex Share replica; another replica already holds the Redis lock');
    }
    this.lockTimer = setInterval(() => { void this.renewLock(); }, LOCK_RENEWAL_MS);
    this.lockTimer.unref?.();
  }

  async restore(dataDir) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    for (const name of ['db.sqlite', '.key', 'pool.sqlite', '.pool-key']) {
      const remote = await this.client.get(this.fileKey(name));
      const path = join(dataDir, name);
      if (remote !== null) await writeFile(path, Buffer.from(remote, 'base64'), { mode: 0o600 });
    }
    for (const [database, key] of [['db.sqlite', '.key'], ['pool.sqlite', '.pool-key']]) {
      const hasDatabase = await this.client.exists(this.fileKey(database));
      const hasKey = await this.client.exists(this.fileKey(key));
      if (hasDatabase !== hasKey) throw new Error(`Redis persistence is missing ${hasDatabase ? key : database}`);
    }
  }

  attach(name, database, keyPath) {
    this.databases.set(name, { database, keyPath });
    return trackSqliteWrites(database, () => this.schedule(name));
  }

  schedule(name) {
    this.pending = this.pending
      .catch(() => {})
      .then(() => this.persist(name));
    this.pending.catch((error) => this.logger?.error?.(`Codex Share Redis persistence failed: ${error.message}`));
  }

  async flush() {
    await this.pending;
    await Promise.all([...this.databases.keys()].map((name) => this.persist(name)));
  }

  close() {
    this.closePromise ||= this.closeOnce();
    return this.closePromise;
  }

  async closeOnce() {
    clearInterval(this.lockTimer);
    await this.flush();
    await this.releaseLock();
    await this.client.close?.();
  }

  async persist(name) {
    const entry = this.databases.get(name);
    if (!entry) return;
    const database = entry.database.serialize().toString('base64');
    const key = (await readFile(entry.keyPath)).toString('base64');
    await this.client.multi()
      .set(this.fileKey(name), database)
      .set(this.fileKey(basename(entry.keyPath)), key)
      .exec();
  }

  async renewLock() {
    const renewed = await this.client.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) end return 0',
      { keys: [this.lockKey()], arguments: [this.instanceId, String(LOCK_TTL_MS)] }
    );
    if (!renewed) this.logger?.error?.('Codex Share Redis lock was lost; stop this replica before starting another');
  }

  async releaseLock() {
    await this.client.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0',
      { keys: [this.lockKey()], arguments: [this.instanceId] }
    ).catch(() => {});
  }

  lockKey() {
    return `${this.prefix}:lock`;
  }

  fileKey(name) {
    return `${this.prefix}:file:${name}`;
  }
}

export function trackSqliteWrites(database, persist) {
  let transactionDepth = 0;
  let transactionDirty = false;
  const markDirty = () => {
    if (transactionDepth) transactionDirty = true;
    else persist();
  };
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (source) => trackStatement(target.prepare(source), markDirty);
      }
      if (property === 'exec') {
        return (source) => {
          const result = target.exec(source);
          if (writesSql(source)) markDirty();
          return result;
        };
      }
      if (property === 'transaction') {
        return (fn) => {
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
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function trackStatement(statement, markDirty) {
  return new Proxy(statement, {
    get(target, property) {
      if (property === 'run') {
        return (...args) => {
          const result = target.run(...args);
          markDirty();
          return result;
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function writesSql(source) {
  return /^\s*(?:alter|analyze|create|delete|drop|insert|pragma|reindex|replace|update|vacuum)\b/i.test(String(source));
}
