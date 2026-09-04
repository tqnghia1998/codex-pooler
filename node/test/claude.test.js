import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect as connectTcp, createServer as createTcpServer } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { claudeMetadataModelExcluded, createUpstream, parseClaudeAuthJson } from '../src/domain.js';
import { CLAUDE_OAUTH_PROFILE_URL, CLAUDE_OAUTH_TOKEN_URL } from '../src/providers.js';
import { claudeModelAlias, claudeRequestedBetas, claudeRequestHeaders, claudeSessionIdForRequest, ensureClaudeCredentialIdentity, forgetClaudeThinkingReplay, prepareClaudeRequestBody, prepareClaudeThinkingReplayRequest, recordClaudeThinkingReplay, signClaudeOAuthBody } from '../src/claude-protocol.js';
import { captureClaudeThinkingReplayResponse } from '../src/claude-thinking-replay.js';
import { countClaudeInputTokens } from '../src/claude-input-tokens.js';
import { applyClaudeRequestScopedAction, claudeCoolingDisabled, claudeRequestRetryLimit, classifyHttpResponse, classifySseEvent } from '../src/upstream-outcomes.js';
import { decodeClaudeResponse } from '../src/upstream-response.js';

const API_KEY = 'client-key';

test('decodes CPA-compatible Claude response compression, including missing headers', async () => {
  const payload = JSON.stringify({ type: 'message', id: 'compressed' });
  for (const [encoding, bytes] of [
    ['', gzipSync(payload)],
    ['deflate', deflateSync(payload)],
    ['br', brotliCompressSync(payload)],
    ['compress', Buffer.from('H52Qe0TQyQOnjAgdItqUmTMnzBmDLESkIXNQxJg3beDIWTinDMU+', 'base64')],
    ['compress', Buffer.from('H52QgB7ER0PJwMoiHQiNplOZzMJng4sERpMkIERjN5tOByhhzMsVPsBA', 'base64')]
  ]) {
    const response = await decodeClaudeResponse(new Response(bytes, {
      status: 200,
      headers: encoding ? { 'content-encoding': encoding } : {}
    }));
    assert.deepEqual(await response.json(), JSON.parse(payload));
    assert.equal(response.headers.get('content-encoding'), null);
  }
});

test('rejects Claude responses whose decoded size exceeds the configured limit', async () => {
  const compressed = gzipSync(Buffer.alloc(4 * 1024, 0x61));
  await assert.rejects(
    decodeClaudeResponse(new Response(compressed, { status: 200, headers: { 'content-encoding': 'gzip' } }), { maxBytes: 128 }),
    (error) => error.statusCode === 502 && /Unable to decode Claude response|too large/.test(error.message)
  );
});

test('classifies CPA Claude rate-limit scope without cooling ordinary model 429s', () => {
  const ordinary = classifyHttpResponse(
    new Response(null, { status: 429 }),
    { type: 'error', error: { type: 'rate_limit_error', message: 'model request limited' } },
    { upstreamType: 'claude' }
  );
  assert.deepEqual({ class: ordinary.class, retryable: ordinary.retryable, modelScoped: ordinary.modelScoped }, { class: 'neutral', retryable: true, modelScoped: true });

  const unified = classifyHttpResponse(
    new Response(null, { status: 429, headers: {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': '60'
    } }),
    { type: 'error', error: { type: 'rate_limit_error', message: 'account limited' } },
    { upstreamType: 'claude' }
  );
  assert.equal(unified.class, 'quota');

  const fableOnly = classifyHttpResponse(
    new Response(null, { status: 429, headers: {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
      'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
      'anthropic-ratelimit-unified-7d_oi-reset': '4102444800'
    } }),
    { type: 'error', error: { type: 'rate_limit_error', message: 'Fable usage window rejected' } },
    { upstreamType: 'claude' }
  );
  assert.deepEqual({ class: fableOnly.class, retryable: fableOnly.retryable, modelScoped: fableOnly.modelScoped }, { class: 'neutral', retryable: true, modelScoped: true });
  assert.equal(fableOnly.retryAfter, null);
  assert.deepEqual(fableOnly.resetAt, []);

  const retryAfter = classifyHttpResponse(
    new Response(null, { status: 429, headers: {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
      'retry-after': '120',
      'anthropic-ratelimit-unified-7d_oi-reset': '4102444800'
    } }),
    { type: 'error', error: { type: 'rate_limit_error' } },
    { upstreamType: 'claude' }
  );
  assert.equal(retryAfter.retryAfter, '120');
  assert.deepEqual(retryAfter.resetAt, []);

  const fast = classifyHttpResponse(
    new Response(null, { status: 429 }),
    { type: 'error', error: { type: 'rate_limit_error', message: 'Usage credits are required for fast mode' } },
    { upstreamType: 'claude' }
  );
  assert.deepEqual({ class: fast.class, retryable: fast.retryable }, { class: 'neutral', retryable: false });

  const sse = classifySseEvent(
    { type: 'response.failed', error: { type: 'rate_limit_error', message: 'model request limited' } },
    { upstreamType: 'claude', headers: new Headers({ 'retry-after': '30' }) }
  );
  assert.deepEqual({ class: sse.class, retryable: sse.retryable, modelScoped: sse.modelScoped, retryAfter: sse.retryAfter }, {
    class: 'neutral', retryable: true, modelScoped: true, retryAfter: '30'
  });
});

test('applies CPA Claude request-scoped error actions from canonical and legacy metadata', () => {
  const upstream = { type: 'claude', metadata: {
    request_scoped_errors: JSON.stringify([
      { status: 403, match: ['enterprise policy'], action: 'stop-and-cooldown' },
      { status: 429, match_regexr: ['model busy'], action: 'continue' }
    ])
  } };
  const stopped = applyClaudeRequestScopedAction(
    { class: 'credential', retryable: true, errorCode: 'permission_error' },
    upstream, 403, { error: { message: 'enterprise policy denied' } }
  );
  assert.deepEqual({ class: stopped.class, retryable: stopped.retryable }, { class: 'quota', retryable: false });

  const continued = applyClaudeRequestScopedAction(
    { class: 'quota', retryable: true, errorCode: 'rate_limit_error' },
    { type: 'claude', metadata: { 'request-scoped-errors': [
      { status: 429, match: ['model busy'], action: 'continue-and-cooldown' }
    ] } }, 429, 'model busy, try another account'
  );
  assert.deepEqual({ class: continued.class, retryable: continued.retryable }, { class: 'quota', retryable: true });
});

test('honors CPA Claude cooling and request-retry metadata overrides', () => {
  const upstream = { type: 'claude', metadata: { disable_cooling: true, request_retry: 3 } };
  assert.equal(claudeCoolingDisabled(upstream), true);
  assert.equal(claudeRequestRetryLimit(upstream), 3);
  assert.equal(claudeRequestRetryLimit({ type: 'claude', metadata: { 'request-retry': -1 } }), 0);
  assert.equal(claudeRequestRetryLimit({ type: 'compass', metadata: { request_retry: 8 } }), 0);
});

test('matches CPA raw-byte CCH signing vectors', () => {
  const raw = '{"model":"model-a","messages":[{"role":"user","content":[{"type":"text","text":"x"}]}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;"},{"type":"text","text":"system-x"}],"tools":[],"metadata":{"user_id":"meta-x"},"max_tokens":1,"thinking":{"type":"adaptive","display":"omitted"},"context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},"output_config":{"effort":"high"},"stream":true}';
  const vectors = [
    [raw, '7ee87'],
    [raw.replace('"model":"model-a"', '"model":"model-b"'), '7ee87'],
    [raw.replace('"max_tokens":1', '"max_tokens":2'), '7ee87'],
    [raw.replace('"text":"x"', '"text":"y"'), 'b9cc8'],
    [raw.replace('"metadata":{"user_id":"meta-x"}', '"metadata":{"user_id":"meta-x","max_tokens":2}'), '7ee87'],
    [raw.replace('"metadata":{"user_id":"meta-x"}', '"metadata":{"user_id":"meta-x","plain":"a"}'), '8d74c'],
    [raw.replace('"stream":true}', '"stream":true,"fallbacks":[{"model":"fallback-a"}]}'), '7ee87'],
    [raw.replace('"metadata":{"user_id":"meta-x"}', '"metadata":{"user_id":"meta-x","max_tokens":999,"fallbacks":[{"model":"fallback-model"}]}'), '4589b']
  ];
  for (const [variant, expected] of vectors) {
    const body = JSON.parse(variant);
    signClaudeOAuthBody(body);
    assert.equal(body.system[0].text.match(/cch=([0-9a-f]{5});/)[1], expected, variant);
  }
});

