import test from 'node:test';
import assert from 'node:assert/strict';
import { responseValidationError } from '../src/response-validation.js';
import { classifySseEvent } from '../src/upstream-outcomes.js';
import { createPublicResponsesState, decodeSseBlock, normalizePublicResponsesEvent } from '../src/openai-streaming.js';

test('relays bounded validation codes and paths without provider text on HTTP and WebSocket', () => {
  for (const code of ['unknown_parameter', 'invalid_parameter']) {
    const body = { error: { type: 'invalid_request_error', code, param: 'tools[0].indexed_web_access', message: 'private provider input' } };
    const error = responseValidationError(body);
    assert.equal(error.code, code);
    assert.equal(error.param, body.error.param);
    assert.equal(error.message.includes('private'), false);
    const frame = { type: 'error', status: 400, ...body };
    assert.equal(classifySseEvent(frame).class, 'caller');
    const projected = decodeSseBlock(normalizePublicResponsesEvent(frame, createPublicResponsesState({}, { websocket: true }))[0]).event;
    assert.deepEqual(projected.error, error);
  }
});

test('reads measured codeless refusal templates and keeps failures non-retryable', () => {
  for (const [message, code, param] of [
    ['Unsupported parameter: metadata', 'unsupported_parameter', 'metadata'],
    ["Invalid response.create payload: Unknown parameter: 'tools[0].old_key'.", 'unknown_parameter', 'tools[0].old_key'],
    ["Invalid response.create payload: Invalid type for 'input[0].content': expected an array", 'invalid_type', 'input[0].content'],
    ["Invalid response.create payload: Missing required parameter: 'tools[0].name'.", 'missing_required_parameter', 'tools[0].name'],
    ["Invalid response.create payload: Invalid 'model': string too long. private value", 'string_above_max_length', 'model'],
    ["Invalid response.create payload: Invalid value: 'private'.", 'invalid_value', null],
    ['[ResponseCreate] [include[0]] [invalid_enum_value] private value', 'invalid_value', 'include[0]'],
    ['[ResponseCreate] [tools[0].old_key] [unknown_parameter] private value', 'unknown_parameter', 'tools[0].old_key']
  ]) {
    const event = { type: 'error', error: { message } };
    const error = responseValidationError(event);
    assert.equal(error.code, code, message);
    assert.equal(error.param, param, message);
    assert.deepEqual(classifySseEvent(event), { class: 'caller', retryable: false, errorCode: code });
    const projected = decodeSseBlock(normalizePublicResponsesEvent(event, createPublicResponsesState({}, { websocket: true }))[0]).event;
    assert.equal(projected.status, 400);
    assert.deepEqual(projected.error, error);
    assert.equal(JSON.stringify(projected).includes('private'), false);
  }
});

test('rejects unbounded or unrecognized messages and redacts unsafe parameters', () => {
  for (const message of ['Unsupported parameter: metadata; private', 'Unsupported parameter: tools[99999].x', 'Unsupported tool type: private', 'Unknown private provider fault', 'x'.repeat(2049)]) {
    assert.equal(responseValidationError({ error: { message } }), null);
  }
  assert.equal(responseValidationError({ error: { code: 'unknown_parameter', type: 'invalid_request_error', param: 'private; unsafe', message: 'private' } }).param, null);
  assert.equal(responseValidationError({ error: { code: 'unknown_parameter', type: 'server_error' } }), null);
  assert.equal(responseValidationError({ error: { code: 'server_error', message: 'private' } }), null);
  assert.equal(responseValidationError({ error: { code: 'unknown_parameter', message: 'x'.repeat(65536) } }), null);
  assert.equal(responseValidationError({ error: { code: 'invalid_parameter', param: 'input[1].content' } }, '/v1/chat/completions').param, 'messages');
  assert.equal(classifySseEvent({ type: 'error', status: 429, error: { type: 'invalid_request_error', code: 'unknown_parameter' } }).class, 'quota');
  assert.equal(classifySseEvent({ type: 'error', status: 500, error: { type: 'invalid_request_error', code: 'unknown_parameter' } }).class, 'transient');
});
