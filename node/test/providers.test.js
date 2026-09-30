import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_OAUTH_USAGE_URL, codexRefreshFailureCode, codexRefreshFailureDetail, ensureProviderCredentials, refreshQuota } from '../src/providers.js';

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

test('retries transient Claude OAuth refresh failures and refreshes advisory identity', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url === 'https://platform.claude.com/v1/oauth/token') {
      if (requests.filter((candidate) => candidate === url).length === 1) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ access_token: 'claude-new-access', refresh_token: 'claude-new-refresh', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ account: { uuid: 'account-after-refresh', email: 'refreshed@example.com' }, organization: { uuid: 'org-after-refresh', name: 'Refreshed Org' } }), { status: 200 });
  };
  const upstream = { id: 'claude-refresh-retry', type: 'claude', accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() };
  const credentials = { accessToken: 'claude-old-access', refreshToken: 'claude-refresh-retry-token' };
  await ensureProviderCredentials(upstream, credentials, { fetchImpl });
  assert.deepEqual(requests, [
    'https://platform.claude.com/v1/oauth/token',
    'https://platform.claude.com/v1/oauth/token',
    'https://api.anthropic.com/api/oauth/profile'
  ]);
  assert.equal(credentials.accessToken, 'claude-new-access');
  assert.equal(upstream.accountId, 'account-after-refresh');
  assert.equal(upstream.email, 'refreshed@example.com');
});

test('blocks repeated Claude OAuth refresh attempts after a 429', async () => {
  let refreshCalls = 0;
  const fetchImpl = async () => {
    refreshCalls += 1;
    return new Response('{}', { status: 429, headers: { 'retry-after': '60' } });
  };
  const upstream = { id: 'claude-refresh-429', type: 'claude', accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() };
  const first = { accessToken: 'claude-old-access', refreshToken: 'claude-refresh-429-token' };
  const second = { accessToken: 'claude-old-access', refreshToken: 'claude-refresh-429-token' };
  await assert.rejects(ensureProviderCredentials(upstream, first, { fetchImpl }), (error) => error.statusCode === 429);
  await assert.rejects(ensureProviderCredentials(upstream, second, { fetchImpl }), (error) => error.statusCode === 429);
  assert.equal(refreshCalls, 1);
});

test('keeps the last known Claude quota when the header probe is rate limited', async () => {
  const quota = { remainingPercent: 70, source: 'claude_oauth_headers', observedAt: new Date(0).toISOString() };
  const upstream = {
    id: 'claude-quota-rate-limited',
    type: 'claude',
    baseUrl: 'https://api.anthropic.com',
    metadata: { auth_kind: 'oauth' },
    quota
  };
  let messagesCalls = 0;
  const options = {
    force: false,
    fetchImpl: async (url) => {
      if (url === CLAUDE_OAUTH_USAGE_URL) return new Response(JSON.stringify({ error: { details: { required_scopes: ['user:profile'], error_code: 'oauth_scope_insufficient' } } }), { status: 403 });
      messagesCalls += 1;
      return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited' } }), { status: 429, headers: { 'retry-after': '600' } });
    }
  };
  const result = await refreshQuota(upstream, { accessToken: 'sk-ant-oat-quota-rate-limited' }, options);
  const repeated = await refreshQuota(upstream, { accessToken: 'sk-ant-oat-quota-rate-limited' }, options);
  assert.equal(result, quota);
  assert.equal(repeated, quota);
  assert.equal(messagesCalls, 1);
});

test('does not attempt AIS quota refresh without its SSO session', async () => {
  await assert.rejects(
    refreshQuota({ type: 'compass', projectId: 'ais', projectKey: 'key', quotaSource: 'ais' }, {}, { fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /AIS quota requires a Compass SSO session/
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
