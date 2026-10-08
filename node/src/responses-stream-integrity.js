const TOOL_TYPES = new Set(['function_call', 'custom_tool_call']);
const PAYLOAD_TYPES = {
  'response.function_call_arguments.delta': 'function_call',
  'response.function_call_arguments.done': 'function_call',
  'response.custom_tool_call_input.delta': 'custom_tool_call',
  'response.custom_tool_call_input.done': 'custom_tool_call'
};

export function createResponsesIntegrityState(maxOutputBytes = 8 * 1024 * 1024) {
  return { tools: new Map(), aliases: new Map(), failure: null, output: [], outputBytes: 0, outputOverflow: false, maxOutputBytes };
}

export function observeResponsesIntegrity(event, state) {
  if (state.failure) return;
  const phase = event.type === 'response.output_item.added' ? 'add' : event.type === 'response.output_item.done' ? 'done' : 'payload';
  const kind = phase === 'payload' ? PAYLOAD_TYPES[event.type] : event.item?.type;
  if (phase === 'payload' && !kind) return;
  const tracked = state.tools.has(event.output_index)
    || state.aliases.has(`item:${event.item?.id ?? event.item_id}`)
    || state.aliases.has(`call:${event.item?.call_id ?? event.call_id}`);
  if (!TOOL_TYPES.has(kind) && !tracked) return;
  const index = event.output_index;
  const itemId = identity(event.item, 'id', state);
  const topId = identity(event, 'item_id', state);
  const callId = identity(event.item, 'call_id', state);
  const topCall = identity(event, 'call_id', state);
  if (state.failure) return;
  if (!compatible(itemId, topId) || !compatible(callId, topCall)
    || !Number.isSafeInteger(index) || index < 0 || !(itemId || topId || callId || topCall)) return fail(state);
  const incomingItem = itemId || topId;
  const incomingCall = callId || topCall;
  const aliases = [incomingItem && `item:${incomingItem}`, incomingCall && `call:${incomingCall}`].filter(Boolean);
  if (['function_call_output', 'custom_tool_call_output'].includes(kind)) {
    if (state.tools.has(index) || incomingItem && state.aliases.has(`item:${incomingItem}`)) fail(state);
    return;
  }
  if (!TOOL_TYPES.has(kind)) return fail(state);
  let tool = state.tools.get(index);
  if (phase === 'add') {
    if (tool || aliases.some((alias) => state.aliases.has(alias))) return fail(state);
    if (state.tools.size >= 4096) return fail(state, 'tool_tracking_overflow');
    tool = { kind, itemId: incomingItem, callId: incomingCall, done: false };
  } else {
    if (!tool || tool.kind !== kind || tool.done
      || !compatible(tool.callId, incomingCall)
      || incomingItem && incomingItem !== tool.itemId && !(phase === 'done' && !tool.itemId && incomingCall && incomingCall === tool.callId)
      || !(incomingItem && incomingItem === tool.itemId || incomingCall && incomingCall === tool.callId)
      || aliases.some((alias) => state.aliases.has(alias) && state.aliases.get(alias) !== index)
      || phase === 'done' && Object.hasOwn(event.item, 'status') && event.item.status !== 'completed') return fail(state);
    tool.itemId ||= incomingItem;
    tool.callId ||= incomingCall;
    tool.done = phase === 'done';
  }
  state.tools.set(index, tool);
  for (const alias of aliases) state.aliases.set(alias, index);
}

export function responsesCompletionFailure(state) {
  return state.failure || ([...state.tools.values()].some((tool) => !tool.done) ? 'incomplete_tool_item' : null);
}

export function recordResponsesOutput(event, state) {
  if (state.outputOverflow || event.type !== 'response.output_item.done' || !event.item || typeof event.item !== 'object' || Array.isArray(event.item)) return;
  state.outputBytes += Buffer.byteLength(JSON.stringify(event));
  if (state.outputBytes > state.maxOutputBytes) {
    state.output = [];
    state.outputOverflow = true;
    return;
  }
  state.output.push({ index: Number.isSafeInteger(event.output_index) && event.output_index >= 0 ? event.output_index : null, item: structuredClone(event.item) });
}

export function fillResponsesOutput(event, state) {
  if (!['response.completed', 'response.incomplete'].includes(event.type) || !event.response || state.outputOverflow || !state.output.length
    || Array.isArray(event.response.output) && event.response.output.length) return event;
  const output = state.output.every((entry) => entry.index !== null)
    ? [...new Map(state.output.map((entry) => [entry.index, entry.item])).entries()].sort(([first], [second]) => first - second).map(([, item]) => item)
    : state.output.map((entry) => entry.item);
  return { ...event, response: { ...event.response, output } };
}

function identity(value, key, state) {
  if (!value || !Object.hasOwn(value, key)) return null;
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) { fail(state); return null; }
  if (Buffer.byteLength(field) > 1024) { fail(state, 'tool_tracking_overflow'); return null; }
  return field;
}

function compatible(first, second) { return !first || !second || first === second; }
function fail(state, reason = 'invalid_tool_correlation') { state.failure = reason; }
