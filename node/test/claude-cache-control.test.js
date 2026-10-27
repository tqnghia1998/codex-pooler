import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareClaudeRequestBody, signClaudeOAuthBody } from '../src/claude-protocol.js';

function cacheMarkers(body) {
  return [
    ...(body.tools || []),
    ...(body.system || []),
    ...body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
  ].flatMap((block) => block.cache_control ? [block.cache_control] : []);
}

function assertValidCacheOrder(body) {
  let shortSeen = false;
  const markers = cacheMarkers(body);
  assert.ok(markers.length > 0 && markers.length <= 4);
  for (const marker of markers) {
    const ttl = marker.ttl || '5m';
    assert.ok(!shortSeen || ttl !== '1h', 'a 1h cache marker must not follow a 5m marker');
    if (ttl === '5m') shortSeen = true;
  }
}

function prepare({ messages, tools, credentials = { accessToken: 'sk-ant-oat-synthetic' }, metadata, claudeConfig }) {
  return prepareClaudeRequestBody({
    req: { headers: {} },
    body: { model: 'claude-sonnet-4-6', max_tokens: 32, messages, ...(tools ? { tools } : {}) },
    credentials,
    upstream: { id: 'cache-test', type: 'claude', metadata },
    sessionId: '11111111-2222-4333-8444-555555555555',
    skipDiagnostics: true,
    claudeConfig
  });
}

for (const toolTtl of [undefined, '5m']) {
  test(`OAuth trailing system messages normalize all cache markers with tool TTL ${toolTtl}`, () => {
    const prepared = prepare({
      tools: toolTtl ? [{ name: 'lookup', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: toolTtl } }] : undefined,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'continue' },
        { role: 'system', content: 'a final instruction' }
      ]
    });
    assertValidCacheOrder(prepared);
    assert.equal(prepared.messages[3].content[0].text, 'a final instruction');
    assert.equal(prepared.messages[3].content[0].cache_control.ttl || '5m', toolTtl || '1h');
    assert.equal(cacheMarkers(prepared).length, toolTtl ? 4 : 3);
  });
}

for (const trailingSystem of [false, true]) {
  test(`API-key cloak normalizes a caller 1h marker after injected 5m markers; trailing system=${trailingSystem}`, () => {
    const prepared = prepare({
      credentials: { projectKey: 'sk-ant-api03-synthetic' },
      metadata: { cloak_mode: 'always' },
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: [{ type: 'text', text: 'continue', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        ...(trailingSystem ? [{ role: 'system', content: 'a final instruction' }] : [])
      ]
    });
    assertValidCacheOrder(prepared);
    assert.equal(prepared.messages[2].content[0].text, 'continue');
    assert.deepEqual(prepared.messages[2].content[0].cache_control, { type: 'ephemeral' });
  });
}

test('cache ordering preserves valid long tool prefixes and explicit short markers', () => {
  const prepared = prepare({
    tools: [{ name: 'lookup', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
      { role: 'user', content: [{ type: 'text', text: 'continue', cache_control: { type: 'ephemeral', ttl: '1h' } }] }
    ]
  });
  assertValidCacheOrder(prepared);
  assert.deepEqual(prepared.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(prepared.messages[1].content[0].cache_control, { type: 'ephemeral', ttl: '5m' });
  assert.deepEqual(prepared.messages[2].content[0].cache_control, { type: 'ephemeral' });
});

test('payload overrides cannot reintroduce invalid cache TTL order before OAuth signing', () => {
  const prepared = prepare({
    messages: [{ role: 'user', content: 'hello' }],
    claudeConfig: { payload: { override: [{
      models: [{ name: 'claude-*' }],
      params: {
        'system.1.cache_control.ttl': '5m',
        'messages.0.content.1.cache_control.ttl': '1h'
      }
    }] } }
  });
  assertValidCacheOrder(prepared);
  const unsigned = structuredClone(prepared);
  unsigned.system[0].text = unsigned.system[0].text.replace(/cch=[0-9a-f]{5};/, 'cch=00000;');
  assert.deepEqual(signClaudeOAuthBody(unsigned), prepared);
});

test('native Claude Code retains caller-owned mixed cache TTLs', () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const system = [{ type: 'text', text: 'native system', cache_control: { type: 'ephemeral', ttl: '1h' } }];
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'native prompt', cache_control: { type: 'ephemeral' } }] }];
  const prepared = prepareClaudeRequestBody({
    req: { headers: {
      'user-agent': 'claude-cli/2.1.310 (external, cli)',
      'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219',
      'x-claude-code-session-id': sessionId
    } },
    body: { model: 'claude-sonnet-4-6', max_tokens: 32, system, messages, metadata: { user_id: JSON.stringify({
      device_id: 'f'.repeat(64), account_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', session_id: sessionId
    }) } },
    credentials: { accessToken: 'sk-ant-oat-synthetic' },
    upstream: { id: 'native-cache', type: 'claude' },
    sessionId
  });
  assert.deepEqual(prepared.system.at(-1), system[0]);
  assert.deepEqual(prepared.messages, messages);
  assert.deepEqual(cacheMarkers(prepared), [{ type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral' }]);
});
