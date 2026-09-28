import test from 'node:test';
import assert from 'node:assert/strict';
import { personalShareSessions } from '../src/share-authorization.js';

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