async function start(store, fetchImpl) {
  const server = createServer(createApp({ store, fetchImpl, apiKey: API_KEY }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function startSocks5Proxy({ username = '', password = '' } = {}) {
  const server = createTcpServer((client) => {
    let state = 'greeting';
    let buffer = Buffer.alloc(0);
    const fail = () => client.destroy();
    const connectDestination = (host, port) => {
      const destination = connectTcp(port, host, () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        destination.pipe(client);
        client.pipe(destination);
      });
      destination.on('error', fail);
    };
    const processBuffer = () => {
      while (!client.destroyed) {
        if (state === 'greeting') {
          if (buffer.length < 2) return;
          const count = buffer[1];
          if (buffer.length < 2 + count || buffer[0] !== 5) return fail();
          const methods = buffer.subarray(2, 2 + count);
          buffer = buffer.subarray(2 + count);
          if (username || password) {
            if (!methods.includes(2)) return fail();
            client.write(Buffer.from([5, 2]));
            state = 'auth';
          } else {
            if (!methods.includes(0)) return fail();
            client.write(Buffer.from([5, 0]));
            state = 'request';
          }
          continue;
        }
        if (state === 'auth') {
          if (buffer.length < 2) return;
          const userLength = buffer[1];
          if (buffer.length < 2 + userLength + 1) return;
          const passwordLength = buffer[2 + userLength];
          if (buffer.length < 3 + userLength + passwordLength) return;
          const receivedUser = buffer.subarray(2, 2 + userLength).toString();
          const receivedPassword = buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString();
          const authVersion = buffer[0];
          buffer = buffer.subarray(3 + userLength + passwordLength);
          if (authVersion !== 1 || receivedUser !== username || receivedPassword !== password) return fail();
          client.write(Buffer.from([1, 0]));
          state = 'request';
          continue;
        }
        if (state !== 'request' || buffer.length < 5) return;
        if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) return fail();
        const addressType = buffer[3];
        let host;
        let offset;
        if (addressType === 1) {
          if (buffer.length < 10) return;
          host = [...buffer.subarray(4, 8)].join('.');
          offset = 8;
        } else if (addressType === 3) {
          const length = buffer[4];
          if (buffer.length < 7 + length) return;
          host = buffer.subarray(5, 5 + length).toString();
          offset = 5 + length;
        } else if (addressType === 4) {
          if (buffer.length < 22) return;
          host = buffer.subarray(4, 20).toString('hex').match(/.{1,4}/g).join(':');
          offset = 20;
        } else return fail();
        const port = buffer.readUInt16BE(offset);
        buffer = Buffer.alloc(0);
        state = 'connected';
        connectDestination(host, port);
        return;
      }
    };
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
    });
    client.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function request(base, path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', ...(options.headers || {}) }
  });
}

test('parses Claude Code OAuth credential exports', () => {
  const parsed = parseClaudeAuthJson({ claudeAiOauth: {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: '2026-09-03T00:00:00.000Z',
    email: 'claude@example.com',
    accountUuid: 'account-uuid',
    organizationUuid: 'organization-uuid',
    excluded_models: ['claude-opus-4-6'],
    cloak_sensitive_words: ['Vietnam'],
    cloak_strict_mode: true,
    timezone: 'Asia/Ho_Chi_Minh',
    claude_device_ids: ['a'.repeat(64)]
  }});
  assert.equal(parsed.accessToken, 'access-token');
  assert.equal(parsed.refreshToken, 'refresh-token');
  assert.equal(parsed.accessTokenExpiresAt, '2026-09-03T00:00:00.000Z');
  assert.equal(parsed.email, 'claude@example.com');
  assert.equal(parsed.accountId, 'account-uuid');
  assert.equal(parsed.organizationId, 'organization-uuid');
  assert.equal(parsed.organizationName, '');
  assert.deepEqual(parsed.metadata, {
    excluded_models: ['claude-opus-4-6'],
    cloak_sensitive_words: ['Vietnam'],
    cloak_strict_mode: true,
    timezone: 'Asia/Ho_Chi_Minh',
    claude_device_ids: ['a'.repeat(64)]
  });
  assert.match(parsed.name, /^c[A-Za-z0-9]*$/);

  const numericExpiry = parseClaudeAuthJson({ claudeAiOauth: { accessToken: 'access-token', expiresAt: 1_800_000_000_000 } });
  assert.equal(numericExpiry.accessTokenExpiresAt, '2027-01-15T08:00:00.000Z');

  const configured = parseClaudeAuthJson({
    access_token: 'access-token',
    prefix: 'team-a',
    headers: { 'X-Workspace': 'enterprise' },
    request_scoped_errors: [{ status: 403, match: ['policy'], action: 'stop' }],
    tool_prefix_disabled: true
  });
  assert.equal(configured.metadata['header:X-Workspace'], 'enterprise');
  assert.equal(configured.metadata.prefix, 'team-a');
  assert.deepEqual(configured.metadata.request_scoped_errors, [{ status: 403, match: ['policy'], action: 'stop' }]);
  assert.equal(configured.metadata.tool_prefix_disabled, true);
});

test('accepts CPA ClaudeKey fields at the upstream management boundary', () => {
  const upstream = createUpstream({
    type: 'claude',
    projectKey: 'sk-ant-api-cpa-fields-test',
    headers: { Cookie: 'session=operator', 'X-Tenant': 'west' },
    models: [{ name: 'claude-sonnet-4-6', alias: 'tenant-sonnet', 'display-name': 'Tenant Sonnet', 'max-context-length': 123456, 'force-mapping': true }],
    excludedModels: ['claude-opus-*'],
    proxyUrl: 'socks5h://proxy.example:1080',
    rebuildMidSystemMessage: true,
    disableCooling: true,
    requestRetry: 3,
    fingerprintProfile: 'claude-code-cli'
  }, { allowLegacyClaudeApiKey: true });
  assert.equal(upstream.metadata['header:Cookie'], 'session=operator');
  assert.equal(upstream.metadata['header:X-Tenant'], 'west');
  assert.deepEqual(upstream.metadata.models, [{ name: 'claude-sonnet-4-6', alias: 'tenant-sonnet', 'display-name': 'Tenant Sonnet', 'max-context-length': 123456, 'force-mapping': true }]);
  assert.deepEqual(upstream.metadata.excluded_models, ['claude-opus-*']);
  assert.equal(upstream.metadata.proxy_url, 'socks5h://proxy.example:1080');
  assert.equal(upstream.metadata.rebuild_mid_system_message, true);
  assert.equal(upstream.metadata.disable_cooling, true);
  assert.equal(upstream.metadata.request_retry, 3);
  assert.equal(upstream.metadata.fingerprint_profile, 'claude-code-cli');
});

test('replays CPA is-compat Claude thinking across model variants and streams', async () => {
  const upstream = {
    id: `claude-replay-${Date.now()}-${Math.random()}`,
    type: 'claude',
    metadata: { models: [{ name: 'provider-compat', alias: 'tenant-compat', isCompat: true }] }
  };
  const req = { headers: { 'x-session-id': 'replay-session' }, proxyAuth: { id: 'caller-key' } };
  const credentials = { projectKey: 'sk-ant-api-replay-test' };
  const first = prepareClaudeThinkingReplayRequest({
    req,
    body: { model: 'tenant-compat', messages: [] },
    credentials,
    upstream,
    sessionId: 'replay-session'
  });
  assert.ok(first.scope);
  const cached = [
    { type: 'thinking', thinking: 'cached reasoning', signature: 'signed-thinking' },
    { type: 'text', text: 'Inspecting.' },
    { type: 'tool_use', id: 'toolu_replay', name: 'Read', input: { path: 'README.md' } }
  ];
  assert.equal(recordClaudeThinkingReplay(first.scope, cached), true);
  const second = prepareClaudeThinkingReplayRequest({
    req,
    body: { model: 'tenant-compat', messages: [{ role: 'assistant', content: [cached[1], cached[2]] }] },
    credentials,
    upstream,
    sessionId: 'replay-session'
  });
  assert.equal(second.scope.replayApplied, true);
  assert.deepEqual(second.body.messages[0].content, cached);

  const streamScope = prepareClaudeThinkingReplayRequest({
    req: { ...req, headers: { 'x-session-id': 'stream-replay-session' } },
    body: { model: 'tenant-compat', messages: [] },
    credentials,
    upstream,
    sessionId: 'stream-replay-session'
  }).scope;
  await captureClaudeThinkingReplayResponse(streamScope, new Response([
    'event: message_start\n',
    'data: {"type":"message_start"}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"cached reasoning"}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed-thinking"}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_stream","name":"Read","input":{}}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n'
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const streamReplay = prepareClaudeThinkingReplayRequest({
    req: { ...req, headers: { 'x-session-id': 'stream-replay-session' } },
    body: { model: 'tenant-compat', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_stream', name: 'Read', input: {} }] }] },
    credentials,
    upstream,
    sessionId: 'stream-replay-session'
  });
  assert.equal(streamReplay.scope.replayApplied, true);
  assert.equal(streamReplay.body.messages[0].content[0].type, 'thinking');
  forgetClaudeThinkingReplay(first.scope);
  forgetClaudeThinkingReplay(streamScope);
});

test('strips a matching CPA Claude model prefix before dispatch', () => {
  const upstream = createUpstream({
    type: 'claude',
    projectKey: 'sk-ant-api-prefix-test',
    metadata: { prefix: 'team-a' }
  }, { allowLegacyClaudeApiKey: true });
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: { model: 'team-a/claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] },
    credentials: { projectKey: 'sk-ant-api-prefix-test' },
    upstream,
    sessionId: 'prefix-session'
  });
  assert.equal(prepared.model, 'claude-sonnet-4-6');
});

test('ports CPA per-auth Claude model aliases, suffixes, and force-mapping', () => {
  const upstream = createUpstream({
    type: 'claude',
    authJson: JSON.stringify({
      access_token: 'sk-ant-oat-alias-test',
      model_aliases: [
        { name: 'claude-sonnet-4-6', alias: 'tenant-sonnet', 'force-mapping': true },
        { name: 'claude-opus-4-6(32768)', alias: 'tenant-opus' }
      ]
    })
  });
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: { model: 'tenant-sonnet', messages: [{ role: 'user', content: 'hello' }] },
    credentials: { accessToken: 'sk-ant-oat-alias-test' },
    upstream,
    sessionId: 'alias-session'
  });
  assert.equal(prepared.model, 'claude-sonnet-4-6');
  assert.deepEqual(claudeModelAlias(prepared), {
    requestedModel: 'tenant-sonnet',
    upstreamModel: 'claude-sonnet-4-6',
    forceMapping: true,
    isCompat: false,
    responseModel: 'tenant-sonnet'
  });

  const suffixed = prepareClaudeRequestBody({
    req: { headers: {} },
    body: { model: 'tenant-opus(8192)', messages: [{ role: 'user', content: 'hello' }] },
    credentials: { accessToken: 'sk-ant-oat-alias-test' },
    upstream,
    sessionId: 'alias-session'
  });
  assert.equal(suffixed.model, 'claude-opus-4-6');
  assert.deepEqual(suffixed.thinking, { type: 'enabled', budget_tokens: 32768 });
  assert.equal(suffixed.max_tokens, 32769);
  assert.deepEqual(claudeModelAlias(suffixed), {
    requestedModel: 'tenant-opus(8192)',
    upstreamModel: 'claude-opus-4-6(32768)',
    forceMapping: false,
    isCompat: false,
    responseModel: ''
  });
  const excluded = createUpstream({
    type: 'claude',
    accessToken: 'sk-ant-oat-excluded-test',
    metadata: {
      excluded_models: ['claude-sonnet-4-6'],
      model_aliases: [{ name: 'claude-sonnet-4-6', alias: 'tenant-sonnet' }]
    }
  });
  assert.equal(claudeMetadataModelExcluded(excluded, 'claude-sonnet-4-6'), true);
  assert.equal(claudeMetadataModelExcluded(excluded, 'claude-sonnet-4-6(8192)'), true);
  assert.equal(claudeMetadataModelExcluded(excluded, 'tenant-sonnet'), true);
});

test('ports Claude model suffix thinking controls before direct Messages dispatch', () => {
  const make = (model, extra = {}) => prepareClaudeRequestBody({
    req: { headers: {} },
    body: { model, max_tokens: 64_000, thinking: { type: 'adaptive', budget_tokens: 8_192 }, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'hello' }], ...extra },
    credentials: { accessToken: 'sk-ant-oat-suffix-test' },
    upstream: { id: 'claude-suffix' },
    sessionId: 'suffix-session'
  });

  const numeric = make('claude-sonnet-4-6(8192)');
  assert.equal(numeric.model, 'claude-sonnet-4-6');
  assert.deepEqual(numeric.thinking, { type: 'enabled', budget_tokens: 8192 });
  assert.equal(numeric.output_config, undefined);

  const level = make('claude-sonnet-4-6(high)');
  assert.deepEqual(level.thinking, { type: 'adaptive' });
  assert.deepEqual(level.output_config, { effort: 'high' });

  const disabled = make('claude-sonnet-4-6(none)');
  assert.deepEqual(disabled.thinking, { type: 'disabled' });
  assert.equal(disabled.output_config, undefined);

  const display = make('claude-sonnet-4-6(8192)', { thinking: { type: 'adaptive', display: 'summarized' } });
  assert.deepEqual(display.thinking, { type: 'enabled', budget_tokens: 8192, display: 'summarized' });
});

