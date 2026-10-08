import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicResponsesState, decodeSseBlock, normalizePublicResponsesEvent } from '../src/openai-streaming.js';
import { createResponsesIntegrityState, observeResponsesIntegrity, responsesCompletionFailure } from '../src/responses-stream-integrity.js';

const tool = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' };
const added = { type: 'response.output_item.added', output_index: 0, item: tool };
const done = { type: 'response.output_item.done', output_index: 0, item: { ...tool, status: 'completed' } };
const completed = { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } };
const decode = (blocks) => blocks.map((block) => decodeSseBlock(block).event);

for (const websocket of [false, true]) {
  test(`repairs closed output on ${websocket ? 'WebSocket' : 'SSE'} terminals without buffering frames`, () => {
    const state = createPublicResponsesState({ lookup: 'ops' }, { websocket });
    const announcement = { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', content: [] } };
    const first = { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'closed answer' }] } };
    assert.equal(decode(normalizePublicResponsesEvent(announcement, state))[0].type, announcement.type);
    assert.equal(decode(normalizePublicResponsesEvent(first, state))[0].item.content[0].text, 'closed answer');
    normalizePublicResponsesEvent({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } }, state);
    const terminal = decode(normalizePublicResponsesEvent(completed, state)).at(-1);
    assert.deepEqual(terminal.response.output.map((item) => item.id), ['rs_1', 'msg_1']);
    assert.equal(terminal.response.output[1].content[0].text, 'closed answer');
    assert.deepEqual(normalizePublicResponsesEvent(first, state), []);
  });

  test(`fails incomplete tools on ${websocket ? 'WebSocket' : 'SSE'} and preserves provider incomplete outcomes`, () => {
    for (const ending of [completed, { ...completed, type: 'response.done' }, { id: 'resp_typeless', output: [] }]) {
      const state = createPublicResponsesState({}, { websocket });
      normalizePublicResponsesEvent(added, state);
      normalizePublicResponsesEvent({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{}' }, state);
      const terminal = decode(normalizePublicResponsesEvent(ending, state)).at(-1);
      assert.equal(terminal.type, 'response.failed');
      assert.equal(state.completionFailure, 'incomplete_tool_item');
    }
    for (const type of ['response.failed', 'response.incomplete']) {
      const state = createPublicResponsesState({}, { websocket });
      normalizePublicResponsesEvent(added, state);
      const terminal = decode(normalizePublicResponsesEvent({ type, response: { id: 'resp_1', status: type.split('.')[1], output: [] } }, state)).at(-1);
      assert.equal(terminal.type, type);
      assert.equal(state.completionFailure, null);
    }
  });
}

test('accepts correlated function/custom tools, safe alias enrichment and distinct tool outputs', () => {
  for (const kind of ['function_call', 'custom_tool_call']) {
    const state = createPublicResponsesState({ lookup: 'ops' });
    const item = { ...tool, type: kind, input: 'run' };
    const { id, ...announcement } = item;
    normalizePublicResponsesEvent({ ...added, item: announcement }, state);
    normalizePublicResponsesEvent({ type: kind === 'function_call' ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta', output_index: 0, call_id: 'call_1', delta: '{}' }, state);
    normalizePublicResponsesEvent({ ...done, item }, state);
    normalizePublicResponsesEvent({ type: 'response.output_item.done', output_index: 1, item: { type: kind === 'function_call' ? 'function_call_output' : 'custom_tool_call_output', id: 'out_1', call_id: 'call_1', output: 'result' } }, state);
    assert.equal(decode(normalizePublicResponsesEvent(completed, state)).at(-1).type, 'response.completed');
    if (kind === 'custom_tool_call') assert.equal(state.integrity.output[0].item.namespace, 'ops');
  }
});

test('rejects changed aliases, duplicate indexes, orphan payloads and every unsuccessful done status', () => {
  const cases = [
    [added, { ...done, output_index: 1 }],
    [added, { ...done, item: { ...tool, id: 'changed' } }],
    [added, { ...done, item_id: 'foreign' }],
    [added, { ...done, call_id: 'foreign' }],
    [added, added],
    [added, { ...added, output_index: 1 }],
    [done],
    [{ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{}' }],
    [added, { ...done, item: { ...tool, type: 'message' } }],
    [added, { type: 'response.output_item.done', output_index: 0, item_id: 'fc_1' }],
    [added, { ...done, item: { type: 'function_call_output', id: 'out', call_id: 'call_1' } }],
    [added, done, done],
    [added, { ...done, output_index: -1 }],
    [added, { ...done, item: { ...tool, id: null } }],
    ...['in_progress', 'incomplete', 'failed', 'cancelled', null].map((status) => [added, { ...done, item: { ...tool, status } }])
  ];
  for (const events of cases) {
    const state = createPublicResponsesState();
    for (const event of events) normalizePublicResponsesEvent(event, state);
    assert.equal(decode(normalizePublicResponsesEvent(completed, state)).at(-1).type, 'response.failed', JSON.stringify(events));
    assert.equal(state.completionFailure, 'invalid_tool_correlation');
  }
});

test('bounds identity/tool tracking and output retention independently', () => {
  const oversized = createResponsesIntegrityState();
  observeResponsesIntegrity({ ...added, item: { ...tool, id: 'x'.repeat(1025) } }, oversized);
  assert.equal(responsesCompletionFailure(oversized), 'tool_tracking_overflow');
  const full = createResponsesIntegrityState();
  for (let index = 0; index <= 4096; index += 1) observeResponsesIntegrity({ ...added, output_index: index, item: { ...tool, id: `fc_${index}`, call_id: `call_${index}` } }, full);
  assert.equal(full.tools.size, 4096);
  assert.equal(responsesCompletionFailure(full), 'tool_tracking_overflow');
  const state = createPublicResponsesState({}, { maxOutputBytes: 16 });
  normalizePublicResponsesEvent({ type: 'response.output_item.done', item: { type: 'message', id: 'msg', content: [] } }, state);
  assert.equal(state.integrity.outputOverflow, true);
  assert.equal(state.integrity.output.length, 0);
  assert.deepEqual(decode(normalizePublicResponsesEvent(completed, state)).at(-1).response.output, []);
});

test('keeps nonempty terminal output, replaces indexed done items, and retains unindexed arrival order', () => {
  const item = (id) => ({ type: 'message', id, content: [] });
  for (const indexed of [false, true]) {
    const state = createPublicResponsesState();
    for (const id of ['first', 'second']) normalizePublicResponsesEvent({ type: 'response.output_item.done', ...(indexed ? { output_index: 0 } : {}), item: item(id) }, state);
    const terminal = decode(normalizePublicResponsesEvent({ type: 'response.incomplete', response: { id: 'resp', status: 'incomplete' } }, state)).at(-1);
    assert.deepEqual(terminal.response.output.map((value) => value.id), indexed ? ['second'] : ['first', 'second']);
  }
  const state = createPublicResponsesState();
  normalizePublicResponsesEvent({ type: 'response.output_item.done', item: item('observed') }, state);
  assert.deepEqual(decode(normalizePublicResponsesEvent({ ...completed, response: { ...completed.response, output: [item('provider')] } }, state)).at(-1).response.output, [item('provider')]);
});
