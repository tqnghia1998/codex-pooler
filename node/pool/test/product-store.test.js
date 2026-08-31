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
    assert.equal(sharingStore.listOffers(second.id, upstreamStore).length, 0);
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
    sharingStore.updateSession(provider.id, session.id, { quotaDollars: 4 }, upstreamStore);
    assert.equal(sharingStore.session(session.id, first.id, upstreamStore).status, 'active');
    sharingStore.updateSession(provider.id, session.id, { quotaDollars: 11 }, upstreamStore);
    assert.equal(sharingStore.session(session.id, first.id, upstreamStore).grantedQuotaDollars, 11);
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

test('marks an offer unusable and blocks requests when its dollar grant exceeds provider quota', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-insufficient-provider-'));
  try {
    const upstreamStore = new Store(dir);
    const upstream = upstreamStore.create({ type: 'compass', projectId: 'limited', projectKey: 'secret' });
    upstreamStore.setQuota(upstream.id, { remainingDollars: 5, remainingPercent: 50, observedAt: new Date().toISOString() });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'provider', 'provider@example.com');
    const consumer = account(sharingStore, 'consumer', 'consumer@example.com');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 10 }, upstreamStore);

    const listed = sharingStore.listOffers(consumer.id, upstreamStore)[0];
    assert.equal(listed.provider.email, 'provider@example.com');
    assert.equal(listed.isUsable, false);
    assert.match(listed.unusableReason, /less actual quota/);
    assert.throws(
      () => sharingStore.createTicket(consumer.id, { offerId: offer.id, quotaDollars: 1 }, upstreamStore),
      /exceeds the provider/
    );
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
