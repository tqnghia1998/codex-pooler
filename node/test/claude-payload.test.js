import test from 'node:test';
import assert from 'node:assert/strict';
import { applyClaudePayloadConfig } from '../src/claude-payload.js';
import { claudeConfigFromEnv } from '../src/claude-config.js';
import { claudeModelAlias, claudeRequestHeaders, prepareClaudeRequestBody } from '../src/claude-protocol.js';
import { claudeCoolingDisabled, claudeRequestRetryLimit, claudeRequestScopedAction } from '../src/upstream-outcomes.js';
import { claudeMetadataModelExcluded, createUpstream, isClaudeOAuthUpstream } from '../src/domain.js';

const baseContext = { model: 'claude-sonnet-4', requestedModel: 'claude-sonnet-4' };

test('loads bounded JSON Claude configuration without exposing credential state', () => {
  assert.deepEqual(claudeConfigFromEnv({ CODEX_POOLER_CLAUDE_CONFIG_JSON: '{"requestRetry":2,"payload":{"filter":[]}}' }), {
    requestRetry: 2,
    payload: { filter: [] }
  });
  assert.throws(() => claudeConfigFromEnv({ CODEX_POOLER_CLAUDE_CONFIG_JSON: '{broken' }), /valid JSON/);
  assert.throws(() => claudeConfigFromEnv({ CODEX_POOLER_CLAUDE_CONFIG_JSON: '[]' }), /JSON object/);
});

test('applies CPA global Claude header defaults and cloak disable precedence', () => {
  const upstream = { type: 'claude', baseUrl: 'https://api.anthropic.com', metadata: { cloak_mode: 'always' } };
  const headers = claudeRequestHeaders({
    req: { headers: {} },
    body: { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'x' }], stream: false },
    credentials: { projectKey: 'sk-ant-api-test' },
    upstream,
    claudeConfig: { claudeHeaderDefaults: {
      userAgent: 'claude-cli/9.9.9 (external, cli)',
      packageVersion: '9.9.0',
      runtimeVersion: 'v99.0.0',
      os: 'Linux',
      arch: 'x64',
      timeout: '900'
    } }
  });
  assert.equal(headers['user-agent'], 'claude-cli/9.9.9 (external, cli)');
  assert.equal(headers['x-stainless-package-version'], '9.9.0');
  assert.equal(headers['x-stainless-runtime-version'], 'v99.0.0');
  assert.equal(headers['x-stainless-os'], 'Linux');
  assert.equal(headers['x-stainless-arch'], 'x64');
  assert.equal(headers['x-stainless-timeout'], '900');

  const shaped = prepareClaudeRequestBody({
    req: { headers: {} },
    body: { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'x' }] },
    credentials: { projectKey: 'sk-ant-api-test' },
    upstream,
    claudeConfig: { claudeHeaderDefaults: { userAgent: 'claude-cli/9.9.9 (external, cli)' } }
  });
  assert.match(shaped.system[0].text, /cc_version=9\.9\.9\./);

  const disabled = prepareClaudeRequestBody({
    req: { headers: {} },
    body: { model: 'claude-sonnet-4', system: 'caller system', messages: [{ role: 'user', content: 'x' }] },
    credentials: { projectKey: 'sk-ant-api-test' },
    upstream: { type: 'claude', baseUrl: 'https://api.anthropic.com' },
    claudeConfig: { disableClaudeCloakMode: true }
  });
  assert.equal(disabled.system[0].text, 'caller system');
  assert.equal(disabled.system.some((block) => block.text?.startsWith('x-anthropic-billing-header:')), false);
  assert.equal(disabled.metadata, undefined);
});