test('preserves empty thinking placeholders for CPA is-compat Claude models', () => {
  const upstream = {
    id: 'claude-is-compat',
    metadata: {
      model_aliases: [{ name: 'third-party-claude', alias: 'compat-claude', 'is-compat': true }]
    }
  };
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'compat-claude',
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: '' }] }]
    },
    credentials: { projectKey: 'sk-ant-api-is-compat' },
    upstream
  });
  assert.equal(prepared.model, 'third-party-claude');
  assert.equal(prepared.messages[0].content[0].type, 'thinking');
});

test('restores CPA force-mapped Claude model names in JSON and SSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-model-alias-'));
  const store = new Store(dir);
  const upstream = store.create({
    type: 'claude',
    accessToken: 'sk-ant-oat-alias-e2e',
    accountId: 'account-uuid',
    metadata: { model_aliases: [{ name: 'claude-sonnet-4-6', alias: 'tenant-sonnet', 'force-mapping': true }] }
  });
  store.setCap(upstream.id, { capDollars: 100 });
  let sentModel;
  const { server, base } = await start(store, async (_url, options) => {
    sentModel = JSON.parse(options.body).model;
    return new Response(JSON.stringify({
      id: 'msg_model_alias',
      type: 'message',
      model: sentModel,
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: { 'x-upstream-type': 'claude' },
      body: JSON.stringify({ model: 'tenant-sonnet', max_tokens: 8, messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(response.status, 200);
    assert.equal(sentModel, 'claude-sonnet-4-6');
    assert.equal((await response.json()).model, 'tenant-sonnet');
  } finally {
    await close(server);
  }

  const { server: streamServer, base: streamBase } = await start(store, async (_url, options) => {
    const model = JSON.parse(options.body).model;
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_model_alias_stream', model, usage: { input_tokens: 1 } } })}`,
      'event: message_stop\ndata: {"type":"message_stop"}'
    ].join('\n\n') + '\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const response = await request(streamBase, '/v1/messages', {
      method: 'POST',
      headers: { 'x-upstream-type': 'claude' },
      body: JSON.stringify({ model: 'tenant-sonnet', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"model":"tenant-sonnet"/);
  } finally {
    await close(streamServer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supports CPA-style Claude API-key credentials without OAuth shaping', () => {
  const upstream = createUpstream({ type: 'claude', projectKey: 'sk-ant-api-test' }, { allowLegacyClaudeApiKey: true });
  const req = { headers: {
    accept: 'application/json',
    'accept-encoding': 'gzip',
    'anthropic-beta': 'interleaved-thinking-2025-05-14',
    'user-agent': 'anthropic-sdk-node/1.0.0'
  }};
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 32,
    metadata: { user_id: 'caller-owned' },
    system: 'caller system',
    messages: [{ role: 'user', content: 'caller prompt' }]
  };
  const prepared = prepareClaudeRequestBody({
    req,
    body,
    credentials: { projectKey: 'sk-ant-api-test' },
    upstream,
    sessionId: 'api-key-session'
  });
  assert.equal(prepared.model, body.model);
  assert.equal(prepared.max_tokens, body.max_tokens);
  assert.deepEqual(prepared.metadata, body.metadata);
  assert.deepEqual(prepared.system, [{ type: 'text', text: 'caller system', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(prepared.messages, [{
    role: 'user',
    content: [{ type: 'text', text: 'caller prompt', cache_control: { type: 'ephemeral' } }]
  }]);

  const headers = claudeRequestHeaders({
    req,
    body: prepared,
    credentials: { projectKey: 'sk-ant-api-test' },
    upstream,
    sessionId: 'api-key-session'
  });
  assert.equal(headers['x-api-key'], 'sk-ant-api-test');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
  assert.equal(headers['x-app'], undefined);
  assert.equal(headers['x-claude-code-session-id'], undefined);
  assert.equal(headers['user-agent'], 'anthropic-sdk-node/1.0.0');
  assert.equal(headers.cookie, undefined);
});

test('does not classify a non-prefixed access token as OAuth when CPA marks it as an API key', () => {
  const upstream = {
    type: 'claude',
    baseUrl: 'https://api.anthropic.com',
    metadata: { auth_kind: 'claude_api_key' }
  };
  const req = { headers: { 'user-agent': 'anthropic-sdk-node/1.0.0' } };
  const body = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] };
  const headers = claudeRequestHeaders({
    req,
    body,
    credentials: { accessToken: 'generic-api-key' },
    upstream,
    sessionId: 'api-key-classification'
  });
  assert.equal(headers['x-api-key'], 'generic-api-key');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['anthropic-beta'], '');
  assert.equal(headers['x-app'], undefined);
});

test('does not preserve CPA async fingerprint from an unconfirmed OAuth caller', () => {
  const headers = claudeRequestHeaders({
    req: { headers: {
      'user-agent': 'claude-cli/2.1.220 (external, cli)',
      'x-app': 'cli',
      'x-stainless-async': 'async'
    } },
    body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] },
    credentials: { accessToken: 'sk-ant-oat-unconfirmed-async' },
    upstream: { type: 'claude', baseUrl: 'https://api.anthropic.com' },
    sessionId: 'async-fingerprint-session'
  });
  assert.equal(headers['x-stainless-async'], undefined);
});

test('ports CPA credential header overrides, including client-header substitution', () => {
  const headers = claudeRequestHeaders({
    req: { headers: {
      'X-Client-App': ['claude-code'],
      'Anthropic-Beta': ['custom-beta']
    } },
    body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] },
    credentials: { projectKey: 'sk-ant-api-test' },
    upstream: {
      type: 'claude',
      baseUrl: 'https://api.anthropic.com',
      metadata: {
        'header:Cookie': 'session=configured',
        'header:X-Static-Vendor': 'vendor-value',
        'header:X-From-Client': '$x-client-app'
      }
    }
  });
  assert.equal(headers.cookie, 'session=configured');
  assert.equal(headers['x-static-vendor'], 'vendor-value');
  assert.equal(headers['x-from-client'], 'claude-code');
  assert.equal(headers['anthropic-beta'], 'custom-beta');
});

test('accepts CPA custom headers supplied as a metadata headers object', () => {
  const headers = claudeRequestHeaders({
    req: { headers: {} },
    body: { model: 'claude-sonnet-4-6' },
    credentials: { projectKey: 'sk-ant-api-header-object' },
    upstream: {
      type: 'claude',
      baseUrl: 'https://claude-gateway.example/compat',
      metadata: { headers: { Cookie: 'session=metadata', 'X-Workspace': 'enterprise' } }
    }
  });
  assert.equal(headers.cookie, 'session=metadata');
  assert.equal(headers['x-workspace'], 'enterprise');
});

test('supports Claude API-key fingerprint-profile opt-in independently of OAuth', () => {
  const upstream = createUpstream({
    type: 'claude',
    projectKey: 'sk-ant-api-profile-test',
    metadata: { fingerprint_profile: 'claude-code-cli' }
  }, { allowLegacyClaudeApiKey: true });
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] },
    credentials: { projectKey: 'sk-ant-api-profile-test' },
    upstream,
    sessionId: 'profile-session'
  });
  assert.equal(typeof prepared.metadata?.user_id, 'string');
  const headers = claudeRequestHeaders({
    req: { headers: {} },
    body: prepared,
    credentials: { projectKey: 'sk-ant-api-profile-test' },
    upstream,
    sessionId: 'profile-session'
  });
  assert.equal(headers['x-api-key'], 'sk-ant-api-profile-test');
  assert.equal(headers.authorization, undefined);
  assert.match(headers['anthropic-beta'], /oauth-2025-04-20/);
  assert.equal(headers['x-app'], 'cli');
});

