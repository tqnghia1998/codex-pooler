import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletionTokenDetails, chatPromptTokenDetails, consumeSseChunk, createChatStreamState, createPublicResponsesState, createSseParserState, decodeSseBlock, MAX_SSE_EVENT_BYTES, normalizeChatEvent, normalizePublicResponsesEvent, pendingSseBlock, restoreCustomToolCallNamespaces, retryableFirstSseEvent, splitSseBlocks } from '../src/openai-streaming.js';

const decode = (chunk) => JSON.parse(chunk.match(/^data: (.+)$/m)[1]);

test('strictly decodes SSE labels and retries only legacy retry codes', () => {
  assert.deepEqual(decodeSseBlock('event: response.created\ndata: {"type":"response.output_text.delta"}'), { kind: 'drop' });
  assert.equal(decodeSseBlock('data: [DONE]').kind, 'done');
  assert.equal(retryableFirstSseEvent({ error: { code: 'server_error' } }), true);
  assert.equal(retryableFirstSseEvent({ error: { code: 'rate_limit_exceeded' } }), false);
  assert.deepEqual(splitSseBlocks('data: one\r\rdata: two\r\r'), ['data: one', 'data: two', '']);
});

test('parses CRLF and standalone CR incrementally without phantom blocks', () => {
  let state = createSseParserState();
  let result = consumeSseChunk(state, 'event: message_start\r');
  assert.deepEqual(result.blocks, []);
  state = result.state;

  result = consumeSseChunk(state, '\ndata: {"message":{"usage":{"input_tokens":1}}}\r\n\r');
  assert.deepEqual(result.blocks.map(decodeSseBlock), [{
    kind: 'event',
    event: { type: 'message_start', message: { usage: { input_tokens: 1 } } }
  }]);
  state = result.state;

  result = consumeSseChunk(state, '\nevent: message_stop\rdata: {"type":"message_stop"}\r\r');
  assert.deepEqual(result.blocks.map(decodeSseBlock), [
    { kind: 'event', event: { type: 'message_stop' } }
  ]);
});

test('rejects oversized complete and incomplete SSE events', () => {
  const oversized = `data: ${'x'.repeat(MAX_SSE_EVENT_BYTES)}`;
  for (const delimiter of ['', '\n\n', '\r\n\r\n', '\r\r']) {
    const result = consumeSseChunk(createSseParserState(), oversized + delimiter);
    assert.equal(result.overflow, true, JSON.stringify(delimiter));
    assert.deepEqual(result.blocks, []);
    assert.deepEqual(result.state, createSseParserState());
  }
});

test('retains fragmented events without rebuilding the pending block', () => {
  let state = createSseParserState();
  let completed = [];
  for (const chunk of ['data: {"type":', '"response.output_text.delta",', '"delta":"hello"}', '\n', '\n']) {
    const result = consumeSseChunk(state, chunk);
    state = result.state;
    completed = completed.concat(result.blocks);
  }
  assert.equal(completed.length, 1);
  assert.equal(decodeSseBlock(completed[0]).event.delta, 'hello');
  assert.equal(pendingSseBlock(state), '');
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

test('projects spend-limit incomplete terminals as failures while retaining ordinary truncation', () => {
  for (const reason of ['credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded']) {
    const event = { type: 'response.incomplete', response: { id: 'resp_quota', status: 'incomplete', incomplete_details: { reason } } };
    assert.equal(decode(normalizePublicResponsesEvent(event, createPublicResponsesState())[0]).type, 'response.failed');
    assert.equal(normalizeChatEvent(event, createChatStreamState({ model: 'gpt' }))[0].error.code, 'upstream_response_failed');
  }
  const truncated = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } };
  assert.deepEqual(normalizePublicResponsesEvent(truncated, createPublicResponsesState()).map((chunk) => decode(chunk).type), ['response.created', 'response.incomplete']);
});