test('matches CPA native Claude fingerprint preservation and stabilization rules', () => {
  const sessionId = '22222222-3333-4444-8555-666666666666';
  const userId = JSON.stringify({
    device_id: 'b'.repeat(64),
    account_uuid: '',
    session_id: sessionId
  });
  const req = {
    headers: {
      'user-agent': 'claude-cli/2.1.220 (external, claude-vscode, agent-sdk/0.3.220)',
      'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
      'x-claude-code-session-id': sessionId,
      'x-stainless-package-version': 'unexpected',
      'x-stainless-runtime-version': 'v99.0.0',
      'x-stainless-os': 'Windows',
      'x-stainless-arch': 'x64'
    }
  };
  const body = {
    model: 'claude-sonnet-4',
    metadata: { user_id: userId },
    messages: [{ role: 'user', content: 'x' }]
  };
  const credentials = { accessToken: 'sk-ant-oat-test' };
  const upstream = { id: 'native-profile-test', type: 'claude', baseUrl: 'https://api.anthropic.com' };

  const legacy = claudeRequestHeaders({ req, body, credentials, upstream });
  assert.equal(legacy['user-agent'], req.headers['user-agent']);
  assert.equal(legacy['x-stainless-package-version'], '0.94.0');
  assert.equal(legacy['x-stainless-runtime-version'], 'v26.3.0');

  req.headers['x-stainless-package-version'] = '0.94.0';
  req.headers['x-stainless-runtime-version'] = 'v26.3.0';
  const preserved = claudeRequestHeaders({
    req,
    body,
    credentials,
    upstream,
    claudeConfig: { claudeHeaderDefaults: { stabilizeDeviceProfile: false } }
  });
  assert.equal(preserved['user-agent'], req.headers['user-agent']);
  assert.equal(preserved['x-stainless-os'], 'Windows');
  assert.equal(preserved['x-stainless-arch'], 'x64');

  const stabilized = claudeRequestHeaders({
    req,
    body,
    credentials,
    upstream: { ...upstream, id: 'native-profile-stabilized' },
    claudeConfig: { claudeHeaderDefaults: { stabilizeDeviceProfile: true } }
  });
  assert.equal(stabilized['user-agent'], req.headers['user-agent']);
  assert.equal(stabilized['x-stainless-os'], 'MacOS');
  assert.equal(stabilized['x-stainless-arch'], 'arm64');
});

test('honors global retry and cooling defaults while preserving per-auth overrides', () => {
  const upstream = { type: 'claude', metadata: {} };
  assert.equal(claudeCoolingDisabled(upstream, { disableCooling: true }), true);
  assert.equal(claudeRequestRetryLimit(upstream, { requestRetry: 4 }), 4);
  assert.equal(claudeCoolingDisabled({ type: 'claude', metadata: { disable_cooling: false } }, { disableCooling: true }), false);
  assert.equal(claudeRequestRetryLimit({ type: 'claude', metadata: { request_retry: 1 } }, { requestRetry: 4 }), 1);
});

test('ports global OAuth aliases, exclusions, and request-scoped error rules', () => {
  const config = {
    oauthModelAlias: { claude: [{ name: 'claude-sonnet-4', alias: 'team-sonnet', forceMapping: true }] },
    oauthExcludedModels: { claude: ['claude-haiku-*'] },
    oauthRequestScopedErrors: { claude: [{ status: 403, match: ['enterprise policy'], action: 'stop-and-cooldown' }] }
  };
  const upstream = { type: 'claude', accessTokenExpiresAt: '2099-01-01T00:00:00.000Z', metadata: {} };
  const prepared = prepareClaudeRequestBody({
    req: { headers: {} },
    body: { model: 'team-sonnet', messages: [{ role: 'user', content: 'x' }] },
    credentials: { projectKey: 'delegated-key' },
    upstream,
    claudeConfig: config
  });
  assert.equal(prepared.model, 'claude-sonnet-4');
  assert.equal(claudeModelAlias(prepared).responseModel, 'team-sonnet');
  assert.equal(claudeMetadataModelExcluded(upstream, 'claude-haiku-4', config), true);
  assert.equal(claudeRequestScopedAction(upstream, 403, 'enterprise policy denied', config), 'stop-and-cooldown');

  const parsedOAuth = createUpstream({ type: 'claude', accessToken: 'sk-ant-oat-no-exp-claim' });
  assert.equal(isClaudeOAuthUpstream(parsedOAuth), true);
  assert.equal(claudeMetadataModelExcluded(parsedOAuth, 'claude-haiku-4', config), true);
  const parsedApiKey = createUpstream({ type: 'claude', projectKey: 'sk-ant-api-test' }, { allowLegacyClaudeApiKey: true });
  assert.equal(isClaudeOAuthUpstream(parsedApiKey), false);
  assert.equal(isClaudeOAuthUpstream({ type: 'claude', accessTokenExpiresAt: null, credentials: { accessToken: 'legacy-token' } }), true);
  assert.equal(isClaudeOAuthUpstream({ type: 'claude', accessTokenExpiresAt: null, credentials: { projectKey: 'legacy-key' } }), false);
});

