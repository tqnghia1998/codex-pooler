import test from 'node:test';
import assert from 'node:assert/strict';
import { personalShareSessions, reserveShareRequest } from '../src/share-authorization.js';

test('ordinary personal-key affinity prefers its share but retains alternatives', () => {
  const first = { shareSessionId: 'first', upstreamId: 'first-upstream' };
  const second = { shareSessionId: 'second', upstreamId: 'second-upstream' };
  const req = {
    proxyAuth: {
      kind: 'personal_share',
      personalKeyId: 'personal-key',
      personalShareSessions: [second, first]
    },
    sharingStore: {
      personalRouteSession: (_key, route) => route === 'session:conversation' || route === 'response:resp_1' ? first : null,
      personalRouteExists: () => true
    }
  };
  assert.deepEqual(personalShareSessions(req, { sessionId: 'conversation' }), [first, second]);
  assert.deepEqual(personalShareSessions(req, { responseId: 'resp_1' }), [first]);
  assert.deepEqual(personalShareSessions(req, { responseId: 'resp_expired' }), []);
});

test('share admission refuses token routes for models it cannot price', () => {
  const reserved = [];
  const req = {
    proxyAuth: { kind: 'share_session', shareSessionId: 'share' },
    sharingStore: { reserveSession: (id, attempt) => { reserved.push(attempt); return true; } }
  };
  // Unpriced usage settles nothing, so it would be free and uncapped on a share.
  assert.equal(reserveShareRequest(req, 'unpriced', { model: 'kimi-k3', route: '/v1/responses' }), false);
  assert.equal(reserveShareRequest(req, 'missing', { model: '', route: '/v1/chat/completions' }), false);
  assert.equal(reserveShareRequest(req, 'native', { model: 'made-up', route: '/backend-api/codex/responses' }), false);
  assert.equal(reserveShareRequest(req, 'priced', { model: 'gpt-6-astra', route: '/v1/responses' }), true);
  assert.equal(reserveShareRequest(req, 'haiku', { model: 'claude-haiku-5-5', route: '/v1/messages' }), true);
  // Image and other compatibility routes settle provider-reported costs instead.
  assert.equal(reserveShareRequest(req, 'image', { model: 'gpt-image-2', route: '/v1/images/generations' }), true);
  assert.equal(reserveShareRequest(req, 'count', { model: 'made-up', route: '/v1/messages/count_tokens' }), true);
  assert.deepEqual(reserved, ['priced', 'haiku', 'image', 'count']);
  assert.equal(reserveShareRequest({ proxyAuth: { kind: 'api_key' } }, 'own', { model: 'kimi-k3', route: '/v1/responses' }), true);
});
