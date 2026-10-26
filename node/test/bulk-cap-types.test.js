import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

function fixture(t) {
  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 4) });
  t.after(() => store.sqlite.close());
  const accounts = ['codex', 'claude', 'compass'].flatMap((type) => [0, 1].map((index) => {
    const id = `${type}-${index}`;
    const row = store.create(type === 'codex' ? { type, accountId: id, accessToken: id }
      : type === 'claude' ? { type, authJson: JSON.stringify({ access_token: `sk-ant-oat-${id}`, account_uuid: id }) }
      : { type, projectId: id, projectKey: id });
    if (index === 0) {
      store.setCap(row.id, { capDollars: 5 });
      store.addUsage(row.id, { attemptId: id, startedAt: new Date(Date.now() + 1).toISOString(), settledCostMicros: 5_000_000, costSource: 'upstream_reported' });
      store.setQuota(row.id, { remainingDollars: 100, remainingPercent: 50 });
    }
    return { ...row, index };
  }));
  const ais = store.create({ type: 'compass', projectId: 'ais', projectKey: 'ais', quotaSource: 'ais' });
  return { store, accounts, ais };
}

for (const mode of ['all', 'uncapped', 'cap_reached', 'rules']) {
  for (const accountTypes of [['claude'], ['codex', 'compass']]) {
    test(`bulk ${mode} changes only selected account types: ${accountTypes.join(', ')}`, (t) => {
      const { store, accounts, ais } = fixture(t);
      const before = new Map([...accounts, ais].map((row) => [row.id, structuredClone(store.get(row.id).spending)]));
      const input = mode === 'rules'
        ? { rules: [{ minQuotaLeft: 0, capDollars: 7 }], unknownQuotaDollars: 3 }
        : { target: mode, capDollars: 7 };
      const result = store.bulkCaps({ ...input, accountTypes });
      const expected = accounts.filter((row) => accountTypes.includes(row.type)
        && (mode === 'uncapped' ? row.index === 1 : mode === 'cap_reached' ? row.index === 0 : true));
      assert.deepEqual(new Set(result.updated.map((row) => row.id)), new Set(expected.map((row) => row.id)));
      for (const row of [...accounts, ais]) {
        if (expected.some((selected) => selected.id === row.id)) {
          assert.equal(store.getPublic(row.id).spending.capDollars, mode === 'rules' && row.index === 1 ? 3 : 7);
        } else {
          assert.deepEqual(store.get(row.id).spending, before.get(row.id), 'Unselected account spending must remain unchanged');
        }
      }
    });
  }
}

for (const accountTypes of [[], null, 'claude', ['unsupported'], ['claude', 1]]) {
  test(`rejects invalid bulk account types ${JSON.stringify(accountTypes)} before changing caps`, (t) => {
    const { store, accounts } = fixture(t);
    const before = accounts.map((row) => structuredClone(store.get(row.id).spending));
    assert.throws(() => store.bulkCaps({ target: 'all', capDollars: 7, accountTypes }), /accountTypes must be a non-empty array/);
    assert.deepEqual(accounts.map((row) => store.get(row.id).spending), before);
  });
}

test('bulk cap API enforces the account-type selection and rejects an empty selection', async (t) => {
  const { store, accounts } = fixture(t);
  const server = createServer(createApp({ store, apiKey: '' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Close the server before fixture cleanup closes the store.
  try {
    const post = (accountTypes) => fetch(`http://127.0.0.1:${server.address().port}/api/spending-caps/bulk`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'all', capDollars: 9, accountTypes })
    });
    const response = await post(['claude']);
    assert.equal(response.status, 200);
    assert.deepEqual(new Set((await response.json()).updated.map((row) => row.id)), new Set(accounts.filter((row) => row.type === 'claude').map((row) => row.id)));
    const before = accounts.map((row) => structuredClone(store.get(row.id).spending));
    const invalid = await post([]);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error.message, /accountTypes/);
    assert.deepEqual(accounts.map((row) => store.get(row.id).spending), before);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('selected Claude accounts with explicit null quota values receive the unknown-quota cap', (t) => {
  const { store, accounts } = fixture(t);
  const claude = accounts.filter((row) => row.type === 'claude');
  for (const row of claude) store.setQuota(row.id, { remainingDollars: null, remainingUnits: null, remainingPercent: 50 });
  const result = store.bulkCaps({ accountTypes: ['claude'], rules: [{ minQuotaLeft: 0, capDollars: 7 }], unknownQuotaDollars: 3 });
  assert.deepEqual(new Set(result.updated.map((row) => row.id)), new Set(claude.map((row) => row.id)));
  for (const row of claude) assert.equal(store.getPublic(row.id).spending.capDollars, 3);
});
