import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstream, deriveClaudeAccountId, dollarsToCredits, filterSpendCapEligible, parseClaudeQuota, parseClaudeQuotaHeaders, parseCodexAuthJson, parseCodexQuota, parseCompassQuota, publicUpstream, recordUsage, setSpendingCap, spendingSummary } from '../src/domain.js';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('imports the useful fields from Codex auth.json', () => {
  const auth = parseCodexAuthJson(JSON.stringify({ tokens: {
    access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } }),
    refresh_token: 'refresh',
    id_token: jwt({ sub: 'person-1', iss: 'https://auth.openai.com', email: 'person@example.com' })
  }}));
  assert.equal(auth.accessToken.startsWith('header.'), true);
  assert.equal(auth.accountId, 'acct-1');
  assert.equal(auth.email, 'person@example.com');
  assert.equal(auth.subject, 'person-1');
  assert.equal(auth.issuer, 'https://auth.openai.com');
  assert.equal(auth.name, 'p5dymc');
});

test('derives names and provider URLs instead of accepting operator labels', () => {
  const codex = createUpstream({
    type: 'codex',
    name: 'ignored',
    baseUrl: 'https://custom.invalid',
    authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'person@example.com' }),
      id_token: jwt({ email: 'person@example.com' })
    }})
  });
  const compass = createUpstream({ type: 'compass', name: 'ignored', baseUrl: 'https://custom.invalid', projectId: 'project-1', projectKey: 'key' });
  assert.equal(codex.name, 'p5dymc');
  assert.equal(publicUpstream(codex).email, 'person@example.com');
  assert.equal(codex.baseUrl, 'https://chatgpt.com');
  assert.equal(compass.name, 'project-1');
  assert.equal(compass.baseUrl, 'https://compass.llm.shopee.io/compass-api/v1');
});

test('preserves CPA-compatible Claude base URLs while rejecting malformed targets', () => {
  const parsed = createUpstream({
    type: 'claude',
    base_url: 'https://claude-gateway.example/compat',
    authJson: JSON.stringify({ access_token: 'sk-ant-oat-base-url-test' })
  });
  assert.equal(parsed.baseUrl, 'https://claude-gateway.example/compat');
  assert.equal(publicUpstream(parsed).baseUrl, parsed.baseUrl);

  const malformed = createUpstream({
    type: 'claude',
    baseUrl: 'not a URL',
    projectKey: 'sk-ant-api-base-url-test'
  }, { allowLegacyClaudeApiKey: true });
  assert.equal(malformed.baseUrl, 'https://api.anthropic.com');
});

test('rejects Claude API-key credential shapes by default', () => {
  assert.throws(
    () => createUpstream({ type: 'claude', accessToken: 'sk-ant-api-key' }),
    /Enterprise OAuth credentials/
  );
  assert.throws(
    () => createUpstream({ type: 'claude', accessToken: 'opaque-key', metadata: { auth_kind: 'claude_api_key' } }),
    /Enterprise OAuth credentials/
  );
});

test('derives a stable local Claude account UUID from the credential token', () => {
  const first = deriveClaudeAccountId({ refreshToken: 'refresh-a', accessToken: 'access-a' });
  const rotated = deriveClaudeAccountId({ refreshToken: 'refresh-a', accessToken: 'access-b' });
  const different = deriveClaudeAccountId({ refreshToken: 'refresh-b', accessToken: 'access-a' });
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(rotated, first);
  assert.notEqual(different, first);
  assert.equal(createUpstream({ type: 'claude', accessToken: 'sk-ant-oat-local-id', refreshToken: 'refresh-local-id' }).accountId, deriveClaudeAccountId({ accessToken: 'sk-ant-oat-local-id', refreshToken: 'refresh-local-id' }));
});

test('selects a monthly Codex window and reports remaining percent', () => {
  const quota = parseCodexQuota({ rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 2_592_000, reset_after_seconds: 60 }
  }});
  assert.equal(quota.label, 'Monthly quota');
  assert.equal(quota.remainingPercent, 75);
  assert.ok(quota.resetAt);
  const unixReset = parseCodexQuota({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 2_592_000, reset_at: 1_800_000_000 } } });
  assert.equal(unixReset.resetAt, '2027-01-15T08:00:00.000Z');
});

