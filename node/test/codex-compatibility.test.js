import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexGatewayOptions,
  prepareCodexMultiAgentRequest,
  restoreCodexMultiAgentResponse,
  sanitizeCodexInputItemIds
} from '../src/codex-compatibility.js';
import { inspectInitialSseEvent } from '../src/proxy.js';

const officialCodexRequest = {
  headers: {
    'user-agent': 'codex_cli_rs/0.152.0',
    'x-openai-subagent': 'collab_spawn'
  }
};

test('Codex gateway options keep transport defaults bounded and protocol rewrites opt-in', () => {
  const options = codexGatewayOptions({ websocketFrameBytes: 128 * 1024, websocketPendingBytes: 128 * 1024, streamBootstrapBytes: 128 * 1024 });
  assert.equal(options.websocketFrameBytes, 128 * 1024);
  assert.equal(options.websocketPendingBytes, 128 * 1024);
  assert.equal(options.websocketBackpressureBytes, 16 * 1024 * 1024);
  assert.equal(options.streamBootstrapBytes, 128 * 1024);
  assert.equal(options.streamBootstrapBuffering, false);
  assert.equal(options.optimizeMultiAgentV2, false);
});

test('sanitizes Codex input IDs deterministically and drops oversized encrypted reasoning', () => {
  const source = {
    input: [
      { type: 'message', id: 'short' },
      { type: 'reasoning', id: 'r'.repeat(80), encrypted_content: 'opaque' },
      { type: 'function_call', id: 'f'.repeat(80) },
      { type: 'custom_tool_call', id: 'c'.repeat(80) }
    ]
  };
  const first = sanitizeCodexInputItemIds(source);
  const second = sanitizeCodexInputItemIds(source);
  assert.deepEqual(first, second);
  assert.equal(first.input.length, 3);
  assert.equal(first.input[0].id, 'msg_short');
  assert.match(first.input[1].id, /^fc_.+_[0-9a-f]{16}$/);
  assert.match(first.input[2].id, /^ctc_.+_[0-9a-f]{16}$/);
  assert.ok([...first.input].every((item) => Array.from(item.id).length <= 64));
});

test('applies multi-agent v2 and orphan delegation transforms only to official clients', () => {
  const payload = {
    tools: [{
      type: 'namespace',
      name: 'collaboration',
      tools: [{
        type: 'function',
        name: 'spawn_agent',
        parameters: { properties: { message: { encrypted: true } } }
      }]
    }],
    input: [
      { type: 'agent_message', content: [{ type: 'encrypted_content', encrypted_content: 'agent result' }] },
      { type: 'function_call_output', namespace: 'codex_app', name: 'create_thread', call_id: 'orphan', output: 'delegated result' }
    ]
  };
  const options = { optimizeMultiAgentV2: true, orphanDelegationCompatibility: true };
  const optimized = prepareCodexMultiAgentRequest(payload, officialCodexRequest, options);
  assert.equal(optimized.optimized, true);
  assert.equal(optimized.payload.tools[0].name, 'collaboration-optimize');
  assert.equal(optimized.payload.tools[0].tools[0].parameters.properties.message.encrypted, undefined);
  assert.deepEqual(optimized.payload.input[0].content, [{ type: 'input_text', text: 'agent result' }]);
  assert.equal(optimized.payload.input[1].type, 'message');
  assert.match(optimized.payload.input[1].content[0].text, /^Tool output from codex_app__create_thread:/);

  const terminalMarker = Symbol('terminal');
  const responseWithMarker = {
    type: 'response.completed',
    response: { output: [{ type: 'function_call', namespace: 'collaboration-optimize', name: 'collaboration-optimize__spawn_agent' }] }
  };
  Object.defineProperty(responseWithMarker, terminalMarker, { value: 'response.incomplete' });
  const restored = restoreCodexMultiAgentResponse(responseWithMarker, true);
  assert.equal(restored.response.output[0].namespace, 'collaboration');
  assert.equal(restored.response.output[0].name, 'collaboration__spawn_agent');
  assert.equal(restored[terminalMarker], 'response.incomplete');

  const untrusted = prepareCodexMultiAgentRequest(payload, { headers: { 'user-agent': 'curl/8.0' } }, options);
  assert.equal(untrusted.optimized, false);
  assert.deepEqual(untrusted.payload, payload);
});

test('buffers Codex SSE bootstrap events so overload can fail over before output', async () => {
  const raw = [
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n',
    'event: response.failed\ndata: {"type":"response.failed","error":{"code":"server_is_overloaded"}}\n\n'
  ].join('');
  let firstEvents = 0;
  const inspected = await inspectInitialSseEvent(
    new Response(raw, { headers: { 'content-type': 'text/event-stream' } }),
    {},
    () => { firstEvents += 1; },
    { bootstrap: true, maxBytes: 64 * 1024, maxEvents: 8, timeoutMs: 1_000 }
  );
  assert.equal(inspected.retryable, true);
  assert.equal(inspected.firstEvent.error.code, 'server_is_overloaded');
  assert.equal(firstEvents, 1);
  assert.equal(await inspected.response.text(), raw);
});

test('releases stalled Codex SSE bootstrap buffering at its total timeout', async () => {
  const body = new ReadableStream({ start() {} });
  const started = Date.now();
  const inspected = await inspectInitialSseEvent(
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    { bodyIdleMs: 10_000 },
    null,
    { bootstrap: true, timeoutMs: 50 }
  );
  assert.equal(inspected.retryable, false);
  assert.ok(Date.now() - started < 500);
  await inspected.response.body.cancel();
});

test('passes through bootstrap data unchanged when event or byte bounds are reached', async () => {
  const raw = [
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n'
  ].join('');
  for (const limits of [{ maxEvents: 1 }, { maxBytes: 8 }]) {
    const inspected = await inspectInitialSseEvent(
      new Response(raw, { headers: { 'content-type': 'text/event-stream' } }),
      {},
      null,
      { bootstrap: true, maxEvents: limits.maxEvents ?? 8, maxBytes: limits.maxBytes ?? 64 * 1024, timeoutMs: 1_000 }
    );
    assert.equal(inspected.retryable, false);
    assert.equal(await inspected.response.text(), raw);
  }
});
