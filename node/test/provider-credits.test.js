import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { parseCodexQuota } from '../src/domain.js';
import { codexCapacityDecision } from '../src/provider-credits.js';

function setup(t) {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
  t.after(() => store.sqlite.close());
  const create = (accountId) => {
    const row = store.create({ type: 'codex', accessToken: `token-${accountId}`, accountId });
    store.setCap(row.id, { capDollars: 100 });
    return store.get(row.id);
  };
  const exhausted = (balance = 10) => parseCodexQuota({ rate_limit: { allowed: false, primary_window: { used_percent: 100, reset_after_seconds: 3600, limit_window_seconds: 18000 } }, credits: { has_credits: true, unlimited: false, balance } });
  return { store, create, exhausted };
}

test('routes opt-in credits after included capacity while preserving hard policy and cooldowns', (t) => {
  const { store, create, exhausted } = setup(t);
  const paid = create('paid'), included = create('included');
  store.setQuota(paid.id, exhausted());
  store.setPriorityList([paid.id, included.id]);
  assert.deepEqual(store.candidatePlan({ model: 'gpt-6-sol' }).map((row) => row.id), [included.id]);
  store.update(paid.id, { allowProviderCredits: true });
  assert.deepEqual(store.candidatePlan({ model: 'gpt-6-sol', affinityId: paid.id }).map((row) => row.id), [included.id, paid.id]);
  assert.equal(store.candidatePlan({ model: 'gpt-6-sol', requestedId: paid.id })[0].id, paid.id);
  store.update(paid.id, { routing: { models: ['other'] } });
  assert.equal(store.candidatePlan({ model: 'gpt-6-sol', requestedId: paid.id }).length, 0);
  store.update(paid.id, { routing: {} });
  const admission = store.beginUpstreamAttempt(paid.id, { model: 'gpt-6-sol' });
  store.settleUpstreamAttempt(paid.id, admission, { class: 'quota', retryAfter: '60' });
  assert.equal(store.candidatePlan({ requestedId: paid.id }).length, 0);
  store.clearUpstreamCooldown(paid.id);
  store.setCap(paid.id, { capDollars: 0 });
  assert.equal(store.candidatePlan({ requestedId: paid.id }).length, 0);
});

test('requires fresh current-credential credit proof and rechecks at physical admission', (t) => {
  const { store, create, exhausted } = setup(t);
  const account = create('paid');
  store.update(account.id, { allowProviderCredits: true });
  for (const balance of [0, null, 'bad']) {
    store.setQuota(account.id, exhausted(balance));
    assert.equal(store.candidatePlan({ requestedId: account.id }).length, 0);
  }
  store.setQuota(account.id, exhausted());
  assert.equal(codexCapacityDecision(account).basis, 'provider_credits');
  assert.doesNotThrow(() => store.assertCodexCapacity(account.id));
  store.update(account.id, { allowProviderCredits: false });
  assert.throws(() => store.assertCodexCapacity(account.id), { codexCapacityChanged: true });
  store.update(account.id, { allowProviderCredits: true });
  assert.equal(codexCapacityDecision(account, '', Date.now() + 300_001).eligible, false);
  const oldEpoch = account.credentialEpoch;
  store.update(account.id, { accessToken: 'replacement' });
  store.setQuota(account.id, exhausted(), { expectedCredentialEpoch: oldEpoch });
  assert.equal(account.quota, null);
});

test('evaluates every included window and keeps model-specific capacity isolated', (t) => {
  const { store, create } = setup(t);
  const account = create('windows');
  const quota = parseCodexQuota({ rate_limit: { allowed: true, primary_window: { used_percent: 100, reset_after_seconds: 3600, limit_window_seconds: 18000 }, secondary_window: { used_percent: 10, limit_window_seconds: 604800 } } });
  store.setQuota(account.id, quota);
  assert.equal(store.candidatePlan({ requestedId: account.id }).length, 0);
  store.setQuota(account.id, parseCodexQuota({ rate_limit: { allowed: true, primary_window: { used_percent: 0, limit_window_seconds: 18000 } }, additional_rate_limits: [{ model: 'limited', rate_limit: { primary_window: { used_percent: 100, reset_after_seconds: 3600 } } }] }));
  assert.equal(store.candidatePlan({ requestedId: account.id, model: 'limited' }).length, 0);
  assert.equal(store.candidatePlan({ requestedId: account.id, model: 'other' }).length, 1);
});

test('persists identity policy across duplicate account records and validates explicit booleans', (t) => {
  const { store, create } = setup(t);
  const first = create('same');
  const second = store.create({ type: 'codex', accessToken: 'second', accountId: 'same' }, { allowDuplicateCodexIdentity: true });
  store.update(first.id, { allowProviderCredits: true });
  assert.equal(store.getPublic(second.id).allowProviderCredits, true);
  assert.throws(() => store.update(first.id, { allowProviderCredits: 'false' }), /boolean/);
  store.update(first.id, { accessToken: 'replacement', accountId: 'different' });
  assert.equal(store.getPublic(first.id).allowProviderCredits, false);
});

test('paid credits never override a reported spend-control cap or missing usage on a denied window', (t) => {
  const { store, create } = setup(t);
  const account = create('spend');
  store.update(account.id, { allowProviderCredits: true });
  store.setQuota(account.id, parseCodexQuota({ spend_control: { individual_limit: { used_percent: 100, reset_after_seconds: 3600 } }, credits: { has_credits: true, balance: 10 } }));
  assert.equal(store.candidatePlan({ requestedId: account.id }).length, 0);
  store.update(account.id, { allowProviderCredits: false });
  store.setQuota(account.id, parseCodexQuota({ rate_limit: { limit_reached: true, primary_window: { reset_after_seconds: 3600 } } }));
  assert.equal(store.candidatePlan({ requestedId: account.id }).length, 0);
});
