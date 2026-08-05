import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError, adaptChatRequest, adaptResponsesRequest } from '../src/openai-adapters.js';

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
      { type: 'function', name: 'flexible', parameters: { type: 'object', properties: { labels: { type: 'object', additionalProperties: { type: 'string' } }, pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } } } }
    ],
    tool_choice: { type: 'function', name: 'weather' },
    text: { format: { type: 'json_schema', name: 'answer', schema, strict: true }, verbosity: 'medium' }
  });
  assert.deepEqual(adapted.tools[0].parameters, schema);
  assert.deepEqual(adapted.tool_choice, { type: 'function', name: 'weather' });
  assert.deepEqual(adapted.tools[2].parameters.properties.labels.additionalProperties, { type: 'string' });
  assert.deepEqual(adapted.tools[2].parameters.properties.pair.items, [{ type: 'string' }, { type: 'number' }]);
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

test('rejects malformed adapter shapes deterministically', () => {
  const responseCases = [
    [{ model: 'gpt', input: [] }, { param: 'input' }],
    [{ model: 'gpt', input: 'x', unknown: true }, { code: 'unsupported_parameter', param: 'unknown' }],
    [{ model: 'gpt', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'http://example.com/a.png' }] }] }, { code: 'unsupported_input_image_format', param: 'input' }],
    [{ model: 'gpt', input: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: '%%%%', format: 'wav' } }] }] }, { param: 'input' }],
    [{ model: 'gpt', input: 'x', tools: [{ type: 'mcp', server_url: 'https://example.com' }] }, { param: 'tools' }],
    [{ model: 'gpt', input: 'x', tools: [{ type: 'function', name: 'known', parameters: {} }], tool_choice: { type: 'function', name: 'missing' } }, { param: 'tool_choice' }],
    [{ model: 'gpt', input: 'x', previous_response_id: 'resp-1' }, { param: 'previous_response_id' }],
    [{ model: 'gpt', input: 'x', tools: [{ type: 'function', name: 'strict', parameters: { type: 'object' }, strict: true }] }, { code: 'invalid_function_parameters', param: 'tools.0.parameters' }],
    [{ model: 'gpt', input: [{ role: 'user', content: 'x', unsupported: true }] }, { param: 'input' }]
  ];
  for (const [payload, expected] of responseCases) assertAdapterError(() => adaptResponsesRequest(payload), expected);

  const chatCases = [
    [{ model: 'gpt' }, { param: 'messages' }],
    [{ model: 'gpt', messages: [] }, { param: 'messages' }],
    [{ model: 'gpt', messages: [{ role: 'bogus', content: 'x' }] }, { param: 'messages' }],
    [{ model: 'gpt', messages: [{ role: 'user', content: 'x' }], functions: [] }, { param: 'functions' }],
    [{ model: 'gpt', messages: [{ role: 'user', content: 'x' }], max_tokens: 0 }, { param: 'max_tokens' }],
    [{ model: 'gpt', messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_schema' } }, { param: 'response_format' }]
  ];
  for (const [payload, expected] of chatCases) assertAdapterError(() => adaptChatRequest(payload), expected);
});
