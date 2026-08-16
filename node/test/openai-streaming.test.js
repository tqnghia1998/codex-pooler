import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatStreamState, createPublicResponsesState, decodeSseBlock, normalizeChatEvent, normalizePublicResponsesEvent, restoreCustomToolCallNamespaces, retryableFirstSseEvent, splitSseBlocks } from '../src/openai-streaming.js';

const decode = (chunk) => JSON.parse(chunk.match(/^data: (.+)$/m)[1]);

test('strictly decodes SSE labels and retries only legacy retry codes', () => {
  assert.deepEqual(decodeSseBlock('event: response.created\ndata: {"type":"response.output_text.delta"}'), { kind: 'drop' });
  assert.equal(decodeSseBlock('data: [DONE]').kind, 'done');
  assert.equal(retryableFirstSseEvent({ error: { code: 'server_error' } }), true);
  assert.equal(retryableFirstSseEvent({ error: { code: 'rate_limit_exceeded' } }), false);
  assert.deepEqual(splitSseBlocks('data: one\r\rdata: two\r\r'), ['data: one', 'data: two', '']);
});

test('projects failed terminals without provider fields and latches', () => {
  const state = createPublicResponsesState();
  assert.equal(decode(normalizePublicResponsesEvent({ type: 'response.output_text.delta', delta: 'hi', sequence_number: 5 }, state)[0]).sequence_number, 5);
  const result = decode(normalizePublicResponsesEvent({ type: 'response.incomplete', sequence_number: 3, response: { id: 'not-public', status: 'failed', error: { code: 'private', message: 'secret' } } }, state).at(-1));
  assert.equal(result.type, 'response.failed');
  assert.equal(result.sequence_number, 6);
  assert.equal(result.response.id, 'resp_failed');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(normalizePublicResponsesEvent({ type: 'response.output_text.delta', delta: 'late' }, state).length, 0);
});

test('synthesizes public lifecycle events and normalizes done/typeless success', () => {
  const state = createPublicResponsesState();
  normalizePublicResponsesEvent({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_1' }, output_index: 2 }, state);
  const events = normalizePublicResponsesEvent({ type: 'response.done', response: { id: 'resp_ok', output: [{ content: [{ text: 'answer' }] }] } }, state).map(decode);
  assert.deepEqual(events.map((event) => event.type), ['response.created', 'response.output_text.delta', 'response.completed']);
  assert.equal(events.at(-1).response.status, 'completed');
  const typeless = decode(normalizePublicResponsesEvent({ id: 'resp_typeless', output: [] }, createPublicResponsesState())[0]);
  assert.equal(typeless.type, 'response.completed');
});

test('restores a missing custom_tool_call namespace from declared tools, live and streamed', () => {
  const namespaces = { shell: 'ops' };
  assert.deepEqual(restoreCustomToolCallNamespaces({ output: [{ type: 'custom_tool_call', name: 'shell', call_id: 'c1' }] }, namespaces).output[0].namespace, 'ops');
  assert.equal(restoreCustomToolCallNamespaces({ output: [{ type: 'custom_tool_call', name: 'shell', namespace: 'explicit' }] }, namespaces).output[0].namespace, 'explicit');
  assert.equal(restoreCustomToolCallNamespaces({ output: [{ type: 'custom_tool_call', name: 'unknown' }] }, namespaces).output[0].namespace, undefined);

  const state = createPublicResponsesState(namespaces);
  const [chunk] = normalizePublicResponsesEvent({ type: 'response.output_item.done', item: { type: 'custom_tool_call', name: 'shell', call_id: 'c1' }, output_index: 0 }, state);
  assert.equal(decode(chunk).item.namespace, 'ops');
});

test('translates Chat tool arguments, moderation, incomplete usage, and early failure', () => {
  const state = createChatStreamState({ model: 'gpt', stream_options: { include_usage: true } });
  const tool = normalizeChatEvent({ type: 'response.output_item.added', output_index: 4, item: { type: 'function_call', call_id: 'call_4', name: 'lookup', arguments: '{"q":1}' } }, state)[0];
  assert.deepEqual(tool.choices[0].delta.tool_calls[0], { index: 4, id: 'call_4', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } });
  assert.deepEqual(normalizeChatEvent({ type: 'response.function_call_arguments.delta', output_index: 4, delta: '}' }, state)[0].choices[0].delta.tool_calls[0], { index: 4, function: { arguments: '}' } });
  assert.deepEqual(normalizeChatEvent({ type: 'response.output_item.added', output_index: 5, item: { type: 'custom_tool_call', call_id: 'call_5', name: 'code_exec', input: 'print(' } }, state)[0].choices[0].delta.tool_calls[0], { index: 5, id: 'call_5', type: 'custom', custom: { name: 'code_exec', input: 'print(' } });
  assert.deepEqual(normalizeChatEvent({ type: 'response.custom_tool_call_input.delta', output_index: 5, delta: ')' }, state)[0].choices[0].delta.tool_calls[0], { index: 5, custom: { input: ')' } });
  assert.deepEqual(normalizeChatEvent({ type: 'response.output_text.delta', delta: 'x', moderation: { flagged: true } }, state)[0].choices, []);
  const terminal = normalizeChatEvent({ type: 'response.incomplete', response: { incomplete_details: { reason: 'content-filter' }, usage: { input_tokens: 2, output_tokens: 3 } } }, state);
  assert.equal(terminal.at(-1), '[DONE]');
  assert.equal(terminal.at(-2).usage.total_tokens, 5);
  assert.equal(terminal.find((chunk) => chunk.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'content_filter');
  assert.deepEqual(normalizeChatEvent({ type: 'response.failed', response: { error: { message: 'secret' } } }, createChatStreamState({ model: 'gpt' })), [{ error: { type: 'server_error', code: 'upstream_response_failed', message: 'Upstream response failed', param: null } }]);

  const completedToolState = createChatStreamState({ model: 'gpt' });
  normalizeChatEvent({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_done', name: 'lookup', arguments: '{}' } }, completedToolState);
  const completedTool = normalizeChatEvent({ type: 'response.completed', response: { status: 'completed' } }, completedToolState);
  assert.equal(completedTool.find((chunk) => chunk.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
});