test('applies explicit Claude cloak mode to an API key without OAuth controls', () => {
  const upstream = createUpstream({
    type: 'claude',
    projectKey: 'sk-ant-api-cloak-test',
    metadata: { cloak_mode: 'always' }
  }, { allowLegacyClaudeApiKey: true });
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'claude-sonnet-4-6',
      system: 'caller system',
      messages: [{ role: 'user', content: 'hello' }]
    },
    credentials: { projectKey: 'sk-ant-api-cloak-test' },
    upstream,
    sessionId: 'cloak-session'
  });
  assert.match(prepared.system[0].text, /^x-anthropic-billing-header:/);
  assert.equal(prepared.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal(JSON.parse(prepared.metadata.user_id).account_uuid, '');
  const headers = claudeRequestHeaders({
    req: { headers: {} },
    body: prepared,
    credentials: { projectKey: 'sk-ant-api-cloak-test' },
    upstream,
    sessionId: 'cloak-session'
  });
  assert.equal(headers['x-api-key'], 'sk-ant-api-cloak-test');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['x-app'], 'cli');
  assert.equal(headers['anthropic-beta'].includes('oauth-2025-04-20'), false);
});

test('matches CPA fake Claude user-id caching and caller-value preservation', () => {
  const body = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] };
  const uncached = { id: 'claude-uncached-cloak', metadata: { cloak_mode: 'always' } };
  const first = JSON.parse(prepareClaudeRequestBody({
    req: { headers: {} }, body, credentials: { projectKey: 'sk-ant-api-uncached' }, upstream: uncached,
    sessionId: '11111111-2222-4333-8444-555555555555'
  }).metadata.user_id);
  const second = JSON.parse(prepareClaudeRequestBody({
    req: { headers: {} }, body, credentials: { projectKey: 'sk-ant-api-uncached' }, upstream: uncached,
    sessionId: '66666666-7777-4666-8777-888888888888'
  }).metadata.user_id);
  assert.notEqual(first.device_id, second.device_id);
  assert.equal(first.session_id, second.session_id);
  assert.notEqual(first.session_id, '11111111-2222-4333-8444-555555555555');
  assert.notEqual(second.session_id, '66666666-7777-4666-8777-888888888888');

  const cached = { id: 'claude-cached-cloak', metadata: { cloak_mode: 'always', cloak_cache_user_id: true } };
  const cachedFirst = JSON.parse(prepareClaudeRequestBody({
    req: { headers: {} }, body, credentials: { projectKey: 'sk-ant-api-cached' }, upstream: cached,
    sessionId: '11111111-2222-4333-8444-555555555555'
  }).metadata.user_id);
  const cachedSecond = JSON.parse(prepareClaudeRequestBody({
    req: { headers: {} }, body, credentials: { projectKey: 'sk-ant-api-cached' }, upstream: cached,
    sessionId: '66666666-7777-4666-8777-888888888888'
  }).metadata.user_id);
  assert.deepEqual(cachedSecond, cachedFirst);

  const caller = JSON.stringify({ device_id: 'a'.repeat(64), account_uuid: '', session_id: '99999999-aaaa-4999-8aaa-bbbbbbbbbbbb' });
  const preserved = prepareClaudeRequestBody({
    req: { headers: {} },
    body: { ...body, metadata: { user_id: caller } },
    credentials: { projectKey: 'sk-ant-api-preserved' },
    upstream: uncached,
    sessionId: '11111111-2222-4333-8444-555555555555'
  });
  assert.equal(preserved.metadata.user_id, caller);
});

test('cache-only Claude cloak selects the CLI header profile', () => {
  const upstream = { id: 'claude-cache-only-cloak', metadata: { cloak_cache_user_id: true } };
  const body = prepareClaudeRequestBody({
    req: { headers: {} },
    body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] },
    credentials: { projectKey: 'sk-ant-api-cache-only' },
    upstream,
    sessionId: '11111111-2222-4333-8444-555555555555'
  });
  const headers = claudeRequestHeaders({
    req: { headers: {} },
    body,
    credentials: { projectKey: 'sk-ant-api-cache-only' },
    upstream,
    sessionId: '11111111-2222-4333-8444-555555555555'
  });
  assert.equal(headers['x-api-key'], 'sk-ant-api-cache-only');
  assert.equal(headers['x-app'], 'cli');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
});

test('an empty CPA cloak object still enables the default cloak policy', () => {
  const upstream = { id: 'claude-empty-cloak', metadata: { cloak: {} } };
  const body = prepareClaudeRequestBody({
    req: { headers: {} },
    body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] },
    credentials: { projectKey: 'sk-ant-api-empty-cloak' },
    upstream,
    sessionId: '11111111-2222-4333-8444-555555555555'
  });
  assert.equal(typeof body.metadata.user_id, 'string');
  assert.match(body.system[0].text, /^x-anthropic-billing-header:/);
  const headers = claudeRequestHeaders({ req: { headers: {} }, body, credentials: { projectKey: 'sk-ant-api-empty-cloak' }, upstream });
  assert.equal(headers['x-app'], 'cli');
});

