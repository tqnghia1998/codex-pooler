import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function account(store, sub, email) {
  return store.upsertCodexAccount({ subject: sub, issuer: 'https://auth.openai.com', email, name: email.split('@')[0] });
}

test('migrates legacy Google-era sharing data and lets Codex claim the existing owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-migration-'));
  try {
    const dbPath = join(dir, 'pool.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        google_sub TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE account_upstreams (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        upstream_id TEXT NOT NULL UNIQUE,
        scope_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, upstream_id)
      );
      CREATE TABLE codex_login_attempts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        verification_url TEXT,
        user_code TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE sharing_offers (
        id TEXT PRIMARY KEY,
        provider_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        upstream_id TEXT NOT NULL,
        quota_micros INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    legacy.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, NULL, ?, ?)').run(
      'legacy-account', 'google-sub', 'legacy@example.com', 'Legacy User', now, now
    );
    legacy.prepare('INSERT INTO account_upstreams VALUES (?, ?, ?, ?)').run('legacy-account', 'upstream-legacy', 'default', now);
    legacy.prepare('INSERT INTO sharing_offers VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'legacy-offer', 'legacy-account', 'upstream-legacy', 10_000_000, 'active', now, now
    );
    legacy.close();

    const sharingStore = new ProductStore(dir);
    const claimed = sharingStore.upsertCodexAccount({
      subject: 'legacy-codex-subject',
      issuer: 'https://auth.openai.com',
      email: 'updated@example.com',
      name: 'Updated User'
    }, 'legacy-account');

    assert.equal(claimed.id, 'legacy-account');
    assert.equal(sharingStore.accountIdForUpstream('upstream-legacy'), 'legacy-account');
    assert.equal(sharingStore.sqlite.prepare('SELECT provider_account_id FROM sharing_offers WHERE id = ?').get('legacy-offer').provider_account_id, 'legacy-account');
    const attemptColumns = sharingStore.sqlite.pragma('table_info(codex_login_attempts)');
    assert.equal(attemptColumns.find(({ name }) => name === 'account_id').notnull, 0);
    assert.ok(attemptColumns.some(({ name }) => name === 'attempt_token_hash'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps product data in pool.sqlite without changing the private gateway database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-store-isolation-'));
  try {
    const upstreamStore = new Store(dir);
    const upstream = upstreamStore.create({ type: 'compass', projectId: 'isolated', projectKey: 'secret' });
    const before = digest(upstreamStore.dbPath);
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'provider', 'provider@example.com');
    sharingStore.linkUpstream(provider.id, upstream.id);
    sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 20 }, upstreamStore);
    assert.equal(digest(upstreamStore.dbPath), before);
    assert.notEqual(sharingStore.dbPath, upstreamStore.dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new Codex Share accounts receive one default personal key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-default-personal-key-'));
  try {
    const sharingStore = new ProductStore(dir);
    const user = account(sharingStore, 'default-key-user', 'default-key@example.com');

    let keys = sharingStore.listPersonalKeys(user.id);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].name, 'Default');
    assert.equal(keys[0].status, 'active');

    sharingStore.upsertCodexAccount({
      subject: 'default-key-user',
      issuer: 'https://auth.openai.com',
      email: 'default-key@example.com',
      name: 'default-key'
    });
    keys = sharingStore.listPersonalKeys(user.id);
    assert.equal(keys.length, 1);
    assert.match(sharingStore.revealPersonalKey(user.id).apiKey, /^cp_personal_/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not transfer a linked upstream between product accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-ownership-'));
  try {
    const sharingStore = new ProductStore(dir);
    const first = account(sharingStore, 'first-owner', 'first@example.com');
    const second = account(sharingStore, 'second-owner', 'second@example.com');
    sharingStore.linkUpstream(first.id, 'upstream-1');

    assert.throws(
      () => sharingStore.linkUpstream(second.id, 'upstream-1'),
      (error) => error.statusCode === 409 && /already linked/.test(error.message)
    );
    assert.equal(sharingStore.listAccountUpstreamLinks(first.id)[0].upstreamId, 'upstream-1');
    assert.deepEqual(sharingStore.listAccountUpstreamLinks(second.id), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shows provider availability issues on offers, tickets, and share sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-provider-issues-'));
  try {
    const upstreamStore = new Store(dir);
    const upstream = upstreamStore.create({ type: 'codex', accessToken: 'provider-access-token' });
    upstreamStore.setCap(upstream.id, { capDollars: 100 });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'issue-provider', 'issue-provider@example.com');
    const consumer = account(sharingStore, 'issue-consumer', 'issue-consumer@example.com');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 5 }, upstreamStore);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id }, upstreamStore);
    const session = sharingStore.approveTicket(provider.id, ticket.id, {}, upstreamStore);
    const nextOffer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 1 }, upstreamStore);
    const pendingTicket = sharingStore.createTicket(consumer.id, { offerId: nextOffer.id }, upstreamStore);

    upstreamStore.setTokenRefresh(upstream.id, {
      status: 'reauth_required',
      trigger: 'runtime',
      errorCode: 'reauth_required',
      finishedAt: new Date().toISOString()
    });

    const visibleOffer = sharingStore.listOffers(consumer.id, upstreamStore)[0];
    assert.equal(visibleOffer.id, nextOffer.id);
    assert.equal(visibleOffer.upstream.providerIssue.code, 'provider_reauth_required');
    assert.equal(visibleOffer.isUsable, false);
    assert.equal(sharingStore.ticket(pendingTicket.id, provider.id, upstreamStore).upstream.providerIssue.code, 'provider_reauth_required');
    assert.equal(sharingStore.ticket(pendingTicket.id, consumer.id, upstreamStore).upstream.providerIssue.code, 'provider_reauth_required');
    assert.equal(sharingStore.session(session.id, provider.id, upstreamStore).providerIssue.code, 'provider_reauth_required');
    assert.equal(sharingStore.session(session.id, consumer.id, upstreamStore).providerIssue.code, 'provider_reauth_required');
    const { apiKey } = sharingStore.revealPersonalKey(consumer.id);
    const personalKey = sharingStore.personalKey(consumer.id, upstreamStore);
    assert.equal(personalKey.activeSessionCount, 0);
    assert.equal(personalKey.remainingQuotaDollars, 0);
    assert.equal(sharingStore.authenticateShareKey(apiKey, upstreamStore).activeSessionCount, 0);
    assert.deepEqual(sharingStore.personalShareSessionCandidates(sharingStore.authenticateShareKey(apiKey, upstreamStore).personalKeyId, {}, upstreamStore), []);
    assert.throws(
      () => sharingStore.createTicket(consumer.id, { offerId: nextOffer.id }, upstreamStore),
      /sign in with Codex again/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approves tickets atomically and enforces session capacity with repeatable key reveal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-flow-'));
  try {
    const upstreamStore = new Store(dir);
    const upstream = upstreamStore.create({ type: 'compass', projectId: 'shared', projectKey: 'secret' });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'provider', 'provider@example.com');
    const first = account(sharingStore, 'first', 'first@example.com');
    const second = account(sharingStore, 'second', 'second@example.com');
    sharingStore.linkUpstream(provider.id, upstream.id);
    upstreamStore.setQuota(upstream.id, { remainingDollars: 20, remainingPercent: 100, observedAt: new Date().toISOString() });
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 10 }, upstreamStore);
    const firstTicket = sharingStore.createTicket(first.id, { offerId: offer.id, quotaDollars: 7 }, upstreamStore);
    const secondTicket = sharingStore.createTicket(second.id, { offerId: offer.id, quotaDollars: 7 }, upstreamStore);

    const session = sharingStore.approveTicket(provider.id, firstTicket.id, { quotaDollars: 6 }, upstreamStore);
    assert.equal(session.grantedQuotaDollars, 6);
    assert.equal(session.consumer.email, 'first@example.com');
    assert.equal(sharingStore.offer(offer.id, provider.id, upstreamStore).status, 'closed');
    assert.equal(sharingStore.listOffers(second.id, upstreamStore)[0].status, 'closed');
    assert.equal(sharingStore.listOffers(second.id, upstreamStore)[0].isUsable, false);
    assert.equal(sharingStore.ticket(secondTicket.id, second.id, upstreamStore).status, 'rejected');
    assert.throws(
      () => sharingStore.approveTicket(provider.id, secondTicket.id, { quotaDollars: 5 }, upstreamStore),
      /only pending tickets/
    );

    const revealed = sharingStore.revealSessionKey(provider.id, session.id);
    assert.match(revealed.apiKey, /^cp_share_/);
    assert.equal(sharingStore.authenticateShareKey(revealed.apiKey).upstreamId, upstream.id);
    assert.equal(sharingStore.revealSessionKey(first.id, session.id).apiKey, revealed.apiKey);
    const replacement = sharingStore.rotateSessionKey(provider.id, session.id);
    assert.match(replacement.apiKey, /^cp_share_/);
    assert.equal(sharingStore.authenticateShareKey(revealed.apiKey), null);
    assert.equal(sharingStore.authenticateShareKey(replacement.apiKey).upstreamId, upstream.id);
    assert.equal(sharingStore.revealSessionKey(first.id, session.id).apiKey, replacement.apiKey);

    sharingStore.settleSession(session.id, 'attempt-1', 2_000_000);
    sharingStore.settleSession(session.id, 'attempt-1', 2_000_000);
    assert.equal(sharingStore.session(session.id, first.id, upstreamStore).consumedQuotaDollars, 2);
    sharingStore.updateSession(provider.id, session.id, { quotaDollars: 2 }, upstreamStore);
    assert.equal(sharingStore.session(session.id, first.id, upstreamStore).status, 'exhausted');
    sharingStore.updateSession(provider.id, session.id, { additionalQuotaDollars: 2 }, upstreamStore);
    assert.equal(sharingStore.session(session.id, first.id, upstreamStore).remainingQuotaDollars, 2);
    assert.equal(sharingStore.session(session.id, first.id, upstreamStore).status, 'active');
    sharingStore.updateSession(provider.id, session.id, { quotaDollars: 11 }, upstreamStore);
    assert.equal(sharingStore.session(session.id, first.id, upstreamStore).grantedQuotaDollars, 11);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('creates one personal key that selects active consumer sessions and preserves routes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-personal-key-'));
  try {
    const upstreamStore = new Store(dir);
    const firstUpstream = upstreamStore.create({ type: 'compass', projectId: 'personal-first', projectKey: 'secret' });
    const secondUpstream = upstreamStore.create({ type: 'compass', projectId: 'personal-second', projectKey: 'secret' });
    const sharingStore = new ProductStore(dir);
    const firstProvider = account(sharingStore, 'personal-first-provider', 'personal-first@example.com');
    const secondProvider = account(sharingStore, 'personal-second-provider', 'personal-second@example.com');
    const consumer = account(sharingStore, 'personal-consumer', 'personal-consumer@example.com');
    sharingStore.linkUpstream(firstProvider.id, firstUpstream.id);
    sharingStore.linkUpstream(secondProvider.id, secondUpstream.id);
    const firstOffer = sharingStore.createOffer(firstProvider.id, { upstreamId: firstUpstream.id, quotaDollars: 4 }, upstreamStore);
    const secondOffer = sharingStore.createOffer(secondProvider.id, { upstreamId: secondUpstream.id, quotaDollars: 6 }, upstreamStore);
    const firstTicket = sharingStore.createTicket(consumer.id, { offerId: firstOffer.id }, upstreamStore);
    const secondTicket = sharingStore.createTicket(consumer.id, { offerId: secondOffer.id }, upstreamStore);
    const firstSession = sharingStore.approveTicket(firstProvider.id, firstTicket.id, {}, upstreamStore);
    const secondSession = sharingStore.approveTicket(secondProvider.id, secondTicket.id, {}, upstreamStore);

    assert.equal(sharingStore.personalKey(consumer.id).hasKey, true);
    const { apiKey } = sharingStore.revealPersonalKey(consumer.id);
    assert.match(apiKey, /^cp_personal_/);
    assert.equal(sharingStore.revealPersonalKey(consumer.id).apiKey, apiKey);
    const access = sharingStore.authenticateShareKey(apiKey);
    assert.equal(access.kind, 'personal_share');
    assert.equal(access.activeSessionCount, 2);

    const candidates = sharingStore.personalShareSessionCandidates(access.personalKeyId);
    assert.deepEqual(candidates.map(({ shareSessionId }) => shareSessionId), [secondSession.id, firstSession.id]);
    const selected = sharingStore.selectPersonalShareSession(access.personalKeyId, secondSession.id, { affinityId: 'window-1' });
    assert.equal(selected.shareSessionId, secondSession.id);
    assert.equal(sharingStore.personalShareSessionCandidates(access.personalKeyId, { sessionId: 'window-1' })[0].shareSessionId, secondSession.id);
    sharingStore.pinPersonalResponse(access.personalKeyId, 'resp-personal', secondSession.id);
    assert.equal(sharingStore.personalShareSessionCandidates(access.personalKeyId, { responseId: 'resp-personal' })[0].shareSessionId, secondSession.id);

    const replacement = sharingStore.rotatePersonalKey(consumer.id);
    assert.match(replacement.apiKey, /^cp_personal_/);
    assert.equal(sharingStore.authenticateShareKey(apiKey), null);
    assert.equal(sharingStore.authenticateShareKey(replacement.apiKey).kind, 'personal_share');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provider can extend a session expiry without exceeding the provider quota reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-session-expiry-'));
  try {
    const upstreamStore = new Store(dir);
    const upstream = upstreamStore.create({ type: 'compass', projectId: 'session-expiry', projectKey: 'secret' });
    const resetAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000).toISOString();
    upstreamStore.setQuota(upstream.id, { remainingDollars: 20, remainingPercent: 100, resetAt, observedAt: new Date().toISOString() });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'expiry-provider', 'expiry-provider@example.com');
    const consumer = account(sharingStore, 'expiry-consumer', 'expiry-consumer@example.com');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 5 }, upstreamStore);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id }, upstreamStore);
    const session = sharingStore.approveTicket(provider.id, ticket.id, {}, upstreamStore);

    const extended = sharingStore.updateSession(provider.id, session.id, {
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1_000).toISOString()
    }, upstreamStore);
    assert.ok(Date.parse(extended.expiresAt) > Date.parse(session.expiresAt));
    assert.equal(extended.expiresAt, resetAt);
    assert.throws(
      () => sharingStore.updateSession(provider.id, session.id, {
        expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1_000).toISOString()
      }, upstreamStore),
      /can only be extended/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not publish or approve sharing offers when the provider quota is known to be exhausted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-exhausted-provider-'));
  try {
    const upstreamStore = new Store(dir);
    const exhausted = upstreamStore.create({ type: 'compass', projectId: 'exhausted', projectKey: 'secret' });
    const available = upstreamStore.create({ type: 'compass', projectId: 'available', projectKey: 'secret' });
    upstreamStore.setQuota(exhausted.id, { remainingPercent: 0, observedAt: new Date().toISOString() });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'provider', 'provider@example.com');
    const consumer = account(sharingStore, 'consumer', 'consumer@example.com');
    sharingStore.linkUpstream(provider.id, exhausted.id);
    sharingStore.linkUpstream(provider.id, available.id);

    assert.throws(
      () => sharingStore.createOffer(provider.id, { upstreamId: exhausted.id, quotaDollars: 10 }, upstreamStore),
      /provider quota is exhausted/
    );

    const offer = sharingStore.createOffer(provider.id, { upstreamId: available.id, quotaDollars: 10 }, upstreamStore);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id, quotaDollars: 5 }, upstreamStore);
    upstreamStore.setQuota(available.id, { remainingPercent: 0, observedAt: new Date().toISOString() });

    assert.throws(
      () => sharingStore.createTicket(consumer.id, { offerId: offer.id, quotaDollars: 1 }, upstreamStore),
      /provider quota is exhausted/
    );
    assert.throws(
      () => sharingStore.approveTicket(provider.id, ticket.id, { quotaDollars: 5 }, upstreamStore),
      /provider quota is exhausted/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('treats percentage-only provider quota as unknown dollars instead of zero dollars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-percentage-quota-'));
  try {
    const upstreamStore = new Store(dir);
    const upstream = upstreamStore.create({ type: 'compass', projectId: 'percentage-only', projectKey: 'secret' });
    upstreamStore.setQuota(upstream.id, {
      remainingDollars: null,
      remainingPercent: 75,
      observedAt: new Date().toISOString()
    });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'provider', 'provider@example.com');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 10 }, upstreamStore);
    const commitment = sharingStore.providerSummary(provider.id, upstream.id, upstreamStore).commitment;

    assert.equal(commitment.actualQuotaDollars, null);
    assert.equal(commitment.offerableQuotaDollars, null);
    assert.equal(commitment.underfundedQuotaDollars, 0);
    assert.equal(sharingStore.offer(offer.id, provider.id, upstreamStore).isUnderfunded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects an offer when its dollar grant exceeds provider quota', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-insufficient-provider-'));
  try {
    const upstreamStore = new Store(dir);
    const upstream = upstreamStore.create({ type: 'compass', projectId: 'limited', projectKey: 'secret' });
    upstreamStore.setQuota(upstream.id, { remainingDollars: 5, remainingPercent: 50, observedAt: new Date().toISOString() });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'provider', 'provider@example.com');
    sharingStore.linkUpstream(provider.id, upstream.id);
    assert.throws(
      () => sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 10 }, upstreamStore),
      /truly offerable quota/
    );
    assert.equal(sharingStore.listOffers(provider.id, upstreamStore).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('creates a ticket for an offer’s full currently available quota', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-ticket-available-quota-'));
  try {
    const upstreamStore = new Store(dir);
    const upstream = upstreamStore.create({ type: 'compass', projectId: 'ticket-available', projectKey: 'secret' });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'provider', 'provider@example.com');
    const consumer = account(sharingStore, 'consumer', 'consumer@example.com');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 10 }, upstreamStore);

    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id, quotaDollars: 1 }, upstreamStore);

    assert.equal(ticket.requestedQuotaDollars, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publishes the complete Codex email username as the Pool display name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-display-name-'));
  try {
    const sharingStore = new ProductStore(dir);
    const user = sharingStore.upsertCodexAccount({
      subject: 'vincent-subject',
      issuer: 'https://auth.openai.com',
      email: 'vincent.halim@example.com',
      name: 'v1nc3nt.h4l1m'
    });

    assert.equal(user.displayName, 'vincent.halim');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps account sessions permanent, including sessions with an old expiry value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-permanent-session-'));
  try {
    const sharingStore = new ProductStore(dir);
    const user = account(sharingStore, 'permanent-session', 'permanent@example.com');
    const session = sharingStore.createAccountSession(user.id);
    sharingStore.sqlite.prepare('UPDATE account_sessions SET expires_at = ? WHERE token_hash = ?')
      .run('2020-01-01T00:00:00.000Z', createHash('sha256').update(session.token).digest('hex'));

    assert.equal(sharingStore.authenticateAccountSession(session.token).account.id, user.id);
    assert.equal(sharingStore.cleanup(new Date('2026-09-01T00:00:00.000Z')).loginAttempts, 0);
    assert.equal(sharingStore.sqlite.prepare('SELECT COUNT(*) AS count FROM account_sessions').get().count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleans stale product records while retaining current records and account sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-retention-'));
  try {
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'retention-provider', 'retention-provider@example.com');
    const consumer = account(sharingStore, 'retention-consumer', 'retention-consumer@example.com');
    const permanentSession = sharingStore.createAccountSession(provider.id);
    const revokedSession = sharingStore.createAccountSession(consumer.id);
    const now = new Date('2026-09-01T00:00:00.000Z');
    const old = new Date(now.getTime() - 181 * 24 * 60 * 60 * 1_000).toISOString();
    const oldLoginExpiry = new Date(now.getTime() - 25 * 60 * 60 * 1_000).toISOString();
    const recent = new Date(now.getTime() - 60 * 60 * 1_000).toISOString();

    sharingStore.sqlite.prepare('UPDATE account_sessions SET revoked_at = ? WHERE token_hash = ?')
      .run(old, createHash('sha256').update(revokedSession.token).digest('hex'));

    sharingStore.sqlite.prepare(`
      INSERT INTO codex_login_attempts
        (id, account_id, attempt_token_hash, status, created_at, updated_at, expires_at)
      VALUES ('old-login', ?, 'old-login-hash', 'failed', ?, ?, ?)
    `).run(provider.id, old, old, oldLoginExpiry);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_offers
        (id, provider_account_id, upstream_id, quota_micros, status, created_at, updated_at)
      VALUES ('old-offer', ?, 'old-upstream', 10000000, 'closed', ?, ?)
    `).run(provider.id, old, old);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_tickets
        (id, offer_id, provider_account_id, consumer_account_id, requested_micros, status, created_at, resolved_at)
      VALUES ('old-ticket', 'old-offer', ?, ?, 10000000, 'rejected', ?, ?)
    `).run(provider.id, consumer.id, old, old);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_sessions
        (id, offer_id, ticket_id, provider_account_id, consumer_account_id, upstream_id, scope_id,
         granted_micros, consumed_micros, status, created_at, updated_at)
      VALUES ('old-session', 'old-offer', 'old-ticket', ?, ?, 'old-upstream', 'default', 10000000, 10000000, 'revoked', ?, ?)
    `).run(provider.id, consumer.id, old, old);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_session_keys
        (id, session_id, key_hash, created_at, disabled_at)
      VALUES ('old-session-key', 'old-session', 'old-session-key-hash', ?, ?)
    `).run(old, old);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_session_settlements (session_id, attempt_id, settled_micros, created_at)
      VALUES ('old-session', 'old-attempt', 1000000, ?)
    `).run(old);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_reservations
        (id, session_id, reserved_micros, status, created_at, expires_at, settled_at)
      VALUES ('old-attempt', 'old-session', 1000000, 'settled', ?, ?, ?)
    `).run(old, old, old);
    sharingStore.sqlite.prepare(`
      INSERT INTO personal_api_keys
        (id, account_id, name, key_hash, key_cipher, last_session_id, created_at, updated_at)
      VALUES ('retention-key', ?, 'Retention', 'retention-key-hash', 'cipher', 'old-session', ?, ?)
    `).run(consumer.id, old, old);
    sharingStore.sqlite.prepare(`
      INSERT INTO personal_api_key_routes (key_id, route_key, session_id, updated_at)
      VALUES ('retention-key', 'session:old', 'old-session', ?)
    `).run(old);
    sharingStore.sqlite.prepare(`
      INSERT INTO email_outbox
        (id, account_id, recipient, subject, body_text, status, attempt_count, next_attempt_at, created_at, sent_at)
      VALUES ('old-email', ?, 'retention@example.com', 'Old', 'Old', 'sent', 0, ?, ?, ?)
    `).run(provider.id, old, old, old);
    sharingStore.sqlite.prepare(`
      INSERT INTO quota_requests
        (id, account_id, quota_micros, status, created_at, updated_at)
      VALUES ('old-quota-request', ?, 10000000, 'cancelled', ?, ?)
    `).run(consumer.id, old, old);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_events
        (id, actor_account_id, entity_type, entity_id, action, detail_json, created_at)
      VALUES ('old-event', ?, 'offer', 'old-offer', 'created', '{}', ?)
    `).run(provider.id, old);
    sharingStore.sqlite.prepare('INSERT INTO sharing_activity (subject_type, subject_id) VALUES (?, ?)')
      .run('session', 'old-session');
    sharingStore.sqlite.prepare('INSERT INTO sharing_activity (subject_type, subject_id) VALUES (?, ?)')
      .run('personal_key', 'missing-key');
    sharingStore.sqlite.prepare(`
      INSERT INTO provider_observations (upstream_id, issue_code, observed_at)
      VALUES ('old-upstream', 'provider_unavailable', ?)
    `).run(old);

    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_offers
        (id, provider_account_id, upstream_id, quota_micros, status, created_at, updated_at)
      VALUES ('recent-offer', ?, 'recent-upstream', 10000000, 'active', ?, ?)
    `).run(provider.id, recent, recent);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_tickets
        (id, offer_id, provider_account_id, consumer_account_id, requested_micros, status, created_at)
      VALUES ('recent-ticket', 'recent-offer', ?, ?, 10000000, 'pending', ?)
    `).run(provider.id, consumer.id, recent);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_sessions
        (id, offer_id, ticket_id, provider_account_id, consumer_account_id, upstream_id, scope_id,
         granted_micros, consumed_micros, status, created_at, updated_at)
      VALUES ('recent-session', 'recent-offer', 'recent-ticket', ?, ?, 'recent-upstream', 'default', 10000000, 0, 'active', ?, ?)
    `).run(provider.id, consumer.id, recent, recent);
    sharingStore.sqlite.prepare(`
      INSERT INTO personal_api_key_routes (key_id, route_key, session_id, updated_at)
      VALUES ('retention-key', 'session:recent', 'recent-session', ?)
    `).run(recent);
    sharingStore.sqlite.prepare(`
      INSERT INTO personal_api_key_routes (key_id, route_key, session_id, updated_at)
      VALUES ('retention-key', 'session:recently-used', 'recent-session', ?)
    `).run(old);
    const touchedRoute = sharingStore.personalRouteSession('retention-key', 'session:recently-used');
    assert.equal(touchedRoute.shareSessionId, 'recent-session');
    assert.ok(sharingStore.sqlite.prepare(`
      SELECT updated_at FROM personal_api_key_routes
      WHERE key_id = 'retention-key' AND route_key = 'session:recently-used'
    `).get().updated_at > old);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_events
        (id, actor_account_id, entity_type, entity_id, action, detail_json, created_at)
      VALUES ('recent-event', ?, 'offer', 'recent-offer', 'created', '{}', ?)
    `).run(provider.id, recent);

    const removed = sharingStore.cleanup(now);

    assert.equal(removed.loginAttempts, 1);
    assert.equal(removed.routes, 1);
    assert.equal(removed.reservations, 1);
    assert.equal(removed.settlements, 1);
    assert.equal(removed.emails, 1);
    assert.equal(removed.accountSessions, 1);
    assert.equal(removed.sessions, 1);
    assert.equal(removed.tickets, 1);
    assert.equal(removed.offers, 1);
    assert.equal(removed.quotaRequests, 1);
    assert.equal(removed.events, 1);
    assert.equal(removed.activity, 2);
    assert.equal(removed.providerObservations, 1);
    assert.equal(sharingStore.authenticateAccountSession(permanentSession.token).account.id, provider.id);
    assert.equal(sharingStore.sqlite.prepare('SELECT COUNT(*) AS count FROM account_sessions').get().count, 1);
    assert.equal(sharingStore.sqlite.prepare('SELECT COUNT(*) AS count FROM personal_api_key_routes').get().count, 2);
    assert.equal(sharingStore.sqlite.prepare("SELECT COUNT(*) AS count FROM sharing_events WHERE id = 'recent-event'").get().count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
