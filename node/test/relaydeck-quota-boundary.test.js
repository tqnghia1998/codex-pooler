import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshQuota, CLAUDE_OAUTH_USAGE_URL } from '../src/providers.js';
import { refreshUpstreamQuota } from '../src/upstream-quota-refresh.js';
import { Store } from '../src/store.js';

test('shared gateway runtime imports exclude the Relaydeck employee allowance query and configuration', () => {
  const seen = new Set();
  function visit(url) {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = readFileSync(url, 'utf8');
    assert.doesNotMatch(source, /claude_enterprise_spend_limits|CLAUDE_SPEND_LIMITS|organizations\/spend_limits/);
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) visit(new URL(match[1], url));
  }
  for (const name of ['providers', 'proxy', 'store', 'upstream-quota-refresh', 'gateway-dispatch', 'codex-token-refresh']) {
    visit(new URL(`../src/${name}.js`, import.meta.url));
  }
  assert.ok(seen.size > 20);
  assert.ok(![...seen].some((url) => /\/(relaydeck-quota|claude-spend-limits)\.js$/.test(url)));
});

test('unconfigured gateway consumers ignore Relaydeck spend credentials and keep the existing OAuth path', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-quota-boundary-'));
  const mapFile = join(dir, 'private-users.json');
  writeFileSync(mapFile, JSON.stringify({ 'employee@example.com': 'user_test' }));
  const names = ['CODEX_POOLER_CLAUDE_SPEND_LIMITS_API_KEY', 'CODEX_POOLER_CLAUDE_SPEND_LIMITS_MAP_FILE'];
  const previous = names.map((name) => process.env[name]);
  process.env[names[0]] = 'relaydeck-only-key';
  process.env[names[1]] = mapFile;
  t.after(() => {
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
    rmSync(dir, { recursive: true, force: true });
  });
  const account = { type: 'claude', email: 'employee@example.com', metadata: { auth_kind: 'oauth' } };
  let calls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url, CLAUDE_OAUTH_USAGE_URL);
    assert.equal(options.headers['x-api-key'], undefined);
    calls++;
    return new Response(JSON.stringify({ five_hour: { utilization: 25 } }));
  };
  assert.equal((await refreshQuota(account, { accessToken: 'sk-ant-oat-gateway-boundary' }, { fetchImpl })).source, 'claude_oauth_usage');
  const store = new Store(dir);
  const saved = store.create({ ...account, accessToken: 'sk-ant-oat-gateway-boundary' });
  const refreshed = await refreshUpstreamQuota(store, saved.id, { fetchImpl });
  assert.equal(refreshed.quota.source, 'claude_oauth_usage');
  assert.equal(refreshed.quota.remainingPercent, 75);
  assert.equal(store.quotaPolicy, undefined);
  assert.equal(calls, 2);
});