test('forwards a stored Claude API key with caller-owned Messages semantics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-api-key-'));
  const store = new Store(dir, { allowLegacyClaudeApiKey: true });
  const upstream = store.create({ type: 'claude', projectKey: 'sk-ant-api-proxy-test' });
  store.setCap(upstream.id, { capDollars: 100 });
  let call;
  const { server, base } = await start(store, async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ id: 'msg_api_key', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  });
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: {
        'x-upstream-type': 'claude',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
        'user-agent': 'anthropic-sdk-node/1.0.0'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 32,
        system: 'caller system',
        messages: [{ role: 'user', content: 'caller prompt' }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(call.options.headers['x-api-key'], 'sk-ant-api-proxy-test');
    assert.equal(call.options.headers.authorization, undefined);
    assert.equal(call.options.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
    assert.equal(call.options.headers['x-app'], undefined);
    assert.equal(call.options.headers.cookie, undefined);
    const sentBody = JSON.parse(call.options.body);
    assert.equal(sentBody.system[0].text, 'caller system');
    assert.deepEqual(sentBody.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(sentBody.messages[0].content, [{ type: 'text', text: 'caller prompt', cache_control: { type: 'ephemeral' } }]);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatches Claude requests through the configured CPA base URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-base-url-'));
  const store = new Store(dir, { allowLegacyClaudeApiKey: true });
  const upstream = store.create({
    type: 'claude',
    baseUrl: 'https://claude-gateway.example/compat',
    projectKey: 'sk-ant-api-base-url-test'
  });
  store.setCap(upstream.id, { capDollars: 100 });
  let call;
  const { server, base } = await start(store, async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ id: 'msg_base_url', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  });
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: { 'x-upstream-id': upstream.id },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(call.url, 'https://claude-gateway.example/compat/v1/messages?beta=true');
    assert.equal(call.options.headers['x-api-key'], undefined);
    assert.equal(call.options.headers.authorization, 'Bearer sk-ant-api-base-url-test');
    assert.equal(call.options.headers['user-agent'], 'node');
    assert.equal(call.options.headers.accept, '*/*');
    assert.equal(call.options.headers['accept-encoding'], 'gzip, deflate');
    assert.equal(JSON.parse(call.options.body).system, undefined);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sends CPA-configured Claude Host headers on the wire', async () => {
  const upstreamServer = createServer((req, res) => {
    assert.equal(req.headers.host, 'configured.claude.gateway');
    assert.ok(req.rawHeaders.includes('X-Stainless-OS'), 'CPA wire casing for X-Stainless-OS');
    assert.equal(req.headers['accept-language'], undefined, 'Claude egress should not add fetch browser headers');
    assert.equal(req.headers['sec-fetch-mode'], undefined, 'Claude egress should not add fetch browser headers');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_host_override', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-host-'));
  const store = new Store(dir, { allowLegacyClaudeApiKey: true });
  const upstream = store.create({
    type: 'claude',
    baseUrl: `http://127.0.0.1:${upstreamServer.address().port}/compat`,
    projectKey: 'sk-ant-api-host-override',
    metadata: { 'header:Host': 'configured.claude.gateway' }
  });
  store.setCap(upstream.id, { capDollars: 100 });
  const { server, base } = await start(store);
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: { 'x-upstream-id': upstream.id, 'x-stainless-os': 'MacOS' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(response.status, 200);
  } finally {
    await close(server);
    await close(upstreamServer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forwards CPA-configured Cookie headers with caller substitution', () => {
  const headers = claudeRequestHeaders({
    req: { headers: { cookie: 'session=relay-cookie; tenant=acme' } },
    body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] },
    credentials: { projectKey: 'sk-ant-api-cookie-header' },
    upstream: {
      type: 'claude',
      baseUrl: 'https://claude-gateway.example/compat',
      metadata: { 'header:Cookie': '$Cookie' }
    }
  });
  assert.equal(headers.cookie, 'session=relay-cookie; tenant=acme');
});

test('uses CPA streaming negotiation defaults for custom Claude gateways', () => {
  const headers = claudeRequestHeaders({
    req: { headers: {} },
    body: { model: 'claude-sonnet-4-6', stream: true },
    credentials: { projectKey: 'sk-ant-api-streaming-defaults' },
    upstream: { type: 'claude', baseUrl: 'https://claude-gateway.example/compat' }
  });
  assert.equal(headers.accept, 'text/event-stream');
  assert.equal(headers['accept-encoding'], 'identity');
  assert.equal(headers['user-agent'], 'codex-pooler-node/0.1.0');
  assert.equal(headers.authorization, 'Bearer sk-ant-api-streaming-defaults');
  assert.equal(headers['x-api-key'], undefined);
});

test('restores CPA streaming negotiation after custom Claude header rules', () => {
  const headers = claudeRequestHeaders({
    req: { headers: {} },
    body: { model: 'claude-sonnet-4-6', stream: true },
    credentials: { projectKey: 'sk-ant-api-streaming-header-rule' },
    upstream: {
      type: 'claude',
      baseUrl: 'https://claude-gateway.example/compat',
      metadata: {
        'header:Accept': 'application/json',
        'header:Accept-Encoding': 'gzip'
      }
    }
  });
  assert.equal(headers.accept, 'text/event-stream');
  assert.equal(headers['accept-encoding'], 'identity');
});

test('routes Claude requests through a per-credential HTTP proxy URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-proxy-'));
  const target = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_proxy', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const proxy = createServer((req, res) => {
    res.writeHead(502);
    res.end();
  });
  proxy.on('connect', (req, client, head) => {
    const [host, portText] = String(req.url || '').split(':');
    const targetSocket = connectTcp(Number(portText), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) targetSocket.write(head);
      targetSocket.pipe(client);
      client.pipe(targetSocket);
    });
    targetSocket.on('error', () => client.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const store = new Store(dir, { allowLegacyClaudeApiKey: true });
  const upstream = store.create({
    type: 'claude',
    baseUrl: `http://127.0.0.1:${target.address().port}`,
    projectKey: 'sk-ant-api-proxy-url-test',
    metadata: { proxy_url: `http://127.0.0.1:${proxy.address().port}` }
  });
  store.setCap(upstream.id, { capDollars: 100 });
  const { server, base } = await start(store, globalThis.fetch);
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: { 'x-upstream-id': upstream.id },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 'msg_proxy');
  } finally {
    await close(server);
    await close(proxy);
    await close(target);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes Claude requests through CPA-compatible SOCKS5h proxy URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-socks-'));
  const target = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_socks', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const proxy = await startSocks5Proxy({ username: 'proxy-user', password: 'proxy-pass' });
  const store = new Store(dir, { allowLegacyClaudeApiKey: true });
  const upstream = store.create({
    type: 'claude',
    baseUrl: `http://localhost:${target.address().port}`,
    projectKey: 'sk-ant-api-socks-url-test',
    metadata: { proxy_url: `socks5h://proxy-user:proxy-pass@127.0.0.1:${proxy.address().port}` }
  });
  store.setCap(upstream.id, { capDollars: 100 });
  const { server, base } = await start(store, globalThis.fetch);
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: { 'x-upstream-id': upstream.id },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 'msg_socks');
  } finally {
    await close(server);
    await close(proxy);
    await close(target);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not inject CPA OAuth context management into caller-owned API-key bodies', () => {
  const upstream = createUpstream({ type: 'claude', projectKey: 'sk-ant-api-context-test' }, { allowLegacyClaudeApiKey: true });
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'claude-sonnet-4-6',
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'hello' }]
    },
    credentials: { projectKey: 'sk-ant-api-context-test' },
    upstream,
    sessionId: 'api-key-context-session'
  });
  assert.equal(prepared.context_management, undefined);
  assert.deepEqual(prepared.thinking, { type: 'adaptive' });
});

test('places the CPA rolling cache marker on a final string system turn', () => {
  const upstream = createUpstream({ type: 'claude', projectKey: 'sk-ant-api-cache-turn-test' }, { allowLegacyClaudeApiKey: true });
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'claude-sonnet-5',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'final instruction' }
      ]
    },
    credentials: { projectKey: 'sk-ant-api-cache-turn-test' },
    upstream,
    sessionId: 'api-key-cache-turn-session'
  });
  assert.equal(prepared.messages[0].content, 'hello');
  assert.deepEqual(prepared.messages[1].content, [{
    type: 'text',
    text: 'final instruction',
    cache_control: { type: 'ephemeral' }
  }]);
});

test('rejects legacy-model mid-system turns before direct Anthropic dispatch', () => {
  assert.throws(() => prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'mid instruction' }
      ]
    },
    credentials: { projectKey: 'sk-ant-api-legacy-system-test' },
    upstream: { type: 'claude', baseUrl: 'https://api.anthropic.com' },
    sessionId: 'legacy-system-session'
  }), (error) => error?.statusCode === 400 && /role 'system' is not supported/.test(error.message));
});

test('preserves CPA markerless native Claude Code helper requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-helper-'));
  const store = new Store(dir);
  const upstream = store.create({
    type: 'claude',
    accessToken: 'sk-ant-oat-helper-test',
    accountId: '123e4567-e89b-42d3-a456-426614174000'
  });
  store.setCap(upstream.id, { capDollars: 100 });
  let call;
  const { server, base } = await start(store, async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ id: 'msg_helper', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  });
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const userId = JSON.stringify({
    device_id: 'f'.repeat(64),
    account_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    session_id: sessionId
  });
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: {
        'x-upstream-type': 'claude',
        'user-agent': 'claude-cli/2.1.220 (external, cli)',
        'x-app': 'cli',
        'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-claude-code-session-id': sessionId,
        'x-client-request-id': '66666666-7777-4888-8999-aaaaaaaaaaaa',
        'x-stainless-lang': 'js',
        'x-stainless-runtime': 'node',
        'x-stainless-package-version': '0.94.0',
        'x-stainless-runtime-version': 'v26.3.0',
        'x-stainless-os': 'MacOS',
        'x-stainless-arch': 'arm64',
        'x-stainless-retry-count': '0',
        'x-stainless-timeout': '600',
        'accept': 'application/json',
        'accept-encoding': 'gzip'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'helper probe' }],
        metadata: { user_id: userId }
      })
    });
    assert.equal(response.status, 200);
    assert.equal(call.options.headers['anthropic-beta'], 'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05');
    assert.equal(call.options.headers['accept-encoding'], 'gzip');
    assert.equal(call.options.headers['x-stainless-async'], undefined);
    const sentBody = JSON.parse(call.options.body);
    assert.deepEqual(Object.keys(sentBody), ['model', 'max_tokens', 'messages', 'metadata']);
    assert.equal(sentBody.messages[0].content, 'helper probe');
    assert.equal(sentBody.system, undefined);
    assert.equal(sentBody.stream, undefined);
    const forwardedUserId = JSON.parse(sentBody.metadata.user_id);
    assert.match(forwardedUserId.device_id, /^[a-f0-9]{64}$/);
    assert.match(forwardedUserId.account_uuid, /^[0-9a-f-]{36}$/i);
    assert.equal(forwardedUserId.session_id, sessionId);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonicalizes CPA Claude conversation identities and ignores unconfirmed native signals', () => {
  const nativeReq = { headers: {
    'x-claude-code-session-id': 'native-session-name',
    'x-session-affinity': 'generic-affinity'
  } };
  const nativeBody = {
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'probe' }],
    metadata: { user_id: JSON.stringify({ session_id: 'metadata-session-name' }) }
  };
  const first = claudeSessionIdForRequest(nativeReq, nativeBody);
  const second = claudeSessionIdForRequest(nativeReq, nativeBody);
  assert.match(first, /^[0-9a-f-]{36}$/i);
  assert.equal(first, second);

  const genericReq = { headers: {
    'x-claude-code-session-id': 'must-not-be-trusted',
    'x-session-affinity': 'generic-affinity'
  } };
  const generic = claudeSessionIdForRequest(genericReq, { model: 'claude-sonnet-4-6' });
  assert.equal(generic, claudeSessionIdForRequest({ headers: { 'x-session-affinity': 'generic-affinity' } }, { model: 'claude-sonnet-4-6' }));
  assert.notEqual(generic, claudeSessionIdForRequest({ headers: { 'x-session-affinity': 'other-affinity' } }, { model: 'claude-sonnet-4-6' }));

  const bodySession = claudeSessionIdForRequest({ headers: {} }, {
    request: { session_id: 'nested-session' }
  });
  assert.equal(bodySession, claudeSessionIdForRequest({ headers: {} }, { session_id: 'nested-session' }));
  assert.notEqual(bodySession, claudeSessionIdForRequest({ headers: {} }, { thread_id: 'different-thread' }));
  assert.notEqual(bodySession, claudeSessionIdForRequest({ headers: {} }, { conversation: { id: 'different-conversation' } }));
});

