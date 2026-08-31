import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';
import { CodexLoginManager } from '../src/codex-login.js';

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

function successfulSpawn(rawAuth, onHome = () => {}) {
  return (_command, _args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    onHome(options.env.CODEX_HOME);
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('https://auth.openai.com/codex/device\nABCD-EFGH\n'));
      mkdirSync(options.env.CODEX_HOME, { recursive: true });
      writeFileSync(join(options.env.CODEX_HOME, 'auth.json'), rawAuth);
      child.emit('exit', 0, null);
    });
    return child;
  };
}

async function waitForLogin(manager, token) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const login = manager.status(token);
    if (login && ['completed', 'failed', 'cancelled'].includes(login.status)) return login;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Codex login did not finish');
}

test('anonymous Codex login imports credentials, creates identity, and issues one browser session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-login-test-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    let temporaryHome;
    const manager = new CodexLoginManager({
      sharingStore,
      upstreamStore,
      spawnImpl: successfulSpawn(authJson(), (home) => { temporaryHome = home; }),
      command: 'fake-codex'
    });

    const attempt = manager.start();
    assert.notEqual(attempt.token, attempt.login.id);
    const storedHash = sharingStore.sqlite.prepare('SELECT attempt_token_hash FROM codex_login_attempts').get().attempt_token_hash;
    assert.equal(storedHash.includes(attempt.token), false);

    const login = await waitForLogin(manager, attempt.token);
    assert.equal(login.status, 'completed');
    assert.equal(existsSync(temporaryHome), false);
    assert.equal(upstreamStore.list().length, 1);

    const completed = sharingStore.consumeCompletedCodexLogin(attempt.token);
    assert.ok(completed.session.token);
    const accountAuth = sharingStore.authenticateAccountSession(completed.session.token);
    assert.equal(accountAuth.account.email, 'codex@example.com');
    assert.equal(sharingStore.listAccountUpstreamLinks(accountAuth.account.id)[0].upstreamId, upstreamStore.list()[0].id);
    assert.equal(sharingStore.consumeCompletedCodexLogin(attempt.token), null);
    assert.equal(manager.status('wrong-token'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same Codex subject signs into the same Codex Pool account and refreshes its upstream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-login-reuse-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const firstManager = new CodexLoginManager({
      sharingStore,
      upstreamStore,
      spawnImpl: successfulSpawn(authJson({ refreshToken: 'first-refresh' }))
    });
    const first = firstManager.start();
    await waitForLogin(firstManager, first.token);
    const firstSession = sharingStore.consumeCompletedCodexLogin(first.token);
    const firstAccountId = sharingStore.authenticateAccountSession(firstSession.session.token).account.id;

    const secondManager = new CodexLoginManager({
      sharingStore,
      upstreamStore,
      spawnImpl: successfulSpawn(authJson({ refreshToken: 'second-refresh' }))
    });
    const second = secondManager.start();
    await waitForLogin(secondManager, second.token);
    const secondSession = sharingStore.consumeCompletedCodexLogin(second.token);
    const secondAccountId = sharingStore.authenticateAccountSession(secondSession.session.token).account.id;

    assert.equal(secondAccountId, firstAccountId);
    assert.equal(upstreamStore.list().length, 1);
    assert.equal(upstreamStore.credentials(upstreamStore.list()[0].id).refreshToken, 'second-refresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.json import signs into the same account and replaces stored credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-auth-import-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const manager = new CodexLoginManager({ sharingStore, upstreamStore });

    const first = manager.importAuthJson(authJson({ refreshToken: 'first-refresh' }));
    const second = manager.importAuthJson(authJson({ refreshToken: 'second-refresh' }));

    assert.equal(second.account.id, first.account.id);
    assert.equal(second.upstream.id, first.upstream.id);
    assert.equal(upstreamStore.list().length, 1);
    assert.equal(upstreamStore.credentials(second.upstream.id).refreshToken, 'second-refresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.json imports keep Business workspace members separate when they share a ChatGPT account ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-auth-workspace-members-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const manager = new CodexLoginManager({ sharingStore, upstreamStore });

    const first = manager.importAuthJson(authJson({ subject: 'samlp|first-subject', accountId: 'enterprise-account' }));
    const second = manager.importAuthJson(authJson({
      subject: 'samlp|rotated-subject',
      accountId: 'enterprise-account',
      refreshToken: 'rotated-refresh'
    }));

    assert.notEqual(second.account.id, first.account.id);
    assert.notEqual(second.upstream.id, first.upstream.id);
    assert.equal(upstreamStore.list().length, 2);
    assert.equal(upstreamStore.credentials(first.upstream.id).refreshToken, 'refresh-login');
    assert.equal(upstreamStore.credentials(second.upstream.id).refreshToken, 'rotated-refresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.json import accepts pasted Markdown fence lines and current Codex metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-auth-fenced-import-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const manager = new CodexLoginManager({ sharingStore, upstreamStore });
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

    const imported = manager.importAuthJson(fenced);

    assert.equal(imported.account.email, 'codex@example.com');
    assert.equal(upstreamStore.list().length, 1);
    assert.equal(upstreamStore.credentials(imported.upstream.id).refreshToken, 'refresh-login');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a different Codex subject does not overwrite an upstream owned by another identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-login-separate-owner-'));
  try {
    const upstreamStore = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const upstream = upstreamStore.create({ type: 'codex', authJson: authJson({ subject: 'first-subject' }) });
    const owner = sharingStore.upsertCodexAccount({
      subject: 'first-subject',
      issuer: 'https://auth.openai.com',
      email: 'codex@example.com'
    });
    sharingStore.linkUpstream(owner.id, upstream.id);

    const manager = new CodexLoginManager({
      sharingStore,
      upstreamStore,
      spawnImpl: successfulSpawn(authJson({
        subject: 'second-subject',
        accountId: 'different-account',
        refreshToken: 'attacker-refresh'
      }))
    });
    const attempt = manager.start();
    const login = await waitForLogin(manager, attempt.token);

    assert.equal(login.status, 'completed');
    assert.equal(sharingStore.accountIdForUpstream(upstream.id), owner.id);
    assert.notEqual(upstreamStore.credentials(upstream.id).refreshToken, 'attacker-refresh');
    assert.equal(upstreamStore.list().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
