import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { offerExceedsProviderQuota, providerIssue } from './provider-availability.js';

const LOGIN_ATTEMPT_TTL_MS = 20 * 60 * 1_000;
const OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const SHARE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const RESERVATION_TTL_MS = 2 * 60 * 60 * 1_000;
const LOGIN_ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const ROUTE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const ACCOUNT_SESSION_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const EXPIRY_CHECK_INTERVAL_MS = 1_000;
const SETTLEMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const EMAIL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const HISTORY_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const ACTIVITY_FAILURE_LIMIT = 10;
const ACTIVITY_MODEL_LIMIT = 20;

export class ProductStore {
  constructor(dataDir = process.env.POOL_DATA_DIR || resolve(process.cwd(), 'pool/.data'), { encryptionKey = null, inMemory = false } = {}) {
    this.dataDir = inMemory ? null : resolve(dataDir);
    this.dbPath = inMemory ? ':memory:' : join(this.dataDir, 'pool.sqlite');
    this.keyPath = inMemory ? null : join(this.dataDir, '.pool-key');
    this.emailNotificationsEnabled = false;
    this.lastExpiryCheckAt = 0;
    if (!inMemory) {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      chmodSync(this.dataDir, 0o700);
    }
    if (inMemory && !encryptionKey) throw new Error('In-memory ProductStore requires an encryption key');
    this.key = encryptionKey ? normalizeEncryptionKey(encryptionKey) : this.loadKey();
    this.sqlite = new Database(this.dbPath);
    if (!inMemory) chmodSync(this.dbPath, 0o600);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.createSchema();
  }