test('applies CPA-compatible Claude payload defaults, raw values, overrides, and filters', () => {
  const input = {
    model: 'claude-sonnet-4',
    metadata: { client: 'codex' },
    messages: [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' }
    ],
    transient: true
  };
  const output = applyClaudePayloadConfig(input, {
    ...baseContext,
    headers: { 'X-Client-Tier': ['tenant-acme-region-1'] },
    config: {
      payload: {
        default: [{
          models: [{ name: 'claude-*', protocol: 'claude', fromProtocol: 'claude', headers: { 'x-client-tier': 'tenant-*-region-*' }, match: [{ 'metadata.client': 'codex' }], exist: ['messages.#(role=="user").content'] }],
          params: { 'metadata.defaulted': 'yes' }
        }],
        defaultRaw: [{ models: [{ name: 'claude-*', protocol: 'claude' }], params: { 'metadata.raw': '{"enabled":true}' } }],
        override: [{ models: [{ name: 'claude-*', protocol: 'claude' }], params: { 'metadata.client': 'rewritten' } }],
        overrideRaw: [{ models: [{ name: 'claude-*', protocol: 'claude' }], params: { 'metadata.list': '[1,2,3]' } }],
        filter: [{ models: [{ name: 'claude-*', protocol: 'claude' }], params: ['transient', 'messages.#(role=="assistant").content'] }]
      }
    }
  });
  assert.deepEqual(output, {
    model: 'claude-sonnet-4',
    metadata: { client: 'rewritten', defaulted: 'yes', raw: { enabled: true }, list: [1, 2, 3] },
    messages: [{ role: 'user', content: 'one' }, { role: 'assistant' }]
  });
  assert.deepEqual(input.metadata, { client: 'codex' });
  assert.equal(input.transient, true);
});

test('supports CPA root paths, protocol aliases, source protocol gates, and conditions', () => {
  const output = applyClaudePayloadConfig({ request: { model: 'claude-opus-4', options: { stream: true } } }, {
    model: 'claude-opus-4',
    requestedModel: 'claude-opus-4(high)',
    protocol: 'claude',
    fromProtocol: 'openai-response',
    root: 'request',
    config: {
      payload: {
        override: [{
          models: [{ name: 'claude-opus-*', protocol: 'claude', fromProtocol: 'responses', notMatch: [{ 'options.missing': true }] }],
          params: { 'options.stream': false, 'options.mode': 'native' }
        }]
      }
    }
  });
  assert.deepEqual(output, { request: { model: 'claude-opus-4', options: { stream: false, mode: 'native' } } });
});

test('defaults only fill missing fields and wildcard query paths update every match', () => {
  const output = applyClaudePayloadConfig({
    model: 'claude-haiku',
    messages: [
      { role: 'user', content: [{ type: 'text', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text' }] }
    ]
  }, {
    model: 'claude-haiku',
    config: {
      payload: {
        default: [{ models: [{ name: 'claude-*' }], params: { 'messages.#(role=="user")#.content.#(type=="text")#.cache_control.type': 'ephemeral' } }]
      }
    }
  });
  assert.deepEqual(output.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(output.messages[1].content[0].cache_control, { type: 'ephemeral' });
});
