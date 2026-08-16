import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError, adaptChatRequest, adaptResponsesRequest, customToolNamespaces } from '../src/openai-adapters.js';

function assertAdapterError(fn, { code = 'invalid_request', param }) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof AdapterError, true);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, code);
    assert.equal(error.param, param);
    return true;
  });
}

test('adapts Chat fallback and rich multimodal tool requests', () => {
  assert.deepEqual(adaptChatRequest({ model: 'gpt-5.6-sol', input: 'hello' }), {
    model: 'gpt-5.6-sol',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    instructions: ''
  });
  assert.deepEqual(adaptChatRequest({ model: 'gpt-5.6-sol', messages: [], input: 'hello' }).input[0].content[0], { type: 'input_text', text: 'hello' });
  assert.equal(adaptChatRequest({ model: 'gpt-5.6-sol', messages: [{ role: 'user', name: 'alice', content: 'hello' }] }).input[0].name, 'alice');

  const audio = Buffer.from('RIFF').toString('base64');
  const adapted = adaptChatRequest({
    model: 'gpt-5.6-sol',
    messages: [
      { role: 'system', content: 'Follow policy.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png', detail: 'high' } },
          { type: 'file', file: { filename: 'brief.pdf', file_data: 'data:application/pdf;base64,JVBERg==' } },
          { type: 'input_audio', input_audio: { data: ` ${audio.slice(0, 4)}\n${audio.slice(4)} `, format: 'wav' } }
        ]
      },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'done' }
    ],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { properties: { query: { type: 'string' } } } } }],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
    response_format: { type: 'json_object' },
    verbosity: ' HIGH ',
    max_tokens: 20,
    max_completion_tokens: 30,
    reasoning_effort: ' MINIMAL '
  });

  assert.equal(adapted.instructions, 'Follow policy.');
  assert.deepEqual(adapted.input[0].content, [
    { type: 'input_text', text: 'inspect' },
    { type: 'input_image', image_url: 'https://example.com/image.png' },
    { type: 'input_file', filename: 'brief.pdf', file_data: 'data:application/pdf;base64,JVBERg==' },
    { type: 'input_audio', audio_url: `data:audio/wav;base64,${audio}` }
  ]);
  assert.deepEqual(adapted.input.slice(1), [
    { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'done' }
  ]);
  assert.deepEqual(adapted.tools, [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } }]);
  assert.deepEqual(adapted.tool_choice, { type: 'function', name: 'lookup' });
  assert.equal(adapted.max_output_tokens, 30);
  assert.deepEqual(adapted.reasoning, { effort: 'minimal' });
  assert.deepEqual(adapted.text, { format: { type: 'json_object' }, verbosity: 'high' });
});

test('normalizes Responses instructions, replay, continuation, and cache controls', () => {
  const stateless = adaptResponsesRequest({
    model: 'gpt-5.6-sol',
    instructions: 'Existing',
    prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    input: [
      { role: 'system', content: 'System' },
      { role: 'developer', content: [{ type: 'input_text', text: 'cached', prompt_cache_breakpoint: { mode: 'explicit' } }, { type: 'input_text', text: 'lifted' }] },
      { type: 'function_call', id: 'call-2', name: 'run', arguments: '{}', status: 'completed', caller: { type: 'program', caller_id: 'program-1' } },
      { type: 'function_call_output', output: [{ ok: true }, 'plain JSON'] },
      { type: 'reasoning', summary: [] }
    ]
  });
  assert.equal(stateless.instructions, 'Existing\nSystem\nlifted');
  assert.deepEqual(stateless.input, [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'cached', prompt_cache_breakpoint: { mode: 'explicit' } }] },
    { type: 'function_call', id: 'call-2', name: 'run', arguments: '{}', caller: { type: 'program', caller_id: 'program-1' }, call_id: 'call-2' },
    { type: 'function_call_output', output: [{ ok: true }, 'plain JSON'], call_id: 'call-2' }
  ]);

  const continuation = adaptResponsesRequest({
    model: 'gpt-5.6-sol', previous_response_id: 'resp-1',
    input: [
      { type: 'reasoning', encrypted_content: 'cipher', summary: [] },
      { type: 'item_reference', id: 'item-1' },
      { type: 'function_call_output', call_id: 'call-1', output: null }
    ]
  });
  assert.equal(continuation.input[0].type, 'reasoning');
  assert.deepEqual(continuation.input[1], { type: 'item_reference', id: 'item-1' });
  assert.equal(continuation.input[2].output, null);
});