test('drops backend-only public Responses events before sequencing', () => {
  const state = createPublicResponsesState();
  assert.deepEqual(normalizePublicResponsesEvent({ type: 'responsesapi.websocket_timing', duration_ms: 1 }, state), []);
  assert.deepEqual(normalizePublicResponsesEvent({ type: 'codex.rate_limits', limits: [] }, state), []);
  const [chunk] = normalizePublicResponsesEvent({ type: 'response.output_text.delta', delta: 'visible' }, state);
  assert.equal(decode(chunk).sequence_number, 0);
});

test('projects provider WebSocket 4xx terminals as public error events', () => {
  const [chunk] = normalizePublicResponsesEvent({
    type: 'error',
    status: 400,
    error: { type: 'invalid_request_error', code: 'unsupported_parameter', message: 'provider details must not leak' }
  }, createPublicResponsesState({}, { websocket: true }));
  assert.deepEqual(decode(chunk), {
    type: 'error',
    status: 400,
    error: {
      type: 'invalid_request_error',
      code: 'unsupported_parameter',
      message: 'upstream rejected the request (unsupported_parameter)',
      param: null
    },
    sequence_number: 0
  });
});

test('preserves SSE failure projection for provider 4xx terminals', () => {
  const [chunk] = normalizePublicResponsesEvent({
    type: 'error',
    status: 400,
    error: { type: 'invalid_request_error', code: 'unsupported_parameter', message: 'provider details must not leak' }
  }, createPublicResponsesState());
  assert.deepEqual(decode(chunk), {
    type: 'response.failed',
    response: {
      id: 'resp_failed',
      object: 'response',
      created_at: 0,
      status: 'failed',
      error: {
        type: 'server_error',
        code: 'server_error',
        message: 'upstream request failed',
        param: null
      },
      model: 'unknown',
      output: [],
      output_text: '',
      instructions: null,
      metadata: null,
      temperature: null,
      top_p: null,
      parallel_tool_calls: false,
      tool_choice: 'auto',
      tools: []
    },
    sequence_number: 0
  });
});

test('projects quota-limited incomplete terminals as failures', () => {
  for (const reason of ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded']) {
    const event = { type: 'response.incomplete', response: { id: 'resp_limited', status: 'incomplete', incomplete_details: { reason } } };
    const [chunk] = normalizePublicResponsesEvent(event, createPublicResponsesState());
    const projected = decode(chunk);
    assert.equal(projected.type, 'response.failed', reason);
    assert.deepEqual(projected.error, {
      type: 'server_error', code: reason, message: 'upstream request failed', param: null
    });
    assert.deepEqual(projected.response.error, projected.error);
    const chat = normalizeChatEvent(event, createChatStreamState({ model: 'gpt-6-sol' }));
    assert.equal(chat[0].error.code, 'upstream_response_failed', reason);
  }
});

test('projects policy failures with only the stable public contract', () => {
  const result = decode(normalizePublicResponsesEvent({
    type: 'response.failed',
    sequence_number: 4,
    provider_sibling: 'drop',
    response: {
      id: 'resp_policy',
      error: {
        type: 'provider_policy',
        code: 'misalignment_policy_violation',
        message: 'Request blocked by policy.',
        param: 'drop',
        sibling: 'drop'
      }
    }
  }, createPublicResponsesState())[0]);
  assert.deepEqual(result.response.error, {
    type: 'invalid_request_error',
    code: 'misalignment_policy_violation',
    message: 'Request blocked by policy.'
  });
  assert.equal(JSON.stringify(result).includes('provider_policy'), false);
  assert.equal(JSON.stringify(result).includes('"param"'), false);
});

test('synthesizes public lifecycle events and normalizes done/typeless success', () => {
  const state = createPublicResponsesState();
  normalizePublicResponsesEvent({ type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' }, output_index: 2 }, state);
  const events = normalizePublicResponsesEvent({ type: 'response.done', response: { id: 'resp_ok', output: [{ type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'answer' }] }] } }, state).map(decode);
  assert.deepEqual(events.map((event) => event.type), ['response.created', 'response.completed']);
  assert.equal(events.at(-1).response.status, 'completed');
  const typeless = normalizePublicResponsesEvent({ id: 'resp_typeless', output: [] }, createPublicResponsesState()).map(decode);
  assert.deepEqual(typeless.map((event) => event.type), ['response.created', 'response.completed']);
});

