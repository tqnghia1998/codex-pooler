import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';
import { CodexAuthImporter } from '../src/codex-import.js';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function authJson({ subject = 'codex-user', email = 'codex@example.com', accountId = 'acct-login', refreshToken = 'refresh-login' } = {}) {
  return JSON.stringify({ tokens: {
    access_token: jwt({
      sub: subject,
      iss: 'https://auth.openai.com',
      email,
      'https://api.openai.com/auth': { chatgpt_account_id: accountId }
    }),
    id_token: jwt({ sub: subject, iss: 'https://auth.openai.com', email }),
    refresh_token: refreshToken
  }});
}

test('reuses the canonical Codex upstream when duplicate links already exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-login-deduplicate-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const first = upstreamStore.create(
      { type: 'codex', authJson: authJson({ refreshToken: 'first-refresh' }) },
      { allowDuplicateCodexIdentity: true }
    );
    const second = upstreamStore.create(
      { type: 'codex', authJson: authJson({ refreshToken: 'second-refresh' }) },
      { allowDuplicateCodexIdentity: true }
    );
    const provider = sharingStore.upsertAccount({ email: 'codex@example.com', name: 'codex' });
    sharingStore.linkUpstream(provider.id, first.id);
    sharingStore.linkUpstream(provider.id, second.id);
    const importer = new CodexAuthImporter({ sharingStore, upstreamStore });

    const imported = importer.importAuthJson(authJson({ refreshToken: 'replacement-refresh' }));

    assert.equal(imported.upstream.id, second.id);
    assert.equal(upstreamStore.list().length, 2);
    assert.equal(upstreamStore.credentials(second.id).refreshToken, 'replacement-refresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gateway store permits duplicate identities for every provider when QuotaHub owns the links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-duplicate-provider-identities-'));
  try {
    const store = new Store(dir);
    const providers = [
      () => ({ type: 'codex', authJson: authJson() }),
      () => ({
        type: 'claude',
        accessToken: 'sk-ant-oat-duplicate-provider',
        metadata: { skip_account_profile: true }
      }),
      () => ({
        type: 'compass',
        quotaSource: 'ais',
        projectId: 'duplicate-ais-project',
        projectKey: 'duplicate-ais-key'
      })
    ];

    for (const input of providers) {
      store.create(input());
      assert.doesNotThrow(() => store.create(input(), { allowDuplicateIdentity: true }));
    }

    assert.equal(store.list().length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.json import signs into the same account and replaces stored credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-auth-import-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const importer = new CodexAuthImporter({ sharingStore, upstreamStore });

    const first = importer.importAuthJson(authJson({ refreshToken: 'first-refresh' }));
    const second = importer.importAuthJson(authJson({ refreshToken: 'second-refresh' }));

    assert.equal(second.account.id, first.account.id);
    assert.equal(second.upstream.id, first.upstream.id);
    assert.equal(upstreamStore.list().length, 1);
    assert.equal(upstreamStore.credentials(second.upstream.id).refreshToken, 'second-refresh');
    assert.equal(sharingStore.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM sharing_events
      WHERE entity_type = 'upstream' AND entity_id = ? AND action = 'linked'
    `).get(first.upstream.id).count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one QuotaHub account can link multiple Codex accounts without replacing either credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-multiple-codex-providers-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const importer = new CodexAuthImporter({ sharingStore, upstreamStore });

    const first = importer.importAuthJson(authJson({ accountId: 'first-codex-account', refreshToken: 'first-refresh' }));
    const second = importer.importAuthJson(authJson({ accountId: 'second-codex-account', refreshToken: 'second-refresh' }));
    const repeatedFirst = importer.importAuthJson(authJson({ accountId: 'first-codex-account', refreshToken: 'rotated-first-refresh' }));

    assert.equal(second.account.id, first.account.id);
    assert.notEqual(second.upstream.id, first.upstream.id);
    assert.equal(repeatedFirst.upstream.id, first.upstream.id);
    assert.equal(upstreamStore.list().length, 2);
    assert.equal(upstreamStore.credentials(first.upstream.id).refreshToken, 'rotated-first-refresh');
    assert.equal(upstreamStore.credentials(second.upstream.id).refreshToken, 'second-refresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.json imports with the same email update the same linked credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-auth-workspace-members-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const importer = new CodexAuthImporter({ sharingStore, upstreamStore });

    const first = importer.importAuthJson(authJson({ subject: 'samlp|first-subject', accountId: 'enterprise-account' }));
    const second = importer.importAuthJson(authJson({
      subject: 'samlp|rotated-subject',
      accountId: 'enterprise-account',
      refreshToken: 'rotated-refresh'
    }));

    assert.equal(second.account.id, first.account.id);
    assert.equal(second.upstream.id, first.upstream.id);
    assert.equal(upstreamStore.list().length, 1);
    assert.equal(upstreamStore.credentials(first.upstream.id).refreshToken, 'rotated-refresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.json import accepts pasted Markdown fence lines and current Codex metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-auth-fenced-import-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const importer = new CodexAuthImporter({ sharingStore, upstreamStore });
    const payload = JSON.parse(authJson());
    const lines = JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      ...payload,
      last_refresh: '2026-08-28T07:32:05.126750Z'
    }, null, 2).split('\n');
    const fenced = lines.map((line, index) => (
      index % 2 ? `\`\`\`json\n${line}\n\`\`\`` : line
    )).join('\n');

    const imported = importer.importAuthJson(fenced);

    assert.equal(imported.account.email, 'codex@example.com');
    assert.equal(upstreamStore.list().length, 1);
    assert.equal(upstreamStore.credentials(imported.upstream.id).refreshToken, 'refresh-login');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a different Codex subject does not overwrite an upstream owned by another identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-login-separate-owner-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const upstream = upstreamStore.create({ type: 'codex', authJson: authJson({ subject: 'first-subject' }) });
    const owner = sharingStore.upsertAccount({ email: 'owner@example.com', name: 'Owner' });
    sharingStore.linkUpstream(owner.id, upstream.id);

    const importer = new CodexAuthImporter({ sharingStore, upstreamStore });
    importer.importAuthJson(authJson({
      subject: 'second-subject',
      accountId: 'different-account',
      refreshToken: 'attacker-refresh'
    }));

    assert.equal(sharingStore.accountIdForUpstream(upstream.id), owner.id);
    assert.notEqual(upstreamStore.credentials(upstream.id).refreshToken, 'attacker-refresh');
    assert.equal(upstreamStore.list().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
