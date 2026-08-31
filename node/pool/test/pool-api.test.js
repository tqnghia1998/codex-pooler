import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, start } from '../src/server.js';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';
import { CodexLoginManager } from '../src/codex-login.js';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function authJson({ subject = 'import-user', email = 'import@example.com', accountId = 'acct-import', refreshToken = 'refresh-import' } = {}) {
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

function account(store, sub) {
  return store.upsertCodexAccount({ subject: sub, issuer: 'https://auth.openai.com', email: `${sub}@example.com`, name: sub });
}

function authHeaders(session, csrf = true) {
  return {
    cookie: `codex_pool_session=${session.token}; codex_pool_csrf=${session.csrfToken}`,
    ...(csrf ? { 'x-csrf-token': session.csrfToken } : {}),
    'content-type': 'application/json'
  };
}

async function request(base, path, session, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { ...authHeaders(session, options.csrf !== false), ...(options.headers || {}) }
  });
  return { response, body: response.status === 204 ? null : await response.json() };
}

function setCookies(response) {
  return typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
}

function cookieValue(cookies, name) {
  const item = cookies.find((value) => value.startsWith(`${name}=`));
  return item?.slice(name.length + 1).split(';')[0] || '';
}

test('Codex device sign-in creates an opaque browser session and enforces origin and CSRF checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-auth-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const account = sharingStore.upsertCodexAccount({
      subject: 'browser-user',
      issuer: 'https://auth.openai.com',
      email: 'browser@example.com',
      name: 'Browser User'
    });
    const manager = {
      start() {
        const attempt = sharingStore.createCodexLoginAttempt();
        sharingStore.updateCodexLoginAttempt(attempt.login.id, { accountId: account.id, status: 'completed' });
        return { ...attempt, login: sharingStore.codexLoginAttemptById(attempt.login.id) };
      },
      status(token) {
        return sharingStore.codexLoginAttemptByToken(token);
      },
      cancel(token) {
        const login = sharingStore.codexLoginAttemptByToken(token);
        return login ? sharingStore.updateCodexLoginAttempt(login.id, { status: 'cancelled' }) : null;
      }
    };
    const server = createServer(createApp({ store, productStore: sharingStore, codexLoginManager: manager }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      let response = await fetch(`${base}/auth/codex/start`, {
        method: 'POST',
        headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 403);

      response = await fetch(`${base}/auth/codex/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 201);
      const loginCookies = setCookies(response);
      const loginToken = decodeURIComponent(cookieValue(loginCookies, 'codex_pool_login'));
      assert.ok(loginToken);
      assert.equal(JSON.stringify(await response.json()).includes(loginToken), false);

      response = await fetch(`${base}/auth/codex/login`, {
        method: 'DELETE',
        headers: { origin: 'https://attacker.example', cookie: `codex_pool_login=${encodeURIComponent(loginToken)}` }
      });
      assert.equal(response.status, 403);
      response = await fetch(`${base}/auth/codex/status`);
      assert.equal(response.status, 401);
      response = await fetch(`${base}/auth/codex/status`, { headers: { cookie: `codex_pool_login=${encodeURIComponent(loginToken)}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).login.status, 'completed');
      const sessionCookies = setCookies(response);
      const sessionToken = decodeURIComponent(cookieValue(sessionCookies, 'codex_pool_session'));
      const csrfToken = decodeURIComponent(cookieValue(sessionCookies, 'codex_pool_csrf'));
      assert.ok(sessionToken);
      assert.ok(csrfToken);

      response = await fetch(`${base}/auth/codex/status`, { headers: { cookie: `codex_pool_login=${encodeURIComponent(loginToken)}` } });
      assert.equal(response.status, 401);

      response = await fetch(`${base}/api/pool/me`, { headers: { cookie: `codex_pool_session=${encodeURIComponent(sessionToken)}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).account.id, account.id);

      response = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: { cookie: `codex_pool_session=${encodeURIComponent(sessionToken)}; codex_pool_csrf=${encodeURIComponent(csrfToken)}` },
        body: '{}'
      });
      assert.equal(response.status, 403);
      response = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: {
          cookie: `codex_pool_session=${encodeURIComponent(sessionToken)}; codex_pool_csrf=${encodeURIComponent(csrfToken)}`,
          'x-csrf-token': csrfToken,
          'content-type': 'application/json'
        },
        body: '{}'
      });
      assert.equal(response.status, 204);
      response = await fetch(`${base}/api/pool/me`, { headers: { cookie: `codex_pool_session=${encodeURIComponent(sessionToken)}` } });
      assert.equal(response.status, 401);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.json sign-in imports credentials and returns only public account data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-auth-json-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const manager = new CodexLoginManager({ sharingStore, upstreamStore: store });
    const server = createServer(createApp({ store, productStore: sharingStore, codexLoginManager: manager }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      let response = await fetch(`${base}/auth/codex/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: '{' })
      });
      assert.equal(response.status, 400);

      const rawAuth = authJson();
      response = await fetch(`${base}/auth/codex/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: rawAuth })
      });
      assert.equal(response.status, 200);
      const cookies = setCookies(response);
      const sessionToken = decodeURIComponent(cookieValue(cookies, 'codex_pool_session'));
      const csrfToken = decodeURIComponent(cookieValue(cookies, 'codex_pool_csrf'));
      assert.ok(sessionToken);
      assert.ok(csrfToken);

      const responseText = await response.text();
      const result = JSON.parse(responseText);
      assert.equal(result.account.email, 'import@example.com');
      assert.equal(responseText.includes('refresh-import'), false);
      assert.equal(responseText.includes('access_token'), false);
      assert.equal(store.list().length, 1);
      assert.equal(store.credentials(store.list()[0].id).refreshToken, 'refresh-import');

      response = await fetch(`${base}/api/pool/me`, {
        headers: { cookie: `codex_pool_session=${encodeURIComponent(sessionToken)}` }
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).account.id, result.account.id);

      response = await fetch(`${base}/auth/codex/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: authJson({ refreshToken: 'rotated-refresh' }) })
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).account.id, result.account.id);
      assert.equal(store.list().length, 1);
      assert.equal(store.credentials(store.list()[0].id).refreshToken, 'rotated-refresh');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('separate browser sessions keep different Codex Pool identities after another account signs in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-separate-browser-sessions-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const manager = new CodexLoginManager({ sharingStore, upstreamStore: store });
    const server = createServer(createApp({ store, productStore: sharingStore, codexLoginManager: manager }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const firstLogin = await fetch(`${base}/auth/codex/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: authJson({ subject: 'browser-one', email: 'one@example.com', accountId: 'account-one' }) })
      });
      assert.equal(firstLogin.status, 200);
      const firstAccount = (await firstLogin.json()).account;
      const firstSession = decodeURIComponent(cookieValue(setCookies(firstLogin), 'codex_pool_session'));

      const secondLogin = await fetch(`${base}/auth/codex/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: authJson({ subject: 'browser-two', email: 'two@example.com', accountId: 'account-two' }) })
      });
      assert.equal(secondLogin.status, 200);
      const secondAccount = (await secondLogin.json()).account;
      const secondSession = decodeURIComponent(cookieValue(setCookies(secondLogin), 'codex_pool_session'));

      assert.notEqual(firstAccount.id, secondAccount.id);
      assert.notEqual(firstSession, secondSession);

      const firstMe = await fetch(`${base}/api/pool/me`, {
        headers: { cookie: `codex_pool_session=${encodeURIComponent(firstSession)}` }
      });
      const secondMe = await fetch(`${base}/api/pool/me`, {
        headers: { cookie: `codex_pool_session=${encodeURIComponent(secondSession)}` }
      });
      assert.equal((await firstMe.json()).account.id, firstAccount.id);
      assert.equal((await secondMe.json()).account.id, secondAccount.id);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sharing API requires account sessions and CSRF while offers stay public to signed-in accounts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-api-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'compass', projectId: 'api-shared', projectKey: 'secret' });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'provider');
    const consumer = account(sharingStore, 'consumer');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const providerSession = sharingStore.createAccountSession(provider.id);
    const consumerSession = sharingStore.createAccountSession(consumer.id);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      let response = await fetch(`${base}/api/pool/offers`);
      assert.equal(response.status, 401);

      let result = await request(base, '/api/pool/offers', providerSession, {
        method: 'POST',
        csrf: false,
        body: JSON.stringify({ upstreamId: upstream.id, quotaDollars: 10 })
      });
      assert.equal(result.response.status, 403);

      result = await request(base, '/api/pool/offers', providerSession, {
        method: 'POST',
        body: JSON.stringify({ upstreamId: upstream.id, quotaDollars: 10 })
      });
      assert.equal(result.response.status, 201);
      const offerId = result.body.offer.id;

      result = await request(base, '/api/pool/offers', consumerSession);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.offers[0].id, offerId);

      result = await request(base, '/api/pool/tickets', consumerSession, {
        method: 'POST',
        body: JSON.stringify({ offerId, quotaDollars: 4 })
      });
      assert.equal(result.response.status, 201);
      assert.equal(result.body.ticket.requestedQuotaDollars, 10);
      const ticketId = result.body.ticket.id;

      result = await request(base, '/api/pool/tickets', consumerSession, {
        method: 'POST',
        body: JSON.stringify({ offerId })
      });
      assert.equal(result.response.status, 400);
      assert.match(result.body.error.message, /pending ticket already exists/);

      result = await request(base, `/api/pool/tickets/${ticketId}/approve`, providerSession, {
        method: 'POST',
        body: JSON.stringify({ quotaDollars: 3 })
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.session.grantedQuotaDollars, 3);
      const sessionId = result.body.session.id;

      result = await request(base, '/api/pool/offers', consumerSession);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.offers.length, 0);

      result = await request(base, `/api/pool/sessions/${sessionId}/reveal-key`, providerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.match(result.body.apiKey, /^cp_share_/);

      result = await request(base, `/api/pool/sessions/${sessionId}/rotate-key`, providerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.match(result.body.apiKey, /^cp_share_/);

      result = await request(base, `/api/pool/sessions/${sessionId}/reveal-key`, consumerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.match(result.body.apiKey, /^cp_share_/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a signed-in provider can read and refresh its own Codex quota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-quota-api-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'codex', authJson: authJson({ subject: 'quota-provider', accountId: 'quota-account' }) });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'quota-provider');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const session = sharingStore.createAccountSession(provider.id);
    const server = createServer(createApp({
      store,
      productStore: sharingStore,
      fetchImpl: async () => new Response(JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 40,
            limit_window_seconds: 3600,
            reset_after_seconds: 1800
          }
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const result = await request(base, `/api/pool/upstreams/${upstream.id}/refresh-quota`, session, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.upstream.quota.remainingPercent, 60);
      assert.ok(result.body.upstream.quota.resetAt);

      const upstreams = await request(base, '/api/pool/upstreams', session);
      assert.equal(upstreams.response.status, 200);
      assert.equal(upstreams.body.upstreams[0].quota.remainingPercent, 60);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Pool refreshes Codex quotas at startup and on its scheduled interval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-quota-scheduler-'));
  try {
    const store = new Store(dir);
    const productStore = new ProductStore(dir);
    store.create({ type: 'codex', accessToken: 'scheduled-token' });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 3600
          }
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const server = start(0, { store, productStore, fetchImpl, quotaRefreshIntervalMs: 10 });
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const deadline = Date.now() + 1_000;
      while (calls < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(calls >= 2);
      assert.equal(store.list()[0].quota.remainingPercent, 75);
      assert.ok(store.list()[0].quota.observedAt);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