  createSchema() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        google_sub TEXT UNIQUE,
        codex_subject TEXT,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS account_upstreams (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        upstream_id TEXT NOT NULL UNIQUE,
        scope_id TEXT NOT NULL,
        sharing_status TEXT NOT NULL DEFAULT 'active',
        sharing_updated_at TEXT,
        link_order INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, upstream_id)
      );
      CREATE TABLE IF NOT EXISTS codex_login_attempts (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        attempt_token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        verification_url TEXT,
        user_code TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sharing_offers (
        id TEXT PRIMARY KEY,
        provider_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        upstream_id TEXT NOT NULL,
        quota_micros INTEGER NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sharing_tickets (
        id TEXT PRIMARY KEY,
        offer_id TEXT NOT NULL REFERENCES sharing_offers(id) ON DELETE CASCADE,
        provider_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        consumer_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        demand_request_id TEXT REFERENCES quota_requests(id) ON DELETE SET NULL,
        requested_micros INTEGER NOT NULL,
        approved_micros INTEGER,
        status TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sharing_sessions (
        id TEXT PRIMARY KEY,
        offer_id TEXT NOT NULL REFERENCES sharing_offers(id) ON DELETE CASCADE,
        ticket_id TEXT NOT NULL UNIQUE REFERENCES sharing_tickets(id) ON DELETE CASCADE,
        provider_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        consumer_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        upstream_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        granted_micros INTEGER NOT NULL,
        consumed_micros INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        pending_key_cipher TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sharing_session_keys (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE REFERENCES sharing_sessions(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        disabled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS personal_api_keys (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT 'Default',
        key_hash TEXT NOT NULL UNIQUE,
        key_cipher TEXT NOT NULL,
        last_session_id TEXT REFERENCES sharing_sessions(id) ON DELETE SET NULL,
        expires_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disabled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS personal_api_key_routes (
        key_id TEXT NOT NULL REFERENCES personal_api_keys(id) ON DELETE CASCADE,
        route_key TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sharing_sessions(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (key_id, route_key)
      );
      CREATE TABLE IF NOT EXISTS sharing_session_settlements (
        session_id TEXT NOT NULL REFERENCES sharing_sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        settled_micros INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, attempt_id)
      );
      CREATE TABLE IF NOT EXISTS sharing_reservations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sharing_sessions(id) ON DELETE CASCADE,
        key_id TEXT,
        reserved_micros INTEGER NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        route TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        settled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sharing_activity (
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        total_micros INTEGER NOT NULL DEFAULT 0,
        today_date TEXT,
        today_micros INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        last_success_at TEXT,
        models_json TEXT NOT NULL DEFAULT '[]',
        failures_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (subject_type, subject_id)
      );
      CREATE TABLE IF NOT EXISTS quota_requests (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        quota_micros INTEGER NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_observations (
        upstream_id TEXT PRIMARY KEY,
        issue_code TEXT,
        reset_at TEXT,
        remaining_micros INTEGER,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_outbox (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sharing_events (
        id TEXT PRIMARY KEY,
        actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sharing_offers_provider_idx ON sharing_offers(provider_account_id);
      CREATE INDEX IF NOT EXISTS sharing_offers_status_created_idx ON sharing_offers(status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_tickets_provider_idx ON sharing_tickets(provider_account_id, status);
      CREATE INDEX IF NOT EXISTS sharing_tickets_consumer_idx ON sharing_tickets(consumer_account_id, status);
      CREATE INDEX IF NOT EXISTS sharing_tickets_provider_created_idx ON sharing_tickets(provider_account_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_tickets_consumer_created_idx ON sharing_tickets(consumer_account_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_tickets_provider_status_created_idx ON sharing_tickets(provider_account_id, status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_tickets_consumer_status_created_idx ON sharing_tickets(consumer_account_id, status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_sessions_provider_idx ON sharing_sessions(provider_account_id, status);
      CREATE INDEX IF NOT EXISTS sharing_sessions_consumer_idx ON sharing_sessions(consumer_account_id, status);
      CREATE INDEX IF NOT EXISTS sharing_sessions_provider_created_idx ON sharing_sessions(provider_account_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_sessions_consumer_created_idx ON sharing_sessions(consumer_account_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_sessions_provider_status_created_idx ON sharing_sessions(provider_account_id, status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_sessions_consumer_status_created_idx ON sharing_sessions(consumer_account_id, status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_reservations_session_idx ON sharing_reservations(session_id, status, expires_at);
      CREATE INDEX IF NOT EXISTS sharing_reservations_key_idx ON sharing_reservations(key_id, status);
      CREATE INDEX IF NOT EXISTS quota_requests_status_idx ON quota_requests(status, created_at);
      CREATE INDEX IF NOT EXISTS email_outbox_pending_idx ON email_outbox(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS personal_api_keys_account_idx ON personal_api_keys(account_id, created_at);
      CREATE INDEX IF NOT EXISTS personal_api_key_routes_session_idx ON personal_api_key_routes(session_id);
      CREATE INDEX IF NOT EXISTS codex_login_attempts_expiry_idx ON codex_login_attempts(expires_at);
      CREATE INDEX IF NOT EXISTS personal_api_key_routes_updated_idx ON personal_api_key_routes(updated_at);
      CREATE INDEX IF NOT EXISTS sharing_reservations_retention_idx ON sharing_reservations(status, settled_at, expires_at);
      CREATE INDEX IF NOT EXISTS sharing_session_settlements_created_idx ON sharing_session_settlements(created_at);
      CREATE INDEX IF NOT EXISTS sharing_sessions_retention_idx ON sharing_sessions(status, updated_at);
      CREATE INDEX IF NOT EXISTS sharing_tickets_retention_idx ON sharing_tickets(status, resolved_at, created_at);
      CREATE INDEX IF NOT EXISTS sharing_offers_retention_idx ON sharing_offers(status, updated_at);
      CREATE INDEX IF NOT EXISTS quota_requests_retention_idx ON quota_requests(status, updated_at);
      CREATE INDEX IF NOT EXISTS email_outbox_retention_idx ON email_outbox(status, sent_at, created_at);
      CREATE INDEX IF NOT EXISTS sharing_events_cursor_idx ON sharing_events(created_at DESC, id DESC);
    `);
    this.migrateIdentitySchema();
    this.migrateSharingSchema();
  }

  migrateIdentitySchema() {
    const accountColumns = this.sqlite.pragma('table_info(accounts)');
    if (!accountColumns.some(({ name }) => name === 'codex_subject')) {
      this.sqlite.exec('ALTER TABLE accounts ADD COLUMN codex_subject TEXT');
    }
    this.sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_codex_subject_idx
      ON accounts(codex_subject)
      WHERE codex_subject IS NOT NULL;
      CREATE INDEX IF NOT EXISTS accounts_email_idx
      ON accounts(email);
    `);

    const attemptColumns = this.sqlite.pragma('table_info(codex_login_attempts)');
    const accountColumn = attemptColumns.find(({ name }) => name === 'account_id');
    const current = attemptColumns.some(({ name }) => name === 'attempt_token_hash')
      && attemptColumns.some(({ name }) => name === 'consumed_at')
      && accountColumn?.notnull === 0;
    if (!current) {
      this.sqlite.exec(`
        DROP TABLE codex_login_attempts;
        CREATE TABLE codex_login_attempts (
          id TEXT PRIMARY KEY,
          account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
          attempt_token_hash TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          verification_url TEXT,
          user_code TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT
        );
      `);
    }
    this.sqlite.exec('DROP TABLE IF EXISTS oauth_states');

    const sessionColumns = this.sqlite.pragma('table_info(account_sessions)');
    if (sessionColumns.find(({ name }) => name === 'expires_at')?.notnull) {
      this.sqlite.exec(`
        PRAGMA foreign_keys = OFF;
        ALTER TABLE account_sessions RENAME TO account_sessions_legacy;
        CREATE TABLE account_sessions (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          csrf_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          revoked_at TEXT
        );
        INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, created_at, expires_at, revoked_at)
        SELECT id, account_id, token_hash, csrf_hash, created_at, NULL, revoked_at
        FROM account_sessions_legacy;
        DROP TABLE account_sessions_legacy;
        PRAGMA foreign_keys = ON;
      `);
    }
  }

  migrateSharingSchema() {
    addColumn(this.sqlite, 'account_upstreams', 'sharing_status', "TEXT NOT NULL DEFAULT 'active'");
    addColumn(this.sqlite, 'account_upstreams', 'sharing_updated_at', 'TEXT');
    addColumn(this.sqlite, 'account_upstreams', 'link_order', 'INTEGER');
    this.sqlite.exec('UPDATE account_upstreams SET link_order = rowid WHERE link_order IS NULL');
    addColumn(this.sqlite, 'sharing_offers', 'expires_at', 'TEXT');
    addColumn(this.sqlite, 'sharing_tickets', 'expires_at', 'TEXT');
    addColumn(this.sqlite, 'sharing_tickets', 'demand_request_id', 'TEXT');
    addColumn(this.sqlite, 'sharing_sessions', 'expires_at', 'TEXT');

    const personalColumns = this.sqlite.pragma('table_info(personal_api_keys)');
    const accountColumn = personalColumns.find(({ name }) => name === 'account_id');
    if (accountColumn && hasUniqueSingleColumnIndex(this.sqlite, 'personal_api_keys', 'account_id')) {
      this.sqlite.exec(`
        PRAGMA foreign_keys = OFF;
        ALTER TABLE personal_api_key_routes RENAME TO personal_api_key_routes_legacy;
        ALTER TABLE personal_api_keys RENAME TO personal_api_keys_legacy;
        CREATE TABLE personal_api_keys (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          name TEXT NOT NULL DEFAULT 'Default',
          key_hash TEXT NOT NULL UNIQUE,
          key_cipher TEXT NOT NULL,
          last_session_id TEXT REFERENCES sharing_sessions(id) ON DELETE SET NULL,
          expires_at TEXT,
          last_used_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          disabled_at TEXT
        );
        CREATE TABLE personal_api_key_routes (
          key_id TEXT NOT NULL REFERENCES personal_api_keys(id) ON DELETE CASCADE,
          route_key TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES sharing_sessions(id) ON DELETE CASCADE,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (key_id, route_key)
        );
        INSERT INTO personal_api_keys
          (id, account_id, name, key_hash, key_cipher, last_session_id, created_at, updated_at, disabled_at)
        SELECT id, account_id, 'Default', key_hash, key_cipher, last_session_id, created_at, updated_at, disabled_at
        FROM personal_api_keys_legacy;
        INSERT INTO personal_api_key_routes (key_id, route_key, session_id, updated_at)
        SELECT key_id, route_key, session_id, updated_at
        FROM personal_api_key_routes_legacy;
        DROP TABLE personal_api_key_routes_legacy;
        DROP TABLE personal_api_keys_legacy;
        CREATE INDEX personal_api_keys_account_idx ON personal_api_keys(account_id, created_at);
        CREATE INDEX personal_api_key_routes_session_idx ON personal_api_key_routes(session_id);
        PRAGMA foreign_keys = ON;
      `);
    } else {
      addColumn(this.sqlite, 'personal_api_keys', 'name', "TEXT NOT NULL DEFAULT 'Default'");
      addColumn(this.sqlite, 'personal_api_keys', 'expires_at', 'TEXT');
      addColumn(this.sqlite, 'personal_api_keys', 'last_used_at', 'TEXT');
    }
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS personal_api_keys_account_idx ON personal_api_keys(account_id, created_at);
      CREATE INDEX IF NOT EXISTS sharing_offers_status_created_idx ON sharing_offers(status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_tickets_provider_created_idx ON sharing_tickets(provider_account_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_tickets_consumer_created_idx ON sharing_tickets(consumer_account_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_tickets_provider_status_created_idx ON sharing_tickets(provider_account_id, status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_tickets_consumer_status_created_idx ON sharing_tickets(consumer_account_id, status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_sessions_provider_created_idx ON sharing_sessions(provider_account_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_sessions_consumer_created_idx ON sharing_sessions(consumer_account_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_sessions_provider_status_created_idx ON sharing_sessions(provider_account_id, status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_sessions_consumer_status_created_idx ON sharing_sessions(consumer_account_id, status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sharing_reservations_session_idx ON sharing_reservations(session_id, status, expires_at);
      CREATE INDEX IF NOT EXISTS sharing_reservations_key_idx ON sharing_reservations(key_id, status);
      CREATE INDEX IF NOT EXISTS quota_requests_status_idx ON quota_requests(status, created_at);
      CREATE INDEX IF NOT EXISTS email_outbox_pending_idx ON email_outbox(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS codex_login_attempts_expiry_idx ON codex_login_attempts(expires_at);
      CREATE INDEX IF NOT EXISTS personal_api_key_routes_updated_idx ON personal_api_key_routes(updated_at);
      CREATE INDEX IF NOT EXISTS sharing_reservations_retention_idx ON sharing_reservations(status, settled_at, expires_at);
      CREATE INDEX IF NOT EXISTS sharing_session_settlements_created_idx ON sharing_session_settlements(created_at);
      CREATE INDEX IF NOT EXISTS sharing_sessions_retention_idx ON sharing_sessions(status, updated_at);
      CREATE INDEX IF NOT EXISTS sharing_tickets_retention_idx ON sharing_tickets(status, resolved_at, created_at);
      CREATE INDEX IF NOT EXISTS sharing_offers_retention_idx ON sharing_offers(status, updated_at);
      CREATE INDEX IF NOT EXISTS quota_requests_retention_idx ON quota_requests(status, updated_at);
      CREATE INDEX IF NOT EXISTS email_outbox_retention_idx ON email_outbox(status, sent_at, created_at);
      DROP INDEX IF EXISTS sharing_events_created_idx;
      CREATE INDEX IF NOT EXISTS sharing_events_cursor_idx ON sharing_events(created_at DESC, id DESC);
    `);
  }

  upsertSmartAccount({ username = '', email = '', name = '', sub = '' } = {}) {
    const cleanSub = String(sub || username || email || '').trim();
    if (!cleanSub) throw new Error('Smart account identifier is required');
    const smartSubject = `smart:${cleanSub}`;
    const normalizedEmail = cleanEmail(email, username ? `${username}@shopee.com` : 'user@smart.shopee.io');
    const normalizedName = cleanName(name || username, normalizedEmail);
    const now = new Date().toISOString();
    if (!this._smartAccountStmts) {
      this._smartAccountStmts = {
        findBySubject: this.sqlite.prepare('SELECT * FROM accounts WHERE codex_subject = ? OR codex_subject = ?'),
        findByEmail: this.sqlite.prepare('SELECT * FROM accounts WHERE email = ?'),
        update: this.sqlite.prepare(`
          UPDATE accounts
          SET codex_subject = COALESCE(NULLIF(?, ''), codex_subject), email = ?, display_name = ?, updated_at = ?
          WHERE id = ?
        `),
        insert: this.sqlite.prepare(`
          INSERT INTO accounts (id, google_sub, codex_subject, email, display_name, avatar_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
        `)
      };
    }
    const stmts = this._smartAccountStmts;
    const apply = this.sqlite.transaction(() => {
      let existing = stmts.findBySubject.get(smartSubject, `space:${cleanSub}`);
      if (!existing && normalizedEmail && normalizedEmail !== 'user@smart.shopee.io') {
        existing = stmts.findByEmail.get(normalizedEmail);
      }
      if (existing) {
        stmts.update.run(smartSubject, normalizedEmail, normalizedName, now, existing.id);
        this.ensureDefaultPersonalKey(existing.id);
        return existing.id;
      }
      const id = randomUUID();
      stmts.insert.run(id, `smart:${hash(smartSubject)}`, smartSubject, normalizedEmail, normalizedName, now, now);
      this.ensureDefaultPersonalKey(id);
      return id;
    });
    return this.account(apply());
  }

  upsertCodexAccount({ subject, issuer = '', email = '', name = '' }, preferredAccountId = null, { allowIdentityRotation = false } = {}) {
    const codexSubject = codexIdentity(subject, issuer);
    if (!codexSubject) throw new Error('Codex identity is missing subject');
    const now = new Date().toISOString();
    const apply = this.sqlite.transaction(() => {
      const bySubject = this.sqlite.prepare('SELECT * FROM accounts WHERE codex_subject = ?').get(codexSubject);
      const preferred = preferredAccountId ? this.requireAccount(preferredAccountId) : null;
      if (bySubject && preferred && bySubject.id !== preferred.id) {
        throw Object.assign(new Error('Codex identity is already linked to another Codex Share account'), { statusCode: 409 });
      }
      if (preferred?.codex_subject && preferred.codex_subject !== codexSubject && !allowIdentityRotation) {
        throw Object.assign(new Error('Codex account is already linked to another Codex Share identity'), { statusCode: 409 });
      }
      const existing = preferred || bySubject;
      const normalizedEmail = cleanEmail(email, existing?.email);
      if (existing) {
        this.sqlite.prepare(`
          UPDATE accounts
          SET codex_subject = ?, email = ?, display_name = ?, updated_at = ?
          WHERE id = ?
        `).run(codexSubject, normalizedEmail, cleanName(name, normalizedEmail), now, existing.id);
        this.ensureDefaultPersonalKey(existing.id);
        return existing.id;
      }
      const id = randomUUID();
      this.sqlite.prepare(`
        INSERT INTO accounts (id, google_sub, codex_subject, email, display_name, avatar_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(id, `codex:${hash(codexSubject)}`, codexSubject, normalizedEmail, cleanName(name, normalizedEmail), now, now);
      this.ensureDefaultPersonalKey(id);
      return id;
    });
    return this.account(apply());
  }

  createAccountSession(accountId) {
    this.requireAccount(accountId);
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const now = new Date();
    this.sqlite.prepare(`
      INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), accountId, hash(token), hash(csrfToken), now.toISOString(), null);
    return { token, csrfToken, expiresAt: null };
  }

  authenticateAccountSession(token, csrfToken = null) {
    if (!token) return null;
    const row = this.sqlite.prepare(`
      SELECT account_sessions.*, accounts.email, accounts.display_name, accounts.avatar_url
      FROM account_sessions JOIN accounts ON accounts.id = account_sessions.account_id
      WHERE token_hash = ? AND revoked_at IS NULL
    `).get(hash(token));
    if (!row) return null;
    const csrfValid = csrfToken ? constantEqual(row.csrf_hash, hash(csrfToken)) : false;
    return {
      sessionId: row.id,
      account: publicAccount({
        id: row.account_id,
        email: row.email,
        display_name: row.display_name,
        avatar_url: row.avatar_url
      }),
      csrfValid
    };
  }

  revokeAccountSession(token) {
    if (!token) return false;
    return this.sqlite.prepare('UPDATE account_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), hash(token)).changes > 0;
  }

  account(id) {
    const row = this.sqlite.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return row ? publicAccount(row) : null;
  }

  accountForCodexIdentity({ subject, issuer = '' }) {
    const identity = codexIdentity(subject, issuer);
    if (!identity) return null;
    const row = this.sqlite.prepare('SELECT * FROM accounts WHERE codex_subject = ?').get(identity);
    return row ? publicAccount(row) : null;
  }

  linkUpstream(accountId, upstreamId, scopeId = 'default') {
    const link = this.sqlite.transaction(() => {
      this.requireAccount(accountId);
      const existing = this.sqlite.prepare('SELECT account_id, link_order FROM account_upstreams WHERE upstream_id = ?').get(upstreamId);
      if (existing && existing.account_id !== accountId) {
        throw Object.assign(new Error('Codex account is already linked to another Codex Share account'), { statusCode: 409 });
      }
      const now = new Date().toISOString();
      const linkOrder = existing?.link_order || this.sqlite.prepare('SELECT COALESCE(MAX(link_order), 0) + 1 AS value FROM account_upstreams WHERE account_id = ?').get(accountId).value;
      this.sqlite.prepare(`
        INSERT INTO account_upstreams (account_id, upstream_id, scope_id, link_order, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(upstream_id) DO UPDATE SET scope_id = excluded.scope_id
      `).run(accountId, upstreamId, scopeId, linkOrder, now);
      return { created: !existing, link: { accountId, upstreamId, scopeId, createdAt: now } };
    })();
    if (link.created) this.event(accountId, 'upstream', upstreamId, 'linked', { scopeId });
    return link.link;
  }

  accountOwnsUpstream(accountId, upstreamId) {
    return Boolean(this.sqlite.prepare('SELECT 1 FROM account_upstreams WHERE account_id = ? AND upstream_id = ?').get(accountId, upstreamId));
  }

  listAccountUpstreamLinks(accountId) {
    return this.sqlite.prepare(`
      SELECT upstream_id AS upstreamId, scope_id AS scopeId, sharing_status AS sharingStatus,
        sharing_updated_at AS sharingUpdatedAt,
        link_order AS linkOrder,
        created_at AS createdAt
      FROM account_upstreams
      WHERE account_id = ?
      ORDER BY link_order
    `)
      .all(accountId);
  }

  listCanonicalAccountUpstreamLinks(accountId, upstreamStore) {
    const grouped = new Map();
    for (const link of this.listAccountUpstreamLinks(accountId)) {
      const upstream = upstreamStore.get(link.upstreamId);
      if (!upstream) continue;
      const key = upstreamIdentityKey(upstream) || `upstream:${upstream.id}`;
      const candidates = grouped.get(key) || [];
      candidates.push({ link, upstream });
      grouped.set(key, candidates);
    }
    return [...grouped.values()]
      .map((candidates) => candidates
        .sort((left, right) => compareCanonicalUpstreams(left, right, this))[0].link)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  upstreamActivity(upstreamId) {
    const offers = this.sqlite.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('active', 'paused') THEN 1 ELSE 0 END) AS active
      FROM sharing_offers
      WHERE upstream_id = ?
    `).get(upstreamId);
    const sessions = this.sqlite.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('active', 'paused') THEN 1 ELSE 0 END) AS active
      FROM sharing_sessions
      WHERE upstream_id = ?
    `).get(upstreamId);
    const tickets = this.sqlite.prepare(`
      SELECT COUNT(*) AS total
      FROM sharing_tickets
      JOIN sharing_offers ON sharing_offers.id = sharing_tickets.offer_id
      WHERE sharing_offers.upstream_id = ?
    `).get(upstreamId);
    return {
      activeSessions: Number(sessions?.active) || 0,
      activeOffers: Number(offers?.active) || 0,
      activityCount: (Number(offers?.total) || 0) + (Number(sessions?.total) || 0) + (Number(tickets?.total) || 0)
    };
  }

  accountIdForUpstream(upstreamId) {
    return this.sqlite.prepare('SELECT account_id AS accountId FROM account_upstreams WHERE upstream_id = ?').get(upstreamId)?.accountId || null;
  }

  providerSharingState(upstreamId) {
    const row = this.sqlite.prepare(`
      SELECT account_id, sharing_status, sharing_updated_at
      FROM account_upstreams
      WHERE upstream_id = ?
    `).get(upstreamId);
    return row ? {
      accountId: row.account_id,
      status: row.sharing_status || 'active',
      updatedAt: row.sharing_updated_at || null
    } : null;
  }

  setProviderSharing(accountId, upstreamId, status, upstreamStore) {
    if (!['active', 'paused'].includes(status)) throw new Error('sharing status must be active or paused');
    if (!this.accountOwnsUpstream(accountId, upstreamId) || !upstreamStore.get(upstreamId)) throw notFound();
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE account_upstreams
      SET sharing_status = ?, sharing_updated_at = ?
      WHERE account_id = ? AND upstream_id = ?
    `).run(status, now, accountId, upstreamId);
    this.event(accountId, 'upstream', upstreamId, status === 'paused' ? 'sharing_paused' : 'sharing_resumed', {});
    this.notifyProviderParticipants(
      upstreamId,
      status === 'paused' ? 'Codex sharing paused' : 'Codex sharing resumed',
      status === 'paused'
        ? 'The provider paused all sharing from this Codex account. Existing grants are preserved but cannot be used until sharing resumes.'
        : 'The provider resumed sharing from this Codex account.',
      `provider-sharing:${upstreamId}:${status}:${now}`
    );
    return this.providerSummary(accountId, upstreamId, upstreamStore);
  }

  revokeProviderSharing(accountId, upstreamId, upstreamStore) {
    if (!this.accountOwnsUpstream(accountId, upstreamId) || !upstreamStore.get(upstreamId)) throw notFound();
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE account_upstreams
        SET sharing_status = 'paused', sharing_updated_at = ?
        WHERE account_id = ? AND upstream_id = ?
      `).run(now, accountId, upstreamId);
      const offers = this.sqlite.prepare(`
        SELECT id FROM sharing_offers
        WHERE upstream_id = ? AND status IN ('active', 'paused')
      `).all(upstreamId);
      for (const offer of offers) {
        this.sqlite.prepare("UPDATE sharing_offers SET status = 'closed', updated_at = ? WHERE id = ?").run(now, offer.id);
        this.sqlite.prepare(`
          UPDATE sharing_tickets
          SET status = 'rejected', resolved_at = ?
          WHERE offer_id = ? AND status = 'pending'
        `).run(now, offer.id);
      }
      const sessions = this.sqlite.prepare(`
        SELECT id FROM sharing_sessions
        WHERE upstream_id = ? AND status NOT IN ('revoked', 'expired')
      `).all(upstreamId);
      for (const session of sessions) {
        this.sqlite.prepare(`
          UPDATE sharing_sessions
          SET status = 'revoked', pending_key_cipher = NULL, updated_at = ?
          WHERE id = ?
        `).run(now, session.id);
        this.sqlite.prepare(`
          UPDATE sharing_session_keys
          SET disabled_at = ?
          WHERE session_id = ? AND disabled_at IS NULL
        `).run(now, session.id);
        this.sqlite.prepare(`
          UPDATE sharing_reservations
          SET status = 'released', settled_at = ?, error_code = 'provider_revoked'
          WHERE session_id = ? AND status = 'active'
        `).run(now, session.id);
      }
      this.event(accountId, 'upstream', upstreamId, 'sharing_revoked', {
        offerCount: offers.length,
        sessionCount: sessions.length
      });
    })();
    this.notifyProviderParticipants(
      upstreamId,
      'Codex sharing revoked',
      'The provider revoked all offers and sessions from this Codex account.',
      `provider-sharing:${upstreamId}:revoked:${now}`
    );
    return this.providerSummary(accountId, upstreamId, upstreamStore);
  }

  providerSummary(accountId, upstreamId, upstreamStore) {
    if (!this.accountOwnsUpstream(accountId, upstreamId)) throw notFound();
    const upstream = upstreamStore.getPublic(upstreamId);
    if (!upstream) throw notFound();
    return {
      upstreamId,
      sharing: this.providerSharingState(upstreamId),
      commitment: publicProviderCommitment(this.providerCommitment(upstreamId, upstreamStore))
    };
  }

  providerCommitment(upstreamId, upstreamStore, cache = null) {
    if (cache?.has(upstreamId)) return cache.get(upstreamId);
    this.expireDue();
    const upstream = upstreamStore?.getPublic(upstreamId) || upstreamStore?.get(upstreamId) || null;
    const actualMicros = (upstream?.quotaSource === 'ais' || upstream?.quotaSource === 'aiswitch') ? null : providerRemainingMicros(upstream);
    const sessions = this.sqlite.prepare(`
      SELECT id, granted_micros, consumed_micros, created_at
      FROM sharing_sessions
      WHERE upstream_id = ? AND status IN ('active', 'paused')
      ORDER BY created_at, id
    `).all(upstreamId);
    const offers = this.sqlite.prepare(`
      SELECT id, quota_micros, created_at
      FROM sharing_offers
      WHERE upstream_id = ? AND status IN ('active', 'paused')
      ORDER BY created_at, id
    `).all(upstreamId);
    const sessionCommittedMicros = sessions.reduce(
      (total, row) => total + Math.max(0, row.granted_micros - row.consumed_micros),
      0
    );
    const offerReservedMicros = offers.reduce((total, row) => total + row.quota_micros, 0);
    const committedMicros = sessionCommittedMicros + offerReservedMicros;
    let backing = actualMicros;
    const sessionBacking = new Map();
    for (const row of sessions) {
      const remaining = Math.max(0, row.granted_micros - row.consumed_micros);
      const backed = backing === null ? remaining : Math.min(remaining, Math.max(0, backing));
      sessionBacking.set(row.id, backed);
      if (backing !== null) backing -= backed;
    }
    const offerBacking = new Map();
    for (const row of offers) {
      const backed = backing === null ? row.quota_micros : Math.min(row.quota_micros, Math.max(0, backing));
      offerBacking.set(row.id, backed);
      if (backing !== null) backing -= backed;
    }
    const commitment = {
      actualMicros,
      sessionCommittedMicros,
      offerReservedMicros,
      committedMicros,
      offerableMicros: actualMicros === null ? null : Math.max(0, actualMicros - committedMicros),
      underfundedMicros: actualMicros === null ? 0 : Math.max(0, committedMicros - actualMicros),
      sessionBacking,
      offerBacking
    };
    cache?.set(upstreamId, commitment);
    return commitment;
  }

  createCodexLoginAttempt() {
    const id = randomUUID();
    const token = randomToken(32);
    const now = new Date();
    this.sqlite.prepare(`
      INSERT INTO codex_login_attempts
      (id, attempt_token_hash, status, created_at, updated_at, expires_at)
      VALUES (?, ?, 'starting', ?, ?, ?)
    `).run(id, hash(token), now.toISOString(), now.toISOString(), new Date(now.getTime() + LOGIN_ATTEMPT_TTL_MS).toISOString());
    return { login: this.codexLoginAttemptById(id), token };
  }

  updateCodexLoginAttempt(id, patch = {}) {
    const allowedStatuses = new Set(['starting', 'waiting', 'completed', 'failed', 'cancelled']);
    const current = this.sqlite.prepare('SELECT * FROM codex_login_attempts WHERE id = ?').get(id);
    if (!current) throw notFound();
    const status = patch.status || current.status;
    if (!allowedStatuses.has(status)) throw new Error('invalid Codex login status');
    this.sqlite.prepare(`
      UPDATE codex_login_attempts
      SET account_id = ?, status = ?, verification_url = ?, user_code = ?, error_code = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.accountId === undefined ? current.account_id : patch.accountId,
      status,
      patch.verificationUrl === undefined ? current.verification_url : cleanUrl(patch.verificationUrl),
      patch.userCode === undefined ? current.user_code : cleanCode(patch.userCode),
      patch.errorCode === undefined ? current.error_code : cleanCode(patch.errorCode),
      new Date().toISOString(),
      id
    );
    return this.codexLoginAttemptById(id);
  }

  codexLoginAttemptById(id) {
    const row = this.sqlite.prepare('SELECT * FROM codex_login_attempts WHERE id = ?').get(id);
    return row ? publicLoginAttempt(row) : null;
  }

  codexLoginAttemptByToken(token) {
    if (!token) return null;
    const row = this.sqlite.prepare(`
      SELECT * FROM codex_login_attempts
      WHERE attempt_token_hash = ? AND expires_at > ?
    `).get(hash(token), new Date().toISOString());
    return row ? publicLoginAttempt(row) : null;
  }

  accountIdForCompletedCodexLogin(token) {
    if (!token) return null;
    return this.sqlite.prepare(`
      SELECT account_id AS accountId
      FROM codex_login_attempts
      WHERE attempt_token_hash = ? AND expires_at > ?
        AND status = 'completed' AND account_id IS NOT NULL AND consumed_at IS NULL
    `).get(hash(token), new Date().toISOString())?.accountId || null;
  }

  consumeCompletedCodexLogin(token) {
    if (!token) return null;
    const consume = this.sqlite.transaction(() => {
      const row = this.sqlite.prepare(`
        SELECT * FROM codex_login_attempts
        WHERE attempt_token_hash = ? AND expires_at > ?
          AND status = 'completed' AND account_id IS NOT NULL AND consumed_at IS NULL
      `).get(hash(token), new Date().toISOString());
      if (!row) return null;
      const session = this.createAccountSession(row.account_id);
      const consumedAt = new Date().toISOString();
      this.sqlite.prepare('UPDATE codex_login_attempts SET consumed_at = ?, updated_at = ? WHERE id = ? AND consumed_at IS NULL')
        .run(consumedAt, consumedAt, row.id);
      return { login: publicLoginAttempt({ ...row, consumed_at: consumedAt, updated_at: consumedAt }), session };
    });
    return consume();
  }

  expireDue(now = new Date(), { force = false } = {}) {
    const timestampMs = new Date(now).getTime();
    if (!force && timestampMs >= this.lastExpiryCheckAt && timestampMs - this.lastExpiryCheckAt < EXPIRY_CHECK_INTERVAL_MS) {
      return { offers: [], tickets: [], sessions: [] };
    }
    const timestamp = new Date(timestampMs).toISOString();
    const expire = this.sqlite.transaction(() => {
      const offers = this.sqlite.prepare(`
        SELECT id, provider_account_id
        FROM sharing_offers
        WHERE status IN ('active', 'paused') AND expires_at IS NOT NULL AND expires_at <= ?
      `).all(timestamp);
      for (const row of offers) {
        this.sqlite.prepare("UPDATE sharing_offers SET status = 'expired', updated_at = ? WHERE id = ?")
          .run(timestamp, row.id);
        this.sqlite.prepare(`
          UPDATE sharing_tickets
          SET status = 'expired', resolved_at = ?
          WHERE offer_id = ? AND status = 'pending'
        `).run(timestamp, row.id);
        this.event(row.provider_account_id, 'offer', row.id, 'expired', {});
      }
      const tickets = this.sqlite.prepare(`
        SELECT id, consumer_account_id
        FROM sharing_tickets
        WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
      `).all(timestamp);
      for (const row of tickets) {
        this.sqlite.prepare("UPDATE sharing_tickets SET status = 'expired', resolved_at = ? WHERE id = ?")
          .run(timestamp, row.id);
        this.event(row.consumer_account_id, 'ticket', row.id, 'expired', {});
      }
      const sessions = this.sqlite.prepare(`
        SELECT id, provider_account_id
        FROM sharing_sessions
        WHERE status IN ('active', 'paused', 'exhausted') AND expires_at IS NOT NULL AND expires_at <= ?
      `).all(timestamp);
      for (const row of sessions) {
        this.sqlite.prepare(`
          UPDATE sharing_sessions
          SET status = 'expired', pending_key_cipher = NULL, updated_at = ?
          WHERE id = ?
        `).run(timestamp, row.id);
        this.sqlite.prepare(`
          UPDATE sharing_session_keys
          SET disabled_at = ?
          WHERE session_id = ? AND disabled_at IS NULL
        `).run(timestamp, row.id);
        this.sqlite.prepare(`
          UPDATE sharing_reservations
          SET status = 'released', settled_at = ?, error_code = 'session_expired'
          WHERE session_id = ? AND status = 'active'
        `).run(timestamp, row.id);
        this.event(row.provider_account_id, 'session', row.id, 'expired', {});
      }
      this.sqlite.prepare(`
        UPDATE sharing_reservations
        SET status = 'released', settled_at = ?, error_code = 'reservation_expired'
        WHERE status = 'active' AND expires_at <= ?
      `).run(timestamp, timestamp);
      this.sqlite.prepare(`
        UPDATE quota_requests
        SET status = 'expired', updated_at = ?
        WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
      `).run(timestamp, timestamp);
      return { offers, tickets, sessions };
    });
    const expired = expire();
    this.lastExpiryCheckAt = timestampMs;
    for (const row of expired.offers) {
      this.notifyOfferParticipants(row.id, 'Quota offer expired', 'A Codex Share offer expired without being approved.', `offer:${row.id}:expired`);
    }
    for (const row of expired.tickets) {
      this.notifyTicketParticipants(row.id, 'Quota request expired', 'A pending Codex Share request expired.', `ticket:${row.id}:expired`);
    }
    for (const row of expired.sessions) {
      this.notifySessionParticipants(row.id, 'Share session expired', 'A Codex Share session reached its expiration time.', `session:${row.id}:expired`);
    }
    return expired;
  }

  cleanup(now = new Date()) {
    this.expireDue(now, { force: true });
    const timestamp = new Date(now).getTime();
    const loginAttemptCutoff = new Date(timestamp - LOGIN_ATTEMPT_RETENTION_MS).toISOString();
    const routeCutoff = new Date(timestamp - ROUTE_RETENTION_MS).toISOString();
    const settlementCutoff = new Date(timestamp - SETTLEMENT_RETENTION_MS).toISOString();
    const emailCutoff = new Date(timestamp - EMAIL_RETENTION_MS).toISOString();
    const eventCutoff = new Date(timestamp - EVENT_RETENTION_MS).toISOString();
    const historyCutoff = new Date(timestamp - HISTORY_RETENTION_MS).toISOString();
    const remove = this.sqlite.transaction(() => ({
      loginAttempts: this.sqlite.prepare(`
        DELETE FROM codex_login_attempts
        WHERE expires_at <= ?
      `).run(loginAttemptCutoff).changes,
      routes: this.sqlite.prepare(`
        DELETE FROM personal_api_key_routes
        WHERE updated_at <= ?
      `).run(routeCutoff).changes,
      reservations: this.sqlite.prepare(`
        DELETE FROM sharing_reservations
        WHERE status <> 'active'
          AND COALESCE(settled_at, expires_at, created_at) <= ?
      `).run(settlementCutoff).changes,
      settlements: this.sqlite.prepare(`
        DELETE FROM sharing_session_settlements
        WHERE created_at <= ?
          AND session_id IN (
            SELECT id FROM sharing_sessions WHERE status NOT IN ('active', 'paused')
          )
      `).run(settlementCutoff).changes,
      emails: this.sqlite.prepare(`
        DELETE FROM email_outbox
        WHERE status IN ('sent', 'failed')
          AND COALESCE(sent_at, created_at) <= ?
      `).run(emailCutoff).changes,
      accountSessions: this.sqlite.prepare(`
        DELETE FROM account_sessions
        WHERE revoked_at IS NOT NULL AND revoked_at <= ?
      `).run(new Date(timestamp - ACCOUNT_SESSION_RETENTION_MS).toISOString()).changes,
      sessions: this.sqlite.prepare(`
        DELETE FROM sharing_sessions
        WHERE status NOT IN ('active', 'paused') AND updated_at <= ?
      `).run(historyCutoff).changes,
      tickets: this.sqlite.prepare(`
        DELETE FROM sharing_tickets
        WHERE status <> 'pending'
          AND COALESCE(resolved_at, created_at) <= ?
          AND NOT EXISTS (
            SELECT 1 FROM sharing_sessions
            WHERE sharing_sessions.ticket_id = sharing_tickets.id
              AND sharing_sessions.status IN ('active', 'paused')
          )
      `).run(historyCutoff).changes,
      offers: this.sqlite.prepare(`
        DELETE FROM sharing_offers
        WHERE status NOT IN ('active', 'paused') AND updated_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM sharing_sessions
            WHERE sharing_sessions.offer_id = sharing_offers.id
              AND sharing_sessions.status IN ('active', 'paused')
          )
      `).run(historyCutoff).changes,
      quotaRequests: this.sqlite.prepare(`
        DELETE FROM quota_requests
        WHERE status <> 'active' AND updated_at <= ?
      `).run(historyCutoff).changes,
      events: this.sqlite.prepare(`
        DELETE FROM sharing_events
        WHERE created_at <= ?
      `).run(eventCutoff).changes,
      activity: this.sqlite.prepare(`
        DELETE FROM sharing_activity
        WHERE (subject_type = 'session' AND NOT EXISTS (
          SELECT 1 FROM sharing_sessions WHERE id = subject_id
        ))
        OR (subject_type = 'personal_key' AND NOT EXISTS (
          SELECT 1 FROM personal_api_keys WHERE id = subject_id
        ))
      `).run().changes,
      providerObservations: this.sqlite.prepare(`
        DELETE FROM provider_observations
        WHERE NOT EXISTS (
          SELECT 1 FROM account_upstreams WHERE upstream_id = provider_observations.upstream_id
        )
      `).run().changes
    }));
    return remove();
  }

  createOffer(accountId, { upstreamId, quotaDollars, expiresAt }, upstreamStore) {
    this.expireDue(new Date(), { force: true });
    const upstream = upstreamStore.get(upstreamId);
    if (!upstream || !this.accountOwnsUpstream(accountId, upstreamId)) throw notFound();
    requireProviderQuota(upstream);
    requireProviderSharing(this.providerSharingState(upstreamId));
    const quotaMicros = dollarsToMicros(quotaDollars);
    const id = randomUUID();
    const now = new Date();
    const commitment = this.providerCommitment(upstreamId, upstreamStore);
    if (commitment.actualMicros !== null && quotaMicros > commitment.offerableMicros) {
      throw new Error('offer exceeds the provider’s truly offerable quota');
    }
    const expiry = sharingExpiry(expiresAt, upstream, now, OFFER_TTL_MS);
    this.sqlite.prepare(`
      INSERT INTO sharing_offers
        (id, provider_account_id, upstream_id, quota_micros, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(id, accountId, upstreamId, quotaMicros, expiry, now.toISOString(), now.toISOString());
    this.event(accountId, 'offer', id, 'created', { quotaMicros, expiresAt: expiry });
    this.notifyDemandForOffer(id, upstreamStore);
    return this.offer(id, accountId, upstreamStore);
  }

  updateOffer(accountId, id, input, upstreamStore) {
    this.expireDue(new Date(), { force: true });
    const row = this.requireOffer(id);
    if (row.provider_account_id !== accountId) throw forbidden();
    const status = input.status === undefined ? row.status : input.status;
    if (!['active', 'paused', 'closed'].includes(status)) throw new Error('status must be active, paused, or closed');
    const upstream = upstreamStore.get(row.upstream_id);
    if (!upstream) throw notFound();
    if (status === 'active') {
      requireProviderQuota(upstream);
      requireProviderSharing(this.providerSharingState(row.upstream_id));
    }
    const quotaMicros = input.quotaDollars === undefined ? row.quota_micros : dollarsToMicros(input.quotaDollars);
    const allocated = this.offerAllocatedMicros(id);
    if (quotaMicros < allocated) throw new Error('shareable quota cannot be below already allocated quota');
    const commitment = this.providerCommitment(row.upstream_id, upstreamStore);
    const currentCommitment = ['active', 'paused'].includes(row.status) ? row.quota_micros : 0;
    const nextCommitment = ['active', 'paused'].includes(status) ? quotaMicros : 0;
    if (commitment.actualMicros !== null && commitment.committedMicros - currentCommitment + nextCommitment > commitment.actualMicros) {
      throw new Error('offer exceeds the provider’s truly offerable quota');
    }
    const now = new Date();
    const expiry = input.expiresAt === undefined
      ? row.expires_at
      : sharingExpiry(input.expiresAt, upstream, now, OFFER_TTL_MS);
    this.sqlite.prepare(`
      UPDATE sharing_offers
      SET quota_micros = ?, status = ?, expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(quotaMicros, status, expiry, now.toISOString(), id);
    if (status === 'closed') {
      this.sqlite.prepare("UPDATE sharing_tickets SET status = 'rejected', resolved_at = ? WHERE offer_id = ? AND status = 'pending'")
        .run(now.toISOString(), id);
    }
    this.event(accountId, 'offer', id, 'updated', { quotaMicros, status, expiresAt: expiry });
    if (status === 'active') this.notifyDemandForOffer(id, upstreamStore);
    return this.offer(id, accountId, upstreamStore);
  }

  listOffers(viewerAccountId, upstreamStore) {
    this.expireDue();
    const commitmentCache = new Map();
    const rows = this.sqlite.prepare(`
      SELECT sharing_offers.*, accounts.display_name AS provider_name, accounts.email AS provider_email
      FROM sharing_offers JOIN accounts ON accounts.id = sharing_offers.provider_account_id
    `).all();
    const allocations = this.offerAllocations(rows.map(({ id }) => id));
    const offers = rows.flatMap((row) => {
      const upstream = upstreamStore.getPublic(row.upstream_id);
      if (!upstream) return [];
      const commitment = this.providerCommitment(row.upstream_id, upstreamStore, commitmentCache);
      return [publicOffer(row, upstream, allocations.get(row.id) || 0, viewerAccountId, {
        sharing: this.providerSharingState(row.upstream_id),
        backedMicros: commitment.offerBacking.get(row.id) ?? row.quota_micros,
        underfundedMicros: commitment.underfundedMicros
      })];
    });
    return offers.sort(compareOffers);
  }

  sharingCounts(accountId) {
    this.expireDue();
    const count = (sql, ...args) => this.sqlite.prepare(sql).get(...args).count;
    return {
      'community-offers': count("SELECT COUNT(*) AS count FROM sharing_offers WHERE provider_account_id != ? AND status = 'active'", accountId),
      'my-offers': count("SELECT COUNT(*) AS count FROM sharing_offers WHERE provider_account_id = ? AND status = 'active'", accountId),
      'quota-requests': count("SELECT COUNT(*) AS count FROM quota_requests WHERE status = 'active'"),
      'sent-requests': count("SELECT COUNT(*) AS count FROM sharing_tickets WHERE consumer_account_id = ? AND status = 'pending'", accountId),
      approvals: count("SELECT COUNT(*) AS count FROM sharing_tickets WHERE provider_account_id = ? AND status = 'pending'", accountId),
      'my-access': count("SELECT COUNT(*) AS count FROM sharing_sessions WHERE consumer_account_id = ? AND status NOT IN ('revoked', 'expired')", accountId),
      'shared-by-me': count("SELECT COUNT(*) AS count FROM sharing_sessions WHERE provider_account_id = ? AND status NOT IN ('revoked', 'expired')", accountId)
    };
  }

  adminAnalytics({ eventCursor = null } = {}) {
    this.expireDue();
    if (eventCursor) return this.adminEventPage(eventCursor);
    const row = (sql, ...args) => this.sqlite.prepare(sql).get(...args);
    const count = (sql, ...args) => row(sql, ...args).count;
    const usage = row(`
      SELECT COALESCE(SUM(request_count), 0) AS requests,
        COALESCE(SUM(success_count), 0) AS successes,
        COALESCE(SUM(total_micros), 0) AS settled_micros,
        COALESCE(SUM(CASE WHEN today_date = ? THEN today_micros ELSE 0 END), 0) AS today_micros
      FROM sharing_activity WHERE subject_type = 'session'
    `, utcDate());
    const tickets = row(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status = 'approved'), 0) AS approved,
        COALESCE(SUM(status = 'rejected'), 0) AS rejected,
        COALESCE(SUM(status = 'pending'), 0) AS pending
      FROM sharing_tickets
    `);
    return {
      overview: {
        accounts: count('SELECT COUNT(*) AS count FROM accounts'),
        linkedProviders: count('SELECT COUNT(*) AS count FROM account_upstreams'),
        activeOffers: count("SELECT COUNT(*) AS count FROM sharing_offers WHERE status = 'active'"),
        activeSessions: count("SELECT COUNT(*) AS count FROM sharing_sessions WHERE status IN ('active', 'paused')"),
        pendingTickets: tickets.pending,
        activeQuotaRequests: count("SELECT COUNT(*) AS count FROM quota_requests WHERE status = 'active'")
      },
      usage: {
        requests: usage.requests,
        successes: usage.successes,
        settledMicros: usage.settled_micros,
        todayMicros: usage.today_micros
      },
      tickets: {
        total: tickets.total,
        approved: tickets.approved,
        rejected: tickets.rejected,
        pending: tickets.pending
      },
      providers: {
        sharingActive: count("SELECT COUNT(*) AS count FROM account_upstreams WHERE sharing_status = 'active'"),
        sharingPaused: count("SELECT COUNT(*) AS count FROM account_upstreams WHERE sharing_status = 'paused'"),
        unavailable: count('SELECT COUNT(*) AS count FROM provider_observations WHERE issue_code IS NOT NULL')
      },
      topProviders: this.adminUsageLeaders('provider'),
      topConsumers: this.adminUsageLeaders('consumer'),
      ...this.adminEventPage(eventCursor)
    };
  }

  adminEventPage(cursor) {
    const events = cursor
      ? this.sqlite.prepare(`
          SELECT sharing_events.id, sharing_events.entity_type, sharing_events.action, sharing_events.created_at,
            accounts.email AS actor_email
          FROM sharing_events
          LEFT JOIN accounts ON accounts.id = sharing_events.actor_account_id
          WHERE (sharing_events.created_at, sharing_events.id) < (?, ?)
          ORDER BY sharing_events.created_at DESC, sharing_events.id DESC
          LIMIT 13
        `).all(cursor.createdAt, cursor.id)
      : this.sqlite.prepare(`
          SELECT sharing_events.id, sharing_events.entity_type, sharing_events.action, sharing_events.created_at,
            accounts.email AS actor_email
          FROM sharing_events
          LEFT JOIN accounts ON accounts.id = sharing_events.actor_account_id
          ORDER BY sharing_events.created_at DESC, sharing_events.id DESC
          LIMIT 13
        `).all();
    const page = events.slice(0, 12).map((event) => ({
      id: event.id,
      entityType: event.entity_type,
      action: event.action,
      createdAt: event.created_at,
      actorEmail: event.actor_email || 'System'
    }));
    const last = page.at(-1);
    return {
      recentEvents: page,
      nextEventCursor: events.length > page.length && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url')
        : null
    };
  }

  adminUsageLeaders(role) {
    const accountColumn = role === 'provider' ? 'provider_account_id' : 'consumer_account_id';
    return this.sqlite.prepare(`
      SELECT accounts.email, COUNT(sharing_sessions.id) AS session_count,
        COALESCE(SUM(sharing_sessions.consumed_micros), 0) AS consumed_micros
      FROM sharing_sessions
      JOIN accounts ON accounts.id = sharing_sessions.${accountColumn}
      GROUP BY accounts.id
      ORDER BY consumed_micros DESC, session_count DESC, accounts.email ASC
      LIMIT 5
    `).all().map((leader) => ({
      id: leader.email,
      email: leader.email,
      sessionCount: leader.session_count,
      consumedMicros: leader.consumed_micros
    }));
  }

  listOffersPage(viewerAccountId, upstreamStore, options) {
    this.expireDue();
    const conditions = [];
    const args = [];
    if (!options.includePast) conditions.push("sharing_offers.status = 'active'");
    if (options.role === 'mine') {
      conditions.push('sharing_offers.provider_account_id = ?');
      args.push(viewerAccountId);
    } else if (options.role === 'community') {
      conditions.push('sharing_offers.provider_account_id != ?');
      args.push(viewerAccountId);
    }
    if (options.query) {
      conditions.push('instr(lower(accounts.email), ?) > 0');
      args.push(options.query);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalItems = this.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM sharing_offers JOIN accounts ON accounts.id = sharing_offers.provider_account_id
      ${where}
    `).get(...args).count;
    const rows = this.sqlite.prepare(`
      SELECT sharing_offers.*, accounts.display_name AS provider_name, accounts.email AS provider_email,
        EXISTS(
          SELECT 1 FROM sharing_tickets
          WHERE sharing_tickets.offer_id = sharing_offers.id
            AND sharing_tickets.consumer_account_id = ?
            AND sharing_tickets.status = 'pending'
        ) AS has_pending_request
      FROM sharing_offers JOIN accounts ON accounts.id = sharing_offers.provider_account_id
      ${where}
      ORDER BY sharing_offers.created_at DESC, sharing_offers.id DESC
      LIMIT ? OFFSET ?
    `).all(viewerAccountId, ...args, options.limit, options.offset);
    const commitmentCache = new Map();
    const allocations = this.offerAllocations(rows.map(({ id }) => id));
    const offers = rows.flatMap((row) => {
      const upstream = upstreamStore.getPublic(row.upstream_id);
      if (!upstream) return [];
      const commitment = this.providerCommitment(row.upstream_id, upstreamStore, commitmentCache);
      return [publicOffer(row, upstream, allocations.get(row.id) || 0, viewerAccountId, {
        sharing: this.providerSharingState(row.upstream_id),
        backedMicros: commitment.offerBacking.get(row.id) ?? row.quota_micros,
        underfundedMicros: commitment.underfundedMicros
      })];
    });
    return sharingListPage('offers', offers, totalItems, options);
  }

  offer(id, viewerAccountId, upstreamStore) {
    this.expireDue();
    const row = this.sqlite.prepare(`
      SELECT sharing_offers.*, accounts.display_name AS provider_name, accounts.email AS provider_email
      FROM sharing_offers JOIN accounts ON accounts.id = sharing_offers.provider_account_id
      WHERE sharing_offers.id = ?
    `).get(id);
    if (!row) throw notFound();
    const upstream = upstreamStore.getPublic(row.upstream_id);
    if (!upstream) throw notFound();
    const commitment = this.providerCommitment(row.upstream_id, upstreamStore);
    return publicOffer(row, upstream, this.offerAllocatedMicros(id), viewerAccountId, {
      sharing: this.providerSharingState(row.upstream_id),
      backedMicros: commitment.offerBacking.get(row.id) ?? row.quota_micros,
      underfundedMicros: commitment.underfundedMicros
    });
  }

  createTicket(accountId, { offerId }, upstreamStore) {
    this.expireDue(new Date(), { force: true });
    const offer = this.requireOffer(offerId);
    if (offer.status !== 'active') throw new Error('offer is not accepting tickets');
    const upstream = upstreamStore.get(offer.upstream_id);
    if (!upstream) throw notFound();
    requireProviderQuota(upstream);
    requireProviderSharing(this.providerSharingState(offer.upstream_id));
    requireOfferUsable(offer, upstream);
    const commitment = this.providerCommitment(offer.upstream_id, upstreamStore);
    if (commitment.underfundedMicros > 0 || (commitment.offerBacking.get(offer.id) ?? offer.quota_micros) < offer.quota_micros) {
      throw new Error('offer is underfunded by the provider’s current quota');
    }
    if (offer.provider_account_id === accountId) throw new Error('providers cannot request their own offer');
    this.requireAccount(accountId);
    const requestedMicros = Math.max(0, offer.quota_micros - this.offerAllocatedMicros(offer.id));
    if (!requestedMicros) throw new Error('offer has no shareable quota remaining');
    if (this.sqlite.prepare("SELECT 1 FROM sharing_tickets WHERE offer_id = ? AND consumer_account_id = ? AND status = 'pending'").get(offerId, accountId)) {
      throw new Error('a pending ticket already exists for this offer');
    }
    const id = randomUUID();
    const now = new Date();
    const demand = this.sqlite.prepare(`
      SELECT id
      FROM quota_requests
      WHERE account_id = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(accountId);
    const expiry = offer.expires_at;
    this.sqlite.prepare(`
      INSERT INTO sharing_tickets
      (id, offer_id, provider_account_id, consumer_account_id, demand_request_id,
       requested_micros, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, offerId, offer.provider_account_id, accountId, demand?.id || null, requestedMicros, expiry, now.toISOString());
    this.event(accountId, 'ticket', id, 'created', { requestedMicros, expiresAt: expiry });
    this.notifyAccount(
      offer.provider_account_id,
      'New Codex Share request',
      'A friend requested your offered Codex quota. Open Codex Share to approve or reject it.',
      `ticket:${id}:created`
    );
    return this.ticket(id, accountId, upstreamStore);
  }

  listTickets(accountId, upstreamStore) {
    this.expireDue();
    return this.sqlite.prepare(`
      SELECT sharing_tickets.*,
        provider.display_name AS provider_name,
        provider.email AS provider_email,
        consumer.display_name AS consumer_name,
        consumer.email AS consumer_email,
        sharing_offers.upstream_id
      FROM sharing_tickets
      JOIN accounts provider ON provider.id = sharing_tickets.provider_account_id
      JOIN accounts consumer ON consumer.id = sharing_tickets.consumer_account_id
      JOIN sharing_offers ON sharing_offers.id = sharing_tickets.offer_id
      WHERE sharing_tickets.provider_account_id = ? OR sharing_tickets.consumer_account_id = ?
      ORDER BY sharing_tickets.created_at DESC
    `).all(accountId, accountId).map((row) => publicTicket(row, accountId, upstreamStore.getPublic(row.upstream_id)));
  }

  listTicketsPage(accountId, upstreamStore, options) {
    this.expireDue();
    const conditions = [];
    const args = [];
    if (options.role === 'sent') {
      conditions.push('sharing_tickets.consumer_account_id = ?');
      args.push(accountId);
    } else if (options.role === 'received') {
      conditions.push('sharing_tickets.provider_account_id = ?');
      args.push(accountId);
    } else {
      conditions.push('(sharing_tickets.provider_account_id = ? OR sharing_tickets.consumer_account_id = ?)');
      args.push(accountId, accountId);
    }
    if (!options.includePast) conditions.push("sharing_tickets.status = 'pending'");
    if (options.query) {
      conditions.push('(instr(lower(provider.email), ?) > 0 OR instr(lower(consumer.email), ?) > 0)');
      args.push(options.query, options.query);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const select = `
      FROM sharing_tickets
      JOIN accounts provider ON provider.id = sharing_tickets.provider_account_id
      JOIN accounts consumer ON consumer.id = sharing_tickets.consumer_account_id
      JOIN sharing_offers ON sharing_offers.id = sharing_tickets.offer_id
      ${where}`;
    const totalItems = this.sqlite.prepare(`SELECT COUNT(*) AS count ${select}`).get(...args).count;
    const rows = this.sqlite.prepare(`
      SELECT sharing_tickets.*, provider.display_name AS provider_name, provider.email AS provider_email,
        consumer.display_name AS consumer_name, consumer.email AS consumer_email, sharing_offers.upstream_id
      ${select}
      ORDER BY sharing_tickets.created_at DESC, sharing_tickets.id DESC
      LIMIT ? OFFSET ?
    `).all(...args, options.limit, options.offset);
    return sharingListPage('tickets', rows.map((row) => publicTicket(row, accountId, upstreamStore.getPublic(row.upstream_id))), totalItems, options);
  }

  ticket(id, accountId, upstreamStore) {
    this.expireDue();
    const row = this.sqlite.prepare(`
      SELECT sharing_tickets.*,
        provider.display_name AS provider_name,
        provider.email AS provider_email,
        consumer.display_name AS consumer_name,
        consumer.email AS consumer_email,
        sharing_offers.upstream_id
      FROM sharing_tickets
      JOIN accounts provider ON provider.id = sharing_tickets.provider_account_id
      JOIN accounts consumer ON consumer.id = sharing_tickets.consumer_account_id
      JOIN sharing_offers ON sharing_offers.id = sharing_tickets.offer_id
      WHERE sharing_tickets.id = ?
    `).get(id);
    if (!row || ![row.provider_account_id, row.consumer_account_id].includes(accountId)) throw notFound();
    return publicTicket(row, accountId, upstreamStore.getPublic(row.upstream_id));
  }

  cancelTicket(accountId, id, upstreamStore) {
    this.expireDue(new Date(), { force: true });
    const row = this.requireTicket(id);
    if (row.consumer_account_id !== accountId) throw forbidden();
    if (row.status !== 'pending') throw new Error('only pending tickets can be cancelled');
    this.resolveTicket(row, 'cancelled');
    this.event(accountId, 'ticket', id, 'cancelled', {});
    this.notifyTicketParticipants(id, 'Codex Share request cancelled', 'A pending Codex Share request was cancelled.', `ticket:${id}:cancelled`);
    return this.ticket(id, accountId, upstreamStore);
  }

  rejectTicket(accountId, id, upstreamStore) {
    this.expireDue(new Date(), { force: true });
    const row = this.requireTicket(id);
    if (row.provider_account_id !== accountId) throw forbidden();
    if (row.status !== 'pending') throw new Error('only pending tickets can be rejected');
    this.resolveTicket(row, 'rejected');
    this.event(accountId, 'ticket', id, 'rejected', {});
    this.notifyTicketParticipants(id, 'Codex Share request rejected', 'A Codex Share request was rejected. The offer is available to request again if it remains active.', `ticket:${id}:rejected`);
    return this.ticket(id, accountId, upstreamStore);
  }

  approveTicket(accountId, id, { quotaDollars } = {}, upstreamStore) {
    this.expireDue(new Date(), { force: true });
    const approve = this.sqlite.transaction(() => {
      const ticket = this.requireTicket(id);
      if (ticket.provider_account_id !== accountId) throw forbidden();
      if (ticket.status !== 'pending') throw new Error('only pending tickets can be approved');
      const offer = this.requireOffer(ticket.offer_id);
      if (offer.status !== 'active') throw new Error('offer is not active');
      const upstream = upstreamStore.get(offer.upstream_id);
      if (!upstream || !this.accountOwnsUpstream(accountId, offer.upstream_id)) throw notFound();
      requireProviderQuota(upstream);
      requireProviderSharing(this.providerSharingState(offer.upstream_id));
      requireOfferUsable(offer, upstream);
      const approvedMicros = quotaDollars === undefined ? ticket.requested_micros : dollarsToMicros(quotaDollars);
      const available = Math.max(0, offer.quota_micros - this.offerAllocatedMicros(offer.id));
      if (approvedMicros > available) throw new Error('approved quota exceeds available shareable quota');
      const commitment = this.providerCommitment(offer.upstream_id, upstreamStore);
      const prospectiveCommitment = commitment.committedMicros - offer.quota_micros + approvedMicros;
      if (commitment.actualMicros !== null && prospectiveCommitment > commitment.actualMicros) {
        throw new Error('approved quota exceeds the provider’s truly offerable quota');
      }
      const sessionId = randomUUID();
      const keyId = randomUUID();
      const apiKey = `cp_share_${randomToken(32)}`;
      const now = new Date();
      const expiresAt = earliestExpiry(
        offer.expires_at,
        sharingExpiry(null, upstream, now, SHARE_SESSION_TTL_MS)
      );
      this.sqlite.prepare("UPDATE sharing_tickets SET approved_micros = ?, status = 'approved', resolved_at = ? WHERE id = ?")
        .run(approvedMicros, now.toISOString(), id);
      this.sqlite.prepare("UPDATE sharing_offers SET status = 'closed', updated_at = ? WHERE id = ?")
        .run(now.toISOString(), offer.id);
      this.sqlite.prepare("UPDATE sharing_tickets SET status = 'rejected', resolved_at = ? WHERE offer_id = ? AND id != ? AND status = 'pending'")
        .run(now.toISOString(), offer.id, id);
      if (ticket.demand_request_id) {
        this.sqlite.prepare(`
          UPDATE sharing_tickets
          SET status = 'cancelled', resolved_at = ?
          WHERE demand_request_id = ? AND id != ? AND status = 'pending'
        `).run(now.toISOString(), ticket.demand_request_id, id);
      }
      this.sqlite.prepare(`
        INSERT INTO sharing_sessions
        (id, offer_id, ticket_id, provider_account_id, consumer_account_id, upstream_id, scope_id,
         granted_micros, consumed_micros, status, pending_key_cipher, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?)
      `).run(
        sessionId, offer.id, ticket.id, ticket.provider_account_id, ticket.consumer_account_id,
        offer.upstream_id, upstream.scopeId || 'default', approvedMicros, encrypt(apiKey, this.key),
        expiresAt, now.toISOString(), now.toISOString()
      );
      this.sqlite.prepare(`
        INSERT INTO sharing_session_keys (id, session_id, key_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(keyId, sessionId, hash(apiKey), now.toISOString());
      if (ticket.demand_request_id) {
        this.sqlite.prepare(`
          UPDATE quota_requests
          SET status = 'fulfilled', updated_at = ?
          WHERE id = ? AND status = 'active'
        `).run(now.toISOString(), ticket.demand_request_id);
      }
      this.event(accountId, 'ticket', id, 'approved', { approvedMicros, sessionId, expiresAt });
      return sessionId;
    });
    const sessionId = approve();
    this.notifyTicketParticipants(id, 'Codex Share request approved', 'Your Codex Share request was approved. A share session is ready to use.', `ticket:${id}:approved`);
    return this.session(sessionId, accountId, upstreamStore);
  }

  listSessions(accountId, upstreamStore) {
    this.expireDue();
    const commitmentCache = new Map();
    return this.sqlite.prepare(`
      SELECT sharing_sessions.*,
        provider.display_name AS provider_name,
        provider.email AS provider_email,
        consumer.display_name AS consumer_name
        , consumer.email AS consumer_email
      FROM sharing_sessions
      JOIN accounts provider ON provider.id = sharing_sessions.provider_account_id
      JOIN accounts consumer ON consumer.id = sharing_sessions.consumer_account_id
      WHERE sharing_sessions.provider_account_id = ? OR sharing_sessions.consumer_account_id = ?
      ORDER BY sharing_sessions.created_at DESC
    `).all(accountId, accountId).map((row) => {
      const commitment = this.providerCommitment(row.upstream_id, upstreamStore, commitmentCache);
      return publicShareSession(row, accountId, upstreamStore.getPublic(row.upstream_id), {
        sharing: this.providerSharingState(row.upstream_id),
        backedMicros: commitment.sessionBacking.get(row.id) ?? Math.max(0, row.granted_micros - row.consumed_micros),
        activity: this.activity('session', row.id)
      });
    });
  }

  listSessionsPage(accountId, upstreamStore, options) {
    this.expireDue();
    const conditions = [];
    const args = [];
    if (options.role === 'consumer') {
      conditions.push('sharing_sessions.consumer_account_id = ?');
      args.push(accountId);
    } else if (options.role === 'provider') {
      conditions.push('sharing_sessions.provider_account_id = ?');
      args.push(accountId);
    } else {
      conditions.push('(sharing_sessions.provider_account_id = ? OR sharing_sessions.consumer_account_id = ?)');
      args.push(accountId, accountId);
    }
    if (!options.includePast) conditions.push("sharing_sessions.status NOT IN ('revoked', 'expired')");
    if (options.query) {
      conditions.push('(instr(lower(provider.email), ?) > 0 OR instr(lower(consumer.email), ?) > 0)');
      args.push(options.query, options.query);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const select = `
      FROM sharing_sessions
      JOIN accounts provider ON provider.id = sharing_sessions.provider_account_id
      JOIN accounts consumer ON consumer.id = sharing_sessions.consumer_account_id
      ${where}`;
    const totalItems = this.sqlite.prepare(`SELECT COUNT(*) AS count ${select}`).get(...args).count;
    const rows = this.sqlite.prepare(`
      SELECT sharing_sessions.*, provider.display_name AS provider_name, provider.email AS provider_email,
        consumer.display_name AS consumer_name, consumer.email AS consumer_email
      ${select}
      ORDER BY sharing_sessions.created_at DESC, sharing_sessions.id DESC
      LIMIT ? OFFSET ?
    `).all(...args, options.limit, options.offset);
    const activities = this.activities('session', rows.map(({ id }) => id));
    const commitmentCache = new Map();
    const sessions = rows.map((row) => {
      const commitment = this.providerCommitment(row.upstream_id, upstreamStore, commitmentCache);
      return publicShareSession(row, accountId, upstreamStore.getPublic(row.upstream_id), {
        sharing: this.providerSharingState(row.upstream_id),
        backedMicros: commitment.sessionBacking.get(row.id) ?? Math.max(0, row.granted_micros - row.consumed_micros),
        activity: activities.get(row.id) || emptyActivity()
      });
    });
    return sharingListPage('sessions', sessions, totalItems, options);
  }

  session(id, accountId, upstreamStore) {
    this.expireDue();
    const row = this.sessionRow(id);
    if (![row.provider_account_id, row.consumer_account_id].includes(accountId)) throw notFound();
    const commitment = this.providerCommitment(row.upstream_id, upstreamStore);
    return publicShareSession(row, accountId, upstreamStore.getPublic(row.upstream_id), {
      sharing: this.providerSharingState(row.upstream_id),
      backedMicros: commitment.sessionBacking.get(row.id) ?? Math.max(0, row.granted_micros - row.consumed_micros),
      activity: this.activity('session', row.id)
    });
  }

  updateSession(accountId, id, input, upstreamStore) {
    this.expireDue(new Date(), { force: true });
    const update = this.sqlite.transaction(() => {
      const row = this.sessionRow(id);
      if (row.provider_account_id !== accountId) throw forbidden();
      if (row.status === 'revoked') throw new Error('revoked sessions cannot be changed');
      let grantedMicros = row.granted_micros;
      if (input.quotaDollars !== undefined && input.additionalQuotaDollars !== undefined) {
        throw new Error('set either quotaDollars or additionalQuotaDollars');
      }
      if (input.quotaDollars !== undefined) {
        grantedMicros = dollarsToMicros(input.quotaDollars);
        if (grantedMicros < row.consumed_micros) throw new Error('quota cannot be below already consumed usage');
      } else if (input.additionalQuotaDollars !== undefined) {
        grantedMicros += dollarsToMicros(input.additionalQuotaDollars);
      }
      if (input.quotaDollars !== undefined || input.additionalQuotaDollars !== undefined) {
        const upstream = upstreamStore.get(row.upstream_id);
        if (!upstream || !this.accountOwnsUpstream(accountId, row.upstream_id)) throw notFound();
        requireProviderQuota(upstream);
        const commitment = this.providerCommitment(row.upstream_id, upstreamStore);
        const currentRemaining = ['active', 'paused'].includes(row.status)
          ? Math.max(0, row.granted_micros - row.consumed_micros)
          : 0;
        const nextRemaining = Math.max(0, grantedMicros - row.consumed_micros);
        if (commitment.actualMicros !== null
          && commitment.committedMicros - currentRemaining + nextRemaining > commitment.actualMicros) {
          throw new Error('session quota exceeds the provider’s actual remaining quota');
        }
      }
      const now = new Date();
      let expiresAt = row.expires_at;
      if (input.expiresAt !== undefined) {
        const upstream = upstreamStore.get(row.upstream_id);
        if (!upstream || !this.accountOwnsUpstream(accountId, row.upstream_id)) throw notFound();
        const nextExpiry = sharingExpiry(input.expiresAt, upstream, now, SHARE_SESSION_TTL_MS);
        if (expiresAt && Date.parse(nextExpiry) < Date.parse(expiresAt)) {
          throw new Error('session expiration can only be extended');
        }
        expiresAt = nextExpiry;
      }
      let status = input.status === undefined ? row.status : input.status;
      if (status === 'exhausted' && input.status === undefined && grantedMicros > row.consumed_micros) status = 'active';
      if (!['active', 'paused', 'exhausted'].includes(status) || input.status === 'exhausted') throw new Error('status must be active or paused');
      if (status === 'active') requireProviderSharing(this.providerSharingState(row.upstream_id));
      if (grantedMicros <= row.consumed_micros) status = 'exhausted';
      const updatedAt = now.toISOString();
      this.sqlite.prepare('UPDATE sharing_sessions SET granted_micros = ?, status = ?, expires_at = ?, updated_at = ? WHERE id = ?')
        .run(grantedMicros, status, expiresAt, updatedAt, id);
      this.event(accountId, 'session', id, 'updated', { grantedMicros, status, expiresAt });
    });
    update();
    this.notifySessionParticipants(
      id,
      'Codex Share session updated',
      'A share session was paused, resumed, resized, or had its expiry extended. Open Codex Share for the current state.',
      `session:${id}:updated:${this.sessionRow(id).updated_at}`
    );
    return this.session(id, accountId, upstreamStore);
  }

  revokeSession(accountId, id, upstreamStore) {
    this.expireDue(new Date(), { force: true });
    const row = this.sessionRow(id);
    if (![row.provider_account_id, row.consumer_account_id].includes(accountId)) throw forbidden();
    if (row.status !== 'revoked') {
      const now = new Date().toISOString();
      this.sqlite.transaction(() => {
        this.sqlite.prepare("UPDATE sharing_sessions SET status = 'revoked', pending_key_cipher = NULL, updated_at = ? WHERE id = ?").run(now, id);
        this.sqlite.prepare('UPDATE sharing_session_keys SET disabled_at = ? WHERE session_id = ? AND disabled_at IS NULL').run(now, id);
        this.sqlite.prepare(`
          UPDATE sharing_reservations
          SET status = 'released', settled_at = ?, error_code = 'session_revoked'
          WHERE session_id = ? AND status = 'active'
        `).run(now, id);
        this.event(accountId, 'session', id, 'revoked', {});
      })();
      this.notifySessionParticipants(id, 'Codex Share session revoked', 'A Codex Share session was revoked and its API key is no longer usable.', `session:${id}:revoked`);
    }
    return this.session(id, accountId, upstreamStore);
  }

  revealSessionKey(accountId, id) {
    const reveal = this.sqlite.transaction(() => {
      const row = this.sessionRow(id);
      if (![row.provider_account_id, row.consumer_account_id].includes(accountId)) throw forbidden();
      if (row.status === 'revoked') throw new Error('session is revoked');
      if (!row.pending_key_cipher) throw new Error('session key is unavailable; ask the provider to generate a new key');
      const apiKey = decrypt(row.pending_key_cipher, this.key);
      this.event(accountId, 'session', id, 'key_revealed', {});
      return apiKey;
    });
    return { apiKey: reveal() };
  }

  rotateSessionKey(accountId, id) {
    const rotate = this.sqlite.transaction(() => {
      const row = this.sessionRow(id);
      if (row.provider_account_id !== accountId) throw forbidden();
      if (row.status === 'revoked') throw new Error('session is revoked');
      const apiKey = `cp_share_${randomToken(32)}`;
      const now = new Date().toISOString();
      this.sqlite.prepare('UPDATE sharing_session_keys SET key_hash = ?, created_at = ?, disabled_at = NULL WHERE session_id = ?')
        .run(hash(apiKey), now, id);
      this.sqlite.prepare('UPDATE sharing_sessions SET pending_key_cipher = ?, updated_at = ? WHERE id = ?')
        .run(encrypt(apiKey, this.key), now, id);
      this.event(accountId, 'session', id, 'key_rotated', {});
      return apiKey;
    });
    const apiKey = rotate();
    this.notifySessionParticipants(id, 'Share session key replaced', 'A new API key was generated for a Codex Share session. The previous key no longer works.', `session:${id}:key-rotated:${this.sessionRow(id).updated_at}`);
    return { apiKey };
  }

  personalKey(accountId, upstreamStore) {
    this.requireAccount(accountId);
    const row = this.personalKeyRowForAccount(accountId);
    const access = this.personalKeyAccess(row?.id || null, accountId, upstreamStore);
    return {
      hasKey: Boolean(row && !row.disabled_at),
      id: row?.id || null,
      name: row?.name || 'Default',
      activeSessionCount: access.activeSessionCount,
      remainingQuotaDollars: microsToDollars(access.remainingMicros),
      canUse: access.activeSessionCount > 0,
      activity: row ? this.activity('personal_key', row.id) : emptyActivity()
    };
  }

  revealPersonalKey(accountId) {
    const reveal = this.sqlite.transaction(() => {
      let row = this.personalKeyRowForAccount(accountId);
      if (!row || row.disabled_at) row = this.createPersonalKey(accountId);
      this.event(accountId, 'personal_key', row.id, 'revealed', {});
      return decrypt(row.key_cipher, this.key);
    });
    return { apiKey: reveal() };
  }

  rotatePersonalKey(accountId) {
    const rotate = this.sqlite.transaction(() => {
      let row = this.personalKeyRowForAccount(accountId);
      const now = new Date().toISOString();
      const apiKey = `cp_personal_${randomToken(32)}`;
      if (!row || row.disabled_at) {
        row = this.createPersonalKey(accountId, apiKey, now);
      } else {
        this.sqlite.prepare(`
          UPDATE personal_api_keys
          SET key_hash = ?, key_cipher = ?, updated_at = ?
          WHERE id = ?
        `).run(hash(apiKey), encrypt(apiKey, this.key), now, row.id);
        row = this.personalKeyRow(row.id);
      }
      this.event(accountId, 'personal_key', row.id, 'rotated', {});
      return apiKey;
    });
    return { apiKey: rotate() };
  }

  listPersonalKeys(accountId, upstreamStore) {
    this.requireAccount(accountId);
    const access = this.personalKeyAccess(null, accountId, upstreamStore);
    return this.sqlite.prepare(`
      SELECT * FROM personal_api_keys
      WHERE account_id = ?
      ORDER BY disabled_at IS NOT NULL, created_at, id
    `).all(accountId).map((row) => publicPersonalKey(row, access, this.activity('personal_key', row.id)));
  }

  createNamedPersonalKey(accountId, { name, expiresAt } = {}, upstreamStore) {
    this.requireAccount(accountId);
    const apiKey = `cp_personal_${randomToken(32)}`;
    const now = new Date();
    const row = this.createPersonalKey(accountId, apiKey, now.toISOString(), {
      name: cleanKeyName(name),
      expiresAt: optionalFutureTime(expiresAt, now)
    });
    this.event(accountId, 'personal_key', row.id, 'created', { name: row.name, expiresAt: row.expires_at });
    return {
      personalKey: publicPersonalKey(row, this.personalKeyAccess(row.id, accountId, upstreamStore), this.activity('personal_key', row.id)),
      apiKey
    };
  }

  revealNamedPersonalKey(accountId, id) {
    const row = this.requirePersonalKey(accountId, id);
    if (row.disabled_at) throw new Error('personal key is revoked');
    if (isExpired(row.expires_at)) throw new Error('personal key is expired');
    this.event(accountId, 'personal_key', row.id, 'revealed', {});
    return { apiKey: decrypt(row.key_cipher, this.key) };
  }

  rotateNamedPersonalKey(accountId, id) {
    const row = this.requirePersonalKey(accountId, id);
    if (row.disabled_at) throw new Error('personal key is revoked');
    const apiKey = `cp_personal_${randomToken(32)}`;
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE personal_api_keys
      SET key_hash = ?, key_cipher = ?, updated_at = ?
      WHERE id = ?
    `).run(hash(apiKey), encrypt(apiKey, this.key), now, row.id);
    this.event(accountId, 'personal_key', row.id, 'rotated', {});
    this.notifyAccount(
      accountId,
      'Personal Codex Share key rotated',
      `The personal key "${row.name}" was rotated. Its previous value no longer works.`,
      `personal-key:${row.id}:rotated:${now}`
    );
    return { apiKey };
  }

  revokeNamedPersonalKey(accountId, id, upstreamStore) {
    const row = this.requirePersonalKey(accountId, id);
    if (!row.disabled_at) {
      const now = new Date().toISOString();
      this.sqlite.prepare('UPDATE personal_api_keys SET disabled_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, row.id);
      this.sqlite.prepare('DELETE FROM personal_api_key_routes WHERE key_id = ?').run(row.id);
      this.event(accountId, 'personal_key', row.id, 'revoked', {});
      this.notifyAccount(
        accountId,
        'Personal Codex Share key revoked',
        `The personal key "${row.name}" was revoked.`,
        `personal-key:${row.id}:revoked`
      );
    }
    return publicPersonalKey(
      this.personalKeyRow(id),
      this.personalKeyAccess(id, accountId, upstreamStore),
      this.activity('personal_key', id)
    );
  }

  authenticateShareKey(key, upstreamStore) {
    if (typeof key !== 'string') return null;
    if (key.startsWith('cp_personal_')) {
      const row = this.sqlite.prepare(`
        SELECT id, account_id
        FROM personal_api_keys
        WHERE key_hash = ? AND disabled_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `).get(hash(key), new Date().toISOString());
      return row ? this.personalShareAccess(row.id, upstreamStore) : null;
    }
    if (!key.startsWith('cp_share_')) return null;
    const row = this.sqlite.prepare(`
      SELECT sharing_session_keys.id AS key_id, sharing_sessions.*
      FROM sharing_session_keys
      JOIN sharing_sessions ON sharing_sessions.id = sharing_session_keys.session_id
      WHERE sharing_session_keys.key_hash = ? AND sharing_session_keys.disabled_at IS NULL
    `).get(hash(key));
    return row && row.status !== 'revoked'
      ? shareSessionAccess(row, row.key_id, this.providerSharingState(row.upstream_id)?.status)
      : null;
  }

  shareSessionUsage(sessionId) {
    const row = this.sessionRow(sessionId);
    return {
      session_id: row.id,
      status: row.status,
      granted_cost_usd: microsToDollars(row.granted_micros),
      consumed_cost_usd: microsToDollars(row.consumed_micros),
      remaining_cost_usd: microsToDollars(Math.max(0, row.granted_micros - row.consumed_micros)),
      upstream_id: row.upstream_id
    };
  }

  personalKeyUsage(accountId, upstreamStore) {
    const access = this.personalKeyAccess(null, accountId, upstreamStore);
    return {
      active_session_count: access.activeSessionCount,
      granted_cost_usd: microsToDollars(access.grantedMicros),
      consumed_cost_usd: microsToDollars(access.consumedMicros),
      remaining_cost_usd: microsToDollars(access.remainingMicros)
    };
  }

  personalShareAccess(personalKeyId, upstreamStore) {
    const key = this.personalKeyRow(personalKeyId);
    if (!key || key.disabled_at) return null;
    const access = this.personalKeyAccess(key.id, key.account_id, upstreamStore);
    const providerReauthUpstreamIds = this.activeConsumerSessions(key.account_id)
      .filter((session) => providerIssue(upstreamStore?.getPublic(session.upstreamId))?.code === 'provider_reauth_required')
      .map((session) => session.upstreamId);
    return {
      id: key.id,
      kind: 'personal_share',
      personalKeyId: key.id,
      accountId: key.account_id,
      scopeId: 'default',
      activeSessionCount: access.activeSessionCount,
      remainingMicros: access.remainingMicros,
      providerReauthRequired: access.activeSessionCount === 0 && providerReauthUpstreamIds.length > 0,
      providerReauthUpstreamIds
    };
  }

  personalShareSessionCandidates(personalKeyId, { sessionId = '', responseId = '' } = {}, upstreamStore) {
    const key = this.personalKeyRow(personalKeyId);
    if (!key || key.disabled_at) return [];
    const route = responseId ? `response:${responseId}` : sessionId ? `session:${sessionId}` : '';
    if (route) {
      const pinned = this.personalRouteSession(key.id, route, upstreamStore);
      if (pinned) return [pinned];
      if (this.personalRouteExists(key.id, route)) return [];
    }
    const sessions = this.activeConsumerSessions(key.account_id, upstreamStore);
    return orderPersonalSessions(sessions, key.last_session_id);
  }

  selectPersonalShareSession(personalKeyId, sessionId, { affinityId = '' } = {}, upstreamStore) {
    const select = this.sqlite.transaction(() => {
      const key = this.personalKeyRow(personalKeyId);
      if (!key || key.disabled_at) return null;
      const row = this.activeConsumerSessions(key.account_id, upstreamStore).find((session) => session.shareSessionId === sessionId);
      if (!row) return null;
      const now = new Date().toISOString();
      this.sqlite.prepare('UPDATE personal_api_keys SET last_session_id = ?, updated_at = ? WHERE id = ?')
        .run(row.shareSessionId, now, key.id);
      if (affinityId) {
        this.sqlite.prepare(`
          INSERT INTO personal_api_key_routes (key_id, route_key, session_id, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(key_id, route_key) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
        `).run(key.id, `session:${affinityId}`, row.shareSessionId, now);
      }
      return personalSessionAccess(row, key.id);
    });
    return select();
  }

  pinPersonalResponse(personalKeyId, responseId, sessionId, upstreamStore) {
    if (!personalKeyId || !responseId || !sessionId) return;
    const key = this.personalKeyRow(personalKeyId);
    if (!key || key.disabled_at) return;
    const row = this.activeConsumerSessions(key.account_id, upstreamStore).find((session) => session.shareSessionId === sessionId);
    if (!row) return;
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO personal_api_key_routes (key_id, route_key, session_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key_id, route_key) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `).run(key.id, `response:${responseId}`, row.shareSessionId, now);
  }

  shareSessionAccess(sessionId) {
    this.expireDue();
    const row = this.sqlite.prepare(`
      SELECT id, status, granted_micros, consumed_micros, upstream_id, scope_id
      FROM sharing_sessions
      WHERE id = ?
    `).get(sessionId);
    return row ? shareSessionAccess(row, null, this.providerSharingState(row.upstream_id)?.status) : null;
  }

  reserveSession(sessionId, attemptId, { keyId = null, model = '', route = '', upstreamStore = null } = {}) {
    if (!sessionId || !attemptId) return null;
    this.expireDue(new Date(), { force: true });
    const reserve = this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare('SELECT * FROM sharing_reservations WHERE id = ?').get(attemptId);
      if (existing) return existing.status === 'active' ? existing : null;
      const row = this.sessionRow(sessionId);
      if (row.status !== 'active') return null;
      if (isExpired(row.expires_at)) return null;
      if (this.providerSharingState(row.upstream_id)?.status === 'paused') return null;
      const commitment = upstreamStore
        ? this.providerCommitment(row.upstream_id, upstreamStore)
        : null;
      const sessionRemaining = Math.max(0, row.granted_micros - row.consumed_micros);
      const backedMicros = commitment?.sessionBacking.get(row.id) ?? sessionRemaining;
      const availableMicros = Math.max(0, Math.min(sessionRemaining, backedMicros));
      if (!availableMicros) return null;
      const now = new Date();
      this.sqlite.prepare(`
        INSERT INTO sharing_reservations
          (id, session_id, key_id, reserved_micros, status, model, route, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `).run(
        attemptId,
        sessionId,
        keyId,
        0,
        cleanModel(model),
        cleanRoute(route),
        now.toISOString(),
        new Date(now.getTime() + RESERVATION_TTL_MS).toISOString()
      );
      if (keyId) {
        this.sqlite.prepare('UPDATE personal_api_keys SET last_used_at = ?, updated_at = ? WHERE id = ?')
          .run(now.toISOString(), now.toISOString(), keyId);
      }
      this.recordActivityStart('session', sessionId, { model, now });
      if (keyId) this.recordActivityStart('personal_key', keyId, { model, now });
      return this.sqlite.prepare('SELECT * FROM sharing_reservations WHERE id = ?').get(attemptId);
    });
    const row = reserve();
    return row ? publicReservation(row) : null;
  }

  releaseReservation(attemptId, errorCode = 'request_failed') {
    if (!attemptId) return false;
    const release = this.sqlite.transaction(() => {
      const row = this.sqlite.prepare('SELECT * FROM sharing_reservations WHERE id = ?').get(attemptId);
      if (!row || row.status !== 'active') return null;
      const now = new Date().toISOString();
      this.sqlite.prepare(`
        UPDATE sharing_reservations
        SET status = 'released', settled_at = ?, error_code = ?
        WHERE id = ? AND status = 'active'
      `).run(now, errorCode === null ? null : cleanErrorCode(errorCode), attemptId);
      if (errorCode === null) {
        this.recordActivitySuccess('session', row.session_id, 0, now);
        if (row.key_id) this.recordActivitySuccess('personal_key', row.key_id, 0, now);
      } else {
        this.recordActivityFailure('session', row.session_id, errorCode, now);
        if (row.key_id) this.recordActivityFailure('personal_key', row.key_id, errorCode, now);
      }
      return row;
    });
    return Boolean(release());
  }

  settleSession(sessionId, attemptId, settledMicros) {
    if (!sessionId || !attemptId || !Number.isSafeInteger(settledMicros) || settledMicros < 0) return null;
    const settle = this.sqlite.transaction(() => {
      const row = this.sessionRow(sessionId);
      const inserted = this.sqlite.prepare(`
        INSERT OR IGNORE INTO sharing_session_settlements (session_id, attempt_id, settled_micros, created_at)
        VALUES (?, ?, ?, ?)
      `).run(sessionId, attemptId, settledMicros, new Date().toISOString());
      if (!inserted.changes) {
        this.sqlite.prepare(`
          UPDATE sharing_reservations
          SET status = 'settled', settled_at = ?
          WHERE id = ? AND status = 'active'
        `).run(new Date().toISOString(), attemptId);
        return row;
      }
      const consumedMicros = row.consumed_micros + settledMicros;
      const status = row.status === 'revoked' ? 'revoked'
        : consumedMicros >= row.granted_micros ? 'exhausted'
          : row.status;
      this.sqlite.prepare('UPDATE sharing_sessions SET consumed_micros = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(consumedMicros, status, new Date().toISOString(), sessionId);
      const reservation = this.sqlite.prepare('SELECT * FROM sharing_reservations WHERE id = ?').get(attemptId);
      this.sqlite.prepare(`
        UPDATE sharing_reservations
        SET status = 'settled', settled_at = ?
        WHERE id = ? AND status = 'active'
      `).run(new Date().toISOString(), attemptId);
      this.recordActivitySuccess('session', sessionId, settledMicros);
      if (reservation?.key_id) this.recordActivitySuccess('personal_key', reservation.key_id, settledMicros);
      return { row: this.sessionRow(sessionId), previousConsumedMicros: row.consumed_micros };
    });
    const result = settle();
    const row = result.row || result;
    this.notifySessionThresholds(row, result.previousConsumedMicros ?? row.consumed_micros);
    return publicShareSession(row, null, null);
  }

  cleanupUpstream(upstreamId) {
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      const offers = this.sqlite.prepare('SELECT id FROM sharing_offers WHERE upstream_id = ?').all(upstreamId);
      for (const { id } of offers) {
        this.sqlite.prepare("UPDATE sharing_offers SET status = 'closed', updated_at = ? WHERE id = ?").run(now, id);
        this.sqlite.prepare("UPDATE sharing_tickets SET status = 'rejected', resolved_at = ? WHERE offer_id = ? AND status = 'pending'").run(now, id);
      }
      const sessions = this.sqlite.prepare("SELECT id FROM sharing_sessions WHERE upstream_id = ? AND status != 'revoked'").all(upstreamId);
      for (const { id } of sessions) {
        this.sqlite.prepare("UPDATE sharing_sessions SET status = 'revoked', pending_key_cipher = NULL, updated_at = ? WHERE id = ?").run(now, id);
        this.sqlite.prepare('UPDATE sharing_session_keys SET disabled_at = ? WHERE session_id = ? AND disabled_at IS NULL').run(now, id);
      }
      this.sqlite.prepare('DELETE FROM account_upstreams WHERE upstream_id = ?').run(upstreamId);
    })();
  }

  offerAllocatedMicros(offerId, excludingSessionId = null) {
    const rows = this.sqlite.prepare('SELECT id, granted_micros, consumed_micros, status FROM sharing_sessions WHERE offer_id = ?').all(offerId);
    return allocationTotal(rows, excludingSessionId);
  }

  offerAllocations(offerIds) {
    if (!offerIds.length) return new Map();
    const placeholders = offerIds.map(() => '?').join(', ');
    return new Map(this.sqlite.prepare(`
      SELECT offer_id,
        COALESCE(SUM(CASE WHEN status = 'revoked' THEN consumed_micros ELSE MAX(granted_micros, consumed_micros) END), 0) AS allocated_micros
      FROM sharing_sessions
      WHERE offer_id IN (${placeholders})
      GROUP BY offer_id
    `).all(...offerIds).map(({ offer_id, allocated_micros }) => [offer_id, allocated_micros]));
  }

  upstreamAllocatedMicros(upstreamId, excludingSessionId = null) {
    const rows = this.sqlite.prepare('SELECT id, granted_micros, consumed_micros, status FROM sharing_sessions WHERE upstream_id = ?').all(upstreamId);
    return allocationTotal(rows, excludingSessionId);
  }

  createPersonalKey(accountId, apiKey = `cp_personal_${randomToken(32)}`, now = new Date().toISOString(), {
    name = 'Default',
    expiresAt = null
  } = {}) {
    const id = randomUUID();
    this.sqlite.prepare(`
      INSERT INTO personal_api_keys
        (id, account_id, name, key_hash, key_cipher, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, accountId, cleanKeyName(name), hash(apiKey), encrypt(apiKey, this.key), expiresAt, now, now);
    return this.personalKeyRow(id);
  }

  ensureDefaultPersonalKey(accountId) {
    const existing = this.sqlite.prepare(`
      SELECT id
      FROM personal_api_keys
      WHERE account_id = ? AND name = ?
      LIMIT 1
    `).get(accountId, 'Default');
    return existing || this.createPersonalKey(accountId);
  }

  personalKeyRow(id) {
    return id ? this.sqlite.prepare('SELECT * FROM personal_api_keys WHERE id = ?').get(id) : null;
  }

  personalKeyRowForAccount(accountId) {
    return this.sqlite.prepare(`
      SELECT *
      FROM personal_api_keys
      WHERE account_id = ? AND disabled_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY name = 'Default' DESC, created_at, id
      LIMIT 1
    `).get(accountId, new Date().toISOString());
  }

  personalRouteSession(keyId, route, upstreamStore) {
    const row = this.sqlite.prepare(`
      SELECT sharing_sessions.*
      FROM personal_api_key_routes
      JOIN sharing_sessions ON sharing_sessions.id = personal_api_key_routes.session_id
      WHERE personal_api_key_routes.key_id = ? AND personal_api_key_routes.route_key = ?
        AND sharing_sessions.status = 'active'
        AND sharing_sessions.granted_micros > sharing_sessions.consumed_micros
    `).get(keyId, route);
    if (!row || !personalSessionAvailable(row, upstreamStore)) return null;
    this.sqlite.prepare('UPDATE personal_api_key_routes SET updated_at = ? WHERE key_id = ? AND route_key = ?')
      .run(new Date().toISOString(), keyId, route);
    return personalSessionAccess(row, keyId);
  }

  personalRouteExists(keyId, route) {
    return Boolean(this.sqlite.prepare('SELECT 1 FROM personal_api_key_routes WHERE key_id = ? AND route_key = ?').get(keyId, route));
  }

  activeConsumerSessions(accountId, upstreamStore) {
    this.expireDue();
    const pausedUpstreams = new Set(this.sqlite.prepare(`
      SELECT upstream_id
      FROM account_upstreams
      WHERE sharing_status = 'paused'
    `).all().map(({ upstream_id }) => upstream_id));
    const rows = this.sqlite.prepare(`
      SELECT id, status, granted_micros, consumed_micros, upstream_id, scope_id, expires_at
      FROM sharing_sessions
      WHERE consumer_account_id = ? AND status = 'active' AND granted_micros > consumed_micros
    `).all(accountId)
      .filter((row) => personalSessionAvailable(row, upstreamStore))
      .filter((row) => !pausedUpstreams.has(row.upstream_id));
    if (!rows.length) return [];
    const commitmentCache = new Map();
    return rows.flatMap((row) => {
      const commitment = upstreamStore ? this.providerCommitment(row.upstream_id, upstreamStore, commitmentCache) : null;
      const sessionRemaining = Math.max(0, row.granted_micros - row.consumed_micros);
      const backedMicros = commitment?.sessionBacking.get(row.id) ?? sessionRemaining;
      const remainingMicros = Math.max(0, Math.min(sessionRemaining, backedMicros));
      return remainingMicros ? [personalSessionAccess({ ...row, remainingMicros })] : [];
    });
  }

  personalKeyAccess(keyId, accountId, upstreamStore) {
    const sessions = this.activeConsumerSessions(accountId, upstreamStore);
    const totals = this.sqlite.prepare(`
      SELECT
        COALESCE(SUM(granted_micros), 0) AS granted_micros,
        COALESCE(SUM(consumed_micros), 0) AS consumed_micros
      FROM sharing_sessions
      WHERE consumer_account_id = ? AND status NOT IN ('revoked', 'expired')
    `).get(accountId);
    return {
      personalKeyId: keyId,
      activeSessionCount: sessions.length,
      grantedMicros: totals.granted_micros,
      consumedMicros: totals.consumed_micros,
      remainingMicros: sessions.reduce((total, session) => total + session.remainingMicros, 0)
    };
  }

  listQuotaRequests(viewerAccountId) {
    this.expireDue();
    return this.sqlite.prepare(`
      SELECT quota_requests.*, accounts.email, accounts.display_name
      FROM quota_requests
      JOIN accounts ON accounts.id = quota_requests.account_id
      ORDER BY quota_requests.status = 'active' DESC, quota_requests.created_at DESC
    `).all().map((row) => publicQuotaRequest(row, viewerAccountId));
  }

  listQuotaRequestsPage(viewerAccountId, options) {
    this.expireDue();
    const conditions = [];
    const args = [];
    if (!options.includePast) conditions.push("quota_requests.status = 'active'");
    if (options.query) {
      conditions.push('instr(lower(accounts.email), ?) > 0');
      args.push(options.query);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const select = `FROM quota_requests JOIN accounts ON accounts.id = quota_requests.account_id ${where}`;
    const totalItems = this.sqlite.prepare(`SELECT COUNT(*) AS count ${select}`).get(...args).count;
    const rows = this.sqlite.prepare(`
      SELECT quota_requests.*, accounts.email, accounts.display_name
      ${select}
      ORDER BY quota_requests.status = 'active' DESC, quota_requests.created_at DESC, quota_requests.id DESC
      LIMIT ? OFFSET ?
    `).all(...args, options.limit, options.offset);
    return {
      ...sharingListPage('quotaRequests', rows.map((row) => publicQuotaRequest(row, viewerAccountId)), totalItems, options),
      hasActiveOwnQuotaRequest: Boolean(this.sqlite.prepare(`
        SELECT 1 FROM quota_requests WHERE account_id = ? AND status = 'active'
      `).get(viewerAccountId))
    };
  }

  createQuotaRequest(accountId, { quotaDollars, expiresAt } = {}) {
    this.requireAccount(accountId);
    this.expireDue(new Date(), { force: true });
    const now = new Date();
    const quotaMicros = dollarsToMicros(quotaDollars);
    const expiry = optionalFutureTime(expiresAt, now)
      || new Date(now.getTime() + OFFER_TTL_MS).toISOString();
    const apply = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE quota_requests
        SET status = 'cancelled', updated_at = ?
        WHERE account_id = ? AND status = 'active'
      `).run(now.toISOString(), accountId);
      const id = randomUUID();
      this.sqlite.prepare(`
        INSERT INTO quota_requests
          (id, account_id, quota_micros, status, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(id, accountId, quotaMicros, expiry, now.toISOString(), now.toISOString());
      this.event(accountId, 'quota_request', id, 'created', { quotaMicros, expiresAt: expiry });
      return id;
    });
    return this.quotaRequest(apply(), accountId);
  }

  cancelQuotaRequest(accountId, id) {
    const row = this.sqlite.prepare('SELECT * FROM quota_requests WHERE id = ?').get(id);
    if (!row || row.account_id !== accountId) throw notFound();
    if (row.status === 'active') {
      const now = new Date().toISOString();
      this.sqlite.prepare("UPDATE quota_requests SET status = 'cancelled', updated_at = ? WHERE id = ?")
        .run(now, id);
      this.event(accountId, 'quota_request', id, 'cancelled', {});
    }
    return this.quotaRequest(id, accountId);
  }

  quotaRequest(id, viewerAccountId) {
    const row = this.sqlite.prepare(`
      SELECT quota_requests.*, accounts.email, accounts.display_name
      FROM quota_requests
      JOIN accounts ON accounts.id = quota_requests.account_id
      WHERE quota_requests.id = ?
    `).get(id);
    if (!row) throw notFound();
    return publicQuotaRequest(row, viewerAccountId);
  }

  activity(subjectType, subjectId) {
    const row = this.sqlite.prepare(`
      SELECT * FROM sharing_activity
      WHERE subject_type = ? AND subject_id = ?
    `).get(subjectType, subjectId);
    return publicActivity(row);
  }

  activities(subjectType, subjectIds) {
    if (!subjectIds.length) return new Map();
    const placeholders = subjectIds.map(() => '?').join(', ');
    return new Map(this.sqlite.prepare(`
      SELECT * FROM sharing_activity
      WHERE subject_type = ? AND subject_id IN (${placeholders})
    `).all(subjectType, ...subjectIds).map((row) => [row.subject_id, publicActivity(row)]));
  }

  recordActivityStart(subjectType, subjectId, { model = '', now = new Date() } = {}) {
    const timestamp = new Date(now).toISOString();
    const current = this.activityRow(subjectType, subjectId);
    const models = cleanModel(model)
      ? [cleanModel(model), ...parseJsonArray(current?.models_json).filter((item) => item !== cleanModel(model))].slice(0, ACTIVITY_MODEL_LIMIT)
      : parseJsonArray(current?.models_json);
    this.sqlite.prepare(`
      INSERT INTO sharing_activity
        (subject_type, subject_id, request_count, success_count, total_micros, today_date,
         today_micros, last_used_at, last_success_at, models_json, failures_json)
      VALUES (?, ?, 1, 0, 0, ?, 0, ?, NULL, ?, '[]')
      ON CONFLICT(subject_type, subject_id) DO UPDATE SET
        request_count = request_count + 1,
        last_used_at = excluded.last_used_at,
        models_json = excluded.models_json
    `).run(subjectType, subjectId, utcDate(now), timestamp, JSON.stringify(models));
  }

  recordActivitySuccess(subjectType, subjectId, settledMicros, now = new Date()) {
    const timestamp = new Date(now).toISOString();
    const date = utcDate(now);
    const current = this.activityRow(subjectType, subjectId);
    const todayMicros = current?.today_date === date ? current.today_micros : 0;
    this.sqlite.prepare(`
      INSERT INTO sharing_activity
        (subject_type, subject_id, request_count, success_count, total_micros, today_date,
         today_micros, last_used_at, last_success_at, models_json, failures_json)
      VALUES (?, ?, 0, 1, ?, ?, ?, ?, ?, '[]', '[]')
      ON CONFLICT(subject_type, subject_id) DO UPDATE SET
        success_count = success_count + 1,
        total_micros = total_micros + excluded.total_micros,
        today_date = excluded.today_date,
        today_micros = ?,
        last_used_at = excluded.last_used_at,
        last_success_at = excluded.last_success_at
    `).run(
      subjectType,
      subjectId,
      settledMicros,
      date,
      settledMicros,
      timestamp,
      timestamp,
      todayMicros + settledMicros
    );
  }

  recordActivityFailure(subjectType, subjectId, errorCode, now = new Date()) {
    const timestamp = new Date(now).toISOString();
    const current = this.activityRow(subjectType, subjectId);
    const failures = [
      { code: cleanErrorCode(errorCode), at: timestamp },
      ...parseJsonArray(current?.failures_json)
    ].slice(0, ACTIVITY_FAILURE_LIMIT);
    this.sqlite.prepare(`
      INSERT INTO sharing_activity
        (subject_type, subject_id, request_count, success_count, total_micros, today_date,
         today_micros, last_used_at, last_success_at, models_json, failures_json)
      VALUES (?, ?, 0, 0, 0, ?, 0, ?, NULL, '[]', ?)
      ON CONFLICT(subject_type, subject_id) DO UPDATE SET
        last_used_at = excluded.last_used_at,
        failures_json = excluded.failures_json
    `).run(subjectType, subjectId, utcDate(now), timestamp, JSON.stringify(failures));
  }

  activityRow(subjectType, subjectId) {
    return this.sqlite.prepare(`
      SELECT * FROM sharing_activity
      WHERE subject_type = ? AND subject_id = ?
    `).get(subjectType, subjectId);
  }

  observeProviders(upstreamStore) {
    const now = new Date().toISOString();
    for (const link of this.sqlite.prepare('SELECT upstream_id FROM account_upstreams').all()) {
      const upstream = upstreamStore.getPublic(link.upstream_id);
      const issueCode = providerIssue(upstream)?.code || null;
      const resetAt = upstream?.quota?.resetAt || null;
      const remainingMicros = providerRemainingMicros(upstream);
      const previous = this.sqlite.prepare('SELECT * FROM provider_observations WHERE upstream_id = ?').get(link.upstream_id);
      this.sqlite.prepare(`
        INSERT INTO provider_observations
          (upstream_id, issue_code, reset_at, remaining_micros, observed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(upstream_id) DO UPDATE SET
          issue_code = excluded.issue_code,
          reset_at = excluded.reset_at,
          remaining_micros = excluded.remaining_micros,
          observed_at = excluded.observed_at
      `).run(link.upstream_id, issueCode, resetAt, remainingMicros, now);
      if (!previous) continue;
      if (!previous.issue_code && issueCode) {
        this.notifyProviderParticipants(
          link.upstream_id,
          'Shared Codex account unavailable',
          'A provider account backing your Codex Share offer or session became unavailable.',
          `provider:${link.upstream_id}:issue:${issueCode}:${now}`
        );
      } else if (previous.issue_code && !issueCode) {
        this.notifyProviderParticipants(
          link.upstream_id,
          'Shared Codex account recovered',
          'A provider account backing Codex Share is available again.',
          `provider:${link.upstream_id}:recovered:${now}`
        );
      }
      if (previous.reset_at && resetAt && previous.reset_at !== resetAt
        && Date.parse(previous.reset_at) <= Date.now()) {
        this.notifyProviderParticipants(
          link.upstream_id,
          'Provider Codex quota reset',
          'The provider quota window reset. Codex Share recalculated the quota backing current offers and sessions.',
          `provider:${link.upstream_id}:reset:${resetAt}`
        );
      }
    }
  }

  pendingEmails(limit = 20, now = new Date()) {
    return this.sqlite.prepare(`
      SELECT *
      FROM email_outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY created_at
      LIMIT ?
    `).all(new Date(now).toISOString(), Math.max(1, Math.min(100, Number(limit) || 20))).map(publicEmail);
  }

  markEmailSent(id, now = new Date()) {
    return this.sqlite.prepare(`
      UPDATE email_outbox
      SET status = 'sent', sent_at = ?, last_error = NULL
      WHERE id = ? AND status = 'pending'
    `).run(new Date(now).toISOString(), id).changes > 0;
  }

  markEmailFailed(id, error, now = new Date()) {
    const row = this.sqlite.prepare('SELECT attempt_count FROM email_outbox WHERE id = ?').get(id);
    if (!row) return false;
    const attempts = row.attempt_count + 1;
    const retryAt = new Date(new Date(now).getTime() + Math.min(6 * 60 * 60 * 1_000, 30_000 * 2 ** Math.min(8, attempts - 1)));
    const status = attempts >= 10 ? 'failed' : 'pending';
    return this.sqlite.prepare(`
      UPDATE email_outbox
      SET status = ?, attempt_count = ?, next_attempt_at = ?, last_error = ?
      WHERE id = ?
    `).run(status, attempts, retryAt.toISOString(), cleanMailError(error), id).changes > 0;
  }

  setEmailNotificationsEnabled(enabled) {
    this.emailNotificationsEnabled = Boolean(enabled);
    if (!this.emailNotificationsEnabled) {
      this.sqlite.prepare("DELETE FROM email_outbox WHERE status = 'pending'").run();
    }
  }

  notifyAccount(accountId, subject, text, dedupeKey = null) {
    if (!this.emailNotificationsEnabled) return false;
    const account = this.requireAccount(accountId);
    const recipient = validRecipient(account.email);
    if (!recipient) return false;
    const now = new Date().toISOString();
    return this.sqlite.prepare(`
      INSERT OR IGNORE INTO email_outbox
        (id, account_id, recipient, subject, body_text, dedupe_key, status, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      randomUUID(),
      accountId,
      recipient,
      cleanMailSubject(subject),
      cleanMailBody(text),
      dedupeKey || null,
      now,
      now
    ).changes > 0;
  }

  notifyOfferParticipants(offerId, subject, text, dedupeKey) {
    const rows = this.sqlite.prepare(`
      SELECT provider_account_id AS account_id
      FROM sharing_offers
      WHERE id = ?
      UNION
      SELECT consumer_account_id
      FROM sharing_tickets
      WHERE offer_id = ?
    `).all(offerId, offerId);
    for (const row of rows) this.notifyAccount(row.account_id, subject, text, `${dedupeKey}:${row.account_id}`);
  }

  notifyTicketParticipants(ticketId, subject, text, dedupeKey) {
    const row = this.sqlite.prepare(`
      SELECT provider_account_id, consumer_account_id
      FROM sharing_tickets
      WHERE id = ?
    `).get(ticketId);
    if (!row) return;
    for (const accountId of [row.provider_account_id, row.consumer_account_id]) {
      this.notifyAccount(accountId, subject, text, `${dedupeKey}:${accountId}`);
    }
  }

  notifySessionParticipants(sessionId, subject, text, dedupeKey) {
    const row = this.sqlite.prepare(`
      SELECT provider_account_id, consumer_account_id
      FROM sharing_sessions
      WHERE id = ?
    `).get(sessionId);
    if (!row) return;
    for (const accountId of [row.provider_account_id, row.consumer_account_id]) {
      this.notifyAccount(accountId, subject, text, `${dedupeKey}:${accountId}`);
    }
  }

  notifyProviderParticipants(upstreamId, subject, text, dedupeKey) {
    const rows = this.sqlite.prepare(`
      SELECT account_id FROM account_upstreams WHERE upstream_id = ?
      UNION
      SELECT consumer_account_id FROM sharing_sessions WHERE upstream_id = ?
      UNION
      SELECT consumer_account_id
      FROM sharing_tickets
      JOIN sharing_offers ON sharing_offers.id = sharing_tickets.offer_id
      WHERE sharing_offers.upstream_id = ? AND sharing_tickets.status = 'pending'
    `).all(upstreamId, upstreamId, upstreamId);
    for (const row of rows) this.notifyAccount(row.account_id, subject, text, `${dedupeKey}:${row.account_id}`);
  }

  notifyDemandForOffer(offerId, upstreamStore) {
    const offer = this.offer(offerId, null, upstreamStore);
    if (!offer.isUsable || offer.status !== 'active') return;
    const requests = this.sqlite.prepare(`
      SELECT id, account_id, quota_micros
      FROM quota_requests
      WHERE status = 'active' AND quota_micros <= ?
    `).all(Math.round(offer.availableDollars * 1_000_000));
    for (const request of requests) {
      this.notifyAccount(
        request.account_id,
        'Codex quota is available',
        `A friend published $${formatDollars(offer.availableDollars)} of usable Codex quota.`,
        `quota-request:${request.id}:offer:${offerId}`
      );
    }
  }

  notifySessionThresholds(row, previousConsumedMicros) {
    if (!row.granted_micros) return;
    const previous = previousConsumedMicros / row.granted_micros;
    const current = row.consumed_micros / row.granted_micros;
    for (const threshold of [0.8, 0.95, 1]) {
      if (previous < threshold && current >= threshold) {
        const percent = Math.round(threshold * 100);
        this.notifySessionParticipants(
          row.id,
          `Codex Share session ${percent}% used`,
          threshold === 1
            ? 'A Codex Share session exhausted its granted quota.'
            : `A Codex Share session has used ${percent}% of its granted quota.`,
          `session:${row.id}:threshold:${percent}`
        );
      }
    }
  }

  requireAccount(id) {
    const row = this.sqlite.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!row) throw notFound();
    return row;
  }

  requireOffer(id) {
    const row = this.sqlite.prepare('SELECT * FROM sharing_offers WHERE id = ?').get(id);
    if (!row) throw notFound();
    return row;
  }

  requireTicket(id) {
    const row = this.sqlite.prepare('SELECT * FROM sharing_tickets WHERE id = ?').get(id);
    if (!row) throw notFound();
    return row;
  }

  requirePersonalKey(accountId, id) {
    const row = this.personalKeyRow(id);
    if (!row || row.account_id !== accountId) throw notFound();
    return row;
  }

  sessionRow(id) {
    const row = this.sqlite.prepare(`
      SELECT sharing_sessions.*,
        provider.display_name AS provider_name,
        provider.email AS provider_email,
        consumer.display_name AS consumer_name
        , consumer.email AS consumer_email
      FROM sharing_sessions
      JOIN accounts provider ON provider.id = sharing_sessions.provider_account_id
      JOIN accounts consumer ON consumer.id = sharing_sessions.consumer_account_id
      WHERE sharing_sessions.id = ?
    `).get(id);
    if (!row) throw notFound();
    return row;
  }

  resolveTicket(row, status) {
    this.sqlite.prepare('UPDATE sharing_tickets SET status = ?, resolved_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), row.id);
  }

  event(actorAccountId, entityType, entityId, action, detail) {
    this.sqlite.prepare(`
      INSERT INTO sharing_events (id, actor_account_id, entity_type, entity_id, action, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), actorAccountId || null, entityType, entityId, action, JSON.stringify(detail || {}), new Date().toISOString());
  }

  loadKey() {
    if (existsSync(this.keyPath)) {
      const key = readFileSync(this.keyPath);
      if (key.length !== 32) throw new Error('Stored Codex Share key is invalid');
      return key;
    }
    const key = randomBytes(32);
    writeFileSync(this.keyPath, key, { mode: 0o600 });
    chmodSync(this.keyPath, 0o600);
    return key;
  }
}

function allocationTotal(rows, excludingSessionId) {
  return rows.reduce((total, row) => {
    if (row.id === excludingSessionId) return total;
    return total + (row.status === 'revoked' ? row.consumed_micros : Math.max(row.granted_micros, row.consumed_micros));
  }, 0);
}

function addColumn(sqlite, table, name, definition) {
  if (sqlite.pragma(`table_info(${table})`).some((column) => column.name === name)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function hasUniqueSingleColumnIndex(sqlite, table, column) {
  return sqlite.pragma(`index_list(${table})`).some((index) => {
    if (!index.unique) return false;
    const columns = sqlite.pragma(`index_info(${index.name})`);
    return columns.length === 1 && columns[0].name === column;
  });
}

function publicAccount(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: poolDisplayName(row.email, row.display_name),
    avatarUrl: row.avatar_url || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function publicLoginAttempt(row) {
  return {
    id: row.id,
    status: row.status,
    verificationUrl: row.verification_url || null,
    userCode: row.user_code || null,
    errorCode: row.error_code || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

function publicOffer(row, upstream, allocatedMicros, viewerAccountId, {
  sharing = null,
  backedMicros = row.quota_micros,
  underfundedMicros = 0
} = {}) {
  const quotaMicros = row.quota_micros;
  const issue = providerIssue(upstream);
  const providerPaused = sharing?.status === 'paused';
  const offerUnderfundedMicros = Math.max(0, quotaMicros - backedMicros);
  const exceedsProviderQuota = offerExceedsProviderQuota(quotaMicros, upstream) || offerUnderfundedMicros > 0;
  const unusable = Boolean(issue || providerPaused || exceedsProviderQuota || row.status !== 'active');
  return {
    id: row.id,
    provider: {
      id: row.provider_account_id,
      displayName: poolDisplayName(row.provider_email || upstream?.email, row.provider_name),
      email: row.provider_email || upstream?.email || null
    },
    upstream: upstream ? {
      id: upstream.id,
      name: upstream.email || upstream.name,
      type: upstream.type,
      quota: upstream.quota,
      quotaSource: upstream.quotaSource,
      providerIssue: issue
    } : null,
    quotaDollars: microsToDollars(quotaMicros),
    allocatedDollars: microsToDollars(allocatedMicros),
    availableDollars: microsToDollars(Math.max(0, quotaMicros - allocatedMicros)),
    backedQuotaDollars: microsToDollars(backedMicros),
    underfundedQuotaDollars: microsToDollars(offerUnderfundedMicros),
    providerUnderfundedQuotaDollars: microsToDollars(underfundedMicros),
    isUnderfunded: offerUnderfundedMicros > 0,
    providerSharingStatus: sharing?.status || 'active',
    status: row.status,
    isUsable: !unusable,
    unusableReason: issue?.message
      || (providerPaused ? 'The provider paused sharing from this Codex account.' : null)
      || (exceedsProviderQuota ? 'The provider has less actual quota than this offer.' : null)
      || (row.status !== 'active' ? 'The offer is not active.' : null),
    isProvider: viewerAccountId === row.provider_account_id,
    hasPendingRequest: Boolean(row.has_pending_request),
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicTicket(row, viewerAccountId, upstream) {
  return {
    id: row.id,
    offerId: row.offer_id,
    provider: {
      id: row.provider_account_id,
      displayName: poolDisplayName(row.provider_email, row.provider_name),
      email: row.provider_email || null
    },
    consumer: {
      id: row.consumer_account_id,
      displayName: poolDisplayName(row.consumer_email, row.consumer_name),
      email: row.consumer_email || null
    },
    upstream: upstream ? { id: upstream.id, name: upstream.email || upstream.name, type: upstream.type, providerIssue: providerIssue(upstream) } : null,
    requestedQuotaDollars: microsToDollars(row.requested_micros),
    approvedQuotaDollars: row.approved_micros === null ? null : microsToDollars(row.approved_micros),
    status: row.status,
    direction: viewerAccountId === row.provider_account_id ? 'received' : 'sent',
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null
  };
}

function publicShareSession(row, viewerAccountId, upstream, {
  sharing = null,
  backedMicros = Math.max(0, row.granted_micros - row.consumed_micros),
  activity = emptyActivity()
} = {}) {
  const remainingMicros = Math.max(0, row.granted_micros - row.consumed_micros);
  const isProvider = viewerAccountId === row.provider_account_id;
  const backedRemainingMicros = Math.max(0, Math.min(remainingMicros, backedMicros));
  return {
    id: row.id,
    offerId: row.offer_id,
    ticketId: row.ticket_id,
    provider: {
      id: row.provider_account_id,
      displayName: poolDisplayName(row.provider_email, row.provider_name),
      email: row.provider_email || null
    },
    consumer: {
      id: row.consumer_account_id,
      displayName: poolDisplayName(row.consumer_email, row.consumer_name),
      email: row.consumer_email || null
    },
    upstream: upstream
      ? {
          id: upstream.id,
          name: upstream.email || upstream.name,
          type: upstream.type,
          quotaSource: upstream.quotaSource,
          providerIssue: providerIssue(upstream)
        }
      : { id: row.upstream_id },
    providerIssue: providerIssue(upstream),
    grantedQuotaDollars: microsToDollars(row.granted_micros),
    consumedQuotaDollars: microsToDollars(row.consumed_micros),
    remainingQuotaDollars: microsToDollars(remainingMicros),
    backedRemainingQuotaDollars: microsToDollars(backedRemainingMicros),
    underfundedQuotaDollars: microsToDollars(Math.max(0, remainingMicros - backedRemainingMicros)),
    isUnderfunded: backedRemainingMicros < remainingMicros,
    providerSharingStatus: sharing?.status || 'active',
    status: row.status,
    canRevealKey: [row.provider_account_id, row.consumer_account_id].includes(viewerAccountId)
      && Boolean(row.pending_key_cipher)
      && !['revoked', 'expired'].includes(row.status),
    canRotateKey: isProvider && !['revoked', 'expired'].includes(row.status),
    role: isProvider ? 'provider' : viewerAccountId === row.consumer_account_id ? 'consumer' : null,
    activity,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function shareSessionAccess(row, keyId = null, providerSharingStatus = 'active') {
  return {
    ...(keyId ? { id: keyId } : {}),
    kind: 'share_session',
    shareSessionId: row.id,
    scopeId: row.scope_id,
    upstreamId: row.upstream_id,
    sessionStatus: row.status,
    providerSharingStatus,
    remainingMicros: Math.max(0, row.granted_micros - row.consumed_micros)
  };
}

function personalSessionAccess(row, keyId) {
  const sessionId = row.shareSessionId || row.id;
  return {
    id: keyId,
    shareSessionId: sessionId,
    scopeId: row.scope_id,
    upstreamId: row.upstream_id,
    sessionStatus: row.status,
    remainingMicros: Number.isSafeInteger(row.remainingMicros)
      ? row.remainingMicros
      : Math.max(0, row.granted_micros - row.consumed_micros)
  };
}

function personalSessionAvailable(row, upstreamStore) {
  return !upstreamStore || !providerIssue(upstreamStore.getPublic(row.upstream_id));
}

function orderPersonalSessions(sessions, lastSessionId) {
  return [...sessions].sort((left, right) => {
    if (left.shareSessionId === lastSessionId) return 1;
    if (right.shareSessionId === lastSessionId) return -1;
    if (right.remainingMicros !== left.remainingMicros) return right.remainingMicros - left.remainingMicros;
    return left.shareSessionId.localeCompare(right.shareSessionId);
  });
}

function dollarsToMicros(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Error('quotaDollars must be greater than zero');
  const micros = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new Error('quotaDollars is invalid');
  return micros;
}

function requireProviderQuota(upstream) {
  const issue = providerIssue(upstream);
  if (issue) throw new Error(issue.message);
}

function requireProviderSharing(state) {
  if (state?.status === 'paused') throw new Error('sharing is paused for this Codex account');
}

function requireOfferUsable(offer, upstream) {
  if (!offerExceedsProviderQuota(offer.quota_micros, upstream)) return;
  throw new Error('offer exceeds the provider’s actual remaining quota and cannot be requested');
}

function microsToDollars(value) {
  return Math.max(0, Number(value) || 0) / 1_000_000;
}

function providerRemainingMicros(upstream) {
  const value = upstream?.quota?.remainingDollars;
  if (value === null || value === undefined || value === '') return null;
  const remainingDollars = Number(value);
  if (!Number.isFinite(remainingDollars)) return null;
  return Math.max(0, Math.round(remainingDollars * 1_000_000));
}

function sharingExpiry(value, upstream, now, fallbackMs) {
  const requested = optionalFutureTime(value, now);
  const resetAt = optionalFutureTime(upstream?.quota?.resetAt, now);
  return earliestExpiry(requested, resetAt, new Date(new Date(now).getTime() + fallbackMs).toISOString());
}

function optionalFutureTime(value, now = new Date()) {
  if (value === null || value === undefined || value === '') return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= new Date(now).getTime()) throw new Error('expiration must be in the future');
  return new Date(timestamp).toISOString();
}

function earliestExpiry(...values) {
  const timestamps = values
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null;
}

function isExpired(value, now = Date.now()) {
  return Boolean(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now;
}

function compareOffers(left, right) {
  if (left.isUsable !== right.isUsable) return left.isUsable ? -1 : 1;
  if (right.availableDollars !== left.availableDollars) return right.availableDollars - left.availableDollars;
  const leftReset = Date.parse(left.upstream?.quota?.resetAt);
  const rightReset = Date.parse(right.upstream?.quota?.resetAt);
  if (Number.isFinite(leftReset) && Number.isFinite(rightReset) && leftReset !== rightReset) return leftReset - rightReset;
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

function sharingListPage(key, items, totalItems, { limit = 10, offset = 0 } = {}) {
  const nextOffset = offset + items.length;
  return {
    [key]: items,
    totalItems,
    hasMore: nextOffset < totalItems,
    nextOffset: nextOffset < totalItems ? nextOffset : null
  };
}

function publicPersonalKey(row, access, activity) {
  const status = row.disabled_at ? 'revoked' : isExpired(row.expires_at) ? 'expired' : 'active';
  return {
    id: row.id,
    name: row.name,
    status,
    hasKey: status === 'active',
    canUse: status === 'active' && access.activeSessionCount > 0,
    activeSessionCount: access.activeSessionCount,
    remainingQuotaDollars: microsToDollars(access.remainingMicros),
    lastUsedAt: row.last_used_at || null,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activity
  };
}

function publicProviderCommitment(commitment) {
  return {
    actualQuotaDollars: commitment.actualMicros === null ? null : microsToDollars(commitment.actualMicros),
    sessionCommitmentDollars: microsToDollars(commitment.sessionCommittedMicros),
    offerReservationDollars: microsToDollars(commitment.offerReservedMicros),
    totalCommitmentDollars: microsToDollars(commitment.committedMicros),
    offerableQuotaDollars: commitment.offerableMicros === null ? null : microsToDollars(commitment.offerableMicros),
    underfundedQuotaDollars: microsToDollars(commitment.underfundedMicros)
  };
}

function publicReservation(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    keyId: row.key_id || null,
    reservedMicros: row.reserved_micros,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function publicQuotaRequest(row, viewerAccountId) {
  return {
    id: row.id,
    requester: {
      id: row.account_id,
      email: row.email,
      displayName: poolDisplayName(row.email, row.display_name)
    },
    quotaDollars: microsToDollars(row.quota_micros),
    status: row.status,
    isMine: row.account_id === viewerAccountId,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function emptyActivity() {
  return {
    requestCount: 0,
    successCount: 0,
    totalSpendDollars: 0,
    spendTodayDollars: 0,
    lastUsedAt: null,
    lastSuccessfulAt: null,
    models: [],
    recentFailures: []
  };
}

function publicActivity(row) {
  if (!row) return emptyActivity();
  const today = utcDate();
  return {
    requestCount: row.request_count,
    successCount: row.success_count,
    totalSpendDollars: microsToDollars(row.total_micros),
    spendTodayDollars: microsToDollars(row.today_date === today ? row.today_micros : 0),
    lastUsedAt: row.last_used_at || null,
    lastSuccessfulAt: row.last_success_at || null,
    models: parseJsonArray(row.models_json),
    recentFailures: parseJsonArray(row.failures_json)
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function utcDate(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

function cleanKeyName(value) {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return name || 'Default';
}

function cleanModel(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function cleanRoute(value) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

function cleanErrorCode(value) {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9_.:-]{1,120}$/.test(code) ? code : 'request_failed';
}

function validRecipient(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.slice(0, 320) : '';
}

function cleanMailSubject(value) {
  return String(value || 'Codex Share update').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
}

function cleanMailBody(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, 10_000);
}

function cleanMailError(error) {
  return String(error?.code || error?.message || error || 'email delivery failed')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300);
}

function publicEmail(row) {
  return {
    id: row.id,
    recipient: row.recipient,
    subject: row.subject,
    text: row.body_text,
    attemptCount: row.attempt_count
  };
}

function formatDollars(value) {
  return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function randomToken(bytes) {
  return randomBytes(bytes).toString('base64url');
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function constantEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

function decrypt(value, key) {
  const packed = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
}

function codexIdentity(subject, issuer) {
  const normalizedSubject = typeof subject === 'string' ? subject.trim() : '';
  if (!normalizedSubject) return '';
  const normalizedIssuer = typeof issuer === 'string' ? issuer.trim().replace(/\/+$/, '') : '';
  return `${normalizedIssuer || 'openai'}:${normalizedSubject}`;
}

function cleanEmail(value, fallback = '') {
  const email = typeof value === 'string' ? value.trim().slice(0, 320) : '';
  const fallbackEmail = typeof fallback === 'string' ? fallback.trim().slice(0, 320) : '';
  return email || fallbackEmail || 'Codex user';
}

function cleanName(value, email) {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return name || (typeof email === 'string' ? email.split('@')[0].slice(0, 120) : '') || 'Codex Share user';
}

function poolDisplayName(email, fallback = '') {
  const local = typeof email === 'string' ? email.trim().split('@')[0].slice(0, 120) : '';
  return local || cleanName(fallback, email);
}

function upstreamIdentityKey(upstream) {
  if (upstream?.type === 'codex') {
    const accountId = String(upstream.accountId || '').trim().toLowerCase();
    const email = String(upstream.email || '').trim().toLowerCase();
    const identity = accountId && email ? `${accountId}:${email}` : accountId || email;
    return identity ? `codex:${identity}` : null;
  }
  if (upstream?.type === 'claude') {
    const accountId = String(upstream.accountId || '').trim().toLowerCase();
    const email = String(upstream.email || '').trim().toLowerCase();
    const identity = accountId && email ? `${accountId}:${email}` : accountId || email || upstream.name;
    return identity ? `claude:${identity}` : `claude:${upstream.id}`;
  }
  if (upstream?.quotaSource === 'ais' || upstream?.quotaSource === 'aiswitch') {
    const projectId = String(upstream.projectId || '').trim();
    return projectId ? `ais:${projectId}` : null;
  }
  return null;
}

function normalizeEncryptionKey(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error('Product store encryption key must be exactly 32 bytes');
  const key = Buffer.from(value);
  if (key.length !== 32) throw new Error('Product store encryption key must be exactly 32 bytes');
  return key;
}

function compareCanonicalUpstreams(left, right, productStore) {
  const leftActivity = productStore.upstreamActivity(left.upstream.id);
  const rightActivity = productStore.upstreamActivity(right.upstream.id);
  return rightActivity.activeSessions - leftActivity.activeSessions
    || rightActivity.activeOffers - leftActivity.activeOffers
    || rightActivity.activityCount - leftActivity.activityCount
    || Number(right.link.sharingStatus === 'active') - Number(left.link.sharingStatus === 'active')
    || String(right.link.createdAt).localeCompare(String(left.link.createdAt))
    || Number(right.link.linkOrder || 0) - Number(left.link.linkOrder || 0)
    || String(right.upstream.id).localeCompare(String(left.upstream.id));
}

function cleanUrl(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.toString().slice(0, 1000) : null;
  } catch {
    return null;
  }
}

function cleanCode(value) {
  if (value === null || value === undefined || value === '') return null;
  const code = String(value).replace(/\x1b\[[0-9;]*m/g, '').trim();
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(code) ? code : null;
}

function notFound() {
  return Object.assign(new Error('Not found'), { statusCode: 404 });
}

function forbidden() {
  return Object.assign(new Error('Forbidden'), { statusCode: 403 });
}
