import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeModelsResponse, isClaudeModelsRequest, resolveClaudeModelListId } from '../src/claude-models.js';

test('lists the documented limits for every static Claude model', () => {
  const response = buildClaudeModelsResponse({ list: () => [] });
  assert.deepEqual(response.data.map(({ id, max_input_tokens, max_output_tokens }) => (
    { id, max_input_tokens, max_output_tokens }
  )), [
    'claude-fable-5-1', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5'
  ].map((id) => ({ id, max_input_tokens: 1_000_000, max_output_tokens: 128_000 })));
});

test('serves Claude Code model-list shape and reverses CPA cloaked IDs', () => {
  const upstream = { id: 'claude-listing', type: 'claude', routing: { models: ['team-model'] } };
  const response = buildClaudeModelsResponse({ list: () => [{ id: upstream.id, type: upstream.type }], get: () => upstream }, 'default');
  assert.equal(response.has_more, false);
  assert.ok(Array.isArray(response.data));
  assert.ok(response.data.every((model) => model.type === 'model' && model.display_name));
  assert.ok(response.data.some((model) => model.id === 'claude-sonnet-5-5'));

  const source = 'team-model';
  const listed = response.data.find((model) => model.id.startsWith('claude-fable-5-1-dd-'));
  assert.ok(listed);
  assert.equal(resolveClaudeModelListId(listed.id), source);
  assert.equal(resolveClaudeModelListId(`${listed.id}(8192)`), `${source}(8192)`);
});

test('includes Claude aliases and excludes blocked OAuth models in listings', () => {
  const upstream = {
    id: 'claude-listing',
    type: 'claude',
    metadata: {
      auth_kind: 'oauth',
      model_aliases: [{ name: 'team-model', alias: 'visible-team-model', displayName: 'Team Model' }]
    },
    routing: { models: ['team-model', 'hidden-model'] }
  };
  const store = { list: () => [{ id: upstream.id, type: upstream.type }], get: () => upstream };
  const response = buildClaudeModelsResponse(store, 'default', {
    oauthExcludedModels: { claude: ['hidden-model'] },
    disableClaudeCloakMode: true
  });
  assert.equal(response.data.some((model) => model.id === 'visible-team-model' && model.display_name === 'Team Model'), true);
  assert.equal(response.data.some((model) => model.id === 'hidden-model'), false);
});

test('applies CPA fork semantics to Claude aliases', () => {
  const upstream = {
    id: 'claude-listing',
    type: 'claude',
    metadata: {
      model_aliases: [
        { name: 'rename-me', alias: 'renamed', 'display-name': 'Renamed' },
        { name: 'keep-me', alias: 'kept', fork: true }
      ]
    },
    routing: { models: ['rename-me', 'keep-me'] }
  };
  const response = buildClaudeModelsResponse(
    { list: () => [{ id: upstream.id, type: upstream.type }], get: () => upstream },
    'default',
    { disableClaudeCloakMode: true }
  );
  const ids = response.data.map((model) => model.id);
  assert.equal(ids.includes('rename-me'), false);
  assert.equal(ids.includes('renamed'), true);
  assert.equal(ids.includes('keep-me'), true);
  assert.equal(ids.includes('kept'), true);
  assert.equal(response.data.find((model) => model.id === 'renamed').display_name, 'Renamed');
});

test('uses CPA ClaudeKey.models as the per-credential model catalog', () => {
  const upstream = {
    id: 'claude-config-models',
    type: 'claude',
    metadata: {
      models: [{ name: 'provider-sonnet', alias: 'tenant-sonnet', 'display-name': 'Tenant Sonnet', 'max-context-length': 123456 }]
    }
  };
  const response = buildClaudeModelsResponse(
    { list: () => [{ id: upstream.id, type: upstream.type }], get: () => upstream },
    'default',
    { disableClaudeCloakMode: true }
  );
  assert.deepEqual(response.data.map((model) => model.id), ['tenant-sonnet']);
  assert.equal(response.data[0].display_name, 'Tenant Sonnet');
  assert.equal(response.data[0].max_input_tokens, 123456);
});

test('known Claude models keep their published limits in credential catalogs unless overridden', () => {
  const upstream = {
    id: 'claude-config-models',
    type: 'claude',
    metadata: {
      models: [
        { name: 'claude-opus-5-5', alias: 'team-opus' },
        { name: 'claude-sonnet-5', 'max-context-length': 500_000 }
      ]
    }
  };
  const response = buildClaudeModelsResponse(
    { list: () => [{ id: upstream.id, type: upstream.type }], get: () => upstream },
    'default',
    { disableClaudeCloakMode: true }
  );
  assert.equal(response.data.find(({ id }) => id === 'team-opus').max_input_tokens, 1_000_000);
  assert.equal(response.data.find(({ id }) => id === 'team-opus').context_window, 1_000_000);
  assert.equal(response.data.find(({ id }) => id === 'team-opus').max_output_tokens, 128_000);
  assert.equal(response.data.find(({ id }) => id === 'claude-sonnet-5').max_input_tokens, 500_000);
  assert.equal(response.data.find(({ id }) => id === 'claude-sonnet-5').context_window, 500_000);
});

test('recognizes Anthropic and Claude Code model-list requests', () => {
  assert.equal(isClaudeModelsRequest({ headers: { 'anthropic-version': '2023-06-01' } }), true);
  assert.equal(isClaudeModelsRequest({ headers: { 'user-agent': 'claude-cli/2.1.220 (external, cli)' } }), true);
  assert.equal(isClaudeModelsRequest({ headers: { 'user-agent': 'curl/8.0' } }), false);
});

test('scoped model lists keep Compass defaults alongside allowed Claude models', () => {
  const claude = { id: 'claude', type: 'claude', metadata: { models: [{ name: 'tenant-only' }] } };
  const compass = { id: 'compass', type: 'compass' };
  const store = {
    listForModelCatalog: () => [claude, compass],
    get: (id) => [claude, compass].find((upstream) => upstream.id === id)
  };
  const ids = (upstreamIds) => buildClaudeModelsResponse(store, 'default', null, { upstreamIds })
    .data.map(({ id }) => id);
  assert.deepEqual(ids(['claude']), ['claude-fable-5-1-dd-ylno-tnanet']);
  assert.ok(ids(['compass']).includes('claude-sonnet-5'));
  assert.ok(!ids(['compass']).includes('claude-fable-5-1-dd-ylno-tnanet'));
  assert.ok(ids(['claude', 'compass']).includes('claude-sonnet-5'));
  assert.ok(ids(['claude', 'compass']).includes('claude-fable-5-1-dd-ylno-tnanet'));
  assert.deepEqual(ids([]), []);
});