test('prepares and persists CPA-style Claude OAuth identity once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-identity-'));
  const store = new Store(dir);
  const upstream = store.create({ type: 'claude', accessToken: 'sk-ant-oat-test-token' });
  let profileCalls = 0;
  const fetchImpl = async (url) => {
    assert.equal(url, CLAUDE_OAUTH_PROFILE_URL);
    profileCalls += 1;
    return new Response(JSON.stringify({
      account: { uuid: '123e4567-e89b-42d3-a456-426614174000', email: 'profile@example.com' },
      organization: { uuid: 'org-uuid', name: 'Profile Org' }
    }), { status: 200 });
  };
  try {
    const credentials = store.credentials(upstream.id);
    await ensureClaudeCredentialIdentity({ upstream, credentials, store, fetchImpl });
    const first = store.get(upstream.id);
    const firstDevice = first.metadata.claude_device_ids[0];
    assert.equal(first.accountId, '123e4567-e89b-42d3-a456-426614174000');
    assert.equal(upstream.accountId, first.accountId);
    assert.equal(upstream.metadata.claude_device_ids[0], firstDevice);
    assert.equal(first.email, 'profile@example.com');
    assert.match(firstDevice, /^[a-f0-9]{64}$/);
    assert.equal(store.credentials(upstream.id).organizationId, 'org-uuid');

    await ensureClaudeCredentialIdentity({ upstream: store.get(upstream.id), credentials: store.credentials(upstream.id), store, fetchImpl });
    assert.equal(profileCalls, 1);
    assert.equal(store.get(upstream.id).metadata.claude_device_ids[0], firstDevice);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not persist stale Claude identity after credential replacement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-identity-fence-'));
  const store = new Store(dir);
  const created = store.create({ type: 'claude', accessToken: 'sk-ant-oat-old-token' });
  const upstream = store.get(created.id);
  const credentials = store.credentials(created.id);
  let releaseProfile;
  const profileStarted = new Promise((resolve) => { releaseProfile = resolve; });
  const identityPreparation = ensureClaudeCredentialIdentity({
    upstream,
    credentials,
    store,
    fetchImpl: async () => {
      await profileStarted;
      return new Response(JSON.stringify({ account: { uuid: 'stale-account', email: 'stale@example.com' } }), { status: 200 });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  store.update(created.id, { accessToken: 'sk-ant-oat-new-token' });
  releaseProfile();
  await identityPreparation;
  try {
    assert.match(store.get(created.id).accountId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(store.credentials(created.id).accessToken, 'sk-ant-oat-new-token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('carries CPA diagnostics continuity across completed Claude messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-diagnostics-'));
  const store = new Store(dir);
  const upstream = store.create({ type: 'claude', accessToken: 'sk-ant-oat-test-token', accountId: 'account-uuid' });
  store.setCap(upstream.id, { capDollars: 100 });
  const bodies = [];
  const { server, base } = await start(store, async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: `msg_${bodies.length}`, type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  });
  try {
    const body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8, messages: [{ role: 'user', content: 'continuity' }] });
    assert.equal((await request(base, '/v1/messages', { method: 'POST', headers: { 'x-claude-code-session-id': 'session-diagnostics', 'x-upstream-type': 'claude' }, body })).status, 200);
    assert.equal((await request(base, '/v1/messages', { method: 'POST', headers: { 'x-claude-code-session-id': 'session-diagnostics', 'x-upstream-type': 'claude' }, body })).status, 200);
    assert.equal(bodies[0].diagnostics.previous_message_id, null);
    assert.equal(bodies[1].diagnostics.previous_message_id, 'msg_1');
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forwards Claude count_tokens with CPA’s reduced body and beta profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-count-tokens-'));
  const store = new Store(dir);
  const upstream = store.create({ type: 'claude', accessToken: 'sk-ant-oat-test-token', accountId: 'account-uuid' });
  store.setCap(upstream.id, { capDollars: 100 });
  let call;
  const { server, base } = await start(store, async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ input_tokens: 42 }), { status: 200 });
  });
  try {
    const response = await request(base, '/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'x-upstream-type': 'claude' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        system: 'count this too',
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: 'count' }]
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { input_tokens: 42 });
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages/count_tokens?beta=true');
    assert.deepEqual(call.options.headers['anthropic-beta'].split(','), [
      'claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14',
      'context-management-2025-06-27', 'token-counting-2024-11-01'
    ]);
    assert.equal(call.options.headers['x-stainless-timeout'], undefined);
    const sentBody = JSON.parse(call.options.body);
    assert.deepEqual(Object.keys(sentBody), ['model', 'messages']);
    assert.equal(sentBody.messages[0].role, 'user');
    assert.equal(sentBody.messages[0].content[0].type, 'text');
    assert.match(sentBody.messages[0].content[0].text, /^<system-reminder>\ncount this too\n<\/system-reminder>$/);
    assert.equal(sentBody.messages[0].content[1].text, 'count');
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uses CPA’s O200k local count_tokens fallback for custom Claude origins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-local-count-'));
  const store = new Store(dir);
  const upstream = store.create({
    type: 'claude',
    accessToken: 'sk-ant-oat-test-token',
    refreshToken: 'refresh-token-that-must-not-be-used',
    accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    baseUrl: 'https://claude-gateway.example.test'
  });
  store.setCap(upstream.id, { capDollars: 100 });
  let upstreamCalls = 0;
  const { server, base } = await start(store, async () => {
    upstreamCalls += 1;
    throw new Error('custom count_tokens must not call the upstream');
  });
  const body = {
    model: 'claude-sonnet-4-6',
    system: 'System text.',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'User text.' },
      { type: 'image', source: { type: 'base64', data: 'ignored' } },
      { type: 'document', source: { type: 'text', data: 'Document text.' } }
    ] }],
    tools: [{ name: 'lookup', description: 'Looks up data.', input_schema: { type: 'object' } }],
    metadata: { ignored: true },
    max_tokens: 8192
  };
  try {
    const response = await request(base, '/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'x-upstream-type': 'claude' },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { input_tokens: 22 });
    assert.equal(upstreamCalls, 0);
    assert.equal(countClaudeInputTokens(body), 22);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ports CPA Claude OAuth body transformations and dynamic headers', () => {
  const req = { headers: {
    'anthropic-beta': 'context-1m-2025-08-07,structured-outputs-2025-12-15',
    'x-claude-code-agent-id': 'agent-1',
    'x-claude-code-parent-agent-id': 'parent-1',
    'x-claude-remote-container-id': 'container-1',
    'x-claude-remote-session-id': 'remote-1',
    'x-client-app': 'claude-code',
    'x-anthropic-additional-protection': 'enabled',
    'x-cpa-claude-workload': 'workspace'
  }};
  const credentials = { accessToken: 'sk-ant-oat-test-token' };
  const body = {
    model: 'claude-sonnet-4-6',
    betas: ['fast-mode-2026-02-01'],
    temperature: 0.2,
    top_p: 0.2,
    thinking: { type: 'adaptive' },
    tools: [{ type: 'advisor_search', name: 'search' }],
    messages: [{ role: 'user', content: 'GDP of Vietnam' }]
  };
  const prepared = prepareClaudeRequestBody({ req, body, credentials, upstream: { id: 'claude-1' }, sessionId: 'session-1' });
  assert.equal(Object.hasOwn(prepared, 'betas'), false);
  assert.equal(Object.hasOwn(prepared, 'temperature'), false);
  assert.equal(Object.hasOwn(prepared, 'top_p'), false);
  assert.deepEqual(prepared.context_management, { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] });
  assert.equal(prepared.max_tokens, 1024);
  assert.match(prepared.system[0].text, /cch=(?!00000;)[0-9a-f]{5};/);
  assert.match(prepared.system[0].text, /cc_workload=workspace;/);
  assert.equal(prepared.system[1].cache_control.ttl, '1h');
  assert.equal(prepared.messages.at(-1).content.at(-1).cache_control.ttl, '1h');

  const headers = claudeRequestHeaders({
    req,
    body: prepared,
    credentials,
    sessionId: 'session-1',
    requestedBetas: claudeRequestedBetas({ req, body })
  });
  const betaList = headers['anthropic-beta'].split(',');
  assert.deepEqual(betaList.slice(0, 3), ['claude-code-20250219', 'oauth-2025-04-20', 'context-1m-2025-08-07']);
  for (const beta of ['advisor-tool-2026-03-01', 'advanced-tool-use-2025-11-20', 'fast-mode-2026-02-01', 'extended-cache-ttl-2025-04-11', 'structured-outputs-2025-12-15']) assert.ok(betaList.includes(beta), beta);
  assert.equal(headers['x-claude-code-agent-id'], 'agent-1');
  assert.equal(headers['x-claude-code-parent-agent-id'], 'parent-1');
  assert.equal(headers['x-claude-remote-container-id'], 'container-1');
  assert.equal(headers['x-claude-remote-session-id'], 'remote-1');
  assert.equal(headers['x-client-app'], 'claude-code');
  assert.equal(headers['x-anthropic-additional-protection'], 'enabled');
  assert.equal(headers.cookie, undefined);

  const nativeHeaders = claudeRequestHeaders({
    req: { headers: {
      'user-agent': 'claude-cli/2.1.220 (external, cli)',
      'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219',
      'x-stainless-timeout': '777',
      'x-stainless-os': 'Linux',
      'x-stainless-arch': 'x64',
      'x-claude-code-session-id': '11111111-2222-4333-8444-555555555555'
    } },
    body: {
      ...prepared,
      metadata: { user_id: JSON.stringify({
        device_id: 'f'.repeat(64),
        account_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        session_id: '11111111-2222-4333-8444-555555555555'
      }) }
    },
    credentials,
    sessionId: '11111111-2222-4333-8444-555555555555',
    countTokens: true
  });
  assert.equal(nativeHeaders['x-stainless-timeout'], '777');
  assert.equal(nativeHeaders['x-stainless-os'], 'Linux');
  assert.equal(nativeHeaders['x-stainless-arch'], 'x64');
});

