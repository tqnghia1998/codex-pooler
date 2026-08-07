import test from 'node:test';
import assert from 'node:assert/strict';
import { codexRefreshFailureCode, codexRefreshFailureDetail, ensureProviderCredentials, refreshQuota } from '../src/providers.js';

test('classifies invalidated Codex refresh tokens as requiring reauthentication', () => {
  assert.equal(codexRefreshFailureCode({ providerBody: { error: { code: 'refresh_token_invalidated' } } }), 'reauth_required');
});

test('extracts a safe Codex token refresh failure detail', () => {
  assert.equal(codexRefreshFailureDetail({ providerBody: { error: { message: 'Your refresh token has already been used.' } } }), 'Your refresh token has already been used.');
  assert.equal(codexRefreshFailureDetail(new Error('request failed')), 'request failed');
});

test('refreshes Codex quota using the account header', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    if (url.endsWith('/backend-api/wham/usage')) return new Response('{}', { status: 404, headers: { 'set-cookie': '__cf_bm=cookie-value; Path=/; Secure' } });
    assert.equal(options.headers.cookie, '__cf_bm=cookie-value');
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 2_592_000 } } }), { status: 200 });
  };
  const credentials = { accessToken: 'token' };
  let saved;
  const quota = await refreshQuota({ type: 'codex', baseUrl: 'https://chatgpt.example', accountId: 'acct' }, credentials, { fetchImpl, saveCredentials: (value) => { saved = value; } });
  assert.equal(quota.remainingPercent, 60);
  assert.equal(request.url, 'https://chatgpt.example/backend-api/codex/usage');
  assert.equal(request.options.headers['chatgpt-account-id'], 'acct');
  assert.equal(request.options.headers.authorization, 'Bearer token');
  assert.equal(credentials.codexCookies, '__cf_bm=cookie-value');
  assert.equal(saved, credentials);
});

test('refreshes an expired Codex access token and persists rotated credentials', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://auth.openai.com/oauth/token') {
      assert.equal(options.method, 'POST');
      assert.match(String(options.body), /grant_type=refresh_token/);
      return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 2_592_000 } } }), { status: 200 });
  };
  const upstream = { type: 'codex', baseUrl: 'https://chatgpt.example', accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() };
  const credentials = { accessToken: 'old-access', refreshToken: 'old-refresh', idToken: 'old-id' };
  let saved;
  const quota = await refreshQuota(upstream, credentials, { fetchImpl, saveCredentials: (...args) => { saved = args; } });
  assert.equal(quota.remainingPercent, 80);
  assert.equal(credentials.accessToken, 'new-access');
  assert.equal(credentials.refreshToken, 'new-refresh');
  assert.equal(credentials.idToken, 'new-id');
  assert.deepEqual(saved[0], credentials);
  assert.equal(saved[1], upstream.accessTokenExpiresAt);
  assert.equal(requests[1].options.headers.authorization, 'Bearer new-access');
});

test('refreshes after a Codex quota auth rejection when the expiry is unknown', async () => {
  let quotaCalls = 0;
  const quotaHeaders = [];
  const fetchImpl = async (url, options) => {
    if (url === 'https://auth.openai.com/oauth/token') return new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200 });
    quotaCalls += 1;
    quotaHeaders.push(options.headers.authorization);
    if (quotaCalls === 1) return new Response('{}', { status: 403 });
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 2_592_000 } } }), { status: 200 });
  };
  const credentials = { accessToken: 'old-access', refreshToken: 'refresh' };
  const quota = await refreshQuota({ type: 'codex', baseUrl: 'https://chatgpt.example' }, credentials, { fetchImpl });
  assert.equal(quota.remainingPercent, 95);
  assert.equal(quotaCalls, 2);
  assert.deepEqual(quotaHeaders, ['Bearer old-access', 'Bearer new-access']);
  assert.equal(credentials.accessToken, 'new-access');
});

test('coalesces concurrent Codex token refreshes for one upstream', async () => {
  let refreshCalls = 0;
  const fetchImpl = async () => {
    refreshCalls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return new Response(JSON.stringify({ access_token: 'shared-access', refresh_token: 'shared-refresh', expires_in: 3600 }), { status: 200 });
  };
  const expiry = new Date(Date.now() - 1_000).toISOString();
  const firstUpstream = { id: 'same-upstream', type: 'codex', accessTokenExpiresAt: expiry };
  const secondUpstream = { id: 'same-upstream', type: 'codex', accessTokenExpiresAt: expiry };
  const first = { accessToken: 'old', refreshToken: 'refresh' };
  const second = { accessToken: 'old', refreshToken: 'refresh' };
  await Promise.all([
    ensureProviderCredentials(firstUpstream, first, { fetchImpl }),
    ensureProviderCredentials(secondUpstream, second, { fetchImpl })
  ]);
  assert.equal(refreshCalls, 1);
  assert.equal(first.accessToken, 'shared-access');
  assert.equal(second.accessToken, 'shared-access');
  assert.equal(first.refreshToken, 'shared-refresh');
  assert.equal(second.refreshToken, 'shared-refresh');
});

test('does not attempt AISwitch quota refresh without its SSO session', async () => {
  await assert.rejects(
    refreshQuota({ type: 'compass', projectId: 'aiswitch', projectKey: 'key', quotaSource: 'aiswitch' }, {}, { fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /AISwitch quota requires a Compass SSO session/
  );
});

test('refreshes Compass project quota with the gateway token', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ retcode: 0, data: { project: {
      budget_type: 'recurring', quota_detail: { applied_balance: 10, balance: 8 }
    }}}), { status: 200 });
  };
  const quota = await refreshQuota({ type: 'compass', baseUrl: 'https://compass.example/v1', projectId: 'hello world' }, {}, { compassGatewayToken: 'gateway', fetchImpl });
  assert.equal(quota.remainingPercent, 80);
  assert.equal(request.url, 'https://compass.example/v1/open_project/detail/hello%20world');
  assert.equal(request.options.headers.authorization, 'Bearer gateway');
});