test('falls back to an exhausted monthly window when WHAM omits its percentage', () => {
  const quota = parseCodexQuota({ rate_limit: {
    allowed: false,
    limit_reached: true,
    primary_window: { limit_window_seconds: 2_592_000, reset_after_seconds: 60 }
  }}, new Date('2026-07-15T00:00:00Z'));
  assert.equal(quota.remainingPercent, 0);
  assert.equal(quota.remainingUnits, null);
  assert.equal(quota.limitUnits, null);
  assert.equal(quota.resetAt, '2026-07-15T00:01:00.000Z');
});

test('keeps WHAM percentage-only quotas when absolute totals are unavailable', () => {
  const quota = parseCodexQuota({
    plan_type: 'free',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 99, limit_window_seconds: 2_592_000, reset_after_seconds: 1_292_992, reset_at: 1_787_369_871 }
    },
    credits: { has_credits: false, balance: null },
    spend_control: { reached: false, individual_limit: null }
  });
  assert.equal(quota.remainingPercent, 1);
  assert.equal(quota.remainingDollars, null);
  assert.equal(quota.limitDollars, null);
  assert.equal(quota.resetAt, '2026-08-22T03:37:51.000Z');
});

test('uses Codex spend control as the monthly usage quota', () => {
  const quota = parseCodexQuota({
    rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18_000 } },
    spend_control: { individual_limit: {
      limit: '32500', used: '1832.4014599323273', remaining: '30667.598540067673',
      used_percent: 6, remaining_percent: 94, reset_after_seconds: 2_477_942, reset_at: 1_788_220_800
    }}
  });
  assert.equal(quota.label, 'Monthly usage');
  assert.equal(quota.usedPercent, 6);
  assert.equal(quota.remainingPercent, 94);
  assert.equal(quota.remainingUnits, 30667.598540067673);
  assert.equal(quota.limitUnits, 32500);
  assert.equal(quota.remainingDollars, 1226.703941602707);
  assert.equal(quota.limitDollars, 1300);
  assert.equal(quota.resetAt, '2026-09-01T00:00:00.000Z');
});

test('marks CQP upstreams as AIS and keeps them eligible despite zero quota', () => {
  const upstream = createUpstream({ type: 'compass', projectId: 'ais-project', projectKey: 'key', quotaSource: 'CQP' });
  setSpendingCap(upstream, 100);
  upstream.quota = { remainingPercent: 0 };
  assert.equal(publicUpstream(upstream).quotaSource, 'ais');
  assert.equal(filterSpendCapEligible([upstream]).eligible.length, 1);
});

test('normalizes legacy AISwitch upstreams to AIS', () => {
  const upstream = createUpstream({ type: 'compass', projectId: 'legacy-ais-project', projectKey: 'key', quotaSource: 'aiswitch' });
  assert.equal(publicUpstream(upstream).quotaSource, 'ais');
});

test('converts recurring Compass balance to monthly remaining percent', () => {
  const quota = parseCompassQuota({ retcode: 0, data: { project: {
    budget_type: 'recurring',
    quota_detail: { applied_balance: '100', balance: '72.5' }
  }}}, new Date('2026-07-15T00:00:00Z'));
  assert.equal(quota.remainingPercent, 72.5);
  assert.equal(quota.remainingUnits, 72.5);
  assert.equal(quota.remainingDollars, 72.5);
  assert.equal(quota.limitDollars, 100);
  assert.equal(quota.resetAt, '2026-08-01T00:00:00.000Z');
});

test('parses Claude OAuth session, weekly, and model-scoped usage windows', () => {
  const quota = parseClaudeQuota({
    limits: [
      { kind: 'session', percent: 48, resets_at: '2026-09-04T05:00:00+00:00' },
      { kind: 'weekly_all', percent: 64, resets_at: '2026-09-10T05:00:00+00:00' },
      { kind: 'weekly_scoped', percent: 2, resets_at: '2026-09-08T05:00:00+00:00', scope: { model: { display_name: 'Sonnet' } } }
    ],
    extra_usage: { is_enabled: true, monthly_limit: 100000, used_credits: 1250 }
  }, new Date('2026-09-04T00:00:00Z'));
  assert.equal(quota.source, 'claude_oauth_usage');
  assert.equal(quota.label, 'Session (5h)');
  assert.equal(quota.usedPercent, 48);
  assert.equal(quota.remainingPercent, 52);
  assert.equal(quota.resetAt, '2026-09-04T05:00:00.000Z');
  assert.deepEqual(quota.windows.map(({ key, label, remainingPercent }) => ({ key, label, remainingPercent })), [
    { key: 'session', label: 'Session (5h)', remainingPercent: 52 },
    { key: '7d', label: 'Week (all)', remainingPercent: 36 },
    { key: '7d_sonnet', label: 'Week (Sonnet)', remainingPercent: 98 }
  ]);
  assert.equal(quota.remainingDollars, 987.5);
  assert.equal(quota.limitDollars, 1000);
  assert.equal(quota.extraUsage.enabled, true);
});

