import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upstreamSavePayload, DEFAULT_PACING } from '../ui/upstream-form.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

test('edit payload preserves credentials and pacing while omitting Codex-only fields for other providers', () => {
  for (const type of ['claude', 'compass']) {
    const values = { type, name: 'renamed', allowProviderCredits: false, authJson: '', accessToken: '', projectKey: '', pacing: {
      modelIntervals: [{ model: '  model-a  ', minStartIntervalMs: 25 }, { model: '  ', minStartIntervalMs: 5 }]
    } };
    const payload = upstreamSavePayload(values);
    assert.equal(Object.hasOwn(payload, 'allowProviderCredits'), false);
    for (const field of ['authJson', 'accessToken', 'projectKey']) assert.equal(Object.hasOwn(payload, field), false);
    assert.deepEqual(payload.pacing, { ...DEFAULT_PACING, modelIntervals: [{ model: 'model-a', minStartIntervalMs: 25 }] });
    assert.equal(values.allowProviderCredits, false);
    assert.equal(values.pacing.modelIntervals[0].model, '  model-a  ');
  }
  for (const allowProviderCredits of [true, false]) {
    assert.equal(upstreamSavePayload({ type: 'codex', allowProviderCredits }).allowProviderCredits, allowProviderCredits);
  }
});

test('actual dashboard edit payload can rename Claude, Compass and AIS without changing Codex credit policy', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'relaydeck-edit-upstream-'));
  const store = new Store(dir);
  const server = createServer(createApp({ store, apiKey: 'fixture-key', fetchImpl: async () => new Response('{}', { status: 503 }) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.sqlite.close(); rmSync(dir, { recursive: true, force: true }); });
  const patch = (id, payload) => fetch(`http://127.0.0.1:${server.address().port}/api/upstreams/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  for (const input of [
    { type: 'claude', name: 'employee.name', accessToken: 'sk-ant-oat-edit-fixture' },
    { type: 'compass', projectId: 'project', projectKey: 'fixture' },
    { type: 'compass', projectId: 'ais-project', projectKey: 'fixture', quotaSource: 'ais' }
  ]) {
    const account = store.create(input);
    const payload = upstreamSavePayload({ ...account, name: 'employee.name@shopee.com', authJson: '', accessToken: '', projectKey: '' });
    const response = await patch(account.id, payload);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).upstream.name, 'employee.name@shopee.com');
    assert.equal(store.getPublic(account.id).allowProviderCredits, false);
    for (const enabled of [false, true]) assert.equal((await patch(account.id, { allowProviderCredits: enabled })).status, 400);
  }
  const codex = store.create({ type: 'codex', accessToken: 'fixture-codex' });
  for (const enabled of [true, false]) {
    const payload = upstreamSavePayload({ ...store.getPublic(codex.id), allowProviderCredits: enabled, name: 'Codex renamed' });
    assert.equal((await patch(codex.id, payload)).status, 200);
    assert.equal(store.getPublic(codex.id).allowProviderCredits, enabled);
  }
});

test('production refresh and rename flow accepts short and full employee names with no saved email', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'relaydeck-name-quota-'));
  const mapFile = join(dir, 'users.json');
  writeFileSync(mapFile, JSON.stringify({ 'employee.name@shopee.com': 'user_named' }));
  const names = ['CODEX_POOLER_CLAUDE_SPEND_LIMITS_API_KEY', 'CODEX_POOLER_CLAUDE_SPEND_LIMITS_MAP_FILE'];
  const previous = names.map((name) => process.env[name]);
  process.env[names[0]] = 'fixture-reader'; process.env[names[1]] = mapFile;
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  const store = new Store(dir);
  const account = store.create({ type: 'claude', name: 'employee.name', accessToken: 'sk-ant-oat-name-fixture' });
  const epoch = store.get(account.id).credentialEpoch;
  let calls = 0;
  const server = createServer(createApp({ store, apiKey: 'fixture-key', fetchImpl: async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/v1/organizations/spend_limits/effective');
    assert.equal(parsed.searchParams.get('user_ids[]'), 'user_named');
    calls++;
    return new Response(JSON.stringify({ data: [{ actor: { email_address: 'employee.name@shopee.com', user_id: 'user_named' },
      currency: 'USD', period: 'monthly', amount: '20000', period_to_date_spend: String(calls * 100) }] }));
  } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.sqlite.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/upstreams/${account.id}`;
  const refresh = async () => {
    const response = await fetch(`${base}/refresh-quota`, { method: 'POST' });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).upstream;
  };
  assert.equal((await refresh()).quota.remainingDollars, 199);
  const renamed = await fetch(base, { method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(upstreamSavePayload({ ...store.getPublic(account.id), name: 'employee.name@shopee.com' })) });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  assert.equal((await refresh()).quota.remainingDollars, 198);
  assert.equal(store.get(account.id).email, '');
  assert.equal(store.get(account.id).credentialEpoch, epoch);
  assert.equal(calls, 2);
});
