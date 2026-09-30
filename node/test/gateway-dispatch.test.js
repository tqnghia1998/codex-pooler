import test from 'node:test';
import assert from 'node:assert/strict';
import { isCompatibilityRoute, isUnsupportedV1Route } from '../src/compatibility.js';
import { gatewayRequestKind } from '../src/gateway-dispatch.js';
import { PROXY_ENDPOINTS, WEBSOCKET_ENDPOINTS, isAdditionalGatewayRoute } from '../src/proxy.js';

test('the shared dispatcher classifies every Relaydeck gateway route for both products', () => {
  for (const path of PROXY_ENDPOINTS) assert.equal(gatewayRequestKind('POST', path), 'proxy', `POST ${path}`);
  for (const path of WEBSOCKET_ENDPOINTS) assert.equal(gatewayRequestKind('GET', path), 'websocket', `GET ${path}`);

  for (const [method, path] of [
    ['GET', '/v1/models'],
    ['GET', '/backend-api/codex/models'],
    ['GET', '/backend-api/codex/v1/models']
  ]) {
    assert.equal(gatewayRequestKind(method, path), 'models', `${method} ${path}`);
  }
  assert.equal(gatewayRequestKind('GET', '/v1/usage'), 'usage');

  for (const [method, path] of [
    ['GET', '/v1/files'],
    ['POST', '/v1/files'],
    ['GET', '/v1/files/file_123'],
    ['DELETE', '/v1/files/file_123'],
    ['GET', '/v1/files/file_123/content'],
    ['POST', '/v1/audio/transcriptions'],
    ['POST', '/v1/images/generations'],
    ['POST', '/v1/images/edits']
  ]) {
    assert.equal(isCompatibilityRoute(method, path), true, `${method} ${path} compatibility registration`);
    assert.equal(gatewayRequestKind(method, path), 'compatibility', `${method} ${path}`);
  }

  for (const [method, path] of [
    ['POST', '/backend-api/transcribe'],
    ['POST', '/backend-api/files'],
    ['POST', '/backend-api/files/file_123/uploaded'],
    ['POST', '/backend-api/codex/images/generations'],
    ['POST', '/backend-api/codex/images/edits']
  ]) {
    assert.equal(isAdditionalGatewayRoute(method, path), true, `${method} ${path} raw gateway registration`);
    assert.equal(gatewayRequestKind(method, path), 'raw', `${method} ${path}`);
  }

  for (const [method, path] of [
    ['POST', '/v1/embeddings'],
    ['GET', '/v1/responses/resp_123'],
    ['POST', '/v1/responses/resp_123/cancel']
  ]) {
    assert.equal(isUnsupportedV1Route(method, path), true, `${method} ${path} unsupported registration`);
    assert.equal(gatewayRequestKind(method, path), 'unsupported', `${method} ${path}`);
  }
});