test('parses legacy Claude OAuth usage windows and rejects empty responses', () => {
  const quota = parseClaudeQuota({
    five_hour: { utilization: 12, resets_at: 1_800_000_000 },
    seven_day: { utilization: 34, resets_at: '2026-09-10T00:00:00Z' }
  });
  assert.equal(quota.remainingPercent, 88);
  assert.equal(quota.windows[1].remainingPercent, 66);
  assert.throws(() => parseClaudeQuota({ limits: [] }), /no usable quota window/);
});

test('does not expose disabled Claude extra usage as a dollar quota', () => {
  const quota = parseClaudeQuota({
    five_hour: { utilization: 12 },
    extra_usage: { is_enabled: false, monthly_limit: 100000, used_credits: 1250 }
  });
  assert.equal(quota.remainingDollars, null);
  assert.equal(quota.limitDollars, null);
  assert.equal(quota.extraUsage, undefined);
});

test('parses Claude OAuth utilization and reset headers', () => {
  const quota = parseClaudeQuotaHeaders(new Headers({
    'anthropic-ratelimit-unified-5h-utilization': '0.0184',
    'anthropic-ratelimit-unified-5h-reset': '1800000000',
    'anthropic-ratelimit-unified-7d-utilization': '0.737',
    'anthropic-ratelimit-unified-7d-reset': '1800600000',
    'anthropic-ratelimit-unified-representative-claim': 'seven_day'
  }), new Date('2026-09-04T00:00:00Z'));
  assert.equal(quota.source, 'claude_oauth_headers');
  assert.equal(quota.usedPercent, 73.7);
  assert.equal(quota.remainingPercent, 26.3);
  assert.equal(quota.resetAt, '2027-01-22T06:40:00.000Z');
  assert.equal(quota.windows[0].remainingPercent, 98.16);
});

test('parses Claude overage quota headers when standard windows are absent', () => {
  const quota = parseClaudeQuotaHeaders(new Headers({
    'anthropic-ratelimit-unified-overage-utilization': '0.3',
    'anthropic-ratelimit-unified-overage-reset': '1790812800',
    'anthropic-ratelimit-unified-overage-status': 'allowed',
    'anthropic-ratelimit-unified-representative-claim': 'overage'
  }), new Date('2026-09-04T00:00:00Z'));
  assert.equal(quota.label, 'Overage');
  assert.equal(quota.remainingPercent, 70);
  assert.equal(quota.resetAt, '2026-10-01T00:00:00.000Z');
  assert.equal(quota.windows[0].key, 'overage');
});

test('priced usage updates spend, replacement applies only its delta, and old attempts do not count', () => {
  const upstream = createUpstream({ type: 'compass', name: 'test', projectId: 'p', projectKey: 'k' });
  setSpendingCap(upstream, 100);
  const startedAt = new Date(Date.now() + 1).toISOString();
  recordUsage(upstream, { attemptId: 'attempt-1', startedAt, settledCostMicros: 3_400_000, costSource: 'upstream_reported' });
  assert.equal(spendingSummary(upstream.spending).status, 'normal');
  recordUsage(upstream, { attemptId: 'attempt-1', startedAt, settledCostMicros: 4_000_000, costSource: 'upstream_reported' });
  assert.equal(spendingSummary(upstream.spending).spentCredits, 100);
  assert.equal(spendingSummary(upstream.spending).status, 'reached');

  recordUsage(upstream, { attemptId: 'attempt-1', startedAt, settledCostMicros: 2_000_000, costSource: 'upstream_reported' });
  assert.equal(spendingSummary(upstream.spending).spentCredits, 50);
  recordUsage(upstream, { attemptId: 'attempt-1', startedAt, settledCostMicros: 0, costSource: 'upstream_reported' });
  assert.equal(spendingSummary(upstream.spending).spentCredits, 0);

  recordUsage(upstream, { attemptId: 'old-attempt', startedAt: new Date(0).toISOString(), settledCostMicros: 4_000_000, costSource: 'pricing_snapshot' });
  assert.equal(spendingSummary(upstream.spending).spentCredits, 0);
  setSpendingCap(upstream, 200);
  assert.equal(spendingSummary(upstream.spending).spentCredits, 0);
  assert.equal(spendingSummary(upstream.spending).settlementCount, 0);
});

