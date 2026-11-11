import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { CLAUDE_SPEND_LIMITS_URL, claudeSpendLimitsConfigFromEnv, validateClaudeEmployeeMap, parseClaudeSpendAllowance, queryClaudeSpendAllowance, refreshClaudeSpendAllowance } from '../src/claude-spend-limits.js';
import { refreshQuota, CLAUDE_OAUTH_USAGE_URL } from '../src/providers.js';
import { Store } from '../src/store.js';
import { createApp, refreshAllQuotas } from '../src/server.js';
import { refreshUpstreamQuota } from '../src/upstream-quota-refresh.js';

const map = { 'employee@example.com': 'user_test' };
const row = (values = {}) => ({
  actor: { email_address: 'employee@example.com', user_id: 'user_test' },
  currency: 'USD', period: 'monthly', amount: '20000', period_to_date_spend: '1118.373', ...values
});
const upstream = { id: 'enterprise', type: 'claude', email: 'employee@example.com', metadata: { auth_kind: 'oauth' } };
const credentials = { accessToken: 'sk-ant-oat-enterprise' };
const json = (body, options) => new Response(JSON.stringify(body), options);

function catalog(t) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-spend-limits-'));
  const mapFile = join(dir, 'users.json');
  writeFileSync(mapFile, JSON.stringify(map));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, apiKey: 'private-spend-reader', mapFile };
}

test('parses exact decimal cents, clamps overspend, and distinguishes zero and unlimited caps', () => {
  const quota = parseClaudeSpendAllowance([row()], new Date(0));
  assert.equal(quota.remainingDollars, 188.81627);
  assert.equal(quota.limitDollars, 200);
  assert.equal(quota.usedDollars, 11.18373);
  assert.equal(quota.remainingPercent, 94.408135);
  assert.equal(quota.source, 'claude_enterprise_spend_limits');
  assert.equal(quota.observedAt, new Date(0).toISOString());
  assert.equal(quota.resetAt, null);
  assert.equal(parseClaudeSpendAllowance([row({ amount: '100', period_to_date_spend: '101' })]).remainingDollars, 0);
  assert.equal(parseClaudeSpendAllowance([row({ amount: '0', period_to_date_spend: '0' })]).remainingPercent, 0);
  assert.ok(parseClaudeSpendAllowance([row({ amount: '1000000', period_to_date_spend: '999999.999' })]).remainingPercent > 0);
  const unlimited = parseClaudeSpendAllowance([row({ amount: null })]);
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.remainingPercent, null);
  assert.equal(unlimited.remainingDollars, null);
  const otherCurrency = parseClaudeSpendAllowance([row({ currency: 'SGD' })]);
  assert.equal(otherCurrency.remainingDollars, null);
  assert.equal(otherCurrency.remainingUnits, 18881.627);
  assert.equal(otherCurrency.currency, 'SGD');
});

test('selects the tightest finite period and retains all periods without hiding exhaustion', () => {
  const quota = parseClaudeSpendAllowance([
    row({ period: 'daily', amount: '100', period_to_date_spend: '101' }),
    row({ amount: null }), row({ period: 'yearly' })
  ]);
  assert.equal(quota.key, 'spend_daily');
  assert.equal(quota.remainingPercent, 0);
  assert.equal(quota.windows.length, 3);
  assert.equal(parseClaudeSpendAllowance([row({ period: 'yearly' }), row()]).key, 'spend_monthly');
});

test('rejects malformed money, currencies, periods, and unsafe precision instead of reporting zero', () => {
  for (const amount of [1, '', '-1', '1.2345', 'Infinity', '1e3', '1.', '9007199254741']) {
    assert.throws(() => parseClaudeSpendAllowance([row({ amount })]), /spend amount|precision/i);
  }
  assert.throws(() => parseClaudeSpendAllowance([row({ period_to_date_spend: null })]), /spend amount/);
  assert.throws(() => parseClaudeSpendAllowance([row({ currency: null })]), /currency/);
  assert.throws(() => parseClaudeSpendAllowance([row({ period: undefined })]), /period/);
  assert.throws(() => parseClaudeSpendAllowance([]), /No Claude/);
});

test('validates the catalog and supports explicit configuration namespaces', () => {
  assert.equal(validateClaudeEmployeeMap(map), map);
  for (const value of [null, [], { 'Employee@example.com': 'user_test' }, { 'employee@example.com': 'bad-id' }]) {
    assert.throws(() => validateClaudeEmployeeMap(value), /Invalid Claude/);
  }
  assert.deepEqual(claudeSpendLimitsConfigFromEnv({ POOL_CLAUDE_SPEND_LIMITS_API_KEY: 'key', POOL_CLAUDE_SPEND_LIMITS_MAP_FILE: '/private/map' }, 'POOL_'), { apiKey: 'key', mapFile: '/private/map' });
});

