import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const LOGIN_ATTEMPT_TTL_MS = 20 * 60 * 1_000;

export class ProductStore {
  constructor(dataDir = process.env.POOL_DATA_DIR || resolve(process.cwd(), 'pool/.data')) {
    this.dataDir = resolve(dataDir);
    this.dbPath = join(this.dataDir, 'pool.sqlite');
    this.keyPath = join(this.dataDir, '.pool-key');
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(this.dataDir, 0o700);
    this.key = this.loadKey();
    this.sqlite = new Database(this.dbPath);
    chmodSync(this.dbPath, 0o600);
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
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS account_upstreams (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        upstream_id TEXT NOT NULL UNIQUE,
        scope_id TEXT NOT NULL,
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sharing_tickets (
        id TEXT PRIMARY KEY,
        offer_id TEXT NOT NULL REFERENCES sharing_offers(id) ON DELETE CASCADE,
        provider_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        consumer_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        requested_micros INTEGER NOT NULL,
        approved_micros INTEGER,
        status TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS sharing_session_settlements (
        session_id TEXT NOT NULL REFERENCES sharing_sessions(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        settled_micros INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, attempt_id)
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
      CREATE INDEX IF NOT EXISTS sharing_tickets_provider_idx ON sharing_tickets(provider_account_id, status);
      CREATE INDEX IF NOT EXISTS sharing_tickets_consumer_idx ON sharing_tickets(consumer_account_id, status);
      CREATE INDEX IF NOT EXISTS sharing_sessions_provider_idx ON sharing_sessions(provider_account_id, status);
      CREATE INDEX IF NOT EXISTS sharing_sessions_consumer_idx ON sharing_sessions(consumer_account_id, status);
    `);
    this.migrateIdentitySchema();
  }

  migrateIdentitySchema() {
    const accountColumns = this.sqlite.pragma('table_info(accounts)');
    if (!accountColumns.some(({ name }) => name === 'codex_subject')) {
      this.sqlite.exec('ALTER TABLE accounts ADD COLUMN codex_subject TEXT');
    }
    this.sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_codex_subject_idx
      ON accounts(codex_subject)
      WHERE codex_subject IS NOT NULL
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
  }

  upsertCodexAccount({ subject, issuer = '', email = '', name = '' }, preferredAccountId = null, { allowIdentityRotation = false } = {}) {
    const codexSubject = codexIdentity(subject, issuer);
    if (!codexSubject) throw new Error('Codex identity is missing subject');
    const now = new Date().toISOString();
    const apply = this.sqlite.transaction(() => {
      const bySubject = this.sqlite.prepare('SELECT * FROM accounts WHERE codex_subject = ?').get(codexSubject);
      const preferred = preferredAccountId ? this.requireAccount(preferredAccountId) : null;
      if (bySubject && preferred && bySubject.id !== preferred.id) {
        throw Object.assign(new Error('Codex identity is already linked to another Codex Pool account'), { statusCode: 409 });
      }
      if (preferred?.codex_subject && preferred.codex_subject !== codexSubject && !allowIdentityRotation) {
        throw Object.assign(new Error('Codex account is already linked to another Codex Pool identity'), { statusCode: 409 });
      }
      const existing = preferred || bySubject;
      const normalizedEmail = cleanEmail(email, existing?.email);
      if (existing) {
        this.sqlite.prepare(`
          UPDATE accounts
          SET codex_subject = ?, email = ?, display_name = ?, updated_at = ?
          WHERE id = ?
        `).run(codexSubject, normalizedEmail, cleanName(name, normalizedEmail), now, existing.id);
        return existing.id;
      }
      const id = randomUUID();
      this.sqlite.prepare(`
        INSERT INTO accounts (id, google_sub, codex_subject, email, display_name, avatar_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(id, `codex:${hash(codexSubject)}`, codexSubject, normalizedEmail, cleanName(name, normalizedEmail), now, now);
      return id;
    });
    return this.account(apply());
  }

  createAccountSession(accountId) {
    this.requireAccount(accountId);
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    this.sqlite.prepare(`
      INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), accountId, hash(token), hash(csrfToken), now.toISOString(), expiresAt.toISOString());
    return { token, csrfToken, expiresAt: expiresAt.toISOString() };
  }

  authenticateAccountSession(token, csrfToken = null) {
    if (!token) return null;
    const row = this.sqlite.prepare(`
      SELECT account_sessions.*, accounts.email, accounts.display_name, accounts.avatar_url
      FROM account_sessions JOIN accounts ON accounts.id = account_sessions.account_id
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(hash(token), new Date().toISOString());
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
    this.requireAccount(accountId);
    const existing = this.sqlite.prepare('SELECT account_id FROM account_upstreams WHERE upstream_id = ?').get(upstreamId);
    if (existing && existing.account_id !== accountId) {
      throw Object.assign(new Error('Codex account is already linked to another Codex Pool account'), { statusCode: 409 });
    }
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO account_upstreams (account_id, upstream_id, scope_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(upstream_id) DO UPDATE SET scope_id = excluded.scope_id
    `).run(accountId, upstreamId, scopeId, now);
    this.event(accountId, 'upstream', upstreamId, 'linked', { scopeId });
    return { accountId, upstreamId, scopeId, createdAt: now };
  }

  accountOwnsUpstream(accountId, upstreamId) {
    return Boolean(this.sqlite.prepare('SELECT 1 FROM account_upstreams WHERE account_id = ? AND upstream_id = ?').get(accountId, upstreamId));
  }

  listAccountUpstreamLinks(accountId) {
    return this.sqlite.prepare('SELECT upstream_id AS upstreamId, scope_id AS scopeId, created_at AS createdAt FROM account_upstreams WHERE account_id = ? ORDER BY created_at')
      .all(accountId);
  }

  accountIdForUpstream(upstreamId) {
    return this.sqlite.prepare('SELECT account_id AS accountId FROM account_upstreams WHERE upstream_id = ?').get(upstreamId)?.accountId || null;
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

  createOffer(accountId, { upstreamId, quotaDollars }, upstreamStore) {
    const upstream = upstreamStore.get(upstreamId);
    if (!upstream || !this.accountOwnsUpstream(accountId, upstreamId)) throw notFound();
    requireProviderQuota(upstream);
    const quotaMicros = dollarsToMicros(quotaDollars);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO sharing_offers (id, provider_account_id, upstream_id, quota_micros, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(id, accountId, upstreamId, quotaMicros, now, now);
    this.event(accountId, 'offer', id, 'created', { quotaMicros });
    return this.offer(id, accountId, upstreamStore);
  }

  updateOffer(accountId, id, input, upstreamStore) {
    const row = this.requireOffer(id);
    if (row.provider_account_id !== accountId) throw forbidden();
    const status = input.status === undefined ? row.status : input.status;
    if (!['active', 'paused', 'closed'].includes(status)) throw new Error('status must be active, paused, or closed');
    if (status === 'active') {
      const upstream = upstreamStore.get(row.upstream_id);
      if (!upstream) throw notFound();
      requireProviderQuota(upstream);
    }
    const quotaMicros = input.quotaDollars === undefined ? row.quota_micros : dollarsToMicros(input.quotaDollars);
    const allocated = this.offerAllocatedMicros(id);
    if (quotaMicros < allocated) throw new Error('shareable quota cannot be below already allocated quota');
    const now = new Date().toISOString();
    this.sqlite.prepare('UPDATE sharing_offers SET quota_micros = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(quotaMicros, status, now, id);
    if (status === 'closed') {
      this.sqlite.prepare("UPDATE sharing_tickets SET status = 'rejected', resolved_at = ? WHERE offer_id = ? AND status = 'pending'").run(now, id);
    }
    this.event(accountId, 'offer', id, 'updated', { quotaMicros, status });
    return this.offer(id, accountId, upstreamStore);
  }

  listOffers(viewerAccountId, upstreamStore) {
    return this.sqlite.prepare(`
      SELECT sharing_offers.*, accounts.display_name AS provider_name, accounts.email AS provider_email
      FROM sharing_offers JOIN accounts ON accounts.id = sharing_offers.provider_account_id
      WHERE sharing_offers.status != 'closed'
      ORDER BY sharing_offers.created_at DESC
    `).all().flatMap((row) => {
      const upstream = upstreamStore.getPublic(row.upstream_id);
      return upstream ? [publicOffer(row, upstream, this.offerAllocatedMicros(row.id), viewerAccountId)] : [];
    });
  }

  offer(id, viewerAccountId, upstreamStore) {
    const row = this.sqlite.prepare(`
      SELECT sharing_offers.*, accounts.display_name AS provider_name, accounts.email AS provider_email
      FROM sharing_offers JOIN accounts ON accounts.id = sharing_offers.provider_account_id
      WHERE sharing_offers.id = ?
    `).get(id);
    if (!row) throw notFound();
    const upstream = upstreamStore.getPublic(row.upstream_id);
    if (!upstream) throw notFound();
    return publicOffer(row, upstream, this.offerAllocatedMicros(id), viewerAccountId);
  }

  createTicket(accountId, { offerId }, upstreamStore) {
    const offer = this.requireOffer(offerId);
    if (offer.status !== 'active') throw new Error('offer is not accepting tickets');
    const upstream = upstreamStore.get(offer.upstream_id);
    if (!upstream) throw notFound();
    requireProviderQuota(upstream);
    requireOfferUsable(offer, upstream);
    if (offer.provider_account_id === accountId) throw new Error('providers cannot request their own offer');
    this.requireAccount(accountId);
    const requestedMicros = Math.max(0, offer.quota_micros - this.offerAllocatedMicros(offer.id));
    if (!requestedMicros) throw new Error('offer has no shareable quota remaining');
    if (this.sqlite.prepare("SELECT 1 FROM sharing_tickets WHERE offer_id = ? AND consumer_account_id = ? AND status = 'pending'").get(offerId, accountId)) {
      throw new Error('a pending ticket already exists for this offer');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO sharing_tickets
      (id, offer_id, provider_account_id, consumer_account_id, requested_micros, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, offerId, offer.provider_account_id, accountId, requestedMicros, now);
    this.event(accountId, 'ticket', id, 'created', { requestedMicros });
    return this.ticket(id, accountId, upstreamStore);
  }

  listTickets(accountId, upstreamStore) {
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

  ticket(id, accountId, upstreamStore) {
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
    const row = this.requireTicket(id);
    if (row.consumer_account_id !== accountId) throw forbidden();
    if (row.status !== 'pending') throw new Error('only pending tickets can be cancelled');
    this.resolveTicket(row, 'cancelled');
    this.event(accountId, 'ticket', id, 'cancelled', {});
    return this.ticket(id, accountId, upstreamStore);
  }

  rejectTicket(accountId, id, upstreamStore) {
    const row = this.requireTicket(id);
    if (row.provider_account_id !== accountId) throw forbidden();
    if (row.status !== 'pending') throw new Error('only pending tickets can be rejected');
    this.resolveTicket(row, 'rejected');
    this.event(accountId, 'ticket', id, 'rejected', {});
    return this.ticket(id, accountId, upstreamStore);
  }

  approveTicket(accountId, id, { quotaDollars } = {}, upstreamStore) {
    const approve = this.sqlite.transaction(() => {
      const ticket = this.requireTicket(id);
      if (ticket.provider_account_id !== accountId) throw forbidden();
      if (ticket.status !== 'pending') throw new Error('only pending tickets can be approved');
      const offer = this.requireOffer(ticket.offer_id);
      if (offer.status !== 'active') throw new Error('offer is not active');
      const upstream = upstreamStore.get(offer.upstream_id);
      if (!upstream || !this.accountOwnsUpstream(accountId, offer.upstream_id)) throw notFound();
      requireProviderQuota(upstream);
      requireOfferUsable(offer, upstream);
      const approvedMicros = quotaDollars === undefined ? ticket.requested_micros : dollarsToMicros(quotaDollars);
      const available = Math.max(0, offer.quota_micros - this.offerAllocatedMicros(offer.id));
      if (approvedMicros > available) throw new Error('approved quota exceeds available shareable quota');
      const sessionId = randomUUID();
      const keyId = randomUUID();
      const apiKey = `cp_share_${randomToken(32)}`;
      const now = new Date().toISOString();
      this.sqlite.prepare("UPDATE sharing_tickets SET approved_micros = ?, status = 'approved', resolved_at = ? WHERE id = ?")
        .run(approvedMicros, now, id);
      this.sqlite.prepare("UPDATE sharing_offers SET status = 'closed', updated_at = ? WHERE id = ?")
        .run(now, offer.id);
      this.sqlite.prepare("UPDATE sharing_tickets SET status = 'rejected', resolved_at = ? WHERE offer_id = ? AND id != ? AND status = 'pending'")
        .run(now, offer.id, id);
      this.sqlite.prepare(`
        INSERT INTO sharing_sessions
        (id, offer_id, ticket_id, provider_account_id, consumer_account_id, upstream_id, scope_id,
         granted_micros, consumed_micros, status, pending_key_cipher, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)
      `).run(
        sessionId, offer.id, ticket.id, ticket.provider_account_id, ticket.consumer_account_id,
        offer.upstream_id, upstream.scopeId || 'default', approvedMicros, encrypt(apiKey, this.key), now, now
      );
      this.sqlite.prepare(`
        INSERT INTO sharing_session_keys (id, session_id, key_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(keyId, sessionId, hash(apiKey), now);
      this.event(accountId, 'ticket', id, 'approved', { approvedMicros, sessionId });
      return sessionId;
    });
    const sessionId = approve();
    return this.session(sessionId, accountId, upstreamStore);
  }

  listSessions(accountId, upstreamStore) {
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
    `).all(accountId, accountId).map((row) => publicShareSession(row, accountId, upstreamStore.getPublic(row.upstream_id)));
  }

  session(id, accountId, upstreamStore) {
    const row = this.sessionRow(id);
    if (![row.provider_account_id, row.consumer_account_id].includes(accountId)) throw notFound();
    return publicShareSession(row, accountId, upstreamStore.getPublic(row.upstream_id));
  }

  updateSession(accountId, id, input, upstreamStore) {
    const update = this.sqlite.transaction(() => {
      const row = this.sessionRow(id);
      if (row.provider_account_id !== accountId) throw forbidden();
      if (row.status === 'revoked') throw new Error('revoked sessions cannot be changed');
      let grantedMicros = row.granted_micros;
      if (input.quotaDollars !== undefined) {
        grantedMicros = dollarsToMicros(input.quotaDollars);
        if (grantedMicros < row.consumed_micros) throw new Error('quota cannot be below already consumed usage');
        const upstream = upstreamStore.get(row.upstream_id);
        if (!upstream || !this.accountOwnsUpstream(accountId, row.upstream_id)) throw notFound();
        requireProviderQuota(upstream);
        const allocatedWithoutSession = this.upstreamAllocatedMicros(row.upstream_id, row.id);
        if (offerExceedsProviderQuota(allocatedWithoutSession + grantedMicros, upstream)) {
          throw new Error('session quota exceeds the provider’s actual remaining quota');
        }
      }
      let status = input.status === undefined ? row.status : input.status;
      if (status === 'exhausted' && input.status === undefined && grantedMicros > row.consumed_micros) status = 'active';
      if (!['active', 'paused', 'exhausted'].includes(status) || input.status === 'exhausted') throw new Error('status must be active or paused');
      if (grantedMicros <= row.consumed_micros) status = 'exhausted';
      const now = new Date().toISOString();
      this.sqlite.prepare('UPDATE sharing_sessions SET granted_micros = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(grantedMicros, status, now, id);
      this.event(accountId, 'session', id, 'updated', { grantedMicros, status });
    });
    update();
    return this.session(id, accountId, upstreamStore);
  }

  revokeSession(accountId, id, upstreamStore) {
    const row = this.sessionRow(id);
    if (![row.provider_account_id, row.consumer_account_id].includes(accountId)) throw forbidden();
    if (row.status !== 'revoked') {
      const now = new Date().toISOString();
      this.sqlite.transaction(() => {
        this.sqlite.prepare("UPDATE sharing_sessions SET status = 'revoked', pending_key_cipher = NULL, updated_at = ? WHERE id = ?").run(now, id);
        this.sqlite.prepare('UPDATE sharing_session_keys SET disabled_at = ? WHERE session_id = ? AND disabled_at IS NULL').run(now, id);
        this.event(accountId, 'session', id, 'revoked', {});
      })();
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
    return { apiKey: rotate() };
  }

  authenticateShareKey(key) {
    if (typeof key !== 'string' || !key.startsWith('cp_share_')) return null;
    const row = this.sqlite.prepare(`
      SELECT sharing_session_keys.id AS key_id, sharing_sessions.*
      FROM sharing_session_keys
      JOIN sharing_sessions ON sharing_sessions.id = sharing_session_keys.session_id
      WHERE sharing_session_keys.key_hash = ? AND sharing_session_keys.disabled_at IS NULL
    `).get(hash(key));
    if (!row || row.status === 'revoked') return null;
    return {
      id: row.key_id,
      kind: 'share_session',
      shareSessionId: row.id,
      scopeId: row.scope_id,
      upstreamId: row.upstream_id,
      accountId: row.consumer_account_id,
      sessionStatus: row.status,
      remainingMicros: Math.max(0, row.granted_micros - row.consumed_micros)
    };
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

  shareSessionAccess(sessionId) {
    const row = this.sqlite.prepare(`
      SELECT id, status, granted_micros, consumed_micros, upstream_id, scope_id
      FROM sharing_sessions
      WHERE id = ?
    `).get(sessionId);
    if (!row) return null;
    return {
      shareSessionId: row.id,
      sessionStatus: row.status,
      remainingMicros: Math.max(0, row.granted_micros - row.consumed_micros),
      upstreamId: row.upstream_id,
      scopeId: row.scope_id
    };
  }

  settleSession(sessionId, attemptId, settledMicros) {
    if (!sessionId || !attemptId || !Number.isSafeInteger(settledMicros) || settledMicros < 0) return null;
    const settle = this.sqlite.transaction(() => {
      const row = this.sessionRow(sessionId);
      const inserted = this.sqlite.prepare(`
        INSERT OR IGNORE INTO sharing_session_settlements (session_id, attempt_id, settled_micros, created_at)
        VALUES (?, ?, ?, ?)
      `).run(sessionId, attemptId, settledMicros, new Date().toISOString());
      if (!inserted.changes) return row;
      const consumedMicros = row.consumed_micros + settledMicros;
      const status = row.status === 'revoked' ? 'revoked'
        : consumedMicros >= row.granted_micros ? 'exhausted'
          : row.status;
      this.sqlite.prepare('UPDATE sharing_sessions SET consumed_micros = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(consumedMicros, status, new Date().toISOString(), sessionId);
      return this.sessionRow(sessionId);
    });
    return publicShareSession(settle(), null, null);
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

  upstreamAllocatedMicros(upstreamId, excludingSessionId = null) {
    const rows = this.sqlite.prepare('SELECT id, granted_micros, consumed_micros, status FROM sharing_sessions WHERE upstream_id = ?').all(upstreamId);
    return allocationTotal(rows, excludingSessionId);
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
      if (key.length !== 32) throw new Error('Stored Codex Pool key is invalid');
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

function publicOffer(row, upstream, allocatedMicros, viewerAccountId) {
  const quotaMicros = row.quota_micros;
  const unusable = offerExceedsProviderQuota(quotaMicros, upstream);
  return {
    id: row.id,
    provider: {
      id: row.provider_account_id,
      displayName: poolDisplayName(row.provider_email || upstream?.email, row.provider_name),
      email: row.provider_email || upstream?.email || null
    },
    upstream: upstream ? {
      id: upstream.id,
      name: upstream.name,
      type: upstream.type,
      quota: upstream.quota,
      quotaSource: upstream.quotaSource
    } : null,
    quotaDollars: microsToDollars(quotaMicros),
    allocatedDollars: microsToDollars(allocatedMicros),
    availableDollars: microsToDollars(Math.max(0, quotaMicros - allocatedMicros)),
    status: row.status,
    isUsable: !unusable,
    unusableReason: unusable ? 'The provider has less actual quota than this offer.' : null,
    isProvider: viewerAccountId === row.provider_account_id,
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
    upstream: upstream ? { id: upstream.id, name: upstream.name, type: upstream.type } : null,
    requestedQuotaDollars: microsToDollars(row.requested_micros),
    approvedQuotaDollars: row.approved_micros === null ? null : microsToDollars(row.approved_micros),
    status: row.status,
    direction: viewerAccountId === row.provider_account_id ? 'received' : 'sent',
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null
  };
}

function publicShareSession(row, viewerAccountId, upstream) {
  const remainingMicros = Math.max(0, row.granted_micros - row.consumed_micros);
  const isProvider = viewerAccountId === row.provider_account_id;
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
    upstream: upstream ? { id: upstream.id, name: upstream.name, type: upstream.type } : { id: row.upstream_id },
    grantedQuotaDollars: microsToDollars(row.granted_micros),
    consumedQuotaDollars: microsToDollars(row.consumed_micros),
    remainingQuotaDollars: microsToDollars(remainingMicros),
    status: row.status,
    canRevealKey: [row.provider_account_id, row.consumer_account_id].includes(viewerAccountId) && Boolean(row.pending_key_cipher) && row.status !== 'revoked',
    canRotateKey: isProvider && row.status !== 'revoked',
    role: isProvider ? 'provider' : viewerAccountId === row.consumer_account_id ? 'consumer' : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function dollarsToMicros(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Error('quotaDollars must be greater than zero');
  const micros = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new Error('quotaDollars is invalid');
  return micros;
}

function requireProviderQuota(upstream) {
  if (!providerQuotaExhausted(upstream)) return;
  throw new Error('provider quota is exhausted and cannot be shared until it resets');
}

function requireOfferUsable(offer, upstream) {
  if (!offerExceedsProviderQuota(offer.quota_micros, upstream)) return;
  throw new Error('offer exceeds the provider’s actual remaining quota and cannot be requested');
}

function offerExceedsProviderQuota(quotaMicros, upstream) {
  const remainingDollars = Number(upstream?.quota?.remainingDollars);
  return Number.isFinite(remainingDollars) && quotaMicros > Math.round(Math.max(0, remainingDollars) * 1_000_000);
}

function providerQuotaExhausted(upstream) {
  const quota = upstream?.quota;
  if (!quota || typeof quota !== 'object') return false;
  const remainingPercent = Number(quota.remainingPercent);
  if (Number.isFinite(remainingPercent)) return remainingPercent <= 0;
  const remainingDollars = Number(quota.remainingDollars);
  if (Number.isFinite(remainingDollars)) return remainingDollars <= 0;
  const remainingUnits = Number(quota.remainingUnits);
  return Number.isFinite(remainingUnits) && remainingUnits <= 0;
}

function microsToDollars(value) {
  return Math.max(0, Number(value) || 0) / 1_000_000;
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
  return email || fallback || 'Codex user';
}

function cleanName(value, email) {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return name || String(email).split('@')[0].slice(0, 120) || 'Codex Pool user';
}

function poolDisplayName(email, fallback = '') {
  const local = typeof email === 'string' ? email.trim().split('@')[0].slice(0, 120) : '';
  return local || cleanName(fallback, email);
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
