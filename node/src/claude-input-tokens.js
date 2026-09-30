import { HttpError } from './http-ingress.js';
import { countTokens as countO200kTokens } from 'gpt-tokenizer';

// This mirrors CLIProxyAPI's CountClaudeInputTokens path. It is intentionally
// content-based rather than JSON-size-based: Claude's local fallback counts
// textual and structured tool input while excluding binary media and request
// control fields.
export function countClaudeInputTokens(payload) {
  const root = parseTokenCountPayload(payload);
  const segments = [];
  collectSystem(root.system, segments);
  collectMessages(root.messages, segments);
  collectTools(root.tools, segments);
  collectToolChoice(root.tool_choice, segments);
  return countO200kTokens(segments.join('\n'));
}

function parseTokenCountPayload(payload) {
  let root = payload;
  if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
    try {
      root = JSON.parse(payload.toString());
    } catch {
      throw tokenCountError('invalid Claude token count request JSON');
    }
  }
  if (!isObject(root)) throw tokenCountError('Claude token count request must be a JSON object');
  if (!Array.isArray(root.messages) || root.messages.length === 0) {
    throw tokenCountError('Claude token count request messages must be a non-empty array');
  }
  for (const message of root.messages) {
    if (!isObject(message)) throw tokenCountError('Claude token count request messages must contain objects');
    if (!['user', 'assistant'].includes(message.role)) {
      throw tokenCountError('Claude token count request message role must be user or assistant');
    }
    if (typeof message.content === 'string') continue;
    if (!Array.isArray(message.content)) {
      throw tokenCountError('Claude token count request message content must be a string or array');
    }
    for (const block of message.content) {
      if (!isObject(block) || typeof block.type !== 'string' || !block.type) {
        throw tokenCountError('Claude token count request content blocks must be typed objects');
      }
    }
  }
  return root;
}

function collectSystem(system, segments) {
  if (typeof system === 'string') {
    appendString(segments, system);
    return;
  }
  if (!Array.isArray(system)) return;
  for (const part of system) {
    if (typeof part === 'string') appendString(segments, part);
    else if (isObject(part) && part.type === 'text') appendString(segments, part.text);
  }
}

function collectMessages(messages, segments) {
  for (const message of messages || []) {
    appendString(segments, message.role);
    collectContent(message.content, segments);
  }
}

function collectContent(content, segments) {
  if (content === undefined || content === null) return;
  if (typeof content === 'string') {
    appendString(segments, content);
    return;
  }
  if (Array.isArray(content)) {
    for (const part of content) collectContent(part, segments);
    return;
  }
  if (!isObject(content)) return;

  switch (content.type) {
    case 'text':
      appendString(segments, content.text);
      break;
    case 'thinking':
      appendString(segments, content.thinking);
      break;
    case 'document':
      collectDocument(content, segments);
      break;
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      appendString(segments, content.id);
      appendString(segments, content.name);
      appendJson(segments, content.input);
      break;
    case 'tool_result':
    case 'mcp_tool_result':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
      appendString(segments, content.tool_use_id);
      appendString(segments, content.tool_call_id);
      collectContent(content.content, segments);
      break;
    case 'web_search_result':
    case 'search_result':
      if (typeof content.source === 'string') appendString(segments, content.source);
      appendString(segments, content.title);
      appendString(segments, content.url);
      appendString(segments, content.page_age);
      collectContent(content.content, segments);
      break;
    case 'web_fetch_result':
      appendString(segments, content.url);
      appendString(segments, content.retrieved_at);
      collectContent(content.content, segments);
      break;
    case 'code_execution_result':
    case 'bash_code_execution_result':
    case 'text_editor_code_execution_result':
      appendString(segments, content.stdout);
      appendString(segments, content.stderr);
      appendString(segments, content.return_code);
      collectContent(content.content, segments);
      collectContent(content.output, segments);
      break;
    case 'tool_reference':
      appendString(segments, content.tool_name);
      break;
    case 'image':
    case 'input_audio':
    case 'audio':
    case 'video':
    case 'redacted_thinking':
      break;
    case undefined:
      appendJson(segments, content);
      break;
    default:
      appendString(segments, content.text);
      break;
  }
}

function collectDocument(document, segments) {
  const source = document.source;
  if (!isObject(source) || source.type !== 'text') return;
  appendString(segments, document.title);
  appendString(segments, document.context);
  appendString(segments, source.data);
  appendString(segments, source.content);
}

function collectTools(tools, segments) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!isObject(tool)) continue;
    appendString(segments, tool.type);
    appendString(segments, tool.name);
    appendString(segments, tool.description);
    appendJson(segments, tool.input_schema);
  }
}

function collectToolChoice(toolChoice, segments) {
  if (toolChoice === undefined || toolChoice === null) return;
  if (typeof toolChoice === 'string') {
    appendString(segments, toolChoice);
    return;
  }
  if (!isObject(toolChoice)) return;
  appendString(segments, toolChoice.type);
  appendString(segments, toolChoice.name);
}

function appendString(segments, value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return;
  const text = String(value).trim();
  if (text) segments.push(text);
}

function appendJson(segments, value) {
  if (value === undefined) return;
  if (typeof value === 'string') {
    appendString(segments, value);
    return;
  }
  try {
    appendString(segments, JSON.stringify(value));
  } catch {
    // An already parsed HTTP JSON body should not contain cycles; ignoring an
    // unexpected value matches CPA's best-effort compacting fallback.
  }
}

function tokenCountError(message) {
  return new HttpError(400, 'invalid_request_error', message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