test('uses filtered pagination, exact email plus ID matching, and fresh balances on every query', async () => {
  const filters = [];
  const quota = await queryClaudeSpendAllowance('EMPLOYEE@example.com', map, async (page, userId) => {
    filters.push({ page, userId });
    return page ? { data: [row()], next_page: null } : { data: [row({ actor: { email_address: 'other@example.com', user_id: 'user_test' } })], next_page: 'next' };
  });
  assert.equal(quota.remainingDollars, 188.81627);
  assert.deepEqual(filters, [{ page: undefined, userId: 'user_test' }, { page: 'next', userId: 'user_test' }]);
  let spent = 0;
  const fetchPage = async () => ({ data: [row({ period_to_date_spend: String(++spent) })] });
  assert.equal((await queryClaudeSpendAllowance('employee@example.com', map, fetchPage)).usedDollars, 0.01);
  assert.equal((await queryClaudeSpendAllowance('employee@example.com', map, fetchPage)).usedDollars, 0.02);
});

test('unknown employees fail before requesting; missing or mismatched records are not zero balances', async () => {
  let calls = 0;
  await assert.rejects(queryClaudeSpendAllowance('unknown@example.com', map, () => { calls++; }), /not found/);
  assert.equal(calls, 0);
  for (const data of [[], [row({ actor: { email_address: 'employee@example.com', user_id: 'user_wrong' } })], [row({ actor: { email_address: 'other@example.com', user_id: 'user_test' } })]]) {
    await assert.rejects(queryClaudeSpendAllowance('employee@example.com', map, async () => ({ data, next_page: null })), /does not mean zero/);
  }
  await assert.rejects(queryClaudeSpendAllowance('employee@example.com', map, async () => ({})), /data is not an array/);
  await assert.rejects(queryClaudeSpendAllowance('employee@example.com', map, async () => ({ data: [], next_page: 'same' })), /repeated/);
  await assert.rejects(queryClaudeSpendAllowance('employee@example.com', map, async () => ({ data: [], next_page: 3 })), /cursor/);
});

test('Enterprise quota uses only the scoped administrative GET, never OAuth credentials or a Messages probe', async (t) => {
  const config = catalog(t);
  let calls = 0;
  const options = { claudeSpendLimits: config, fetchImpl: async (url, request) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, CLAUDE_SPEND_LIMITS_URL);
    assert.equal(parsed.searchParams.get('user_ids[]'), 'user_test');
    assert.equal(parsed.searchParams.get('limit'), '1');
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['x-api-key'], config.apiKey);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.redirect, 'error');
    return json({ data: [row({ period_to_date_spend: String(calls) })] });
  } };
  const expired = { ...upstream, accessTokenExpiresAt: new Date(0).toISOString() };
  assert.equal((await refreshQuota(expired, credentials, options)).usedDollars, 0.01);
  assert.equal((await refreshQuota(expired, credentials, options)).usedDollars, 0.02);
  assert.equal(calls, 2);
});

test('unmapped employees retain OAuth behavior; invalid or incomplete configuration fails before network access', async (t) => {
  const config = catalog(t);
  const quota = await refreshQuota({ ...upstream, email: 'unmapped@example.com' }, credentials, {
    claudeSpendLimits: config,
    fetchImpl: async (url) => {
      assert.equal(url, CLAUDE_OAUTH_USAGE_URL);
      return json({ five_hour: { utilization: 25 } });
    }
  });
  assert.equal(quota.source, 'claude_oauth_usage');
  const fetchImpl = async () => { throw new Error('must not fetch'); };
  await assert.rejects(refreshClaudeSpendAllowance(upstream, { apiKey: config.apiKey, fetchImpl }), /require both/);
  writeFileSync(config.mapFile, '{invalid');
  await assert.rejects(refreshClaudeSpendAllowance(upstream, { ...config, fetchImpl }), /valid Claude employee catalog/);
});

test('redacts provider and transport errors and never retries the OAuth token for an administrative 401', async (t) => {
  const config = catalog(t);
  for (const status of [401, 403, 500]) {
    let calls = 0;
    await assert.rejects(refreshQuota({ ...upstream, id: `admin-error-${status}` }, { ...credentials, refreshToken: 'oauth-refresh' }, {
      claudeSpendLimits: config, force: true,
      fetchImpl: async () => { calls++; return json({ error: config.apiKey }, { status }); }
    }), (error) => error.statusCode === status && !JSON.stringify(error).includes(config.apiKey) && !error.message.includes(config.apiKey));
    assert.equal(calls, 1);
  }
  await assert.rejects(refreshClaudeSpendAllowance(upstream, { ...config, fetchImpl: async () => { throw new Error(config.apiKey); } }), (error) => !error.message.includes(config.apiKey));
});

