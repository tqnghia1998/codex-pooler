import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, refreshAllQuotas, start } from '../src/server.js';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';
import { CodexLoginManager } from '../src/codex-login.js';
import { upstreamPacerForStore } from '../../src/upstream-pacer.js';

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
    let refreshedUpstreamId = null;
    const upstream = store.create({ type: 'codex', authJson: authJson({
      subject: 'browser-user',
      email: 'browser@example.com',
      accountId: 'browser-account'
    }) });
    sharingStore.linkUpstream(account.id, upstream.id);
    const server = createServer(createApp({
      store,
      productStore: sharingStore,
      codexLoginManager: manager,
      onCodexCredentialsImported: async (upstreamId) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        refreshedUpstreamId = upstreamId;
        store.setQuota(upstreamId, {
          label: 'Provider quota window',
          usedPercent: 20,
          remainingPercent: 80,
          remainingUnits: null,
          limitUnits: null,
          remainingDollars: null,
          limitDollars: null,
          windowSeconds: 3600,
          resetAt: null,
          observedAt: new Date().toISOString(),
          source: 'codex_usage_api'
        });
      }
    }));
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
      assert.equal(refreshedUpstreamId, upstream.id);
      assert.equal(store.getPublic(upstream.id).quota.remainingPercent, 80);
      const sessionCookies = setCookies(response);
      const sessionToken = decodeURIComponent(cookieValue(sessionCookies, 'codex_pool_session'));
      const csrfToken = decodeURIComponent(cookieValue(sessionCookies, 'codex_pool_csrf'));
      assert.ok(sessionToken);
      assert.ok(csrfToken);
      assert.match(sessionCookies.find((value) => value.startsWith('codex_pool_session=')), /Max-Age=315360000/);

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
    let refreshedUpstreamId = null;
    const server = createServer(createApp({
      store,
      productStore: sharingStore,
      codexLoginManager: manager,
      onCodexCredentialsImported: async (upstreamId) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        refreshedUpstreamId = upstreamId;
        store.setQuota(upstreamId, {
          label: 'Provider quota window',
          usedPercent: 30,
          remainingPercent: 70,
          remainingUnits: null,
          limitUnits: null,
          remainingDollars: null,
          limitDollars: null,
          windowSeconds: 3600,
          resetAt: null,
          observedAt: new Date().toISOString(),
          source: 'codex_usage_api'
        });
      }
    }));
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
      assert.equal(refreshedUpstreamId, store.list()[0].id);
      assert.equal(store.list()[0].quota.remainingPercent, 70);
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