test('ports CPA credential cloak metadata for strict prompts and sensitive words', () => {
  const upstream = {
    id: 'claude-cloak',
    metadata: {
      cloak_strict_mode: true,
      cloak_sensitive_words: ['Vietnam', 'GDP']
    }
  };
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'claude-sonnet-4-6',
      system: [{ type: 'text', text: 'The GDP of Vietnam is confidential.' }],
      messages: [{ role: 'user', content: 'Explain the GDP of Vietnam.' }]
    },
    credentials: { accessToken: 'sk-ant-oat-test-token' },
    upstream,
    sessionId: 'session-cloak'
  });
  assert.deepEqual(prepared.system.map((block) => block.text), [
    prepared.system[0].text,
    'You are Claude Code, Anthropic\'s official CLI for Claude.'
  ]);
  assert.equal(prepared.system.some((block) => block.text.includes('confidential')), false);
  const serialized = JSON.stringify(prepared);
  assert.match(serialized, /V\u200bietnam/);
  assert.match(serialized, /G\u200bDP/);
});

test('rebuilds CPA mid-conversation system messages when explicitly enabled', () => {
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'claude-sonnet-4-6',
      system: 'top rule',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'mid rule' },
        { role: 'user', content: 'continue' }
      ]
    },
    credentials: { accessToken: 'sk-ant-oat-test-token' },
    upstream: { id: 'claude-1', metadata: { rebuild_mid_system_message: true } },
    sessionId: 'session-1'
  });
  assert.equal(prepared.system.length, 2);
  assert.match(prepared.messages[0].content.map((block) => block.text).join('\n'), /top rule/);
  assert.match(prepared.messages[0].content.map((block) => block.text).join('\n'), /mid rule/);
  assert.equal(prepared.messages[0].content.filter((block) => block.text.includes('mid rule')).length, 1);
  assert.deepEqual(prepared.messages.map((message) => message.role), ['user', 'user']);
});

test('honors CPA cloak_mode=never while retaining OAuth identity and CCH', () => {
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'claude-sonnet-4-6',
      system: 'caller system',
      messages: [{ role: 'user', content: 'caller prompt' }]
    },
    credentials: { accessToken: 'sk-ant-oat-test-token' },
    upstream: { id: 'claude-1', metadata: { cloak_mode: 'never' } },
    sessionId: 'session-1'
  });
  assert.equal(prepared.system[0].text.startsWith('x-anthropic-billing-header:'), true);
  assert.equal(prepared.system[1].text, 'caller system');
  assert.deepEqual(prepared.messages[0].content, [{
    type: 'text',
    text: 'caller prompt',
    cache_control: { type: 'ephemeral', ttl: '1h' }
  }]);
  assert.equal(prepared.diagnostics, undefined);
});

test('enforces CPA’s four Claude cache breakpoint limit', () => {
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'claude-sonnet-4-6',
      tools: [
        { name: 'one', cache_control: { type: 'ephemeral' } },
        { name: 'two', cache_control: { type: 'ephemeral' } }
      ],
      system: [
        { type: 'text', text: 'first', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'last', cache_control: { type: 'ephemeral' } }
      ],
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'old', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'new', cache_control: { type: 'ephemeral' } }
      ] }]
    },
    credentials: { accessToken: 'sk-ant-oat-test-token' },
    upstream: { id: 'claude-1' },
    sessionId: 'session-1'
  });
  const count = [
    ...prepared.tools,
    ...prepared.system,
    ...prepared.messages.flatMap((message) => message.content)
  ].filter((block) => block.cache_control).length;
  assert.equal(count, 4);
  assert.deepEqual(prepared.system.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('sanitizes CPA-incompatible Claude tool provenance fields', () => {
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'assistant', content: [
        { type: 'thinking', thinking: '', signature: '' },
        { type: 'tool_use', id: 'tool-1', name: 'search', input: {}, signature: 'foreign', thought_signature: 'foreign', model: 'other', extra_content: { google: { thought_signature: 'foreign' } } }
      ] }]
    },
    credentials: { accessToken: 'sk-ant-oat-test-token' },
    upstream: { id: 'claude-1' },
    sessionId: 'session-1'
  });
  assert.equal(prepared.messages[0].content.some((block) => block.type === 'thinking'), false);
  const tool = prepared.messages[0].content.find((block) => block.type === 'tool_use');
  assert.equal(tool.type, 'tool_use');
  assert.equal(tool.id, 'tool-1');
  assert.equal(tool.name, 'search');
  assert.deepEqual(tool.input, {});
  for (const field of ['signature', 'thoughtSignature', 'thought_signature', 'model', 'extra_content']) assert.equal(tool[field], undefined, field);
});

test('validates and normalizes Claude thinking signatures before OAuth replay', () => {
  const singleLayer = Buffer.from([0x12, 0x04, 0x0a, 0x02, 0x08, 0x0b]).toString('base64');
  const doubleLayer = Buffer.from(singleLayer, 'utf8').toString('base64');
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'assistant', content: [
        { type: 'thinking', thinking: 'keep single', signature: singleLayer },
        { type: 'thinking', thinking: 'normalize double', signature: doubleLayer },
        { type: 'thinking', thinking: 'drop malformed', signature: 'Ebad' }
      ] }]
    },
    credentials: { accessToken: 'sk-ant-oat-test-token' },
    upstream: { id: 'claude-1' },
    sessionId: 'session-1'
  });
  const thinking = prepared.messages[0].content.filter((block) => block.type === 'thinking');
  assert.deepEqual(thinking.map((block) => block.signature), [singleLayer, singleLayer]);
});

test('removes thinking controls when Claude tool_choice forces a tool', () => {
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: {
      model: 'claude-sonnet-4-6',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tool_choice: { type: 'any' },
      messages: [{ role: 'user', content: 'search' }]
    },
    credentials: { accessToken: 'sk-ant-oat-test-token' },
    upstream: { id: 'claude-1' },
    sessionId: 'session-1'
  });
  assert.equal(Object.hasOwn(prepared, 'thinking'), false);
  assert.equal(Object.hasOwn(prepared, 'output_config'), false);
  assert.equal(Object.hasOwn(prepared, 'context_management'), false);
});