test('honors administrative rate-limit cooldowns while preserving the prior allowance', async (t) => {
  const config = catalog(t);
  const previous = parseClaudeSpendAllowance([row()]);
  const account = { ...upstream, id: 'enterprise-rate-limit', quota: previous };
  let calls = 0;
  const options = { claudeSpendLimits: config, fetchImpl: async () => { calls++; return json({}, { status: 429, headers: { 'retry-after': '60' } }); } };
  assert.equal(await refreshQuota(account, credentials, options), previous);
  assert.equal(await refreshQuota(account, credentials, options), previous);
  await assert.rejects(refreshQuota(account, credentials, { ...options, force: true }), (error) => error.statusCode === 429);
  assert.equal(calls, 1);
});

test('management create, manual and bulk refresh persist fresh allowances and preserve them on errors', async (t) => {
  const config = catalog(t);
  const names = ['CODEX_POOLER_CLAUDE_SPEND_LIMITS_API_KEY', 'CODEX_POOLER_CLAUDE_SPEND_LIMITS_MAP_FILE'];
  const previous = names.map((name) => process.env[name]);
  process.env[names[0]] = config.apiKey;
  process.env[names[1]] = config.mapFile;
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  const store = new Store(config.dir);
  let calls = 0;
  let fail = false;
  const fetchImpl = async (url) => {
    if (url === 'https://api.anthropic.com/api/oauth/profile') return json({ account: { email: 'employee@example.com' } });
    assert.ok(url.startsWith(CLAUDE_SPEND_LIMITS_URL));
    calls++;
    return fail ? json({ error: config.apiKey }, { status: 403 }) : json({ data: [row({ period_to_date_spend: String(calls * 100) })] });
  };
  const server = createServer(createApp({ store, apiKey: 'client', fetchImpl }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${base}/api/upstreams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'claude', accessToken: credentials.accessToken }) }).then((response) => response.json());
  const id = created.upstream.id;
  assert.equal(created.upstream.quota.remainingDollars, 199);
  const refresh = () => fetch(`${base}/api/upstreams/${id}/refresh-quota`, { method: 'POST' });
  assert.equal((await (await refresh()).json()).upstream.quota.remainingDollars, 198);
  await refreshAllQuotas(store, { fetchImpl });
  assert.equal(store.get(id).quota.remainingDollars, 197);
  const retained = store.get(id).quota;
  fail = true;
  const failure = await refresh();
  assert.equal(failure.ok, false);
  assert.ok(!(await failure.text()).includes(config.apiKey));
  assert.deepEqual(store.get(id).quota, retained);
});

test('allowance writes use the existing credential-generation fence', async (t) => {
  const config = catalog(t);
  const store = new Store(config.dir);
  const account = store.create({ ...upstream, accessToken: credentials.accessToken });
  await refreshUpstreamQuota(store, account.id, {
    claudeSpendLimits: config, fetchImpl: async () => {
      store.update(account.id, { email: 'replacement@example.com', accessToken: 'sk-ant-oat-replaced' });
      return json({ data: [row()] });
    }
  });
  assert.equal(store.get(account.id).quota, null);
});

test('administrative allowance reads cannot clear OAuth reauthentication requirements', async (t) => {
  const config = catalog(t);
  const store = new Store(config.dir);
  const account = store.create({ ...upstream, accessToken: credentials.accessToken });
  store.setCap(account.id, { capDollars: 100 });
  const admission = store.beginUpstreamAttempt(account.id, { routeClass: 'proxy_http', model: '' });
  store.settleUpstreamAttempt(account.id, admission, { class: 'credential', retryable: true });
  assert.equal(store.get(account.id).health.status, 'reauth_required');
  await refreshUpstreamQuota(store, account.id, { claudeSpendLimits: config, fetchImpl: async () => json({ data: [row()] }) });
  assert.equal(store.get(account.id).quota.remainingDollars, 188.81627);
  assert.equal(store.get(account.id).health.status, 'reauth_required');
  assert.equal(store.beginUpstreamAttempt(account.id, { routeClass: 'proxy_http', model: '' }), null);
});

test('changed employee identity invalidates stored and in-flight administrative allowance observations', async (t) => {
  const config = catalog(t);
  const store = new Store(config.dir);
  const account = store.create({ ...upstream, accessToken: credentials.accessToken });
  store.setQuota(account.id, parseClaudeSpendAllowance([row()]));
  await refreshUpstreamQuota(store, account.id, {
    claudeSpendLimits: config,
    fetchImpl: async () => {
      store.persistClaudeIdentity(account.id, { email: 'replacement@example.com' });
      assert.equal(store.get(account.id).quota, null);
      return json({ data: [row()] });
    }
  });
  assert.equal(store.get(account.id).quota, null);
});
