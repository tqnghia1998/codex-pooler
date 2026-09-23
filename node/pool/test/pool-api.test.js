import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, QUOTA_REFRESH_INTERVAL_MS, refreshAllQuotas, start } from '../src/server.js';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';
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
  return store.upsertAccount({ email: `${sub}@example.com`, name: sub });
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

test('legacy Codex device-auth routes are unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-auth-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const responses = await Promise.all([
        fetch(`${base}/auth/codex/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        }),
        fetch(`${base}/auth/codex/status`),
        fetch(`${base}/auth/codex/login`, { method: 'DELETE' })
      ]);
      for (const response of responses) {
        assert.equal(response.status, 404);
        assert.equal(setCookies(response).some((value) => value.startsWith('codex_pool_login=')), false);
      }

      const response = await fetch(`${base}/auth/codex/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: authJson() })
      });
      assert.equal(response.status, 200);
      assert.equal(setCookies(response).some((value) => value.startsWith('codex_pool_login=')), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex quota refresh defaults to five minutes', () => {
  assert.equal(QUOTA_REFRESH_INTERVAL_MS, 5 * 60 * 1_000);
});

test('SPACE sign-in trusts validated identity only and revokes the browser session when validation fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-space-session-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const calls = [];
    let validationSucceeds = true;
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      if (!validationSucceeds) return new Response(JSON.stringify({ error: 'expired' }), { status: 401 });
      return new Response(JSON.stringify({
        login_email: 'verified@example.com',
        identity_uuid: 'verified-identity',
        user: {
          email: 'verified@example.com',
          full_name: 'Verified User',
          sub: 'verified-subject'
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const server = createServer(createApp({ store, productStore: sharingStore, fetchImpl }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      let response = await fetch(`${base}/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session: JSON.stringify({
            token: 'real-space-token',
            login_email: 'spoofed@example.com',
            identity_uuid: 'spoofed-identity',
            user: { email: 'spoofed@example.com', sub: 'spoofed-subject' }
          })
        })
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).account.email, 'verified@example.com');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://space.shopee.io/apis/space_auth/v1/token_validate');
      assert.equal(calls[0].options.headers.authorization, 'Bearer real-space-token');
      assert.deepEqual(JSON.parse(calls[0].options.body), { requires_2fa: true });
      assert.equal(
        sharingStore.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts WHERE email = ?').get('spoofed@example.com').count,
        0
      );

      const sessionToken = decodeURIComponent(cookieValue(setCookies(response), 'codex_pool_session'));
      validationSucceeds = false;
      response = await fetch(`${base}/auth/session`, {
        method: 'POST',
        headers: {
          cookie: `codex_pool_session=${encodeURIComponent(sessionToken)}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ session: JSON.stringify({ token: 'expired-space-token' }) })
      });
      assert.equal(response.status, 401);
      assert.match(setCookies(response).find((value) => value.startsWith('codex_pool_session=')), /Max-Age=0/);

      response = await fetch(`${base}/api/pool/me`, {
        headers: { cookie: `codex_pool_session=${encodeURIComponent(sessionToken)}` }
      });
      assert.equal(response.status, 401);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SPACE validation preserves imported browser sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-space-preserve-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    let calls = 0;
    const server = createServer(createApp({
      store,
      productStore: sharingStore,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('SPACE must not be called');
      }
    }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const source of ['import']) {
        const user = sharingStore.upsertAccount({ email: `${source}@example.com`, name: source });
        const session = sharingStore.createAccountSession(user.id, { source });
        const response = await fetch(`${base}/auth/session`, {
          method: 'POST',
          headers: {
            cookie: `codex_pool_session=${encodeURIComponent(session.token)}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ session: JSON.stringify({ token: 'space-token' }) })
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).account.id, user.id);
        assert.equal(sharingStore.authenticateAccountSession(session.token).account.id, user.id);
      }
      assert.equal(calls, 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SPACE validation outages preserve the existing SPACE browser session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-space-outage-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const user = sharingStore.upsertAccount({ email: 'space@example.com', name: 'SPACE User' });
    const session = sharingStore.createAccountSession(user.id, { source: 'space' });
    const server = createServer(createApp({
      store,
      productStore: sharingStore,
      fetchImpl: async () => { throw new Error('network unavailable'); }
    }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${base}/auth/session`, {
        method: 'POST',
        headers: {
          cookie: `codex_pool_session=${encodeURIComponent(session.token)}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ session: JSON.stringify({ token: 'space-token' }) })
      });
      assert.equal(response.status, 503);
      assert.deepEqual(setCookies(response), []);
      assert.equal(sharingStore.authenticateAccountSession(session.token).account.id, user.id);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent SPACE validation requests share one replacement browser session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-space-race-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    let calls = 0;
    let resolveValidation;
    const validation = new Promise((resolve) => { resolveValidation = resolve; });
    const server = createServer(createApp({
      store,
      productStore: sharingStore,
      fetchImpl: async () => {
        calls += 1;
        return validation;
      }
    }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const options = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: JSON.stringify({ token: 'shared-space-token' }) })
      };
      const first = fetch(`${base}/auth/session`, options);
      while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      const second = fetch(`${base}/auth/session`, options);
      await new Promise((resolve) => setTimeout(resolve, 10));
      resolveValidation(new Response(JSON.stringify({
        login_email: 'race@example.com',
        identity_uuid: 'race-identity',
        user: { email: 'race@example.com', full_name: 'Race User', sub: 'race-subject' }
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      assert.equal(firstResponse.status, 200);
      assert.equal(secondResponse.status, 200);
      assert.equal(calls, 1);
      const firstToken = decodeURIComponent(cookieValue(setCookies(firstResponse), 'codex_pool_session'));
      const secondToken = decodeURIComponent(cookieValue(setCookies(secondResponse), 'codex_pool_session'));
      assert.ok(firstToken);
      assert.equal(secondToken, firstToken);
      assert.equal(
        sharingStore.sqlite.prepare("SELECT COUNT(*) AS count FROM account_sessions WHERE auth_source = 'space' AND revoked_at IS NULL").get().count,
        1
      );
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
    let refreshedUpstreamId = null;
    const server = createServer(createApp({
      store,
      productStore: sharingStore,
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
      assert.equal(cookies.some((value) => value.startsWith('codex_pool_login=')), false);

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

test('members cannot export linked provider credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-share-credentials-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const first = account(sharingStore, 'credentials-first');
    const firstUpstream = store.create({ type: 'codex', authJson: authJson({
      subject: 'credentials-first',
      email: 'first@example.com',
      accountId: 'first-account',
      refreshToken: 'first-refresh'
    }) });
    sharingStore.linkUpstream(first.id, firstUpstream.id);
    const firstSession = sharingStore.createAccountSession(first.id);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const denied = await request(base, '/api/pool/upstreams/credentials', firstSession, { csrf: false });
      assert.equal(denied.response.status, 404);
      assert.equal(denied.body.error.code, 'not_found');
      assert.equal(JSON.stringify(denied.body).includes('first-refresh'), false);
      const upstreams = await request(base, '/api/pool/upstreams', firstSession, { csrf: false });
      assert.equal(upstreams.response.status, 200);
      assert.equal(upstreams.body.upstreams.length, 1);
      assert.equal(JSON.stringify(upstreams.body).includes('first-refresh'), false);
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
    const server = createServer(createApp({ store, productStore: sharingStore }));
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

test('multiple browser sessions for one QuotaHub account remain valid after another sign-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-same-account-sessions-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const server = createServer(createApp({ store, productStore: sharingStore }));
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

      const otherCodex = await fetch(`${base}/auth/codex/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: authJson({ subject: 'other-browser-account', email: 'same@example.com', accountId: 'other-account' }) })
      });
      assert.equal(otherCodex.status, 409);
      assert.match((await otherCodex.json()).error.message, /one Codex provider/);
      assert.equal(store.list().length, 1);
      assert.equal(sharingStore.listAccountUpstreamLinks(account.id).length, 1);
      assert.equal(setCookies(otherCodex).length, 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serves the QuotaHub favicon', async () => {
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
  const server = createServer(createApp({ publicBasePath: '/quotahub' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<base href="\/quotahub\/">/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('restricts QuotaHub analytics to the whitelisted administrator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-admin-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const admin = sharingStore.upsertAccount({ email: 'quangnghia.trinh@shopee.com', name: 'Admin' });
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
    const addEvent = sharingStore.sqlite.prepare(`
      INSERT INTO sharing_events (id, actor_account_id, entity_type, entity_id, action, detail_json, created_at)
      VALUES (?, ?, 'upstream', ?, 'linked', '{}', '2099-01-01T00:00:00.000Z')
    `);
    for (let index = 1; index <= 13; index += 1) {
      const id = `pagination-${String(index).padStart(2, '0')}`;
      addEvent.run(id, admin.id, id);
    }
    const backup = { enabled: true, lastBackupAt: '2026-09-18T09:30:00.000Z' };
    const server = createServer(createApp({ store, productStore: sharingStore, backupStatus: () => backup }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(`${base}/admin`)).status, 401);
      assert.equal((await request(base, '/api/pool/admin/analytics', memberSession)).response.status, 403);
      const analytics = await request(base, '/api/pool/admin/analytics', adminSession);
      assert.equal(analytics.response.status, 200);
      assert.deepEqual(analytics.body.analytics.recentEvents.map(({ id }) => id), [
        'pagination-13', 'pagination-12', 'pagination-11', 'pagination-10', 'pagination-09', 'pagination-08',
        'pagination-07', 'pagination-06', 'pagination-05', 'pagination-04', 'pagination-03', 'pagination-02'
      ]);
      assert.ok(analytics.body.analytics.nextEventCursor);
      const nextEvents = await request(base, `/api/pool/admin/analytics?eventCursor=${encodeURIComponent(analytics.body.analytics.nextEventCursor)}`, adminSession);
      assert.equal(nextEvents.response.status, 200);
      assert.deepEqual(nextEvents.body.analytics.recentEvents.map(({ id }) => id), ['pagination-01']);
      assert.equal(nextEvents.body.analytics.nextEventCursor, null);
      assert.equal(nextEvents.body.analytics.overview, undefined);
      const matching = await request(base, '/api/pool/admin/analytics?q=pagination-03', adminSession);
      assert.deepEqual(matching.body.analytics.recentEvents.map(({ entityId }) => entityId), ['pagination-03']);
      const none = await request(base, '/api/pool/admin/analytics?q=missing&days=7', adminSession);
      assert.deepEqual(none.body.analytics.recentEvents, []);
      const malformedCursor = await request(base, '/api/pool/admin/analytics?eventCursor=not-a-cursor', adminSession);
      assert.equal(malformedCursor.response.status, 200);
      assert.deepEqual(malformedCursor.body.analytics.recentEvents.map(({ id }) => id), analytics.body.analytics.recentEvents.map(({ id }) => id));
      assert.equal(analytics.body.analytics.overview.accounts, 2);
      assert.equal(analytics.body.analytics.usage.todayMicros, 1000000);
      assert.deepEqual(analytics.body.analytics.backup, backup);
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

test('signed-in members can read a community leaderboard with account emails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-leaderboard-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'provider');
    const consumer = account(sharingStore, 'consumer');
    const providerSession = sharingStore.createAccountSession(provider.id);
    const consumerSession = sharingStore.createAccountSession(consumer.id);
    const now = new Date().toISOString();
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_offers (id, provider_account_id, upstream_id, quota_micros, status, expires_at, created_at, updated_at)
      VALUES ('leaderboard-offer', ?, 'leaderboard-upstream', 5000000, 'active', NULL, ?, ?)
    `).run(provider.id, now, now);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_tickets (id, offer_id, provider_account_id, consumer_account_id, demand_request_id, requested_micros, approved_micros, status, expires_at, created_at, resolved_at)
      VALUES ('leaderboard-ticket', 'leaderboard-offer', ?, ?, NULL, 5000000, 5000000, 'approved', NULL, ?, ?)
    `).run(provider.id, consumer.id, now, now);
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_sessions (id, offer_id, ticket_id, provider_account_id, consumer_account_id, upstream_id, scope_id, granted_micros, consumed_micros, status, expires_at, created_at, updated_at)
      VALUES ('leaderboard-session', 'leaderboard-offer', 'leaderboard-ticket', ?, ?, 'leaderboard-upstream', 'default', 5000000, 2500000, 'active', NULL, ?, ?)
    `).run(provider.id, consumer.id, now, now);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(`${base}/api/pool/leaderboard`)).status, 401);
      const result = await request(base, '/api/pool/leaderboard', consumerSession);
      assert.equal(result.response.status, 200);
      assert.deepEqual(result.body.leaderboard.topProviders, [{
        rank: 1,
        email: 'provider@example.com',
        sessionCount: 1,
        consumedMicros: 2500000
      }]);
      assert.deepEqual(result.body.leaderboard.topConsumers, [{
        rank: 1,
        email: 'consumer@example.com',
        sessionCount: 1,
        consumedMicros: 2500000
      }]);
      assert.equal(result.body.leaderboard.topProviders[0].id, undefined);
      assert.equal(result.body.leaderboard.topProviders[0].displayName, undefined);
      assert.equal((await fetch(`${base}/api/pool/leaderboard`, { headers: authHeaders(providerSession) })).status, 200);

      const addOffer = sharingStore.sqlite.prepare(`
        INSERT INTO sharing_offers (id, provider_account_id, upstream_id, quota_micros, status, expires_at, created_at, updated_at)
        VALUES (?, ?, 'leaderboard-upstream', 12000000, 'active', NULL, ?, ?)
      `);
      const addTicket = sharingStore.sqlite.prepare(`
        INSERT INTO sharing_tickets (id, offer_id, provider_account_id, consumer_account_id, demand_request_id, requested_micros, approved_micros, status, expires_at, created_at, resolved_at)
        VALUES (?, ?, ?, ?, NULL, 12000000, 12000000, 'approved', NULL, ?, ?)
      `);
      const addSession = sharingStore.sqlite.prepare(`
        INSERT INTO sharing_sessions (id, offer_id, ticket_id, provider_account_id, consumer_account_id, upstream_id, scope_id, granted_micros, consumed_micros, status, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'leaderboard-upstream', 'default', 12000000, ?, 'active', NULL, ?, ?)
      `);
      for (let index = 1; index <= 11; index += 1) {
        const name = `ranked-provider-${String(index).padStart(2, '0')}`;
        const leader = account(sharingStore, name);
        addOffer.run(`${name}-offer`, leader.id, now, now);
        addTicket.run(`${name}-ticket`, `${name}-offer`, leader.id, consumer.id, now, now);
        addSession.run(`${name}-session`, `${name}-offer`, `${name}-ticket`, leader.id, consumer.id, index * 1000000, now, now);
      }
      const ranked = await request(base, '/api/pool/leaderboard', consumerSession);
      assert.deepEqual(ranked.body.leaderboard.topProviders.map(({ rank, email }) => ({ rank, email })), [
        ...Array.from({ length: 9 }, (_, index) => ({
          rank: index + 1,
          email: `ranked-provider-${String(11 - index).padStart(2, '0')}@example.com`
        })),
        { rank: 10, email: 'provider@example.com' }
      ]);
      assert.equal(sharingStore.adminUsageLeaders('provider').length, 5);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('admin export and import restore QuotaHub data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-portability-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'compass', projectId: 'portable-project', projectKey: 'secret' });
    const sharingStore = new ProductStore(dir);
    const admin = sharingStore.upsertAccount({ email: 'quangnghia.trinh@shopee.com', name: 'Admin' });
    const member = account(sharingStore, 'member');
    sharingStore.linkUpstream(admin.id, upstream.id);
    const adminSession = sharingStore.createAccountSession(admin.id);
    const memberSession = sharingStore.createAccountSession(member.id);
    const now = new Date().toISOString();
    sharingStore.sqlite.prepare(`
      INSERT INTO sharing_offers (id, provider_account_id, upstream_id, quota_micros, status, expires_at, created_at, updated_at)
      VALUES ('portable-offer', ?, ?, 5000000, 'active', NULL, ?, ?)
    `).run(admin.id, upstream.id, now, now);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await request(base, '/api/pool/admin/export', memberSession)).response.status, 403);
      const first = await request(base, '/api/pool/admin/export', adminSession);
      assert.equal(first.response.status, 200);
      assert.equal(first.body.format, 'quotahub-export');
      assert.equal(first.body.version, 1);
      assert.ok(first.body.gateway.records.length > 0);
      assert.equal(first.body.product.accounts.length, 2);
      assert.equal(first.body.product.sharing_offers.length, 1);
      assert.ok(first.body.product.account_upstreams.some((row) => row.upstream_id === upstream.id));

      sharingStore.sqlite.prepare('DELETE FROM sharing_offers').run();
      sharingStore.sqlite.prepare('DELETE FROM account_upstreams').run();
      const restored = await request(base, '/api/pool/admin/import', adminSession, { method: 'POST', body: JSON.stringify(first.body) });
      assert.equal(restored.response.status, 200);
      assert.equal(restored.body.imported.product.sharing_offers, 1);
      assert.equal(restored.body.imported.product.account_upstreams, 1);
      const second = await request(base, '/api/pool/admin/export', adminSession);
      assert.equal(second.response.status, 200);
      const sortRows = (product) => Object.fromEntries(
        Object.entries(product).map(([table, rows]) => [table, [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])
      );
      assert.deepEqual(sortRows(second.body.product), sortRows(first.body.product));
      assert.deepEqual(second.body.gateway, first.body.gateway);

      const unknownTable = await request(base, '/api/pool/admin/import', adminSession, {
        method: 'POST', body: JSON.stringify({ ...first.body, product: { ...first.body.product, bogus_table: [] } })
      });
      assert.equal(unknownTable.response.status, 400);
      const wrongFormat = await request(base, '/api/pool/admin/import', adminSession, {
        method: 'POST', body: JSON.stringify({ format: 'other', version: 1 })
      });
      assert.equal(wrongFormat.response.status, 400);
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
        body: JSON.stringify({
          upstreamId: upstream.id,
          quotaDollars: 10,
          message: 'Here is my spare quota. Feel free to request it.'
        })
      });
      assert.equal(result.response.status, 201);
      const offerId = result.body.offer.id;
      assert.equal(result.body.offer.message, 'Here is my spare quota. Feel free to request it.');

      result = await request(base, '/api/pool/offers', consumerSession);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.offers[0].id, offerId);
      assert.equal(result.body.offers[0].message, 'Here is my spare quota. Feel free to request it.');

      result = await request(base, `/api/pool/offers/${offerId}`, providerSession, {
        method: 'PATCH',
        body: JSON.stringify({ message: 'Updated spare quota note.' })
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.offer.message, 'Updated spare quota note.');

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
        'my-quota-requests': 0,
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
      assert.equal(result.body.offers.length, 2);
      const replacementOffer = result.body.offers.find((offer) => offer.status === 'active');
      assert.ok(replacementOffer);
      assert.notEqual(replacementOffer.id, offerId);
      assert.equal(replacementOffer.quotaDollars, 7);
      assert.equal(replacementOffer.availableDollars, 7);
      assert.equal(replacementOffer.message, 'Updated spare quota note.');
      const closedOffer = result.body.offers.find((offer) => offer.id === offerId);
      assert.equal(closedOffer.status, 'closed');
      assert.equal(closedOffer.isUsable, false);
      assert.equal(closedOffer.hasGrants, true);
      assert.equal(closedOffer.canEdit, false);
      assert.equal(closedOffer.canClose, false);
      assert.equal(replacementOffer.hasGrants, false);
      assert.equal(replacementOffer.canEdit, true);
      assert.equal(replacementOffer.canClose, false);

      result = await request(base, `/api/pool/offers/${offerId}`, providerSession, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active', quotaDollars: 7 })
      });
      assert.equal(result.response.status, 400);
      assert.match(result.body.error.message, /historical and cannot be edited or reopened/);

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
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"pool-response-test","status":"completed","model":"gpt-5.6-luna","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The current time is now."}]}]}}\n\n',
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
      assert.equal(result.body.connection.model, 'gpt-6-luna');
      assert.equal(result.body.connection.answer, 'The current time is now.');

      const providerRequest = calls.find(({ path }) => path === '/backend-api/codex/responses');
      const body = JSON.parse(providerRequest.options.body);
      assert.equal(body.max_output_tokens, 64);
      assert.equal(body.input[0].content[0].text, 'What is the current time?');

      const cooldown = store.beginUpstreamAttempt(upstream.id, { routeClass: 'proxy_http', model: 'gpt-5.6-luna' });
      store.settleUpstreamAttempt(upstream.id, cooldown, { class: 'quota', retryable: true, retryAfter: '60' });
      result = await request(base, `/api/pool/upstreams/${upstream.id}/test-connection`, providerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.equal(store.get(upstream.id).health.status, 'cooldown');

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
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"shared-session-test","status":"completed","model":"gpt-5.6-luna","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The current time is now."}]}],"usage":{"input_tokens":5,"output_tokens":1,"price_cost_usd":"0.25"}}}\n\n',
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
      assert.equal(result.body.connection.answer, 'The current time is now.');

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

test('providers can unlink and relink duplicate Claude and AIS credentials independently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-provider-relink-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const firstProvider = account(sharingStore, 'first-provider');
    const secondProvider = account(sharingStore, 'second-provider');
    const firstSession = sharingStore.createAccountSession(firstProvider.id);
    const secondSession = sharingStore.createAccountSession(secondProvider.id);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const claudeAuthJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat-shared-setup-token',
        refreshToken: '',
        expiresAt: 0
      },
      metadata: { skip_account_profile: true }
    });
    try {
      const apiKeyClaude = await request(base, '/api/pool/upstreams/claude', firstSession, {
        method: 'POST',
        body: JSON.stringify({ token: 'sk-ant-api03-not-oauth' })
      });
      assert.equal(apiKeyClaude.response.status, 400);
      assert.equal(store.list().length, 0);

      const firstClaude = await request(base, '/api/pool/upstreams/claude', firstSession, {
        method: 'POST',
        body: JSON.stringify({ authJson: claudeAuthJson })
      });
      const secondClaude = await request(base, '/api/pool/upstreams/claude', secondSession, {
        method: 'POST',
        body: JSON.stringify({ authJson: claudeAuthJson })
      });
      assert.equal(firstClaude.response.status, 201);
      assert.equal(secondClaude.response.status, 201);
      assert.notEqual(firstClaude.body.upstream.id, secondClaude.body.upstream.id);

      const repeatedClaude = await request(base, '/api/pool/upstreams/claude', firstSession, {
        method: 'POST',
        body: JSON.stringify({ authJson: claudeAuthJson })
      });
      assert.equal(repeatedClaude.response.status, 201);
      assert.equal(repeatedClaude.body.upstream.id, firstClaude.body.upstream.id);

      const otherClaude = await request(base, '/api/pool/upstreams/claude', firstSession, {
        method: 'POST',
        body: JSON.stringify({ authJson: claudeAuthJson.replace('shared-setup-token', 'other-setup-token') })
      });
      assert.equal(otherClaude.response.status, 409);
      assert.match(otherClaude.body.error.message, /one Claude provider/);
      assert.equal(store.list().filter((upstream) => upstream.type === 'claude').length, 2);

      const removedClaude = await request(base, `/api/pool/upstreams/${firstClaude.body.upstream.id}`, firstSession, {
        method: 'DELETE',
        body: '{}'
      });
      assert.equal(removedClaude.response.status, 204);
      assert.equal(store.get(firstClaude.body.upstream.id), null);

      const relinkedClaude = await request(base, '/api/pool/upstreams/claude', firstSession, {
        method: 'POST',
        body: JSON.stringify({ authJson: claudeAuthJson })
      });
      assert.equal(relinkedClaude.response.status, 201);
      assert.notEqual(relinkedClaude.body.upstream.id, firstClaude.body.upstream.id);

      const firstAis = await request(base, '/api/pool/upstreams/ais', firstSession, {
        method: 'POST',
        body: JSON.stringify({ projectId: 'shared-ais-project', projectKey: 'shared-ais-key' })
      });
      const secondAis = await request(base, '/api/pool/upstreams/ais', secondSession, {
        method: 'POST',
        body: JSON.stringify({ projectId: 'shared-ais-project', projectKey: 'shared-ais-key' })
      });
      assert.equal(firstAis.response.status, 201);
      assert.equal(secondAis.response.status, 201);
      assert.notEqual(firstAis.body.upstream.id, secondAis.body.upstream.id);

      const repeatedAis = await request(base, '/api/pool/upstreams/ais', firstSession, {
        method: 'POST',
        body: JSON.stringify({ projectId: 'shared-ais-project', projectKey: 'shared-ais-key' })
      });
      assert.equal(repeatedAis.response.status, 201);
      assert.equal(repeatedAis.body.upstream.id, firstAis.body.upstream.id);

      const otherAis = await request(base, '/api/pool/upstreams/ais', firstSession, {
        method: 'POST',
        body: JSON.stringify({ projectId: 'other-ais-project', projectKey: 'other-ais-key' })
      });
      assert.equal(otherAis.response.status, 409);
      assert.match(otherAis.body.error.message, /one AIS provider/);
      assert.equal(store.list().filter((upstream) => upstream.quotaSource === 'ais').length, 2);

      const removedAis = await request(base, `/api/pool/upstreams/${firstAis.body.upstream.id}`, firstSession, {
        method: 'DELETE',
        body: '{}'
      });
      assert.equal(removedAis.response.status, 204);
      assert.equal(store.get(firstAis.body.upstream.id), null);

      const relinkedAis = await request(base, '/api/pool/upstreams/ais', firstSession, {
        method: 'POST',
        body: JSON.stringify({ projectId: 'shared-ais-project', projectKey: 'shared-ais-key' })
      });
      assert.equal(relinkedAis.response.status, 201);
      assert.notEqual(relinkedAis.body.upstream.id, firstAis.body.upstream.id);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an owner can add an AIS project without a local quota estimate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-ais-unknown-quota-api-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'ais-provider');
    const consumer = account(sharingStore, 'ais-consumer');
    const providerSession = sharingStore.createAccountSession(provider.id);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const added = await request(base, '/api/pool/upstreams/ais', providerSession, {
        method: 'POST',
        body: JSON.stringify({ projectId: 'ais-project', projectKey: 'ais-key' })
      });
      assert.equal(added.response.status, 201);
      assert.equal(added.body.upstream.type, 'compass');
      assert.equal(added.body.upstream.quotaSource, 'ais');
      assert.equal(added.body.upstream.email, provider.email);
      assert.equal(added.body.upstream.commitment.actualQuotaDollars, null);
      assert.equal(added.body.upstream.commitment.offerableQuotaDollars, null);
      const upstream = store.get(added.body.upstream.id);
      assert.equal(store.credentials(upstream.id).projectKey, 'ais-key');

      const projectUpdated = await request(base, `/api/pool/upstreams/${upstream.id}`, providerSession, {
        method: 'PATCH',
        body: JSON.stringify({ projectId: 'updated-ais-project', projectKey: 'updated-ais-key' })
      });
      assert.equal(projectUpdated.response.status, 200);
      assert.equal(projectUpdated.body.upstream.projectId, 'updated-ais-project');
      assert.equal(store.get(upstream.id).projectId, 'updated-ais-project');
      assert.equal(store.credentials(upstream.id).projectKey, 'updated-ais-key');

      const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 6 }, store);
      const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id }, store);
      const session = sharingStore.approveTicket(provider.id, ticket.id, {}, store);
      assert.equal(session.upstream.quotaSource, 'ais');
      sharingStore.settleSession(session.id, 'ais-settlement', 2_000_000);

      const listed = await request(base, '/api/pool/upstreams', providerSession);
      assert.equal(listed.response.status, 200);
      assert.equal(listed.body.upstreams[0].commitment.actualQuotaDollars, null);
      assert.equal(listed.body.upstreams[0].commitment.offerableQuotaDollars, null);
      assert.equal(listed.body.upstreams[0].commitment.totalCommitmentDollars, 4);
      assert.equal(listed.body.upstreams[0].email, provider.email);
      const nextOffer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 5 }, store);
      assert.equal(nextOffer.isUnderfunded, false);

      const removedBudgetEndpoint = await request(base, `/api/pool/upstreams/${upstream.id}/manual-budget`, providerSession, {
        method: 'PUT',
        body: JSON.stringify({ quotaDollars: 20 })
      });
      assert.equal(removedBudgetEndpoint.response.status, 404);

      const rejected = await request(base, '/api/pool/upstreams/ais', providerSession, {
        method: 'POST',
        body: JSON.stringify({ projectId: 'invalid-ais-project' })
      });
      assert.equal(rejected.response.status, 400);
      assert.match(rejected.body.error.message, /projectKey is required/);
      for (const invalid of [
        { projectKey: 'valid-key' },
        { projectId: 'invalid-ais-project', projectKey: 42 }
      ]) {
        const invalidProject = await request(base, '/api/pool/upstreams/ais', providerSession, {
          method: 'POST',
          body: JSON.stringify(invalid)
        });
        assert.equal(invalidProject.response.status, 400);
        assert.match(invalidProject.body.error.message, /projectId is required|projectKey is required/);
      }
      assert.deepEqual(sharingStore.listAccountUpstreamLinks(provider.id).map((link) => link.upstreamId), [upstream.id]);
      assert.equal(store.list().length, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy AISwitch links show the signed-in provider email', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-aiswitch-owner-api-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'compass', projectId: 'aiswitch-project', projectKey: 'test-key', quotaSource: 'aiswitch' });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'aiswitch-provider');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const session = sharingStore.createAccountSession(provider.id);
    const server = createServer(createApp({ store, productStore: sharingStore }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const listed = await request(`http://127.0.0.1:${server.address().port}`, '/api/pool/upstreams', session);
      assert.equal(listed.response.status, 200);
      assert.equal(listed.body.upstreams[0].email, provider.email);
      assert.equal(listed.body.upstreams[0].name, provider.email);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Pool clears legacy AIS spending caps when it starts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-ais-legacy-cap-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({
      type: 'compass',
      quotaSource: 'ais',
      projectId: 'legacy-ais-project',
      projectKey: 'legacy-ais-key'
    });
    store.setCap(upstream.id, { capDollars: 1_000_000 });
    assert.equal(store.getPublic(upstream.id).spending.capDollars, 1_000_000);

    createApp({ store, productStore: new ProductStore(dir) });

    assert.equal(store.getPublic(upstream.id).spending.capDollars, 0);
    assert.equal(store.get(upstream.id).spending.capStartedAt, null);
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

test('Pool treats Claude quota as unknown even when the gateway has reported usage data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-claude-quota-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({
      type: 'claude',
      accessToken: 'sk-ant-oat-pool-quota',
      metadata: { skip_account_profile: true }
    });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'claude-quota-provider');
    sharingStore.linkUpstream(provider.id, upstream.id);
    store.setQuota(upstream.id, {
      label: 'Claude extra usage',
      usedPercent: 50,
      remainingPercent: 50,
      remainingUnits: null,
      limitUnits: null,
      remainingDollars: 5,
      limitDollars: 10,
      windowSeconds: 3600,
      resetAt: null,
      observedAt: new Date().toISOString(),
      source: 'claude_usage_api'
    });

    let refreshRequests = 0;
    const results = await refreshAllQuotas(store, {
      fetchImpl: async () => {
        refreshRequests += 1;
        throw new Error('Claude quota must not be refreshed by QuotaHub');
      }
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].value, null);
    assert.equal(refreshRequests, 0);
    assert.equal(store.getPublic(upstream.id).quota.remainingDollars, 5);
    const summary = sharingStore.providerSummary(provider.id, upstream.id, store);
    assert.equal(summary.commitment.actualQuotaDollars, null);
    assert.equal(summary.commitment.offerableQuotaDollars, null);
    assert.equal(sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 999 }, store).quotaDollars, 999);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('linking a Claude setup token uses the signed-in QuotaHub email when profile access is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-claude-setup-email-'));
  try {
    const store = new Store(dir);
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'claude-setup-owner');
    const session = sharingStore.createAccountSession(provider.id);
    const server = createServer(createApp({
      store,
      productStore: sharingStore,
      fetchImpl: async () => new Response(JSON.stringify({
        error: { details: { required_scopes: ['user:profile'] } }
      }), { status: 403 })
    }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const linked = await request(base, '/api/pool/upstreams/claude', session, {
        method: 'POST',
        body: JSON.stringify({ token: 'sk-ant-oat-setup-token' })
      });
      assert.equal(linked.response.status, 201);
      assert.equal(linked.body.upstream.email, provider.email);

      const upstreams = await request(base, '/api/pool/upstreams', session);
      assert.equal(upstreams.response.status, 200);
      assert.equal(upstreams.body.upstreams.length, 1);
      assert.equal(upstreams.body.upstreams[0].email, provider.email);
      assert.equal(upstreams.body.upstreams[0].name, provider.email);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provider can manually refresh delayed Claude quota as the primary sharing balance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-claude-advisory-quota-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({
      type: 'claude',
      accessToken: 'sk-ant-oat-pool-advisory',
      metadata: { skip_account_profile: true }
    });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'claude-advisory-provider');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const session = sharingStore.createAccountSession(provider.id);
    const server = createServer(createApp({
      store,
      productStore: sharingStore,
      advisoryQuotaClient: {
        enabled: true,
        async query(email, providers) {
          assert.equal(email, provider.email);
          assert.deepEqual(providers, ['claude']);
          return [{
            provider: 'claude',
            found: true,
            quotaMonth: 202609,
            usageDollars: 5,
            limitDollars: 20,
            remainingDollars: 15,
            reportedAt: '2026-09-18T12:00:00.000Z',
            dataThroughAt: '2026-09-18T11:00:00.000Z',
            delaySeconds: 3600,
            source: 'loop_ai_usage'
          }];
        }
      }
    }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const result = await request(base, `/api/pool/upstreams/${upstream.id}/refresh-quota`, session, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.advisory, true);
      assert.equal(result.body.upstream.advisoryQuota.remainingDollars, 15);
      assert.equal(result.body.upstream.quota.remainingDollars, 15);
      assert.equal(result.body.upstream.quota.source, 'loop_ai_usage');
      assert.equal(sharingStore.providerSummary(provider.id, upstream.id, store).commitment.actualQuotaDollars, 15);
      assert.throws(
        () => sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 16 }, store),
        /provider’s truly offerable quota/
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
      assert.equal(result.body.quotaRequest.message, null);
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

      const otherAccount = account(sharingStore, 'other-account');
      const otherSession = sharingStore.createAccountSession(otherAccount.id);

      await request(base, `/api/pool/providers/${upstream.id}/resume`, providerSession, {
        method: 'POST',
        body: '{}'
      });

      result = await request(base, '/api/pool/quota-requests', consumerSession, {
        method: 'POST',
        body: JSON.stringify({ quotaDollars: 4, message: 'x'.repeat(501) })
      });
      assert.equal(result.response.status, 400);
      assert.match(result.body.error.message, /quota request message must be 500 characters or fewer/);

      result = await request(base, '/api/pool/quota-requests', consumerSession, {
        method: 'POST',
        body: JSON.stringify({
          quotaDollars: 4,
          message: '  Please help, I need some quota for my tasks  ',
          visibility: 'restricted',
          allowedEmails: ['reliability-provider@example.com']
        })
      });
      assert.equal(result.response.status, 201);
      assert.equal(result.body.quotaRequest.message, 'Please help, I need some quota for my tasks');
      assert.equal(result.body.quotaRequest.visibility, 'restricted');
      assert.deepEqual(result.body.quotaRequest.allowedEmails, ['reliability-provider@example.com']);
      const restrictedQuotaRequestId = result.body.quotaRequest.id;

      result = await request(base, '/api/pool/quota-requests', providerSession);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.quotaRequests.some((quotaRequest) => quotaRequest.id === restrictedQuotaRequestId), true);
      assert.equal(result.body.quotaRequests.find((quotaRequest) => quotaRequest.id === restrictedQuotaRequestId).message,
        'Please help, I need some quota for my tasks');

      result = await request(base, '/api/pool/quota-requests', otherSession);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.quotaRequests.some((quotaRequest) => quotaRequest.id === restrictedQuotaRequestId), false);

      result = await request(base, '/api/pool/quota-requests?role=mine&includePast=false', consumerSession);
      assert.equal(result.response.status, 200);
      assert.deepEqual(result.body.quotaRequests.map(({ id }) => id), [restrictedQuotaRequestId]);
      assert.equal(result.body.totalItems, 1);
      assert.equal((await request(base, '/api/pool/quota-requests?role=mine', providerSession)).body.totalItems, 0);
      assert.equal((await request(base, '/api/pool/sharing-counts', consumerSession)).body.counts['my-quota-requests'], 1);

      result = await request(base, '/api/pool/offers', providerSession, {
        method: 'POST',
        body: JSON.stringify({ upstreamId: upstream.id, quotaDollars: 2 })
      });
      assert.equal(result.response.status, 201);
      const pendingOfferId = result.body.offer.id;
      result = await request(base, '/api/pool/tickets', consumerSession, {
        method: 'POST',
        body: JSON.stringify({ offerId: pendingOfferId })
      });
      assert.equal(result.response.status, 201);
      const pendingTicketId = result.body.ticket.id;
      assert.equal(sharingStore.sqlite.prepare('SELECT demand_request_id FROM sharing_tickets WHERE id = ?').get(pendingTicketId).demand_request_id, null);
      sharingStore.sqlite.prepare('UPDATE sharing_tickets SET demand_request_id = ? WHERE id = ?')
        .run(restrictedQuotaRequestId, pendingTicketId);
      const ticketFunnelBeforeGrant = sharingStore.adminAnalytics().tickets;

      result = await request(base, `/api/pool/quota-requests/${restrictedQuotaRequestId}/grant`, providerSession, {
        method: 'POST',
        body: JSON.stringify({ upstreamId: upstream.id, quotaDollars: 1.5 })
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.session.grantedQuotaDollars, 1.5);
      assert.throws(
        () => sharingStore.offer(result.body.session.offerId, provider.id, store),
        (error) => error.statusCode === 404
      );
      assert.equal(result.body.quotaRequest.status, 'fulfilled');
      assert.equal(result.body.replacementQuotaRequest.quotaDollars, 2.5);
      assert.equal(result.body.replacementQuotaRequest.message, 'Please help, I need some quota for my tasks');
      assert.equal(result.body.replacementQuotaRequest.visibility, 'restricted');
      assert.deepEqual(sharingStore.adminAnalytics().tickets, ticketFunnelBeforeGrant);
      const directGrantEvent = sharingStore.sqlite.prepare(`
        SELECT actor_account_id, detail_json
        FROM sharing_events
        WHERE entity_type = 'direct_grant' AND entity_id = ? AND action = 'created'
      `).get(result.body.session.id);
      assert.equal(directGrantEvent.actor_account_id, provider.id);
      assert.deepEqual(JSON.parse(directGrantEvent.detail_json), {
        quotaRequestId: restrictedQuotaRequestId,
        grantedMicros: 1_500_000,
        replacementRequestId: result.body.replacementQuotaRequest.id
      });
      assert.equal(sharingStore.adminAnalytics().recentEvents.some((event) => (
        event.entityType === 'direct_grant' && event.action === 'created'
      )), true);
      const replacementRequestId = result.body.replacementQuotaRequest.id;
      assert.equal(sharingStore.sqlite.prepare('SELECT status FROM sharing_tickets WHERE id = ?').get(pendingTicketId).status, 'pending');
      assert.equal(sharingStore.sqlite.prepare(`
        SELECT sharing_tickets.demand_request_id
        FROM sharing_tickets JOIN sharing_offers ON sharing_offers.id = sharing_tickets.offer_id
        WHERE sharing_offers.internal_only = 1
      `).get().demand_request_id, null);

      result = await request(base, '/api/pool/offers', providerSession, {
        method: 'POST',
        body: JSON.stringify({ upstreamId: upstream.id, quotaDollars: 1 })
      });
      assert.equal(result.response.status, 201);
      result = await request(base, '/api/pool/tickets', consumerSession, {
        method: 'POST',
        body: JSON.stringify({ offerId: result.body.offer.id })
      });
      assert.equal(result.response.status, 201);
      const siblingTicketId = result.body.ticket.id;
      sharingStore.sqlite.prepare('UPDATE sharing_tickets SET demand_request_id = ? WHERE id IN (?, ?)')
        .run(replacementRequestId, pendingTicketId, siblingTicketId);
      result = await request(base, `/api/pool/tickets/${pendingTicketId}/approve`, providerSession, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(result.response.status, 200);
      assert.equal(sharingStore.sqlite.prepare('SELECT status FROM sharing_tickets WHERE id = ?').get(siblingTicketId).status, 'pending');
      assert.equal(sharingStore.quotaRequest(replacementRequestId, consumer.id).status, 'active');
      assert.equal(sharingStore.listSessions(consumer.id, store).length, 2);
      assert.deepEqual(sharingStore.adminAnalytics().tickets, {
        ...ticketFunnelBeforeGrant,
        total: ticketFunnelBeforeGrant.total + 1,
        approved: ticketFunnelBeforeGrant.approved + 1
      });
      assert.equal(sharingStore.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM sharing_offers WHERE internal_only = 1'
      ).get().count, 1);
      assert.equal(sharingStore.listOffers(provider.id, store).some((offer) => offer.internalOnly), false);

      result = await request(base, '/api/pool/quota-requests?role=mine&includePast=false', consumerSession);
      assert.deepEqual(result.body.quotaRequests.map(({ id }) => id), [replacementRequestId]);
      result = await request(base, `/api/pool/quota-requests/${replacementRequestId}/grant`, providerSession, {
        method: 'POST',
        body: JSON.stringify({ upstreamId: upstream.id, quotaDollars: 3 })
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.session.grantedQuotaDollars, 3);
      assert.equal(result.body.quotaRequest.status, 'fulfilled');
      assert.equal(result.body.replacementQuotaRequest, null);
      assert.deepEqual(sharingStore.adminAnalytics().tickets, {
        ...ticketFunnelBeforeGrant,
        total: ticketFunnelBeforeGrant.total + 1,
        approved: ticketFunnelBeforeGrant.approved + 1
      });
      assert.equal(sharingStore.sqlite.prepare('SELECT status FROM sharing_tickets WHERE id = ?').get(siblingTicketId).status, 'pending');

      result = await request(base, '/api/pool/offers', providerSession, {
        method: 'POST',
        body: JSON.stringify({
          upstreamId: upstream.id,
          quotaDollars: 5,
          visibility: 'restricted',
          allowedEmails: ['reliability-consumer@example.com', 'friend@example.com']
        })
      });
      assert.equal(result.response.status, 201);
      assert.equal(result.body.offer.visibility, 'restricted');
      assert.deepEqual(result.body.offer.allowedEmails, ['reliability-consumer@example.com', 'friend@example.com']);
      const restrictedOfferId = result.body.offer.id;

      result = await request(base, '/api/pool/offers', consumerSession);
      const consumerOffers = result.body.offers.filter((o) => o.id === restrictedOfferId);
      assert.equal(consumerOffers.length, 1);
      assert.equal(consumerOffers[0].visibility, 'restricted');

      result = await request(base, '/api/pool/offers', otherSession);
      const otherOffers = result.body.offers.filter((o) => o.id === restrictedOfferId);
      assert.equal(otherOffers.length, 0);

      result = await request(base, '/api/pool/tickets', otherSession, {
        method: 'POST',
        body: JSON.stringify({ offerId: restrictedOfferId })
      });
      assert.equal(result.response.status, 403);

      result = await request(base, '/api/pool/tickets', consumerSession, {
        method: 'POST',
        body: JSON.stringify({ offerId: restrictedOfferId })
      });
      assert.equal(result.response.status, 201);

      result = await request(base, `/api/pool/offers/${restrictedOfferId}`, providerSession, {
        method: 'PATCH',
        body: JSON.stringify({ visibility: 'public', allowedEmails: [] })
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.offer.visibility, 'public');
      assert.equal(result.body.offer.allowedEmails, null);

      sharingStore.setEmailNotificationsEnabled(true);
      result = await request(base, `/api/pool/upstreams/${upstream.id}`, providerSession, {
        method: 'DELETE',
        body: '{}'
      });
      assert.equal(result.response.status, 204);
      assert.equal(store.get(upstream.id), null);
      assert.equal(sharingStore.accountOwnsUpstream(provider.id, upstream.id), false);
      assert.equal(sharingStore.sqlite.prepare('SELECT status FROM sharing_offers WHERE id = ?').get(restrictedOfferId).status, 'closed');
      assert.equal(sharingStore.sqlite.prepare('SELECT status FROM sharing_tickets WHERE offer_id = ?').get(restrictedOfferId).status, 'rejected');
      assert.equal(sharingStore.sqlite.prepare(`
        SELECT subject FROM email_outbox
        WHERE account_id = ? AND subject = 'QuotaHub provider unlinked'
      `).get(consumer.id)?.subject, 'QuotaHub provider unlinked');
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