test('opens a terminal-only public Responses stream with the full item grammar and citations', () => {
  const citation = { type: 'url_citation', url: 'https://example.com/a', title: 'A', start_index: 0, end_index: 6 };
  const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [citation] }] };
  const search = { type: 'web_search_call', id: 'ws_1', status: 'completed' };
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], content: [{ type: 'reasoning_text', text: 'private thought' }] };
  const state = createPublicResponsesState();
  const events = normalizePublicResponsesEvent({
    type: 'response.completed',
    response: { id: 'resp_terminal', created_at: 1700000000, model: 'gpt-5.6-sol', status: 'completed', output: [reasoning, search, message] }
  }, state).map(decode);
  assert.deepEqual(events.map((event) => event.type), [
    'response.created',
    'response.output_item.added', 'response.output_item.done',
    'response.output_item.added', 'response.output_item.done',
    'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
    'response.completed'
  ]);
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  assert.deepEqual(events[0].response, { object: 'response', status: 'in_progress', output: [], id: 'resp_terminal', created_at: 1700000000, model: 'gpt-5.6-sol' });
  assert.deepEqual(events[5].item, { ...message, status: 'in_progress', content: [] });
  const position = { item_id: 'msg_1', output_index: 2, content_index: 0 };
  assert.deepEqual(events[6], { type: 'response.content_part.added', ...position, part: { type: 'output_text', text: '', annotations: [] }, sequence_number: 6 });
  assert.deepEqual(events[7], { type: 'response.output_text.delta', ...position, delta: 'answer', sequence_number: 7 });
  assert.deepEqual(events[9].part.annotations, [citation]);
  assert.deepEqual(events[10].item, message);
  assert.deepEqual(events.at(-1).response.output[2].content[0].annotations, [citation]);
  assert.deepEqual(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta), ['answer']);

  const relayed = createPublicResponsesState();
  normalizePublicResponsesEvent({ type: 'response.output_item.done', output_index: 0, item: search }, relayed);
  const late = normalizePublicResponsesEvent({ type: 'response.completed', response: { id: 'resp_late', output: [search, message] } }, relayed).map(decode);
  assert.deepEqual(late.map((event) => event.type), ['response.created', 'response.completed']);
  assert.deepEqual(late.at(-1).response.output[1].content[0].annotations, [citation]);

  const websocket = normalizePublicResponsesEvent({ type: 'response.completed', response: { id: 'resp_ws', output: [message] } }, createPublicResponsesState({}, { websocket: true })).map(decode);
  assert.deepEqual(websocket.map((event) => event.type), ['response.completed']);
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
  assert.deepEqual(normalizeChatEvent({
    type: 'response.failed',
    response: { error: { code: 'misalignment_policy_violation', message: 'Policy blocked.' } }
  }, createChatStreamState({ model: 'gpt' })), [{
    error: { type: 'invalid_request_error', code: 'misalignment_policy_violation', message: 'Policy blocked.' }
  }]);

  const completedToolState = createChatStreamState({ model: 'gpt' });
  normalizeChatEvent({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_done', name: 'lookup', arguments: '{}' } }, completedToolState);
  const completedTool = normalizeChatEvent({ type: 'response.completed', response: { status: 'completed' } }, completedToolState);
  assert.equal(completedTool.find((chunk) => chunk.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
});

test('reports Chat stream failures as errors after output has started', () => {
  const prefixes = {
    created: [{ type: 'response.created', response: { id: 'resp_1' } }],
    text: [{ type: 'response.created', response: { id: 'resp_1' } }, { type: 'response.output_text.delta', delta: 'partial' }],
    tool: [{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{' } }]
  };
  for (const [name, events] of Object.entries(prefixes)) {
    for (const failure of [{ type: 'response.failed', response: { error: { message: 'secret detail' } } }, { type: 'error', error: { message: 'secret detail', param: 'input' } }]) {
      const state = createChatStreamState({ model: 'gpt', stream_options: { include_usage: true } });
      for (const event of events) normalizeChatEvent(event, state);
      const chunks = normalizeChatEvent(failure, state);
      assert.deepEqual(chunks, [{ error: { type: 'server_error', code: 'upstream_response_failed', message: 'Upstream response failed', param: null } }], `${name} ${failure.type}`);
      assert.equal(JSON.stringify(chunks).includes('secret'), false);
      assert.deepEqual(normalizeChatEvent({ type: 'response.completed', response: { status: 'completed' } }, state), []);
    }
  }
});

test('completes partial Chat tool arguments from matching final snapshots without duplicates', () => {
  const state = createChatStreamState({ model: 'gpt' });
  normalizeChatEvent({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'item_2', call_id: 'call_2', name: 'lookup', arguments: '{"city":' } }, state);
  normalizeChatEvent({ type: 'response.function_call_arguments.delta', output_index: 2, delta: '"東京"' }, state);
  const done = normalizeChatEvent({ type: 'response.function_call_arguments.done', output_index: 2, item_id: 'item_2', arguments: '{"city":"東京"}' }, state);
  assert.equal(done[0].choices[0].delta.tool_calls[0].function.arguments, '}');
  assert.deepEqual(normalizeChatEvent({ type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'item_2', call_id: 'call_2', name: 'lookup', arguments: '{"city":"東京"}' } }, state), []);
  const terminal = normalizeChatEvent({ type: 'response.completed', response: { status: 'completed', output: [null, null, { type: 'function_call', id: 'item_2', call_id: 'call_2', name: 'lookup', arguments: '{"city":"東京"}' }] } }, state);
  assert.equal(terminal.at(-1), '[DONE]');
  assert.equal(state.reconciliationFailed, false);

  const custom = createChatStreamState({ model: 'gpt' });
  normalizeChatEvent({ type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', id: 'item_0', call_id: 'call_0', name: 'exec', input: 'print(' } }, custom);
  const recovered = normalizeChatEvent({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'custom_tool_call', id: 'item_0', call_id: 'call_0', name: 'exec', input: 'print(1)' }] } }, custom);
  assert.equal(recovered[0].choices[0].delta.tool_calls[0].custom.input, '1)');
  assert.equal(recovered.at(-1), '[DONE]');
});

test('fails a divergent Chat tool snapshot without emitting a success terminal', () => {
  const state = createChatStreamState({ model: 'gpt' });
  normalizeChatEvent({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item_0', call_id: 'call_0', name: 'lookup', arguments: '{"q":' } }, state);
  const failure = normalizeChatEvent({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', id: 'item_0', call_id: 'call_0', name: 'lookup', arguments: '{"x":1}' }] } }, state);
  assert.deepEqual(failure, [{ error: { type: 'server_error', code: 'upstream_tool_snapshot_inconsistent', message: 'Upstream tool call snapshot is inconsistent', param: null } }]);
  assert.equal(state.terminal, true);
  assert.equal(state.reconciliationFailed, true);
});

test('emits a tool first seen in a finalized item exactly once', () => {
  const state = createChatStreamState({ model: 'gpt' });
  const item = { type: 'function_call', id: 'item_0', call_id: 'call_0', name: 'lookup', arguments: '{"ok":true}' };
  const [added] = normalizeChatEvent({ type: 'response.output_item.done', output_index: 0, item }, state);
  assert.deepEqual(added.choices[0].delta.tool_calls[0], {
    index: 0, id: 'call_0', type: 'function', function: { name: 'lookup', arguments: '{"ok":true}' }
  });
  const terminal = normalizeChatEvent({ type: 'response.completed', response: { status: 'completed', output: [item] } }, state);
  assert.equal(terminal.length, 3);
  assert.equal(terminal.at(-1), '[DONE]');
  const terminalOnly = normalizeChatEvent({ type: 'response.completed', response: { status: 'completed', output: [item] } }, createChatStreamState({ model: 'gpt' }));
  assert.equal(terminalOnly[0].choices[0].delta.tool_calls[0].function.arguments, '{"ok":true}');
  assert.equal(terminalOnly.at(-2).choices[0].finish_reason, 'tool_calls');
});

test('rejects a repeated added tool instead of resetting its streamed prefix', () => {
  const state = createChatStreamState({ model: 'gpt' });
  const item = { type: 'function_call', id: 'item_0', call_id: 'call_0', name: 'lookup', arguments: '{' };
  normalizeChatEvent({ type: 'response.output_item.added', output_index: 0, item }, state);
  normalizeChatEvent({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '"q":' }, state);
  const repeated = normalizeChatEvent({ type: 'response.output_item.added', output_index: 0, item }, state);
  assert.equal(repeated[0].error.code, 'upstream_tool_snapshot_inconsistent');
  assert.equal(state.terminal, true);
  assert.deepEqual(normalizeChatEvent({ type: 'response.completed', response: { status: 'completed', output: [item] } }, state), []);
});

test('ignores unidentified tool deltas instead of inventing a call at index zero', () => {
  const state = createChatStreamState({ model: 'gpt' });
  assert.deepEqual(normalizeChatEvent({ type: 'response.function_call_arguments.delta', delta: 'private' }, state), []);
  assert.deepEqual(normalizeChatEvent({ type: 'response.custom_tool_call_input.delta', output_index: 9, delta: 'private' }, state), []);
  assert.equal(state.toolArguments.size, 0);
});

test('projects documented Chat token details from Responses usage without inventing counters', () => {
  const responsesUsage = {
    input_tokens: 10, output_tokens: 4,
    input_tokens_details: { cached_tokens: 6, cache_write_tokens: 0, unknown_tokens: 9 },
    output_tokens_details: { reasoning_tokens: 3, text_tokens: -1, audio_tokens: 1.5, accepted_prediction_tokens: '1', rejected_prediction_tokens: true }
  };
  assert.deepEqual(chatPromptTokenDetails(responsesUsage), { cache_write_tokens: 0, cached_tokens: 6 });
  assert.deepEqual(chatCompletionTokenDetails(responsesUsage), { reasoning_tokens: 3 });
  assert.deepEqual(chatPromptTokenDetails({ prompt_tokens_details: {}, input_tokens_details: { cached_tokens: 6 } }), {});
  assert.deepEqual(chatCompletionTokenDetails({ completion_tokens_details: { reasoning_tokens: 0 }, output_tokens_details: { reasoning_tokens: 3 } }), { reasoning_tokens: 0 });
  for (const malformed of [null, false, 1, 'x', []]) {
    assert.deepEqual(chatPromptTokenDetails({ prompt_tokens_details: malformed, input_tokens_details: { cached_tokens: 2 } }), { cached_tokens: 2 });
    assert.equal(chatCompletionTokenDetails({ completion_tokens_details: malformed, output_tokens_details: malformed }), undefined);
  }
  assert.equal(chatPromptTokenDetails(undefined), undefined);

  const state = createChatStreamState({ model: 'gpt', stream_options: { include_usage: true } });
  const terminal = normalizeChatEvent({ type: 'response.completed', response: { id: 'resp_details', status: 'completed', output: [], usage: { ...responsesUsage, total_tokens: 14 } } }, state);
  assert.deepEqual(terminal.at(-2).usage, {
    prompt_tokens: 10, prompt_tokens_details: { cache_write_tokens: 0, cached_tokens: 6 },
    completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 3 }, total_tokens: 14
  });
  const plainTerminal = normalizeChatEvent({ type: 'response.completed', response: { id: 'resp_plain', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } }, createChatStreamState({ model: 'gpt', stream_options: { include_usage: true } }));
  assert.deepEqual(plainTerminal.at(-2).usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
});