test('forwards a Claude OAuth upstream directly to Anthropic Messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-proxy-'));
  const store = new Store(dir);
  const upstream = store.create({
    type: 'claude',
    accessToken: 'sk-ant-oat-test-access-token',
    refreshToken: 'claude-refresh-token',
    email: 'claude@example.com',
    accountId: 'account-uuid'
  });
  store.setCap(upstream.id, { capDollars: 100 });
  let call;
  const { server, base } = await start(store, async (url, options) => {
    call = { url, options };
    return new Response(gzipSync(JSON.stringify({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 7, output_tokens: 3 }
    })), { status: 200, headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'anthropic-ratelimit-unified-5h-utilization': '0.12',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-7d-utilization': '0.34',
      'anthropic-ratelimit-unified-7d-reset': '1800600000'
    } });
  });
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: { 'x-upstream-type': 'claude', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 'msg_123');
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages?beta=true');
    assert.equal(call.options.headers.authorization, 'Bearer sk-ant-oat-test-access-token');
    assert.equal(call.options.headers['anthropic-version'], '2023-06-01');
    assert.match(call.options.headers['anthropic-beta'], /claude-code-20250219/);
    assert.match(call.options.headers['anthropic-beta'], /oauth-2025-04-20/);
    assert.equal(call.options.headers['x-app'], 'cli');
    const sentBody = JSON.parse(call.options.body);
    assert.equal(sentBody.model, 'claude-sonnet-4-6');
    assert.equal(sentBody.max_tokens, 32);
    assert.equal(sentBody.messages[0].content.at(-1).text, 'hello');
    assert.match(sentBody.system[0].text, /^x-anthropic-billing-header:/);
    const userId = JSON.parse(sentBody.metadata.user_id);
    assert.match(userId.device_id, /^[a-f0-9]{64}$/);
    assert.match(userId.account_uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(userId.session_id, /^[0-9a-f-]{36}$/);
    assert.equal(userId.session_id, call.options.headers['x-claude-code-session-id']);
    assert.equal(store.get(upstream.id).quota.source, 'claude_oauth_headers');
    assert.equal(store.get(upstream.id).quota.remainingPercent, 88);
    assert.equal(store.get(upstream.id).quota.windows[1].remainingPercent, 66);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retries a Claude credential in an additional local round when configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-retry-'));
  const store = new Store(dir);
  const upstream = store.create({
    type: 'claude',
    authJson: JSON.stringify({
      access_token: 'sk-ant-oat-retry-test-token',
      email: 'retry@example.com',
      account_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      request_retry: 1,
      disable_cooling: true
    })
  });
  store.setCap(upstream.id, { capDollars: 100 });
  let calls = 0;
  const { server, base } = await start(store, async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'try again' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
    return new Response(JSON.stringify({ id: 'msg_retry', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: { 'x-upstream-type': 'claude' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8, messages: [{ role: 'user', content: 'retry' }] })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 'msg_retry');
    assert.equal(calls, 2);
    assert.equal(store.get(upstream.id).health, undefined);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preserves confirmed native Claude Code OAuth request shape', () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const userId = JSON.stringify({
    device_id: 'f'.repeat(64),
    account_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    session_id: sessionId
  });
  const prepared = prepareClaudeRequestBody({
    req: {
      headers: {
        'user-agent': 'claude-cli/2.1.220 (external, cli, agent-sdk/0.1.0)',
        'x-app': 'cli',
        'anthropic-beta': 'claude-code-20250219,custom-native-beta',
        'x-claude-code-session-id': sessionId,
        authorization: 'Bearer downstream-key'
      }
    },
    body: {
      model: 'claude-sonnet-4-6',
      system: [{ type: 'text', text: 'native system' }],
      messages: [{ role: 'user', content: 'native prompt' }],
      max_tokens: 32,
      metadata: { user_id: userId }
    },
    credentials: { accessToken: 'sk-ant-oat-test-token' },
    upstream: { id: 'claude-native', accountId: 'account-uuid' },
    sessionId
  });
  assert.equal(prepared.system[1].text, 'native system');
  assert.equal(prepared.messages[0].content, 'native prompt');
  assert.equal(prepared.tools, undefined);
  assert.match(prepared.system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.220\./);
  assert.equal(JSON.parse(prepared.metadata.user_id).session_id, sessionId);
  const headers = claudeRequestHeaders({
    req: {
      headers: {
        'user-agent': 'claude-cli/2.1.220 (external, cli, agent-sdk/0.1.0)',
        'x-app': 'cli',
        'anthropic-beta': 'claude-code-20250219,custom-native-beta',
        'x-claude-code-session-id': sessionId
      }
    },
    body: prepared,
    credentials: { accessToken: 'sk-ant-oat-test-token' },
    sessionId
  });
  assert.equal(headers['anthropic-beta'], 'claude-code-20250219,oauth-2025-04-20,custom-native-beta,extended-cache-ttl-2025-04-11');
});

test('aliases OAuth custom tools upstream and restores tool-use names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-tools-'));
  const store = new Store(dir);
  const upstream = store.create({ type: 'claude', accessToken: 'sk-ant-oat-test-token', refreshToken: 'claude-refresh-token', accountId: 'account-uuid' });
  store.setCap(upstream.id, { capDollars: 100 });
  let sentToolName;
  const { server, base } = await start(store, async (_url, options) => {
    sentToolName = JSON.parse(options.body).tools[0].name;
    return new Response(JSON.stringify({
      id: 'msg_tool',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: 'tool-1', name: sentToolName, input: {} }],
      usage: { input_tokens: 7, output_tokens: 3 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: { 'x-upstream-type': 'claude' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 32,
        tools: [{ name: 'search_web', description: 'Search the web', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'search_web' },
        messages: [{ role: 'user', content: 'search' }]
      })
    });
    assert.equal(response.status, 200);
    assert.match(sentToolName, /^mcp__/);
    assert.notEqual(sentToolName, 'search_web');
    assert.equal((await response.json()).content[0].name, 'search_web');
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ports CPA MCP alias word shape and typed-tool transformation', () => {
  const prepared = prepareClaudeRequestBody({
    req: { headers: { authorization: 'Bearer caller-key' } },
    body: {
      model: 'claude-sonnet-4-6',
      tools: [{ type: 'custom', name: 'search.web', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'tool_reference', tool_name: 'search.web' }] }]
    },
    credentials: { accessToken: 'sk-ant-oat-test-token' },
    upstream: { id: 'claude-1' },
    sessionId: 'session-1'
  });
  const alias = prepared.tools[0].name;
  assert.match(alias, /^mcp__[a-z]+_[a-z]+__[a-z]+_[A-Za-z0-9_-]+$/);
  assert.equal(prepared.tools[0].type, undefined);
  assert.equal(prepared.messages[0].content.find((block) => block.tool_name)?.tool_name, alias);
});

test('restores aliased Claude tool names in streaming events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-stream-tools-'));
  const store = new Store(dir);
  const upstream = store.create({ type: 'claude', accessToken: 'sk-ant-oat-test-token', accountId: 'account-uuid' });
  store.setCap(upstream.id, { capDollars: 100 });
  const { server, base } = await start(store, async (_url, options) => {
    const alias = JSON.parse(options.body).tools[0].name;
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_stream', model: 'claude-sonnet-4-6', usage: { input_tokens: 1 } } })}`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: alias, input: {} } })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } })}`,
      'event: message_stop\ndata: {"type":"message_stop"}'
    ].join('\n\n') + '\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: { 'x-upstream-type': 'claude' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 32,
        stream: true,
        tools: [{ name: 'search_web', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'search' }]
      })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"name":"search_web"/);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshes an expired Claude OAuth credential and retries the request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-refresh-'));
  const store = new Store(dir);
  const upstream = store.create({
    type: 'claude',
    accessToken: 'sk-ant-oat-old-access',
    refreshToken: 'old-refresh',
    accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString()
  });
  store.setCap(upstream.id, { capDollars: 100 });
  const calls = [];
  const { server, base } = await start(store, async (url, options) => {
    calls.push({ url, options });
    if (url === CLAUDE_OAUTH_TOKEN_URL) return new Response(JSON.stringify({ access_token: 'sk-ant-oat-new-access', refresh_token: 'new-refresh', expires_in: 3600 }), { status: 200 });
    if (url === CLAUDE_OAUTH_PROFILE_URL) return new Response(JSON.stringify({ account: { uuid: 'refreshed-account', email: 'refreshed@example.com' }, organization: { uuid: 'refreshed-org', name: 'Refreshed Org' } }), { status: 200 });
    return new Response(JSON.stringify({ id: 'msg_refresh', content: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const response = await request(base, '/v1/messages', {
      method: 'POST',
      headers: { 'x-upstream-type': 'claude' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8, messages: [{ role: 'user', content: 'refresh' }] })
    });
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, CLAUDE_OAUTH_TOKEN_URL);
    assert.equal(JSON.parse(calls[0].options.body).refresh_token, 'old-refresh');
    assert.equal(calls.at(-1).options.headers.authorization, 'Bearer sk-ant-oat-new-access');
    assert.equal(store.credentials(upstream.id).accessToken, 'sk-ant-oat-new-access');
    assert.equal(store.credentials(upstream.id).refreshToken, 'new-refresh');
    assert.equal(store.get(upstream.id).accountId, 'refreshed-account');
    assert.equal(store.get(upstream.id).email, 'refreshed@example.com');
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completes Claude OAuth PKCE exchange and creates an upstream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-claude-oauth-'));
  const store = new Store(dir);
  const visited = [];
  const { server, base } = await start(store, async (url) => {
    visited.push(url);
    if (url === CLAUDE_OAUTH_TOKEN_URL) return new Response(JSON.stringify({ access_token: 'sk-ant-oat-oauth-access', refresh_token: 'oauth-refresh', expires_in: 3600 }), { status: 200 });
    if (url === CLAUDE_OAUTH_PROFILE_URL) return new Response(JSON.stringify({ account: { uuid: 'oauth-account', email: 'oauth@example.com' } }), { status: 200 });
    throw new Error(`unexpected URL ${url}`);
  });
  try {
    const startResponse = await request(base, '/api/claude/oauth/start', { method: 'POST', body: '{}' });
    assert.equal(startResponse.status, 200);
    const login = await startResponse.json();
    assert.match(login.authorizationUrl, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
    const exchangeResponse = await request(base, '/api/claude/oauth/exchange', {
      method: 'POST',
      body: JSON.stringify({ state: login.state, code: `authorization-code#${login.state}` })
    });
    assert.equal(exchangeResponse.status, 201);
    const result = await exchangeResponse.json();
    assert.equal(result.upstream.type, 'claude');
    assert.equal(result.upstream.email, 'oauth@example.com');
    assert.equal(result.upstream.accountId, 'oauth-account');
    assert.equal(store.credentials(result.upstream.id).accessToken, 'sk-ant-oat-oauth-access');
    assert.match(result.upstream.metadata.claude_device_ids[0], /^[a-f0-9]{64}$/);
    assert.deepEqual(visited, [CLAUDE_OAUTH_TOKEN_URL, CLAUDE_OAUTH_PROFILE_URL]);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