test('preserves standard detail field on Responses input_image parts', () => {
  const adapted = adaptResponsesRequest({
    model: 'gpt-5.6-sol',
    input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' }] }]
  });
  assert.deepEqual(adapted.input[0].content[0], { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' });
});

test('accepts pi replay shapes when switching models mid-session', () => {
  const citations = [{ type: 'url_citation', start_index: 0, end_index: 5.5, url: 'https://example.com', title: 'Example' }];
  const adapted = adaptResponsesRequest({
    model: 'gpt-5.6-luna',
    input: [
      { type: 'message', role: 'assistant', status: 'completed', id: 'msg_pi_0', phase: undefined,
        content: [{ type: 'output_text', text: 'prior answer', annotations: citations }] },
      { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' }] }
    ]
  });
  assert.deepEqual(adapted.input[0].content[0], { type: 'output_text', text: 'prior answer', annotations: citations });
  assert.equal('phase' in adapted.input[0], false);
  assert.deepEqual(adapted.input[1].content[0], { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' });
});

test('translates official Chat custom tools and named choices', () => {
  const adapted = adaptChatRequest({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'run code' }],
    tools: [{ type: 'custom', custom: { name: 'code_exec', description: 'Runs code', format: { type: 'text' } } }],
    tool_choice: { type: 'custom', custom: { name: 'code_exec' } }
  });
  assert.deepEqual(adapted.tools, [{ type: 'custom', name: 'code_exec', description: 'Runs code', format: { type: 'text' } }]);
  assert.deepEqual(adapted.tool_choice, { type: 'custom', name: 'code_exec' });
});

test('validates and preserves Responses tools and strict local schemas', () => {
  const schema = {
    type: 'object',
    properties: { city: { $ref: '#/$defs/city' } },
    required: ['city'],
    additionalProperties: false,
    $defs: { city: { type: 'string' } }
  };
  const adapted = adaptResponsesRequest({
    model: 'gpt-5.6-sol', input: 'weather',
    tools: [
      { type: 'function', name: 'weather', parameters: schema, strict: true },
      { type: 'namespace', name: 'ops', description: 'Operations', tools: [{ type: 'custom', name: 'shell', format: { type: 'text' } }] },
      { type: 'function', name: 'flexible', parameters: { type: 'object', properties: { labels: { type: 'object', additionalProperties: { type: 'string' } }, pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } } } },
      { type: 'tool_search', execution: 'client', description: 'Searches deferred tools', parameters: { type: 'object', properties: { query: { type: 'string' } } } }
    ],
    tool_choice: { type: 'function', name: 'weather' },
    text: { format: { type: 'json_schema', name: 'answer', schema, strict: true }, verbosity: 'medium' }
  });
  assert.deepEqual(adapted.tools[0].parameters, schema);
  assert.deepEqual(adapted.tool_choice, { type: 'function', name: 'weather' });
  assert.deepEqual(adapted.tools[2].parameters.properties.labels.additionalProperties, { type: 'string' });
  assert.deepEqual(adapted.tools[2].parameters.properties.pair.items, [{ type: 'string' }, { type: 'number' }]);
  assert.deepEqual(adapted.tools[3], { type: 'tool_search', execution: 'client', description: 'Searches deferred tools', parameters: { type: 'object', properties: { query: { type: 'string' } } } });
  assert.equal(adapted.text.format.strict, true);

  const inferred = adaptResponsesRequest({
    model: 'gpt-5.6-sol',
    input: 'repair',
    tools: [{
      type: 'function',
      name: 'nested',
      strict: true,
      parameters: {
        type: 'object',
        properties: { value: { properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } },
        required: ['value'],
        additionalProperties: false
      }
    }]
  });
  assert.equal(inferred.tools[0].parameters.properties.value.type, 'object');
});

test('passes through native Codex replay items untranslated', () => {
  const items = [
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'local_shell_call', id: 'lsh_1', call_id: 'call_1', status: 'completed', action: { type: 'exec', command: ['ls'] } },
    { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'weather' } },
    { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: 'base64data' },
    { type: 'context_compaction', id: 'cc_1', encrypted_content: 'enc' },
    { type: 'agent_message', id: 'am_1', author: 'a', recipient: 'b', content: [] }
  ];
  const adapted = adaptResponsesRequest({ model: 'gpt-5.6-sol', input: items, previous_response_id: undefined });
  assert.deepEqual(adapted.input.slice(1), items.slice(1));
});

test('forwards unrecognized native item/tool types by default but still rejects mcp and shapeless garbage', () => {
  const futureItem = { type: 'future_native_item', id: 'x_1', anything: [1, 2, 3] };
  const adapted = adaptResponsesRequest({
    model: 'gpt-5.6-sol',
    input: [{ type: 'message', role: 'user', content: 'hi' }, futureItem],
    tools: [{ type: 'future_native_tool', anything: 'goes' }]
  });
  assert.deepEqual(adapted.input[1], futureItem);
  assert.deepEqual(adapted.tools[0], { type: 'future_native_tool', anything: 'goes' });

  assertAdapterError(() => adaptResponsesRequest({ model: 'gpt', input: [{ foo: 'bar' }] }), { param: 'input' });
  assertAdapterError(() => adaptResponsesRequest({ model: 'gpt', input: 'x', tools: [{ type: 'mcp', server_url: 'https://example.com' }] }), { param: 'tools' });
});

