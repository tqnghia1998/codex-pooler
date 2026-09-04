import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeModelsResponse, isClaudeModelsRequest, resolveClaudeModelListId } from '../src/claude-models.js';

test('serves Claude Code model-list shape and reverses CPA cloaked IDs', () => {
  const upstream = { id: 'claude-listing', type: 'claude', routing: { models: ['team-model'] } };
  const response = buildClaudeModelsResponse({ list: () => [{ id: upstream.id, type: upstream.type }], get: () => upstream }, 'default');
  assert.equal(response.has_more, false);
  assert.ok(Array.isArray(response.data));
  assert.ok(response.data.every((model) => model.type === 'model' && model.display_name));

  const source = 'team-model';
  const listed = response.data.find((model) => model.id.startsWith('claude-fable-5-dd-'));
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

test('recognizes Anthropic and Claude Code model-list requests', () => {
  assert.equal(isClaudeModelsRequest({ headers: { 'anthropic-version': '2023-06-01' } }), true);
  assert.equal(isClaudeModelsRequest({ headers: { 'user-agent': 'claude-cli/2.1.220 (external, cli)' } }), true);
  assert.equal(isClaudeModelsRequest({ headers: { 'user-agent': 'curl/8.0' } }), false);
});