test('an account can reveal credentials only for its linked Codex upstreams', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-share-credentials-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const first = account(sharingStore, 'credentials-first');
    const second = account(sharingStore, 'credentials-second');
    const firstUpstream = store.create({ type: 'codex', authJson: authJson({
      subject: 'credentials-first',
      email: 'first@example.com',
      accountId: 'first-account',
      refreshToken: 'first-refresh'
    }) });
    const secondUpstream = store.create({ type: 'codex', authJson: authJson({
      subject: 'credentials-second',
      email: 'second@example.com',
      accountId: 'second-account',
      refreshToken: 'second-refresh'
    }) });
    sharingStore.linkUpstream(first.id, firstUpstream.id);
    sharingStore.linkUpstream(second.id, secondUpstream.id);
    const firstSession = sharingStore.createAccountSession(first.id);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const revealed = await request(base, '/api/pool/upstreams/credentials', firstSession, { csrf: false });
      assert.equal(revealed.response.status, 200);
      assert.deepEqual(revealed.body.credentials, [{
        id: firstUpstream.id,
        name: 'first@example.com',
        credentials: {
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: {
            id_token: store.credentials(firstUpstream.id).idToken,
            access_token: store.credentials(firstUpstream.id).accessToken,
            refresh_token: 'first-refresh',
            account_id: 'first-account'
          }
        }
      }]);
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

test('multiple browser sessions for one Codex Share account remain valid after another sign-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-same-account-sessions-'));
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
        body: JSON.stringify({ authJson: authJson({ subject: 'same-browser-account', email: 'same@example.com', accountId: 'same-account' }) })
      });
      assert.equal(firstLogin.status, 200);
      const account = (await firstLogin.json()).account;
      const firstSession = decodeURIComponent(cookieValue(setCookies(firstLogin), 'codex_pool_session'));

      const secondLogin = await fetch(`${base}/auth/codex/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: authJson({ subject: 'same-browser-account', email: 'same@example.com', accountId: 'same-account', refreshToken: 'rotated-refresh' }) })
      });
      assert.equal(secondLogin.status, 200);
      assert.equal((await secondLogin.json()).account.id, account.id);
      const secondSession = decodeURIComponent(cookieValue(setCookies(secondLogin), 'codex_pool_session'));

      assert.notEqual(firstSession, secondSession);
      for (const token of [firstSession, secondSession]) {
        const response = await fetch(`${base}/api/pool/me`, {
          headers: { cookie: `codex_pool_session=${encodeURIComponent(token)}` }
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).account.id, account.id);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serves the Codex Share favicon', async () => {
  const server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/assets/codex-share.svg`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await response.text(), /<svg/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('renders the configured public base path into the dashboard', async () => {
  const server = createServer(createApp({ publicBasePath: '/codex-share' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<base href="\/codex-share\/">/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('restricts Codex Share analytics to the whitelisted administrator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-admin-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const admin = sharingStore.upsertCodexAccount({
      subject: 'admin-user', issuer: 'https://auth.openai.com', email: 'quangnghia.trinh@shopee.com', name: 'Admin'
    });
    const member = account(sharingStore, 'member');
    const adminSession = sharingStore.createAccountSession(admin.id);
    const memberSession = sharingStore.createAccountSession(member.id);
    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
    const today = now.slice(0, 10);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_offers (id, provider_account_id, upstream_id, quota_micros, status, expires_at, created_at, updated_at)
      VALUES ('admin-offer', ?, 'admin-upstream', 5000000, 'active', NULL, ?, ?)
    `).run(admin.id, now, now);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_tickets (id, offer_id, provider_account_id, consumer_account_id, demand_request_id, requested_micros, approved_micros, status, expires_at, created_at, resolved_at)
      VALUES ('admin-ticket', 'admin-offer', ?, ?, NULL, 5000000, 5000000, 'approved', NULL, ?, ?)
    `).run(admin.id, member.id, now, now);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_sessions (id, offer_id, ticket_id, provider_account_id, consumer_account_id, upstream_id, scope_id, granted_micros, consumed_micros, status, expires_at, created_at, updated_at)
      VALUES ('admin-session', 'admin-offer', 'admin-ticket', ?, ?, 'admin-upstream', 'default', 5000000, 2500000, 'active', NULL, ?, ?)
    `).run(admin.id, member.id, now, now);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_activity (subject_type, subject_id, request_count, success_count, total_micros, today_date, today_micros, last_used_at, last_success_at, models_json, failures_json)
      VALUES ('session', 'admin-session', 1, 1, 1000000, ?, 1000000, ?, ?, '[]', '[]'),
        ('session', 'old-session', 1, 1, 2000000, ?, 2000000, ?, ?, '[]', '[]')
    `).run(today, now, now, yesterday, now, now);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(`${base}/admin`)).status, 401);
      assert.equal((await request(base, '/api/pool/admin/analytics', memberSession)).response.status, 403);
      const analytics = await request(base, '/api/pool/admin/analytics', adminSession);
      assert.equal(analytics.response.status, 200);
      assert.equal(analytics.body.analytics.overview.accounts, 2);
      assert.equal(analytics.body.analytics.usage.todayMicros, 1000000);
      assert.deepEqual(analytics.body.analytics.topProviders[0], {
        id: 'quangnghia.trinh@shopee.com', email: 'quangnghia.trinh@shopee.com', sessionCount: 1, consumedMicros: 2500000
      });
      assert.deepEqual(analytics.body.analytics.topConsumers[0], {
        id: 'member@example.com', email: 'member@example.com', sessionCount: 1, consumedMicros: 2500000
      });
      assert.equal((await fetch(`${base}/admin`, { headers: authHeaders(adminSession) })).status, 200);
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

      result = await request(base, '/api/pool/offers?limit=1&offset=0&includePast=false&role=community&q=provider%40example.com', consumerSession);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.totalItems, 1);
      assert.equal(result.body.hasMore, false);
      assert.equal(result.body.nextOffset, null);
      assert.equal(result.body.offers.length, 1);
      assert.equal(result.body.offers[0].id, offerId);

      result = await request(base, '/api/pool/sharing-counts', consumerSession);
      assert.equal(result.response.status, 200);
      assert.deepEqual(result.body.counts, {
        'community-offers': 1,
        'my-offers': 0,
        'quota-requests': 0,
        'sent-requests': 0,
        approvals: 0,
        'my-access': 0,
        'shared-by-me': 0
      });

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
      assert.equal(result.body.offers.length, 1);
      assert.equal(result.body.offers[0].status, 'closed');
      assert.equal(result.body.offers[0].isUsable, false);

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