test('forwards future Responses fields and enum variants while preserving local semantic boundaries', () => {
  const adapted = adaptResponsesRequest({
    model: 'gpt',
    input: 'x',
    future_option: { mode: 'new' },
    reasoning: { effort: 'future_effort', summary: 'brief', future_mode: true },
    service_tier: 'burst',
    stream_options: { include_obfuscation: true, future_option: 1 },
    text: { format: { type: 'future_format', option: true } },
    tools: [{ type: 'future_tool', option: true }],
    tool_choice: { type: 'future_tool', option: true },
    store: false
  });
  assert.deepEqual(adapted.future_option, { mode: 'new' });
  assert.deepEqual(adapted.reasoning, { effort: 'future_effort', summary: 'brief', future_mode: true });
  assert.equal(adapted.service_tier, 'burst');
  assert.equal(adapted.stream_options.future_option, 1);
  assert.deepEqual(adapted.text.format, { type: 'future_format', option: true });
  assert.deepEqual(adapted.tool_choice, { type: 'future_tool', option: true });
  assertAdapterError(() => adaptResponsesRequest({ model: 'gpt', input: 'x', store: true }), { code: 'unsupported_parameter', param: 'store' });
});

test('maps unique namespace custom tool names but skips ambiguous ones', () => {
  const tools = [
    { type: 'namespace', name: 'ops', description: 'Operations', tools: [{ type: 'custom', name: 'shell' }] },
    { type: 'namespace', name: 'files', description: 'Files', tools: [{ type: 'custom', name: 'dup' }] },
    { type: 'namespace', name: 'other', description: 'Other', tools: [{ type: 'custom', name: 'dup' }] },
    { type: 'custom', name: 'flat' }
  ];
  assert.deepEqual(customToolNamespaces(tools), { shell: 'ops' });
  assert.deepEqual(customToolNamespaces(undefined), {});
});

test('rejects malformed adapter shapes deterministically', () => {
  const responseCases = [
    [{ model: 'gpt', input: [] }, { param: 'input' }],
    [{ model: 'gpt', input: 'x', store: true }, { code: 'unsupported_parameter', param: 'store' }],
    [{ model: 'gpt', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'http://example.com/a.png' }] }] }, { code: 'unsupported_input_image_format', param: 'input' }],
    [{ model: 'gpt', input: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: '%%%%', format: 'wav' } }] }] }, { param: 'input' }],
    [{ model: 'gpt', input: 'x', tools: [{ type: 'mcp', server_url: 'https://example.com' }] }, { param: 'tools' }],
    [{ model: 'gpt', input: 'x', tools: [{ type: 'function', name: 'known', parameters: {} }], tool_choice: { type: 'function', name: 'missing' } }, { param: 'tool_choice' }],
    [{ model: 'gpt', input: 'x', previous_response_id: 'resp-1' }, { param: 'previous_response_id' }],
    [{ model: 'gpt', input: 'x', tools: [{ type: 'function', name: 'strict', parameters: { type: 'object' }, strict: true }] }, { code: 'invalid_function_parameters', param: 'tools.0.parameters' }],
    [{ model: 'gpt', input: [{ role: 'user', content: 'x', unsupported: true }] }, { param: 'input' }]
    ,[{ model: 'gpt', input: [{ role: 'assistant', content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'file_citation' }] }] }] }, { param: 'input' }]
  ];
  for (const [payload, expected] of responseCases) assertAdapterError(() => adaptResponsesRequest(payload), expected);

  const chatCases = [
    [{ model: 'gpt' }, { param: 'messages' }],
    [{ model: 'gpt', messages: [] }, { param: 'messages' }],
    [{ model: 'gpt', messages: [{ role: 'bogus', content: 'x' }] }, { param: 'messages' }],
    [{ model: 'gpt', messages: [{ role: 'user', content: 'x' }], functions: [] }, { param: 'functions' }],
    [{ model: 'gpt', messages: [{ role: 'user', content: 'x' }], max_tokens: 0 }, { param: 'max_tokens' }],
    [{ model: 'gpt', messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_schema' } }, { param: 'response_format' }]
    ,[{ model: 'gpt', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'custom', name: 'flat' }] }, { param: 'tools' }]
  ];
  for (const [payload, expected] of chatCases) assertAdapterError(() => adaptChatRequest(payload), expected);
});
