import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

async function runningServer(store, fetchImpl, apiKey = '') {
  const server = createServer(createApp({ store, apiKey, fetchImpl }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, path, body, headers = {}) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

function codexInput({ refreshToken, email = 'proxy@example.com', accountId = 'acct-proxy' } = {}) {
  return {
    type: 'codex',
    authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      id_token: jwt({ email })
    }})
  };
}

test('requires the configured single gateway API key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-proxy-auth-'));
  const fetchImpl = async () => new Response('{"id":"auth-ok","output":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl, 'local-client-key');
  try {
    const rejected = await request(base, '/v1/responses', { model: 'gpt-5-codex', input: 'hello' });
    assert.equal(rejected.response.status, 401);
    const accepted = await request(base, '/v1/responses', { model: 'gpt-5-codex', input: 'hello' }, { authorization: 'Bearer local-client-key' });
    assert.equal(accepted.response.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authenticates before parsing an invalid JSON proxy body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-proxy-auth-order-'));
  let calls = 0;
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, async () => { calls += 1; return new Response('{}'); }, 'local-client-key');
  try {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not-json' });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proxies Codex Responses and translates Chat Completions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-proxy-'));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      id: 'resp-1', model: 'gpt-5-codex', output_text: 'hello',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const responses = await request(base, '/v1/responses', { model: 'gpt-5-codex', input: 'hello' });
    assert.equal(responses.response.status, 200);
    assert.equal(responses.body.output_text, 'hello');
    assert.equal(new URL(calls[0].url).pathname, '/backend-api/codex/responses');
    assert.equal(calls[0].options.headers.authorization.startsWith('Bearer header.'), true);

    const chat = await request(base, '/v1/chat/completions', { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(chat.response.status, 200);
    assert.equal(chat.body.object, 'chat.completion');
    assert.equal(chat.body.choices[0].message.content, 'hello');
    assert.deepEqual(calls[1].body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validates public OpenAI adapters before dispatch and supports Chat input fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-adapter-boundary-'));
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: 'resp-adapter', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const fallback = await request(base, '/v1/chat/completions', { model: 'gpt-5.6-sol', input: 'fallback' });
    assert.equal(fallback.response.status, 200);
    assert.deepEqual(bodies[0].input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fallback' }] }]);
    assert.equal(bodies[0].instructions, '');

    const invalidCases = [
      ['/v1/responses', { model: 'gpt-5.6-sol', input: [] }, 'invalid_request', 'input'],
      ['/v1/responses', { model: 'gpt-5.6-sol', input: 'x', unknown: true }, 'unsupported_parameter', 'unknown'],
      ['/v1/chat/completions', { model: 'gpt-5.6-sol' }, 'invalid_request', 'messages'],
      ['/v1/chat/completions', { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'x' }], functions: [] }, 'invalid_request', 'functions'],
      ['/v1/chat/completions', { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'x' }], max_tokens: 0 }, 'invalid_request', 'max_tokens']
    ];
    for (const [path, payload, code, param] of invalidCases) {
      const result = await request(base, path, payload);
      assert.equal(result.response.status, 400);
      assert.equal(result.body.error.type, 'invalid_request_error');
      assert.equal(result.body.error.code, code);
      assert.equal(result.body.error.param, param);
    }
    assert.equal(bodies.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes collected Chat metadata, partial usage, and incomplete finish reasons', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-chat-output-'));
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  let withToolCall = false;
  const fetchImpl = async () => new Response(JSON.stringify(withToolCall ? {
    id: 'resp-truncated-tool', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'function_call', call_id: 'call-truncated', name: 'unsafe', arguments: '{"partial":' }]
  } : {
    id: 'resp-filtered', created_at: 123, status: 'incomplete', service_tier: 'priority',
    incomplete_details: { reason: 'content_filter' }, output: [],
    usage: { input_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const result = await request(base, '/v1/chat/completions', { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.created, 123);
    assert.equal(result.body.model, 'gpt-5.6-sol');
    assert.equal(result.body.service_tier, 'priority');
    assert.equal(result.body.choices[0].finish_reason, 'content_filter');
    assert.equal(result.body.choices[0].message.content, null);
    assert.deepEqual(result.body.usage, { prompt_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } });

    withToolCall = true;
    const truncated = await request(base, '/v1/chat/completions', { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(truncated.body.choices[0].finish_reason, 'length');
    assert.equal(truncated.body.choices[0].message.tool_calls[0].id, 'call-truncated');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('translates Chat Completions image and tool-call contracts in both directions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-chat-tools-'));
  let upstreamBody;
  const fetchImpl = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      id: 'resp-tools', model: 'gpt-5.6-sol',
      output: [{ type: 'function_call', call_id: 'call-2', name: 'weather', arguments: '{"city":"SG"}' }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const result = await request(base, '/v1/chat/completions', {
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'weather' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==', detail: 'high' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' }
      ],
      tools: [{ type: 'function', function: { name: 'weather', description: 'Weather', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true } }],
      tool_choice: { type: 'function', function: { name: 'weather' } }
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(upstreamBody.input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,AQ==' });
    assert.deepEqual(upstreamBody.input[1], { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' });
    assert.deepEqual(upstreamBody.input[2], { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' });
    assert.deepEqual(upstreamBody.tools[0], { type: 'function', name: 'weather', description: 'Weather', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true });
    assert.deepEqual(upstreamBody.tool_choice, { type: 'function', name: 'weather' });
    assert.equal(result.body.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(result.body.choices[0].message.tool_calls, [{ id: 'call-2', type: 'function', function: { name: 'weather', arguments: '{"city":"SG"}' } }]);
    assert.deepEqual(result.body.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps a session preference until its spending cap is reached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-session-pin-'));
  const authHeaders = [];
  const fetchImpl = async (_url, options) => {
    authHeaders.push(options.headers.authorization);
    return new Response(JSON.stringify({ id: 'resp-session', output_text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = new Store(dir);
  const first = store.create(codexInput({ email: 'first@example.com', accountId: 'acct-first' }));
  const second = store.create(codexInput({ email: 'second@example.com', accountId: 'acct-second' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const firstToken = store.credentials(first.id).accessToken;
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const headers = { 'x-codex-session-id': 'session-1' };
    assert.equal((await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'one' }, headers)).response.status, 200);
    store.addUsage(first.id, { attemptId: 'spend-90', startedAt: new Date(Date.now() + 1).toISOString(), settledCostMicros: 90_000_000, costSource: 'upstream_reported' });
    assert.equal((await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'two' }, headers)).response.status, 200);
    assert.deepEqual(authHeaders, [`Bearer ${firstToken}`, `Bearer ${firstToken}`]);

    store.addUsage(first.id, { attemptId: 'spend-125', startedAt: new Date(Date.now() + 1).toISOString(), settledCostMicros: 35_000_000, costSource: 'upstream_reported' });
    const continued = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'three' }, headers);
    assert.equal(continued.response.status, 200);
    assert.deepEqual(authHeaders, [`Bearer ${firstToken}`, `Bearer ${firstToken}`, `Bearer ${store.credentials(second.id).accessToken}`]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotates a session to the next upstream after five dollars of settled spend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-session-rotation-'));
  const authHeaders = [];
  const fetchImpl = async (_url, options) => {
    authHeaders.push(options.headers.authorization);
    return new Response(JSON.stringify({ id: 'resp-session', output_text: 'ok', usage: { price_cost_usd: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = new Store(dir);
  const first = store.create(codexInput({ email: 'first@example.com', accountId: 'acct-first' }));
  const second = store.create(codexInput({ email: 'second@example.com', accountId: 'acct-second' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  store.setPriorityList([first.id]);
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const headers = { 'x-codex-session-id': 'rotate-at-five' };
    assert.equal((await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'one' }, headers)).response.status, 200);
    assert.equal(store.sessionUpstream('rotate-at-five'), null);
    assert.equal(store.sessionRotationUpstream('rotate-at-five'), first.id);
    assert.equal((await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'two' }, headers)).response.status, 200);
    assert.deepEqual(authHeaders, [`Bearer ${store.credentials(first.id).accessToken}`, `Bearer ${store.credentials(second.id).accessToken}`]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes by model preference, explicit type, and explicit upstream ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-routing-'));
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ id: 'ok', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = new Store(dir);
  const codex = store.create(codexInput());
  const compass = store.create({ type: 'compass', projectId: 'routing-project', projectKey: 'routing-secret' });
  store.setCap(codex.id, { capDollars: 100 });
  store.setCap(compass.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    assert.equal((await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'hi' })).response.status, 200);
    assert.equal((await request(base, '/v1/responses', { model: 'claude-fable-5', input: 'hi' })).response.status, 200);
    assert.equal((await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'hi' }, { 'x-upstream-type': 'compass' })).response.status, 200);
    assert.equal((await request(base, '/v1/responses', { model: 'claude-fable-5', input: 'hi' }, { 'x-upstream-id': codex.id })).response.status, 200);
    assert.equal((await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'hi' }, { 'x-codex-session-id': 'model-switch-session' })).response.status, 200);
    assert.equal((await request(base, '/v1/responses', { model: 'claude-fable-5', input: 'hi' }, { 'x-codex-session-id': 'model-switch-session' })).response.status, 200);
    assert.deepEqual(urls.map((url) => new URL(url).host), ['chatgpt.com', 'compass.llm.shopee.io', 'compass.llm.shopee.io', 'chatgpt.com', 'chatgpt.com', 'chatgpt.com']);
    const invalid = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'hi' }, { 'x-upstream-id': 'missing' });
    assert.equal(invalid.response.status, 503);
    const wrongMessages = await request(base, '/v1/messages', { model: 'claude-fable-5', messages: [] }, { 'x-upstream-id': codex.id });
    assert.equal(wrongMessages.response.status, 503);
    assert.equal(urls.length, 6);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retries Codex proxy requests with a rotated access token after 401', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-proxy-refresh-'));
  const authHeaders = [];
  let upstreamCalls = 0;
  const fetchImpl = async (url, options) => {
    if (url === 'https://auth.openai.com/oauth/token') {
      return new Response(JSON.stringify({ access_token: 'rotated-access-token', expires_in: 3600 }), { status: 200 });
    }
    authHeaders.push(options.headers.authorization);
    upstreamCalls += 1;
    if (upstreamCalls === 1) return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'resp-2', output_text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = new Store(dir);
  const created = store.create(codexInput({ refreshToken: 'refresh-token' }));
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const result = await request(base, '/v1/responses', { model: 'gpt-5-codex', input: 'hello' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(authHeaders, ['Bearer ' + jwt({ email: 'proxy@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-proxy' } }), 'Bearer rotated-access-token']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails over after a successful same-account refresh is still rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-auth-exhausted-failover-'));
  const store = new Store(dir);
  const first = store.create(codexInput({ refreshToken: 'refresh-token', email: 'first-exhausted@example.com', accountId: 'first-exhausted' }));
  const second = store.create(codexInput({ email: 'second-exhausted@example.com', accountId: 'second-exhausted' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const firstToken = store.credentials(first.id).accessToken;
  const secondToken = store.credentials(second.id).accessToken;
  const providerCalls = [];
  const fetchImpl = async (url, options = {}) => {
    if (url === 'https://auth.openai.com/oauth/token') return new Response(JSON.stringify({ access_token: 'rotated-but-rejected', expires_in: 3600 }), { status: 200 });
    providerCalls.push(options.headers.authorization);
    if (options.headers.authorization === `Bearer ${secondToken}`) return new Response(JSON.stringify({ id: 'auth-fallback', status: 'completed', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
  };
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const result = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'auth fallback' });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.id, 'auth-fallback');
    assert.deepEqual(providerCalls, [`Bearer ${firstToken}`, 'Bearer rotated-but-rejected', `Bearer ${secondToken}`]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not fail over when the selected Codex credential refresh fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-auth-no-failover-'));
  const store = new Store(dir);
  const first = store.create(codexInput({ refreshToken: 'bad-refresh', email: 'first-auth@example.com', accountId: 'first-auth' }));
  const second = store.create(codexInput({ email: 'second-auth@example.com', accountId: 'second-auth' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const firstToken = store.credentials(first.id).accessToken;
  const providerCalls = [];
  const fetchImpl = async (url, options = {}) => {
    if (url === 'https://auth.openai.com/oauth/token') throw new Error('refresh unavailable');
    providerCalls.push(options.headers.authorization);
    if (options.headers.authorization === `Bearer ${firstToken}`) return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'should-not-run', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const result = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'auth' });
    assert.equal(result.response.status, 502);
    assert.deepEqual(providerCalls, [`Bearer ${firstToken}`]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not fail over after an expired Codex credential refresh is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-expired-auth-no-failover-'));
  const store = new Store(dir);
  const first = store.create(codexInput({ refreshToken: 'expired-refresh', email: 'first-expired@example.com', accountId: 'first-expired' }));
  const second = store.create(codexInput({ email: 'second-expired@example.com', accountId: 'second-expired' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  store.persistCredentials(first.id, store.credentials(first.id), new Date(Date.now() - 1_000).toISOString());
  const providerCalls = [];
  const fetchImpl = async (url, options = {}) => {
    if (url === 'https://auth.openai.com/oauth/token') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
    providerCalls.push(options.headers.authorization);
    return new Response(JSON.stringify({ id: 'should-not-run', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const result = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'expired' });
    assert.equal(result.response.status, 502);
    assert.deepEqual(providerCalls, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proxies Compass Chat, Responses, and Anthropic Messages directly and settles reported cost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compass-proxy-'));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ id: 'compass-1', model: 'claude-fable-5', content: [{ type: 'text', text: 'hello' }], usage: { price_cost_usd: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const store = new Store(dir);
  const created = store.create({ type: 'compass', projectId: 'project-1', projectKey: 'project-secret' });
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    for (const path of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) {
      const payload = path === '/v1/responses'
        ? { model: 'claude-fable-5', input: 'hello' }
        : { model: 'claude-fable-5', messages: [{ role: 'user', content: 'hello' }] };
      const response = await request(base, path, payload, { 'x-upstream-type': 'compass', 'anthropic-version': '2023-06-01' });
      assert.equal(response.response.status, 200);
    }
    assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
      '/compass-api/v1/chat/completions',
      '/compass-api/v1/responses',
      '/compass-api/v1/messages'
    ]);
    assert.equal(calls[0].options.headers.authorization, 'Bearer project-secret');
    assert.equal(store.getPublic(created.id).spending.spentDollars, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails over Compass after an invalid project key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compass-auth-failover-'));
  const store = new Store(dir);
  const first = store.create({ type: 'compass', projectId: 'first-project', projectKey: 'first-secret' });
  const second = store.create({ type: 'compass', projectId: 'second-project', projectKey: 'second-secret' });
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const calls = [];
  const { server, base } = await runningServer(store, async (_url, options) => {
    calls.push(options.headers.authorization);
    if (calls.length === 1) return new Response(JSON.stringify({ retcode: 40101, message: 'API key not found' }), { status: 401 });
    return new Response(JSON.stringify({ id: 'compass-ok', content: [], model: 'claude-sonnet-4-6' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await request(base, '/v1/messages', { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(result.response.status, 200);
    assert.deepEqual(calls, ['Bearer first-secret', 'Bearer second-secret']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redacts provider 5xx bodies, passes valid Anthropic 4xx, and rejects failed Codex SSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-proxy-errors-'));
  const store = new Store(dir);
  const codex = store.create(codexInput());
  const compass = store.create({ type: 'compass', projectId: 'errors-project', projectKey: 'secret' });
  store.setCap(codex.id, { capDollars: 100 });
  store.setCap(compass.id, { capDollars: 100 });
  let mode = 'compass-500';
  const fetchImpl = async () => {
    if (mode === 'compass-500') return new Response(JSON.stringify({ secret: 'provider-internal-secret' }), { status: 500, headers: { 'content-type': 'application/json' } });
    if (mode === 'compass-400') return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    const status = mode === 'codex-failed-no-status' ? '' : '"status":"failed",';
    return new Response(`data: {"type":"response.failed","response":{${status}"error":{"message":"sensitive upstream details"}}}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    let result = await request(base, '/v1/messages', { model: 'claude-fable-5', messages: [] }, { 'x-upstream-type': 'compass' });
    assert.equal(result.response.status, 502);
    assert.equal(JSON.stringify(result.body).includes('provider-internal-secret'), false);
    mode = 'compass-400';
    result = await request(base, '/v1/messages', { model: 'claude-fable-5', messages: [] }, { 'x-upstream-type': 'compass' });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.message, 'bad request');
    mode = 'codex-failed';
    result = await request(base, '/v1/chat/completions', { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }], stream: false }, { 'x-upstream-type': 'codex' });
    assert.equal(result.response.status, 502);
    assert.equal(JSON.stringify(result.body).includes('sensitive upstream details'), false);
    mode = 'codex-failed-no-status';
    const failedWithoutStatus = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'hi', stream: false }, { 'x-upstream-type': 'codex' });
    assert.equal(failedWithoutStatus.response.status, 502);
    assert.equal(JSON.stringify(failedWithoutStatus.body).includes('sensitive upstream details'), false);
    mode = 'codex-failed';
    const streamed = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }], stream: true })
    });
    const streamText = await streamed.text();
    assert.match(streamText, /upstream_response_failed/);
    assert.equal(streamText.includes('sensitive upstream details'), false);
    assert.equal(streamText.includes('[DONE]'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes and collects non-streaming public Codex Responses and Chat SSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-codex-collect-'));
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response('data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}}\n\ndata: {"type":"response.completed","response":{"id":"resp-live","model":"gpt-5.6-sol","output":[],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const responses = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'OK', stream: false });
    assert.equal(responses.response.status, 200);
    assert.equal(responses.body.object, 'response');
    assert.equal(responses.body.output[0].content[0].text, 'OK');
    assert.deepEqual(bodies[0].input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'OK' }] }]);
    assert.equal(bodies[0].store, false);
    assert.equal(bodies[0].stream, true);

    const chat = await request(base, '/v1/chat/completions', { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'OK' }], stream: false });
    assert.equal(chat.response.status, 200);
    assert.equal(chat.body.choices[0].message.content, 'OK');
    assert.equal(bodies[1].store, false);
    assert.equal(bodies[1].stream, true);

    const compact = await request(base, '/v1/responses/compact', { model: 'gpt-5.6-sol', input: [] });
    assert.equal(compact.response.status, 404);
    assert.equal(compact.body.error.code, 'unsupported_endpoint');
    assert.equal(bodies.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settles streamed Codex usage when the upstream omits its content type', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-codex-headerless-sse-'));
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const terminal = { type: 'response.completed', response: { id: 'resp-headerless', status: 'completed', model: 'gpt-5.6-luna', output: [], usage: { input_tokens: 9, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 5, total_tokens: 14 } } };
  const { server, base } = await runningServer(store, async () => new Response(`event: response.completed\ndata: ${JSON.stringify(terminal)}\n\n`, { status: 200 }));
  try {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-luna', input: 'hello', stream: true }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    await response.text();
    assert.equal(store.get(created.id).spending.spentCostMicros, 8);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes Codex envelopes and scopes metadata headers to backend routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-envelope-'));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (new URL(url).pathname === '/backend-api/codex/models') {
      return new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('data: {"type":"response.completed","response":{"id":"resp-envelope","output":[]}}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'next-turn' }
    });
  };
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl, 'local-client-key');
  try {
    const metadata = JSON.stringify({ code_mode_tool_names: ['shell'], safe: true });
    const backend = await fetch(base + '/backend-api/codex/v1/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-client-key',
        'content-type': 'application/json',
        'x-codex-turn-metadata': metadata,
        'x-codex-window-id': 'window-1',
        'x-codex-parent-thread-id': 'parent-1',
        'x-codex-installation-id': 'install-1',
        'x-codex-turn-state': 'turn-1',
        'x-openai-subagent': 'subagent-1',
        'x-codex-session-id': 'must-not-forward'
      },
      body: JSON.stringify({
        model: 'gpt-5.6-sol', input: 'hello', stream: true, service_tier: ' fast ',
        reasoningEffort: 'minimal', reasoning_summary: 'concise',
        include: ['reasoning.encrypted_content', 'custom', 'reasoning.encrypted_content']
      })
    });
    await backend.text();
    assert.equal(backend.status, 200);
    assert.equal(backend.headers.get('x-codex-turn-state'), 'next-turn');
    assert.match(backend.headers.get('x-models-etag'), /^W\/"cp-models-v1-[a-f0-9]{64}"$/);

    const backendCall = calls.find((call) => new URL(call.url).pathname === '/backend-api/codex/responses');
    assert.equal(backendCall.body.input, 'hello');
    assert.equal(backendCall.body.instructions, '');
    assert.deepEqual(backendCall.body.reasoning, { effort: 'low', summary: 'concise' });
    assert.equal('reasoningEffort' in backendCall.body, false);
    assert.equal(backendCall.body.service_tier, 'priority');
    assert.deepEqual(backendCall.body.include, ['reasoning.encrypted_content', 'custom']);
    assert.equal(backendCall.options.headers['x-codex-window-id'], 'window-1');
    assert.deepEqual(JSON.parse(backendCall.options.headers['x-codex-turn-metadata']), { safe: true });
    assert.equal('x-codex-session-id' in backendCall.options.headers, false);

    calls.length = 0;
    const publicResponse = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-client-key',
        'content-type': 'application/json',
        'x-codex-turn-state': 'must-not-forward'
      },
      body: JSON.stringify({
        model: 'gpt-5.6-sol', input: 'hello', stream: true, service_tier: 'auto',
        reasoning: { effort: 'ultra', summary: 'detailed' }
      })
    });
    await publicResponse.text();
    assert.equal(publicResponse.headers.get('x-codex-turn-state'), null);
    assert.equal(publicResponse.headers.get('x-models-etag'), null);
    assert.deepEqual(calls[0].body.reasoning, { effort: 'max', summary: 'detailed' });
    assert.equal('service_tier' in calls[0].body, false);
    assert.deepEqual(calls[0].body.include, ['reasoning.encrypted_content']);
    assert.equal('x-codex-turn-state' in calls[0].options.headers, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('converts legacy Anthropic thinking only for Claude 4.7 and newer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-adaptive-thinking-'));
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: 'msg-1', content: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const store = new Store(dir);
  const created = store.create({ type: 'compass', projectId: 'thinking-project', projectKey: 'thinking-secret' });
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    for (const model of ['claude-sonnet-4-6', 'claude-sonnet-4-7', 'claude-fable-5']) {
      const result = await request(base, '/v1/messages', {
        model, messages: [], thinking: { type: 'enabled', budget_tokens: 2048, extra: true }
      });
      assert.equal(result.response.status, 200);
    }
    assert.deepEqual(bodies[0].thinking, { type: 'enabled', budget_tokens: 2048, extra: true });
    assert.deepEqual(bodies[1].thinking, { type: 'adaptive', extra: true });
    assert.deepEqual(bodies[2].thinking, { type: 'adaptive', extra: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settles the latest reported Compass streaming cost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-compass-stream-cost-'));
  const fetchImpl = async () => new Response([
    'data: {"type":"message_start","usage":{"price_cost_usd":1}}',
    'data: {"type":"message_delta","usage":{"price_cost_usd":2}}',
    'data: [DONE]', ''
  ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const store = new Store(dir);
  const created = store.create({ type: 'compass', projectId: 'stream-project', projectKey: 'stream-secret' });
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const response = await fetch(base + '/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5', messages: [{ role: 'user', content: 'hello' }], stream: true })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(store.getPublic(created.id).spending.spentDollars, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settles priced Codex and streamed Anthropic usage, preferring reported costs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-priced-settlement-'));
  const store = new Store(dir);
  const codex = store.create(codexInput());
  const compass = store.create({ type: 'compass', projectId: 'priced-project', projectKey: 'priced-secret' });
  store.setCap(codex.id, { capDollars: 100 });
  store.setCap(compass.id, { capDollars: 100 });
  let reported = false;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.model.startsWith('claude-')) {
      return new Response([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":10,"cache_creation_input_tokens":50}}}',
        'data: {"type":"message_delta","usage":{"output_tokens":20}}',
        'data: [DONE]', ''
      ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({
      id: 'priced-codex', model: 'gpt-5.6-sol', output: [],
      usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 100, total_tokens: 1_100, ...(reported ? { price_cost_usd: '2' } : {}) }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    let response = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'price', stream: false });
    assert.equal(response.response.status, 200);
    let settlements = Object.values(store.get(codex.id).spending.settlements);
    assert.equal(settlements[0].settledCostMicros, 7_100);
    assert.equal(settlements[0].costSource, 'pricing_snapshot');

    reported = true;
    response = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'reported', stream: false });
    assert.equal(response.response.status, 200);
    settlements = Object.values(store.get(codex.id).spending.settlements);
    assert.equal(settlements[1].settledCostMicros, 2_000_000);
    assert.equal(settlements[1].costSource, 'upstream_reported');

    const stream = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-upstream-type': 'compass' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'price' }], stream: true }) });
    assert.equal(stream.status, 200);
    await stream.text();
    settlements = Object.values(store.get(compass.id).spending.settlements);
    assert.equal(settlements[0].settledCostMicros, 791);
    assert.equal(settlements[0].costSource, 'pricing_snapshot');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails over only safe pre-output failures while preserving explicit pins and soft session preferences', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-failover-'));
  const store = new Store(dir);
  const first = store.create(codexInput({ email: 'first-failover@example.com', accountId: 'first-failover' }));
  const second = store.create(codexInput({ email: 'second-failover@example.com', accountId: 'second-failover' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const firstToken = store.credentials(first.id).accessToken;
  const calls = [];
  let firstStatus = 503;
  const fetchImpl = async (_url, options) => {
    calls.push(options.headers.authorization);
    if (options.headers.authorization === `Bearer ${firstToken}`) return new Response(JSON.stringify({ error: { code: 'model_not_found', type: 'invalid_request_error', param: 'model' } }), { status: firstStatus, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'fallback', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    let result = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'retry' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(calls, [`Bearer ${firstToken}`, `Bearer ${store.credentials(second.id).accessToken}`]);

    calls.length = 0;
    firstStatus = 429;
    result = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'retry' }, { 'x-upstream-id': first.id });
    assert.equal(result.response.status, 502);
    assert.deepEqual(calls, [`Bearer ${firstToken}`]);

    calls.length = 0;
    store.pinSession('pinned-failover', first.id);
    result = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'retry' }, { 'x-codex-session-id': 'pinned-failover' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(calls, [`Bearer ${firstToken}`, `Bearer ${store.credentials(second.id).accessToken}`]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails over pre-output transport, rate-limit, and model-unavailable failures', async () => {
  for (const failure of ['network', 429, 404]) {
    const dir = mkdtempSync(join(tmpdir(), `codex-pooler-node-pre-output-${failure}-`));
    const store = new Store(dir);
    const first = store.create(codexInput({ email: `first-${failure}@example.com`, accountId: `first-${failure}` }));
    const second = store.create(codexInput({ email: `second-${failure}@example.com`, accountId: `second-${failure}` }));
    store.setCap(first.id, { capDollars: 100 });
    store.setCap(second.id, { capDollars: 100 });
    const firstToken = store.credentials(first.id).accessToken;
    const calls = [];
    const fetchImpl = async (_url, options) => {
      calls.push(options.headers.authorization);
      if (options.headers.authorization !== `Bearer ${firstToken}`) return new Response(JSON.stringify({ id: 'fallback', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (failure === 'network') throw Object.assign(new Error('connection reset'), { name: 'TimeoutError' });
      const error = failure === 404 ? { code: 'model_not_found', type: 'invalid_request_error', param: 'model' } : { type: 'rate_limit_error' };
      return new Response(JSON.stringify({ error }), { status: failure, headers: { 'content-type': 'application/json' } });
    };
    const { server, base } = await runningServer(store, fetchImpl);
    try {
      const result = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'retry' });
      assert.equal(result.response.status, 200, String(failure));
      assert.equal(calls.length, 2, String(failure));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('rejects oversized session IDs before dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-session-id-limit-'));
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  let calls = 0;
  const { server, base } = await runningServer(store, async () => { calls += 1; return new Response('{}'); });
  try {
    const result = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'no dispatch' }, { 'x-codex-session-id': 'x'.repeat(201) });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.code, 'invalid_session_id');
    assert.equal(calls, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails over malformed non-streaming Codex responses before output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-invalid-collection-failover-'));
  const store = new Store(dir);
  const first = store.create(codexInput({ email: 'error-object@example.com', accountId: 'error-object' }));
  const second = store.create(codexInput({ email: 'invalid-collection@example.com', accountId: 'invalid-collection' }));
  const third = store.create(codexInput({ email: 'valid-collection@example.com', accountId: 'valid-collection' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  store.setCap(third.id, { capDollars: 100 });
  const firstToken = store.credentials(first.id).accessToken;
  const secondToken = store.credentials(second.id).accessToken;
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.headers.authorization);
    if (options.headers.authorization === `Bearer ${firstToken}`) return new Response('{"error":{"message":"provider-secret"}}', { headers: { 'content-type': 'application/json' } });
    if (options.headers.authorization === `Bearer ${secondToken}`) return new Response('data: {"type":"response.output_text.delta","delta":"incomplete"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return new Response('data: {"type":"response.completed","response":{"id":"valid-fallback","status":"completed","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const result = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'fallback', stream: false });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.id, 'valid-fallback');
    assert.equal(calls.length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ignores SSE heartbeat comments before valid public events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-sse-heartbeat-'));
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const fetchImpl = async () => new Response(': keepalive\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"heartbeat","status":"completed","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'heartbeat', stream: true }) });
    const text = await response.text();
    assert.match(text, /"id":"heartbeat"/);
    assert.doesNotMatch(text, /"type":"error"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails over only an initial retryable SSE terminal event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-sse-first-event-failover-'));
  const store = new Store(dir);
  const first = store.create(codexInput({ email: 'first-sse@example.com', accountId: 'first-sse' }));
  const second = store.create(codexInput({ email: 'second-sse@example.com', accountId: 'second-sse' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const firstToken = store.credentials(first.id).accessToken;
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.headers.authorization);
    if (options.headers.authorization === `Bearer ${firstToken}`) {
      return new Response('event: response.failed\ndata: {"type":"response.failed","error":{"code":"rate_limit_exceeded"}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"fallback","status":"completed","output":[]}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'retry', stream: true }) });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.match(text, /"id":"fallback"/);
    assert.doesNotMatch(text, /rate_limit_exceeded/);

    calls.length = 0;
    const collected = await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'retry', stream: false });
    assert.equal(collected.response.status, 200);
    assert.equal(collected.body.id, 'fallback');
    assert.equal(calls.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizes committed public SSE failures without replaying another upstream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-sse-sanitized-failure-'));
  const store = new Store(dir);
  const first = store.create(codexInput({ email: 'first-sse-failure@example.com', accountId: 'first-sse-failure' }));
  const second = store.create(codexInput({ email: 'second-sse-failure@example.com', accountId: 'second-sse-failure' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const firstToken = store.credentials(first.id).accessToken;
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.headers.authorization);
    if (options.headers.authorization !== `Bearer ${firstToken}`) throw new Error('must not replay');
    return new Response([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"visible"}',
      'event: response.failed\ndata: {"type":"response.failed","error":{"code":"provider_secret","message":"provider-secret"}}', ''
    ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'stream', stream: true }) });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [`Bearer ${firstToken}`]);
    assert.match(text, /visible/);
    assert.match(text, /"code":"server_error"/);
    assert.doesNotMatch(text, /provider_secret|provider-secret/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sequences public Responses events and drops data after a terminal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-sse-sequence-'));
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const fetchImpl = async () => new Response([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"seq","status":"in_progress"}}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"seq","status":"completed","output":[]}}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"must-not-appear"}', ''
  ].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'sequence', stream: true }) });
    const events = (await response.text()).trim().split('\n\n').map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6)));
    assert.deepEqual(events.map((event) => event.sequence_number), [0, 1]);
    assert.equal(events.at(-1).type, 'response.completed');
    assert.doesNotMatch(JSON.stringify(events), /must-not-appear/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bounds oversized incomplete public SSE events without exposing their content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-sse-size-'));
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const secret = 'oversized-provider-content';
  const fetchImpl = async () => new Response(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${secret.repeat(400_000)}`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'large', stream: true }) });
    const text = await response.text();
    assert.match(text, /"code":"server_error"/);
    assert.doesNotMatch(text, /oversized-provider-content/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not replay an SSE request after output has started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-no-stream-replay-'));
  const store = new Store(dir);
  const first = store.create(codexInput({ email: 'first-stream@example.com', accountId: 'first-stream' }));
  const second = store.create(codexInput({ email: 'second-stream@example.com', accountId: 'second-stream' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const firstToken = store.credentials(first.id).accessToken;
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.headers.authorization);
    if (options.headers.authorization !== `Bearer ${firstToken}`) return new Response('unexpected retry', { status: 200 });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"visible"}\n\n'));
        setTimeout(() => controller.error(new Error('upstream stream broke')), 30);
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const text = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'stream', stream: true }) }).then((response) => response.text()).catch(() => null);
    assert.deepEqual(calls, [`Bearer ${firstToken}`]);
    assert.match(text, /"code":"server_error"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancels the upstream SSE reader when the downstream client disconnects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-sse-disconnect-'));
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  let cancelled = false;
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"disconnect","status":"in_progress"}}\n\n')); },
    cancel() { cancelled = true; }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'disconnect', stream: true }) });
    await response.body.cancel();
    for (let attempt = 0; attempt < 20 && !cancelled; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cancelled, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects oversized non-streaming upstream responses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-large-response-'));
  const huge = JSON.stringify({ id: 'too-large', padding: 'x'.repeat(17 * 1024 * 1024) });
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, async () => new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hello' }) });
    assert.equal(response.status, 502);
    assert.deepEqual((await response.json()).error, { type: 'server_error', code: 'upstream_error', message: 'Upstream request failed', param: null });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('survives an upstream error after streaming response headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-midstream-error-'));
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'));
      setTimeout(() => controller.error(new Error('midstream failure')), 1);
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }], stream: true }) }).then((response) => response.text()).catch(() => null);
    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maps incomplete Codex Chat SSE to finish_reason length', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-incomplete-stream-'));
  const fetchImpl = async () => new Response('data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }], stream: true }) });
    assert.match(await response.text(), /"finish_reason":"length"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('converts split UTF-8 Codex SSE to Chat Completions SSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-proxy-stream-'));
  const bytes = new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hello 🌏"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');
  const emoji = new TextEncoder().encode('🌏');
  const emojiAt = bytes.findIndex((value, index) => emoji.every((part, offset) => bytes[index + offset] === part));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, emojiAt + 2)); controller.enqueue(bytes.slice(emojiAt + 2)); controller.close(); } });
  const fetchImpl = async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'hello' }], stream: true })
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /"content":"hello 🌏"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('continues a response-pinned turn above its cap and fails over a retryable first SSE event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-continuation-cap-'));
  const store = new Store(dir);
  const first = store.create(codexInput({ email: 'pin@example.com', accountId: 'acct-pin' }));
  const second = store.create(codexInput({ email: 'spare@example.com', accountId: 'acct-spare' }));
  store.setCap(first.id, { capDollars: 100 });
  store.setCap(second.id, { capDollars: 100 });
  const authHeaders = [];
  const fetchImpl = async (_url, options) => {
    authHeaders.push(options.headers.authorization);
    return new Response(JSON.stringify({ id: 'resp_pinned01', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const auth = { authorization: 'Bearer pin-key' };
  const { server, base } = await runningServer(store, fetchImpl, 'pin-key');
  try {
    assert.equal((await request(base, '/v1/responses', { model: 'gpt-5.6-sol', input: 'one' }, auth)).response.status, 200);
    const pinned = store.credentials(first.id).accessToken === authHeaders[0].slice(7) ? first : second;
    store.addUsage(pinned.id, { attemptId: 'over-cap', startedAt: new Date(Date.now() + 1).toISOString(), settledCostMicros: 110_000_000, costSource: 'upstream_reported' });
    const continued = await request(base, '/v1/responses', {
      model: 'gpt-5.6-sol', previous_response_id: 'resp_pinned01',
      input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }]
    }, auth);
    assert.equal(continued.response.status, 200);
    assert.equal(authHeaders.at(-1), `Bearer ${store.credentials(pinned.id).accessToken}`);

    store.addUsage(pinned.id, { attemptId: 'past-continuation', startedAt: new Date(Date.now() + 2).toISOString(), settledCostMicros: 130_000_000, costSource: 'upstream_reported' });
    const exhausted = await request(base, '/v1/responses', {
      model: 'gpt-5.6-sol', previous_response_id: 'resp_pinned01',
      input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }]
    }, auth);
    assert.equal(exhausted.response.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails over a retryable first SSE event and keeps the public sequence past an interruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-first-event-retry-'));
  const store = new Store(dir);
  for (const account of ['one', 'two']) {
    const created = store.create(codexInput({ email: `${account}@example.com`, accountId: `acct-${account}` }));
    store.setCap(created.id, { capDollars: 100 });
  }
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const body = calls === 1
      ? 'event: error\ndata: {"type":"error","error":{"type":"server_error","code":"server_error","message":"boom"}}\n\n'
      : [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_seq","status":"in_progress"}}',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}', ''
      ].join('\n\n');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { server, base } = await runningServer(store, fetchImpl);
  try {
    const response = await fetch(base + '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'stream', stream: true })
    });
    const events = (await response.text()).trim().split('\n\n').map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6)));
    assert.equal(calls, 2);
    assert.deepEqual(events.map((event) => [event.type, event.sequence_number]), [['response.created', 0], ['response.output_text.delta', 1], ['error', 2]]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strips unsupported explicit prompt cache controls before Codex egress while keeping prompt_cache_key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-prompt-cache-'));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response('data: {"type":"response.completed","response":{"id":"resp-cache","output":[]}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const store = new Store(dir);
  const created = store.create(codexInput());
  store.setCap(created.id, { capDollars: 100 });
  const { server, base } = await runningServer(store, fetchImpl);
  const buildPayload = () => ({
    model: 'gpt-5.6-sol',
    prompt_cache_key: 'cache-key-fixture',
    prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    input: [{
      type: 'message', role: 'user',
      content: [
        { type: 'input_text', text: 'fixture', prompt_cache_breakpoint: { mode: 'explicit' } },
        { type: 'input_file', file_id: 'file-1', prompt_cache_breakpoint: { mode: 'explicit' } }
      ]
    }]
  });
  try {
    for (const path of ['/v1/responses', '/backend-api/codex/responses/compact']) {
      calls.length = 0;
      const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildPayload()) });
      await response.text();
      assert.equal(response.status, 200, path);
      const body = calls[0].body;
      assert.equal(body.prompt_cache_key, 'cache-key-fixture', path);
      assert.equal('prompt_cache_options' in body, false, path);
      assert.equal('prompt_cache_breakpoint' in body.input[0].content[0], false, path);
      assert.equal('prompt_cache_breakpoint' in body.input[0].content[1], false, path);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
