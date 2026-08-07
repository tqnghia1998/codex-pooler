import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstream, dollarsToCredits, filterSpendCapEligible, parseCodexAuthJson, parseCodexQuota, parseCompassQuota, publicUpstream, recordUsage, setSpendingCap, spendingSummary } from '../src/domain.js';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('imports the useful fields from Codex auth.json', () => {
  const auth = parseCodexAuthJson(JSON.stringify({ tokens: {
    access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } }),
    refresh_token: 'refresh',
    id_token: jwt({ email: 'person@example.com' })
  }}));
  assert.equal(auth.accessToken.startsWith('header.'), true);
  assert.equal(auth.accountId, 'acct-1');
  assert.equal(auth.email, 'person@example.com');
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

test('marks CQP upstreams as AISwitch and keeps them eligible despite zero quota', () => {
  const upstream = createUpstream({ type: 'compass', projectId: 'aiswitch-project', projectKey: 'key', quotaSource: 'CQP' });
  setSpendingCap(upstream, 100);
  upstream.quota = { remainingPercent: 0 };
  assert.equal(publicUpstream(upstream).quotaSource, 'aiswitch');
  assert.equal(filterSpendCapEligible([upstream]).eligible.length, 1);
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