test('a positive cap never rounds down into an unset one', () => {
  assert.equal(dollarsToCredits(0), 0);
  assert.equal(dollarsToCredits(0.01), 1);
  assert.equal(dollarsToCredits(100), 2_500);
});

test('counts a slow settlement that lands after the deduplication window has rolled over', () => {
  const upstream = createUpstream({ type: 'compass', projectId: 'slow', projectKey: 'key' });
  setSpendingCap(upstream, 1_000);
  const slow = { attemptId: 'attempt-slow', startedAt: new Date(Date.now() + 1).toISOString(), settledCostMicros: 40_000, costSource: 'pricing_snapshot' };
  for (let index = 1; index <= 120; index += 1) {
    recordUsage(upstream, { attemptId: `attempt-${index}`, startedAt: new Date(Date.now() + 1 + index).toISOString(), settledCostMicros: 40_000, costSource: 'pricing_snapshot' });
  }
  assert.equal(spendingSummary(upstream.spending).settlementCount, 100);
  assert.equal(recordUsage(upstream, slow).counted, true);
  assert.equal(spendingSummary(upstream.spending).spentCredits, 121);
});

test('usage settlements with reserved property names persist idempotently', () => {
  const upstream = createUpstream({ type: 'compass', projectId: 'settlement-id', projectKey: 'key' });
  setSpendingCap(upstream, 100);
  const usage = { attemptId: '__proto__', startedAt: new Date(Date.now() + 1).toISOString(), settledCostMicros: 4_000_000, costSource: 'upstream_reported' };
  recordUsage(upstream, usage);
  const restored = JSON.parse(JSON.stringify(upstream));
  recordUsage(restored, usage);
  assert.equal(spendingSummary(restored.spending).spentCredits, 100);
  assert.equal(spendingSummary(restored.spending).settlementCount, 1);
});

test('bounds the settlement idempotency ledger', () => {
  const upstream = createUpstream({ type: 'compass', projectId: 'settlement-limit', projectKey: 'key' });
  setSpendingCap(upstream, 100);
  for (let index = 0; index < 101; index += 1) {
    recordUsage(upstream, { attemptId: `attempt-${index}`, startedAt: new Date(Date.now() + index).toISOString(), settledCostMicros: 0, costSource: 'pricing_snapshot' });
  }
  assert.equal(spendingSummary(upstream.spending).settlementCount, 100);
  assert.equal(spendingSummary(upstream.spending).lastActivityAt, Object.values(upstream.spending.settlements).at(-1).startedAt);
});

test('spending eligibility keeps an upstream available until its cap is reached', () => {
  const nearlyCapped = createUpstream({ type: 'compass', name: 'nearly capped', projectId: 'p1', projectKey: 'k' });
  const fresh = createUpstream({ type: 'compass', name: 'fresh', projectId: 'p2', projectKey: 'k' });
  setSpendingCap(nearlyCapped, 100);
  setSpendingCap(fresh, 100);
  recordUsage(nearlyCapped, { attemptId: 'a', startedAt: new Date(Date.now() + 1).toISOString(), settledCostMicros: 3_600_000, costSource: 'pricing_snapshot' });
  assert.deepEqual(filterSpendCapEligible([nearlyCapped, fresh]).eligible.map((item) => item.name), ['p1', 'p2']);

  const capped = createUpstream({ type: 'compass', name: 'capped', projectId: 'p3', projectKey: 'k' });
  setSpendingCap(capped, 100);
  recordUsage(capped, { attemptId: 'b', startedAt: new Date(Date.now() + 1).toISOString(), settledCostMicros: 5_000_000, costSource: 'upstream_reported' });
  assert.equal(filterSpendCapEligible([capped, fresh], { continuationId: capped.id }).error.code, 'pinned_continuation_spend_cap_reached');
});

test('uncapped upstreams are excluded from routing', () => {
  const upstream = createUpstream({ type: 'compass', name: 'uncapped', projectId: 'p', projectKey: 'k' });
  const result = filterSpendCapEligible([upstream]);
  assert.equal(result.error.code, 'no_eligible_backend');
  assert.equal(result.exclusions[0].code, 'spend_cap_unset');
});
