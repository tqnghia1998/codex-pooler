import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { CLAUDE_OAUTH_TOKEN_URL } from '../src/providers.js';

const payload = { model: 'claude-opus-5-5', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const success = () => json({ id: 'msg_ok', type: 'message', role: 'assistant', model: payload.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
const failure = (status = 503) => json({ type: 'error', error: { type: status === 400 ? 'invalid_request_error' : 'overloaded_error', message: 'unavailable' } }, status);

async function fixture(t, fetchImpl, { claudeCount = 1, claudeAuth = {} } = {}) {
  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 9) });
  const compass = store.create({ type: 'compass', projectId: 'fallback-project', projectKey: 'fallback-key' });
  store.setCap(compass.id, { capDollars: 5 });
  const claude = Array.from({ length: claudeCount }, (_, i) => {
    const row = store.create({ type: 'claude', authJson: JSON.stringify({ access_token: `sk-ant-oat-routing-${i}`, account_uuid: `account-${i}`, ...claudeAuth }) });
    store.setCap(row.id, { capDollars: 5 });
    return row;
  });
  const server = createServer(createApp({ store, apiKey: '', fetchImpl }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.sqlite.close(); });
  const post = (body = payload, headers = {}, path = '/v1/messages', options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options, method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify(body)
  });
  return { store, claude, compass, post, server };
}
const provider = (url) => new URL(url).hostname === 'api.anthropic.com' ? 'claude' : 'compass';

test('headerless Anthropic requests prefer Claude even over a Compass soft affinity and priority', async (t) => {
  const calls = [];
  const { store, claude, compass, post } = await fixture(t, async (url) => { calls.push(provider(url)); return success(); });
  store.setPriorityList([compass.id]);
  store.pinSession('existing-session', compass.id);
  const response = await post(payload, { 'x-codex-session-id': 'existing-session' });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['claude']);
  await response.json();
  assert.equal(store.sessionUpstream('existing-session'), claude[0].id);
  assert.equal((await post(payload, { 'x-codex-session-id': 'existing-session' })).status, 200);
  assert.deepEqual(calls, ['claude', 'claude']);
});