test('a provider can test only its own linked Codex connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-share-connection-test-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({
      type: 'codex',
      pacing: { enabled: true, minStartIntervalMs: 60_000, maxQueueDepth: 1, maxQueueAgeMs: 60_000 },
      authJson: authJson({
        subject: 'connection-provider',
        accountId: 'connection-provider-account'
      })
    });
    const pacer = upstreamPacerForStore(store);
    await pacer.acquire(upstream.id);
    void pacer.acquire(upstream.id).catch(() => {});
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'connection-provider');
    const other = account(sharingStore, 'connection-other');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const providerSession = sharingStore.createAccountSession(provider.id);
    const otherSession = sharingStore.createAccountSession(other.id);
    const calls = [];
    const server = createServer(createApp({
      store,
      productStore: sharingStore,
      fetchImpl: async (url, options = {}) => {
        const path = new URL(url).pathname;
        calls.push({ path, options });
        if (path === '/backend-api/codex/models') {
          return new Response(JSON.stringify({
            models: [{ slug: 'gpt-5.6-terra' }, { slug: 'gpt-5.6-luna' }]
          }), { headers: { 'content-type': 'application/json' } });
        }
        if (path === '/backend-api/codex/responses') {
          return new Response(
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"pool-response-test","status":"completed","model":"gpt-5.6-luna","output":[]}}\n\n',
            { headers: { 'content-type': 'text/event-stream' } }
          );
        }
        throw new Error(`Unexpected provider request: ${path}`);
      }
    }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      let result = await request(base, `/api/pool/upstreams/${upstream.id}/test-connection`, providerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.connection.endpoint, '/v1/responses');
      assert.equal(result.body.connection.model, 'gpt-5.6-luna');

      const providerRequest = calls.find(({ path }) => path === '/backend-api/codex/responses');
      const body = JSON.parse(providerRequest.options.body);
      assert.equal(body.max_output_tokens, 64);
      assert.equal(body.input[0].content[0].text, 'What is the current time?');

      const callCount = calls.length;
      result = await request(base, `/api/pool/upstreams/${upstream.id}/test-connection`, otherSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 404);
      assert.equal(calls.length, callCount);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      pacer.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a consumer can test a My Access session through its shared quota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-share-session-connection-test-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({
      type: 'codex',
      authJson: authJson({
        subject: 'session-connection-provider',
        accountId: 'session-connection-provider-account'
      })
    });
    store.setQuota(upstream.id, {
      remainingDollars: 20,
      remainingPercent: 100,
      observedAt: new Date().toISOString()
    });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'session-connection-provider');
    const consumer = account(sharingStore, 'session-connection-consumer');
    const other = account(sharingStore, 'session-connection-other');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, {
      upstreamId: upstream.id,
      quotaDollars: 5
    }, store);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id }, store);
    const sharedSession = sharingStore.approveTicket(provider.id, ticket.id, {}, store);
    const providerSession = sharingStore.createAccountSession(provider.id);
    const consumerSession = sharingStore.createAccountSession(consumer.id);
    const otherSession = sharingStore.createAccountSession(other.id);
    const calls = [];
    const server = createServer(createApp({
      store,
      productStore: sharingStore,
      fetchImpl: async (url, options = {}) => {
        const path = new URL(url).pathname;
        calls.push({ path, options });
        if (path === '/backend-api/codex/models') {
          return new Response(JSON.stringify({
            models: [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-luna' }]
          }), { headers: { 'content-type': 'application/json' } });
        }
        if (path === '/backend-api/codex/responses') {
          return new Response(
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"shared-session-test","status":"completed","model":"gpt-5.6-luna","output":[],"usage":{"input_tokens":5,"output_tokens":1,"price_cost_usd":"0.25"}}}\n\n',
            { headers: { 'content-type': 'text/event-stream' } }
          );
        }
        throw new Error(`Unexpected provider request: ${path}`);
      }
    }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      let result = await request(base, `/api/pool/sessions/${sharedSession.id}/test-connection`, consumerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.connection.endpoint, '/v1/responses');
      assert.equal(result.body.connection.model, 'gpt-5.6-luna');

      const providerRequest = calls.find(({ path }) => path === '/backend-api/codex/responses');
      const body = JSON.parse(providerRequest.options.body);
      assert.equal(body.max_output_tokens, 64);
      assert.equal(body.input[0].content[0].text, 'What is the current time?');
      assert.equal(providerRequest.options.headers['chatgpt-account-id'], 'session-connection-provider-account');
      assert.equal(sharingStore.session(sharedSession.id, consumer.id, store).consumedQuotaDollars, 0.25);

      const callCount = calls.length;
      for (const session of [providerSession, otherSession]) {
        result = await request(base, `/api/pool/sessions/${sharedSession.id}/test-connection`, session, {
          method: 'POST',
          body: '{}'
        });
        assert.equal(result.response.status, 404);
      }
      assert.equal(calls.length, callCount);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Pool upstreams expose server-authoritative provider availability', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-upstream-availability-api-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'codex', authJson: authJson({ subject: 'availability-provider', accountId: 'availability-account' }) });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'availability-provider');
    sharingStore.linkUpstream(provider.id, upstream.id);
    store.setTokenRefresh(upstream.id, {
      status: 'reauth_required',
      trigger: 'runtime',
      errorCode: 'reauth_required',
      finishedAt: new Date().toISOString()
    });
    const session = sharingStore.createAccountSession(provider.id);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const result = await request(base, '/api/pool/upstreams', session);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.upstreams[0].providerIssue.code, 'provider_reauth_required');
      assert.equal(result.body.upstreams[0].name, 'import@example.com');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an owner can add an AISwitch project with a manual share budget that settlement decrements', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-aiswitch-manual-budget-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'aiswitch-provider');
    const consumer = account(sharingStore, 'aiswitch-consumer');
    const providerSession = sharingStore.createAccountSession(provider.id);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const added = await request(base, '/api/pool/upstreams/aiswitch', providerSession, {
        method: 'POST',
        body: JSON.stringify({ projectId: 'aiswitch-project', projectKey: 'aiswitch-key', quotaDollars: 10 })
      });
      assert.equal(added.response.status, 201);
      assert.equal(added.body.upstream.type, 'compass');
      assert.equal(added.body.upstream.quotaSource, 'aiswitch');
      assert.equal(added.body.upstream.spending.capDollars, 1_000_000);
      assert.equal(added.body.upstream.commitment.actualQuotaDollars, 10);
      const upstream = store.get(added.body.upstream.id);
      assert.equal(store.credentials(upstream.id).projectKey, 'aiswitch-key');

      const projectUpdated = await request(base, `/api/pool/upstreams/${upstream.id}`, providerSession, {
        method: 'PATCH',
        body: JSON.stringify({ projectId: 'updated-aiswitch-project', projectKey: 'updated-aiswitch-key' })
      });
      assert.equal(projectUpdated.response.status, 200);
      assert.equal(projectUpdated.body.upstream.projectId, 'updated-aiswitch-project');
      assert.equal(store.get(upstream.id).projectId, 'updated-aiswitch-project');
      assert.equal(store.credentials(upstream.id).projectKey, 'updated-aiswitch-key');

      const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 6 }, store);
      const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id }, store);
      const session = sharingStore.approveTicket(provider.id, ticket.id, {}, store);
      assert.equal(session.upstream.quotaSource, 'aiswitch');
      sharingStore.settleSession(session.id, 'aiswitch-settlement', 2_000_000);

      const listed = await request(base, '/api/pool/upstreams', providerSession);
      assert.equal(listed.response.status, 200);
      assert.equal(listed.body.upstreams[0].commitment.actualQuotaDollars, 8);
      assert.equal(listed.body.upstreams[0].commitment.offerableQuotaDollars, 4);
      assert.throws(
        () => sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 5 }, store),
        /truly offerable quota/
      );

      const updated = await request(base, `/api/pool/upstreams/${upstream.id}/manual-budget`, providerSession, {
        method: 'PUT',
        body: JSON.stringify({ quotaDollars: 20 })
      });
      assert.equal(updated.response.status, 200);
      assert.equal(updated.body.provider.commitment.actualQuotaDollars, 20);

      const exhausted = await request(base, `/api/pool/upstreams/${upstream.id}/manual-budget`, providerSession, {
        method: 'PUT',
        body: JSON.stringify({ quotaDollars: 0 })
      });
      assert.equal(exhausted.response.status, 200);
      assert.equal(exhausted.body.provider.commitment.actualQuotaDollars, 0);

      const invalidBudget = await request(base, `/api/pool/upstreams/${upstream.id}/manual-budget`, providerSession, {
        method: 'PUT',
        body: JSON.stringify({ quotaDollars: null })
      });
      assert.equal(invalidBudget.response.status, 400);

      const rejected = await request(base, '/api/pool/upstreams/aiswitch', providerSession, {
        method: 'POST',
        body: JSON.stringify({ projectId: 'invalid-aiswitch-project', projectKey: 'invalid-aiswitch-key', quotaDollars: -1 })
      });
      assert.equal(rejected.response.status, 400);
      assert.deepEqual(sharingStore.listAccountUpstreamLinks(provider.id).map((link) => link.upstreamId), [upstream.id]);
      assert.equal(store.list().length, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Pool quota refresh batches provider-change notifications', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-quota-batches-'));
  try {
    const store = new Store(dir);
    for (let index = 0; index < 11; index += 1) {
      store.create({ type: 'codex', accessToken: `quota-token-${index}`, accountId: `quota-account-${index}` });
    }
    let changes = 0;
    store.onUpstreamsChange(() => { changes += 1; });
    const results = await refreshAllQuotas(store, {
      fetchImpl: async () => new Response(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 2_592_000 } }
      }), { status: 200 })
    });
    assert.equal(results.filter((result) => result.value?.status === 'refreshed').length, 11);
    assert.equal(changes, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a consumer can reveal and rotate one personal key for active share sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-personal-key-api-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'codex', authJson: authJson({ subject: 'personal-provider', accountId: 'personal-provider-account' }) });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'personal-provider');
    const consumer = account(sharingStore, 'personal-consumer');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 2 }, store);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id }, store);
    sharingStore.approveTicket(provider.id, ticket.id, {}, store);
    const consumerSession = sharingStore.createAccountSession(consumer.id);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      let result = await request(base, '/api/pool/personal-key', consumerSession);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.personalKey.hasKey, true);
      assert.equal(result.body.personalKey.activeSessionCount, 1);

      result = await request(base, '/api/pool/personal-key/reveal', consumerSession, { method: 'POST', body: '{}' });
      assert.equal(result.response.status, 200);
      const firstKey = result.body.apiKey;
      assert.match(firstKey, /^cp_personal_/);

      result = await request(base, '/api/pool/personal-key/rotate', consumerSession, { method: 'POST', body: '{}' });
      assert.equal(result.response.status, 200);
      assert.match(result.body.apiKey, /^cp_personal_/);
      assert.notEqual(result.body.apiKey, firstKey);
      assert.equal(sharingStore.authenticateShareKey(firstKey), null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider controls, named keys, and friend quota requests are available through the product API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-share-reliability-api-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'codex', authJson: authJson({
      subject: 'reliability-provider',
      accountId: 'reliability-provider-account'
    }) });
    store.setQuota(upstream.id, {
      remainingDollars: 20,
      remainingPercent: 100,
      observedAt: new Date().toISOString()
    });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'reliability-provider');
    const consumer = account(sharingStore, 'reliability-consumer');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const providerSession = sharingStore.createAccountSession(provider.id);
    const consumerSession = sharingStore.createAccountSession(consumer.id);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      let result = await request(base, '/api/pool/offers', providerSession, {
        method: 'POST',
        body: JSON.stringify({ upstreamId: upstream.id, quotaDollars: 5 })
      });
      assert.equal(result.response.status, 201);

      result = await request(base, '/api/pool/upstreams', providerSession);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.upstreams[0].commitment.offerReservationDollars, 5);
      assert.equal(result.body.upstreams[0].commitment.offerableQuotaDollars, 15);
      assert.equal(result.body.upstreams[0].sharing.status, 'active');

      result = await request(base, `/api/pool/providers/${upstream.id}/pause`, providerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.provider.sharing.status, 'paused');

      result = await request(base, `/api/pool/providers/${upstream.id}/resume`, providerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.provider.sharing.status, 'active');

      result = await request(base, '/api/pool/personal-keys', consumerSession, {
        method: 'POST',
        body: JSON.stringify({ name: 'Laptop' })
      });
      assert.equal(result.response.status, 201);
      assert.match(result.body.apiKey, /^cp_personal_/);
      const keyId = result.body.personalKey.id;

      result = await request(base, '/api/pool/personal-keys', consumerSession);
      assert.equal(result.response.status, 200);
      assert.deepEqual(result.body.personalKeys.map((personalKey) => personalKey.name), ['Default', 'Laptop']);

      result = await request(base, `/api/pool/personal-keys/${keyId}/reveal`, consumerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.match(result.body.apiKey, /^cp_personal_/);

      result = await request(base, `/api/pool/personal-keys/${keyId}/revoke`, consumerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.personalKey.status, 'revoked');

      result = await request(base, '/api/pool/quota-requests', consumerSession, {
        method: 'POST',
        body: JSON.stringify({ quotaDollars: 3 })
      });
      assert.equal(result.response.status, 201);
      assert.equal(result.body.quotaRequest.quotaDollars, 3);
      const quotaRequestId = result.body.quotaRequest.id;

      result = await request(base, '/api/pool/quota-requests', providerSession);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.quotaRequests[0].requester.email, 'reliability-consumer@example.com');

      result = await request(base, `/api/pool/quota-requests/${quotaRequestId}/cancel`, consumerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.quotaRequest.status, 'cancelled');

      result = await request(base, `/api/pool/providers/${upstream.id}/revoke-all`, providerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.provider.sharing.status, 'paused');
      assert.equal((await request(base, '/api/pool/offers', providerSession)).body.offers[0].status, 'closed');
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

test('Pool refreshes Codex tokens that expire within the 12-hour proactive window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-token-scheduler-'));
  try {
    const store = new Store(dir);
    const productStore = new ProductStore(dir);
    const expiringToken = jwt({ exp: Math.floor(Date.now() / 1000) + 60 * 60 });
    const upstream = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: expiringToken,
      id_token: jwt({ email: 'scheduler@example.com' }),
      refresh_token: 'scheduled-refresh-token'
    }}) });
    let refreshCalls = 0;
    const fetchImpl = async (url) => {
      if (String(url) === 'https://auth.openai.com/oauth/token') {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          access_token: 'refreshed-access-token',
          refresh_token: 'refreshed-refresh-token',
          expires_in: 3600
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 3600
          }
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const server = start(0, { store, productStore, fetchImpl, tokenRefreshIntervalMs: 60_000 });
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const deadline = Date.now() + 1_000;
      while (!refreshCalls && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(refreshCalls, 1);
      assert.equal(store.credentials(upstream.id).accessToken, 'refreshed-access-token');
      assert.equal(store.credentials(upstream.id).refreshToken, 'refreshed-refresh-token');
      assert.equal(store.get(upstream.id).tokenRefresh.status, 'succeeded');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
