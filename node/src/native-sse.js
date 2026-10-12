export const NATIVE_SSE_EVENT_BYTES = 8 * 1024 * 1024;
export const NATIVE_SSE_TERMINAL_BYTES = 64 * 1024 * 1024;
const PREAMBLES = new Set(['response.created', 'response.in_progress', 'response.metadata', 'codex.response.metadata']);
const ORDINARY = new Set([
  ...PREAMBLES, 'response.output_item.added', 'response.output_item.done', 'response.content_part.added',
  'response.content_part.done', 'response.output_text.delta', 'response.output_text.done',
  'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'codex.rate_limits'
]);

export function createNativeSseState() {
  return { buffer: '', bytes: 0, discarding: false, carry: '' };
}

export function nativeSsePreamble(block) {
  const label = /^event:[ \t]*([^\r\n]*)/m.exec(block)?.[1]?.trim();
  return PREAMBLES.has(label);
}

function observationLimit(block) {
  const label = /^event:[ \t]*([^\r\n]*)[\r\n]/.exec(block)?.[1]?.trim();
  return ORDINARY.has(label) ? NATIVE_SSE_EVENT_BYTES : NATIVE_SSE_TERMINAL_BYTES;
}

function delimiterAt(value, offset, eof) {
  let index = Math.max(0, offset);
  if (value[index] === '\n' && value[index - 1] === '\r') index -= 1;
  const ending = (at) => value[at] === '\n' ? 1
    : value[at] === '\r' ? (value[at + 1] === '\n' ? 2 : at + 1 < value.length || eof ? 1 : 0) : 0;
  while (index < value.length) {
    const start = value.slice(index).search(/[\r\n]/);
    if (start < 0) break;
    index += start;
    const first = ending(index);
    if (!first) break;
    const second = ending(index + first);
    if (second) return [index, index + first + second];
    index += first;
  }
  return null;
}

function trailingEnding(value) {
  return value.endsWith('\r\n') ? '\r\n' : /[\r\n]$/.test(value) ? value.slice(-1) : '';
}

// Oversized native events lose observation, not wire delivery. Discard through
// the original separator so a suffix cannot be interpreted as another event.
export function consumeNativeSse(state, value, { eof = false } = {}) {
  const parts = [];
  let input = value;
  while (input) {
    if (state.discarding) {
      const combined = state.carry + input;
      const delimiter = delimiterAt(combined, 0, eof);
      if (!delimiter) {
        parts.push({ kind: 'raw', wire: input });
        state.carry = trailingEnding(combined);
        input = '';
      } else {
        const consumed = Math.max(0, delimiter[1] - state.carry.length);
        parts.push({ kind: 'raw', wire: input.slice(0, consumed) });
        input = input.slice(consumed);
        state.discarding = false;
        state.carry = '';
      }
      continue;
    }
    const previousLength = state.buffer.length;
    const combined = state.buffer + input;
    const delimiter = delimiterAt(combined, previousLength - 2, eof);
    const block = delimiter ? combined.slice(0, delimiter[0]) : combined;
    const bytes = delimiter ? Buffer.byteLength(block)
      : state.bytes + Buffer.byteLength(input);
    const contentBytes = delimiter ? bytes : bytes - Buffer.byteLength(/[\r\n]+$/.exec(block)?.[0] || '');
    const limit = observationLimit(block);
    if (contentBytes > limit) {
      const kind = nativeSsePreamble(block) ? 'preamble_overflow' : 'raw';
      if (!delimiter) {
        parts.push({ kind, wire: combined });
        state.buffer = '';
        state.bytes = 0;
        state.discarding = true;
        state.carry = trailingEnding(combined);
        input = '';
      } else {
        parts.push({ kind, wire: combined.slice(0, delimiter[1]) });
        input = combined.slice(delimiter[1]);
        state.buffer = '';
        state.bytes = 0;
      }
    } else if (!delimiter) {
      state.buffer = combined;
      state.bytes = bytes;
      input = '';
    } else {
      parts.push({ kind: 'block', block: block.replace(/\r\n?/g, '\n'), wire: combined.slice(0, delimiter[1]) });
      input = combined.slice(delimiter[1]);
      state.buffer = '';
      state.bytes = 0;
    }
  }
  if (eof) {
    if (!state.discarding && state.buffer) {
      parts.push({ kind: 'block', block: state.buffer.replace(/\r\n?/g, '\n'), wire: state.buffer });
    }
    Object.assign(state, createNativeSseState());
  }
  return parts;
}