test('tries every eligible Claude candidate before Compass on safe failures', async (t) => {
  for (const kind of ['http', 'transport', 'first-sse-error']) {
    await t.test(kind, async (t) => {
      const calls = [];
      const { post } = await fixture(t, async (url) => {
        const type = provider(url); calls.push(type);
        if (type === 'compass') return success();
        if (kind === 'transport') throw Object.assign(new Error('unavailable'), { code: 'ECONNRESET' });
        if (kind === 'first-sse-error') return new Response('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"unavailable"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
        return failure();
      }, { claudeCount: 2 });
      const response = await post();
      assert.equal(response.status, 200);
      assert.equal((await response.json()).id, 'msg_ok');
      assert.deepEqual(calls, ['claude', 'claude', 'compass']);
    });
  }
});

test('Claude retry rounds finish before Compass and a large Claude pool cannot exhaust the Compass budget', async (t) => {
  for (const count of [1, 9]) {
    await t.test(String(count), async (t) => {
      const calls = [];
      const { post } = await fixture(t, async (url) => {
        const type = provider(url); calls.push(type); return type === 'claude' ? failure() : success();
      }, { claudeCount: count, claudeAuth: { request_retry: 1, disable_cooling: true } });
      const response = await post();
      assert.equal(response.status, 200);
      assert.deepEqual(calls, [...Array(Math.min(count * 2, 8)).fill('claude'), 'compass']);
    });
  }
});

test('skips unavailable Claude accounts and falls back when none are eligible', async (t) => {
  const calls = [];
  const { store, claude, post } = await fixture(t, async (url) => { calls.push(provider(url)); return success(); });
  store.setCap(claude[0].id, { capDollars: 0 });
  assert.equal((await post()).status, 200);
  assert.deepEqual(calls, ['compass']);
});

test('uncapped Claude and Compass accounts are excluded before dispatch and do not consume attempts', async (t) => {
  const calls = [];
  const { store, claude, compass, post } = await fixture(t, async (url, options) => {
    const type = provider(url);
    const auth = options.headers.authorization;
    calls.push({ type, auth });
    return type === 'claude' ? failure() : success();
  }, { claudeCount: 22 });
  // Both never-configured and explicitly zero caps are ineligible.
  const db = store.load();
  for (const row of claude.slice(0, 20)) {
    const upstream = db.upstreams.find((entry) => entry.id === row.id);
    if (claude.indexOf(row) % 2 === 0) delete upstream.spending;
    else upstream.spending.capCredits = 0;
  }
  store.save(db);
  const uncappedCompass = store.create({ type: 'compass', projectId: 'uncapped-project', projectKey: 'uncapped-key' });
  store.setPriorityList([...claude.slice(0, 20).map((row) => row.id), uncappedCompass.id]);
  const plan = store.candidatePlanDetails({ model: payload.model, preferredType: 'claude' });
  assert.equal(plan.candidates.length, 3);
  assert.equal(plan.diagnostics.exclusions.filter((row) => row.code === 'spend_cap_unset').length, 21);
  const response = await post();
  assert.equal(response.status, 200);
  await response.json();
  assert.deepEqual(calls.map((call) => call.type), ['claude', 'claude', 'compass']);
  assert.deepEqual(new Set(calls.map((call) => call.auth)), new Set([
    ...claude.slice(20).map((row) => `Bearer ${store.credentials(row.id).accessToken}`),
    `Bearer ${store.credentials(compass.id).projectKey}`
  ]));
});

test('a pool containing only uncapped accounts returns unavailable without any provider request', async (t) => {
  let calls = 0;
  const { store, claude, compass, post } = await fixture(t, async () => { calls += 1; return success(); });
  for (const row of [...claude, compass]) store.setCap(row.id, { capDollars: 0 });
  assert.equal((await post()).status, 503);
  assert.equal(calls, 0);
});

test('Claude credential preparation and rejected refresh failures permit automatic Compass fallback', async (t) => {
  for (const expired of [true, false]) {
    await t.test(String(expired), async (t) => {
      const calls = [];
      const { post } = await fixture(t, async (url) => {
        if (String(url) === CLAUDE_OAUTH_TOKEN_URL) { calls.push('refresh'); return json({ error: 'invalid_grant' }, 400); }
        const type = provider(url); calls.push(type);
        return type === 'claude' ? json({ type: 'error', error: { type: 'authentication_error' } }, 401) : success();
      }, { claudeAuth: { refresh_token: 'refresh-test', ...(expired ? { expires_at: '2000-01-01T00:00:00.000Z' } : {}) } });
      const response = await post();
      assert.equal(response.status, 200);
      assert.deepEqual(calls, expired ? ['refresh', 'compass'] : ['claude', 'refresh', 'compass']);
    });
  }
});

test('explicit provider/account selections stay strict and caller errors are not retried', async (t) => {
  for (const select of ['type', 'account', 'compass', 'caller']) {
    await t.test(select, async (t) => {
      const calls = [];
      const { claude, post } = await fixture(t, async (url) => {
        const type = provider(url); calls.push(type); return type === 'claude' ? failure(select === 'caller' ? 400 : 503) : success();
      });
      const headers = select === 'type' ? { 'x-upstream-type': 'claude' } : select === 'account' ? { 'x-upstream-id': claude[0].id } : select === 'compass' ? { 'x-upstream-type': 'compass' } : {};
      const response = await post(payload, headers);
      assert.equal(response.status, select === 'caller' ? 400 : select === 'compass' ? 200 : 502);
      assert.deepEqual(calls, [select === 'compass' ? 'compass' : 'claude']);
    });
  }
});

test('never switches providers after Anthropic streaming output starts', async (t) => {
  const calls = [];
  const { post } = await fixture(t, async (url) => {
    calls.push(provider(url));
    return new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_partial","model":"claude-opus-5-5","usage":{"input_tokens":1}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"unavailable"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await post({ ...payload, stream: true });
  assert.match(await response.text(), /partial/);
  assert.deepEqual(calls, ['claude']);
});

test('token counting tries Claude before using the Compass local fallback', async (t) => {
  const calls = [];
  const { post } = await fixture(t, async (url) => { calls.push(provider(url)); return failure(); });
  const response = await post(payload, {}, '/v1/messages/count_tokens');
  assert.equal(response.status, 200);
  assert.ok((await response.json()).input_tokens > 0);
  assert.deepEqual(calls, ['claude']);
});

test('rechecks caps before later Claude and Compass attempts', async (t) => {
  for (const removedType of ['claude', 'compass']) {
    await t.test(removedType, async (t) => {
      const calls = [];
      let state;
      state = await fixture(t, async (url, options) => {
        calls.push(options.headers.authorization);
        if (calls.length === 1) {
          state.store.setCap(removedType === 'claude' ? state.claude[1].id : state.compass.id, { capDollars: 0 });
          return failure();
        }
        return success();
      }, { claudeCount: removedType === 'claude' ? 2 : 1 });
      // Make candidate order explicit within the Claude phase.
      state.store.setPriorityList(state.claude.map((row) => row.id));
      const response = await state.post();
      await response.text();
      assert.deepEqual(calls, [
        `Bearer ${state.store.credentials(state.claude[0].id).accessToken}`,
        ...(removedType === 'claude' ? [`Bearer ${state.store.credentials(state.compass.id).projectKey}`] : [])
      ]);
    });
  }
});

test('rechecks caps after waiting for a pacing slot', async (t) => {
  const { upstreamPacerForStore } = await import('../src/upstream-pacer.js');
  const calls = [];
  const { store, claude, post } = await fixture(t, async (url) => { calls.push(provider(url)); return success(); });
  const pacer = upstreamPacerForStore(store);
  const acquire = pacer.acquire.bind(pacer);
  pacer.acquire = async (id, options) => {
    const result = await acquire(id, options);
    if (id === claude[0].id) store.setCap(id, { capDollars: 0 });
    return result;
  };
  const response = await post();
  assert.equal(response.status, 200);
  await response.json();
  assert.deepEqual(calls, ['compass']);
  assert.equal(store.get(claude[0].id).health, undefined);
});

test('failed Claude responses preserve the existing Compass pin and session spend', async (t) => {
  for (const stream of [false, true]) {
    await t.test(String(stream), async (t) => {
      const { store, compass, post } = await fixture(t, async () => stream
        ? new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_failed","model":"claude-opus-5-5","usage":{"input_tokens":1}}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"unavailable"}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
        : new Response(new ReadableStream({ pull(controller) { controller.error(new Error('truncated body')); } }), { headers: { 'content-type': 'application/json' } }));
      store.pinSession('recover-session', compass.id);
      store.addSessionUsage('recover-session', compass.id, 1_000_000);
      const before = structuredClone(store.sessionEntry('recover-session', 'default', null));
      const response = await post({ ...payload, stream }, { 'x-codex-session-id': 'recover-session' });
      await response.text();
      assert.equal(store.sessionUpstream('recover-session'), compass.id);
      assert.equal(store.sessionEntry('recover-session', 'default', null).spentCostMicros, before.spentCostMicros);
    });
  }
});


test('cancellation during a failed Claude refresh stops later account preparation', async (t) => {
  let releaseRefresh;
  let refreshStarted;
  const held = new Promise((resolve) => { releaseRefresh = resolve; });
  const started = new Promise((resolve) => { refreshStarted = resolve; });
  const calls = [];
  const { store, post, server } = await fixture(t, async (url) => {
    calls.push(String(url));
    if (String(url) === CLAUDE_OAUTH_TOKEN_URL) {
      refreshStarted();
      await held;
      return json({ error: 'invalid_grant' }, 400);
    }
    return success();
  }, { claudeCount: 2, claudeAuth: { refresh_token: 'expired-test', expires_at: '2000-01-01T00:00:00.000Z' } });
  const closed = new Promise((resolve) => server.once('request', (_req, res) => res.once('close', resolve)));
  let preparationSettled;
  const settled = new Promise((resolve) => { preparationSettled = resolve; });
  const settle = store.settleUpstreamAttempt.bind(store);
  store.settleUpstreamAttempt = (...args) => { const result = settle(...args); preparationSettled(); return result; };
  const controller = new AbortController();
  const pending = post(payload, {}, '/v1/messages', { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await closed;
  releaseRefresh();
  await settled;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [CLAUDE_OAUTH_TOKEN_URL]);
});
