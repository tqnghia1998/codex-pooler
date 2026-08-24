const RESPONSES_FORWARDED_FIELDS = new Set([
  'client_metadata', 'include', 'input', 'instructions', 'max_output_tokens', 'metadata', 'model',
  'moderation', 'parallel_tool_calls', 'previous_response_id', 'prompt_cache_key', 'prompt_cache_options',
  'prompt_cache_retention', 'reasoning', 'safety_identifier', 'service_tier', 'store', 'stream',
  'stream_options', 'temperature', 'text', 'tool_choice', 'tools', 'top_p'
]);
const RESPONSES_LOCAL_FIELDS = new Set(['background', 'context_management', 'conversation', 'max_tool_calls', 'prompt', 'top_logprobs', 'user']);
const CHAT_FIELDS = new Set([
  'audio', 'frequency_penalty', 'function_call', 'functions', 'input', 'instructions', 'logit_bias',
  'logprobs', 'max_completion_tokens', 'max_tokens', 'messages', 'metadata', 'modalities', 'model',
  'moderation', 'n', 'parallel_tool_calls', 'prediction', 'presence_penalty', 'prompt_cache_key',
  'prompt_cache_options', 'prompt_cache_retention', 'reasoning_effort', 'response_format',
  'safety_identifier', 'seed', 'service_tier', 'stop', 'store', 'stream', 'stream_options',
  'temperature', 'tool_choice', 'tools', 'top_logprobs', 'top_p', 'user', 'verbosity', 'web_search_options'
]);
const CHAT_LOCAL_FIELDS = new Set([
  'audio', 'frequency_penalty', 'logit_bias', 'logprobs', 'modalities', 'n', 'prediction',
  'presence_penalty', 'seed', 'stop', 'top_logprobs', 'user', 'web_search_options'
]);
const AUDIO_MIMES = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg' };
const IMAGE_MIMES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const FILE_MIMES = new Set(['application/pdf', 'text/plain']);
const TOOL_RESULT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'program_output', 'shell_call_output', 'tool_search_output']);

export class AdapterError extends Error {
  constructor(message, param = null, code = 'invalid_request') {
    super(message);
    this.statusCode = 400;
    this.code = code;
    this.param = param;
  }
}

export function adaptResponsesRequest(payload) {
  const normalized = structuredClone(payload);
  if (Object.hasOwn(normalized, 'logprobs')) unsupported('logprobs');
  for (const field of Object.keys(normalized)) {
    if (RESPONSES_LOCAL_FIELDS.has(field)) unsupported(field);
  }
  if (normalized.store !== undefined && normalized.store !== false) unsupported('store');
  requireModel(normalized);
  validatePromptCacheOptions(normalized.prompt_cache_options);
  validatePositiveInteger(normalized, 'max_output_tokens');
  validateReasoning(normalized.reasoning);
  if (plainObject(normalized.reasoning)) {
    for (const field of ['effort', 'summary', 'context']) {
      if (typeof normalized.reasoning[field] === 'string') normalized.reasoning[field] = normalized.reasoning[field].trim().toLowerCase();
    }
  }
  validateModeration(normalized.moderation);
  normalizeServiceTier(normalized);
  validateStreamOptions(normalized.stream_options, 'include_obfuscation');
  if (normalized.truncation !== undefined) {
    if (typeof normalized.truncation !== 'string' || !['auto', 'disabled'].includes(normalized.truncation.trim().toLowerCase())) {
      invalid('truncation is not supported', 'truncation');
    }
    delete normalized.truncation;
  }
  const normalizedInput = normalizeInput(normalized.input, normalized.previous_response_id);
  normalized.input = normalizedInput.input;
  if (normalizedInput.instructions.length) {
    normalized.instructions = [cleanString(normalized.instructions), ...normalizedInput.instructions].filter(Boolean).join('\n');
  }
  normalized.tools = lowerAndValidateTools(normalized.tools);
  validateToolChoice(normalized);
  validateText(normalized.text);
  validateStrictTargets(normalized);
  validateMedia(normalized.input);
  return defined(normalized);
}

export function adaptChatRequest(payload) {
  const normalized = structuredClone(payload);
  rejectUnsupportedFields(normalized, CHAT_FIELDS);
  if (Object.hasOwn(normalized, 'functions')) invalid('legacy functions are not translatable', 'functions');
  if (Object.hasOwn(normalized, 'function_call')) invalid('legacy function_call is not translatable', 'function_call');
  for (const field of Object.keys(normalized)) {
    if (CHAT_LOCAL_FIELDS.has(field)) unsupported(field);
  }
  requireModel(normalized);
  validateReasoningEffort(normalized.reasoning_effort, 'reasoning_effort');
  normalizeServiceTier(normalized);
  if (normalized.service_tier === 'ultrafast') invalid('service_tier is not supported', 'service_tier');
  validateStreamOptions(normalized.stream_options, 'include_usage');
  validatePositiveInteger(normalized, 'max_tokens');
  validatePositiveInteger(normalized, 'max_completion_tokens');
  if (normalized.verbosity !== undefined) {
    if (typeof normalized.verbosity !== 'string' || !['low', 'medium', 'high'].includes(normalized.verbosity.trim().toLowerCase())) {
      invalid('verbosity is not supported', 'verbosity');
    }
  }
  validatePromptCacheOptions(normalized.prompt_cache_options);

  let responsePayload;
  if (Array.isArray(normalized.messages) && normalized.messages.length) {
    responsePayload = chatMessagesToResponses(normalized);
  } else if (normalized.messages === undefined || Array.isArray(normalized.messages)) {
    if (normalized.input === undefined) invalid(normalized.messages ? 'messages must be a non-empty array' : 'messages is required', 'messages');
    responsePayload = pick(normalized, RESPONSES_FORWARDED_FIELDS);
    if (responsePayload.instructions === undefined) responsePayload.instructions = '';
    delete responsePayload.stream_options;
  } else {
    invalid('messages must be a non-empty array', 'messages');
  }
  return adaptResponsesRequest(responsePayload);
}

function chatMessagesToResponses(payload) {
  const input = payload.messages.flatMap(normalizeChatMessage);
  const result = { model: payload.model, input };
  for (const field of [
    'parallel_tool_calls', 'metadata', 'moderation', 'prompt_cache_key', 'prompt_cache_options',
    'prompt_cache_retention', 'safety_identifier', 'service_tier', 'store', 'stream', 'temperature', 'top_p'
  ]) {
    if (payload[field] !== undefined) result[field] = payload[field];
  }
  if (payload.tools !== undefined) result.tools = translateChatTools(payload.tools);
  if (payload.tool_choice !== undefined) result.tool_choice = translateChatToolChoice(payload.tool_choice);
  const maxTokens = payload.max_completion_tokens ?? payload.max_tokens;
  if (maxTokens !== undefined) result.max_output_tokens = maxTokens;
  if (payload.reasoning_effort !== undefined) result.reasoning = { effort: payload.reasoning_effort.trim().toLowerCase() };
  if (payload.response_format !== undefined || payload.verbosity !== undefined) result.text = chatTextOptions(payload);
  return result;
}

function normalizeChatMessage(message) {
  if (!plainObject(message) || !['system', 'user', 'assistant', 'developer', 'tool'].includes(message.role)) {
    invalid('messages must contain role/content objects', 'messages');
  }
  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    if (!(message.content === undefined || message.content === null || validChatContent(message.content))) invalid('messages must contain role/content objects', 'messages');
    return [
      ...(message.content === undefined || message.content === null || message.content === '' ? [] : normalizeChatContent(message.content, 'assistant', message)),
      ...message.tool_calls.map(normalizeAssistantToolCall)
    ];
  }
  if (message.role === 'tool') {
    const callId = cleanString(message.tool_call_id);
    if (!callId) invalid('messages must contain role/content objects', 'messages');
    return [{ type: 'function_call_output', call_id: callId, output: normalizeToolOutput(message.content) }];
  }
  if (!validChatContent(message.content)) invalid('messages must contain role/content objects', 'messages');
  return normalizeChatContent(message.content, message.role, message);
}

function validChatContent(content) {
  return typeof content === 'string' || plainObject(content) || Array.isArray(content) && content.length > 0;
}

function normalizeChatContent(content, role, message) {
  const parts = Array.isArray(content) ? content : [content];
  const items = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    items.push({ type: 'message', role, content: pending, ...(message.name !== undefined ? { name: message.name } : {}), ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}) });
    pending = [];
  };
  for (const part of parts) {
    if (plainObject(part) && part.type === 'tool-call') {
      flush();
      const callId = cleanString(part.toolCallId);
      const name = cleanString(part.toolName);
      if (!callId || !name || !Object.hasOwn(part, 'input')) invalid('messages must contain role/content objects', 'messages');
      items.push({ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(part.input) });
    } else if (plainObject(part) && part.type === 'tool-result') {
      flush();
      const callId = cleanString(part.toolCallId);
      if (!callId || !Object.hasOwn(part, 'output')) invalid('messages must contain role/content objects', 'messages');
      items.push({ type: 'function_call_output', call_id: callId, output: normalizeClineOutput(part.output) });
    } else {
      pending.push(normalizeChatContentPart(part, role));
    }
  }
  flush();
  return items;
}

function normalizeChatContentPart(part, role) {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof part === 'string') return { type: textType, text: part };
  if (!plainObject(part)) invalid('messages must contain role/content objects', 'messages');
  if (['text', 'input_text'].includes(part.type) && typeof part.text === 'string') {
    return { type: textType, text: part.text, ...breakpoint(part) };
  }
  if (part.type === 'image_url') {
    const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    if (typeof imageUrl !== 'string') invalid('messages must contain role/content objects', 'messages');
    return { type: 'input_image', image_url: imageUrl, ...breakpoint(part) };
  }
  if (part.type === 'input_image' && (typeof part.image_url === 'string' || typeof part.file_id === 'string')) return { ...part };
  if (part.type === 'file' && plainObject(part.file)) {
    if (cleanString(part.file.file_id)) return { type: 'input_file', file_id: part.file.file_id, ...breakpoint(part) };
    if (cleanString(part.file.filename) && typeof part.file.file_data === 'string') return { type: 'input_file', filename: part.file.filename, file_data: part.file.file_data, ...breakpoint(part) };
  }
  if (part.type === 'input_audio') return { ...part };
  invalid('messages must contain role/content objects', 'messages');
}

function normalizeAssistantToolCall(call) {
  const callId = cleanString(call?.call_id) || cleanString(call?.id);
  const name = cleanString(call?.function?.name);
  const args = call?.function?.arguments;
  if (!callId || !name || typeof args !== 'string') invalid('messages must contain role/content objects', 'messages');
  return { type: 'function_call', call_id: callId, name, arguments: args };
}

function normalizeToolOutput(content) {
  if (typeof content === 'string') return content;
  if (content === null) return '';
  if (!Array.isArray(content) || !content.length) invalid('messages must contain role/content objects', 'messages');
  return content.map(normalizeToolOutputPart);
}

function normalizeClineOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(normalizeToolOutputPart);
  if (plainObject(output)) return output;
  invalid('messages must contain role/content objects', 'messages');
}

function normalizeToolOutputPart(part) {
  if (typeof part === 'string') return { type: 'input_text', text: part };
  if (!plainObject(part)) invalid('messages must contain role/content objects', 'messages');
  if (['text', 'input_text'].includes(part.type) && typeof part.text === 'string') return { type: 'input_text', text: part.text, ...breakpoint(part) };
  if (part.type === 'image_url') {
    const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    if (typeof imageUrl === 'string') return { type: 'input_image', image_url: imageUrl };
  }
  if (part.type === 'input_image' && typeof part.image_url === 'string') return { type: 'input_image', image_url: part.image_url, ...breakpoint(part) };
  if (part.type === 'image' && typeof part.data === 'string' && typeof part.mediaType === 'string') return { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` };
  if (part.type === 'json' && Object.hasOwn(part, 'value')) return { type: 'input_text', text: JSON.stringify(part.value) };
  invalid('messages must contain role/content objects', 'messages');
}

function translateChatTools(tools) {
  if (!Array.isArray(tools)) invalid('tools must be an array', 'tools');
  return tools.map((tool) => {
    if (tool?.type === 'function' && plainObject(tool.function)) {
      const name = cleanString(tool.function.name);
      if (!name || !plainObject(tool.function.parameters)) invalid('function tool requires nested function name and parameters', 'tools');
      return { type: 'function', name, parameters: tool.function.parameters, ...(tool.function.description !== undefined ? { description: tool.function.description } : {}), ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}) };
    }
    if (tool?.type === 'custom' && plainObject(tool.custom)) {
      exactKeys(tool, ['type', 'custom'], 'tools');
      exactKeys(tool.custom, ['name', 'description', 'format'], 'tools');
      return { type: 'custom', ...tool.custom };
    }
    if (['web_search_preview', 'image_generation'].includes(tool?.type)) return tool;
    invalid('tool shape is not translatable', 'tools');
  });
}

function translateChatToolChoice(choice) {
  if (plainObject(choice) && choice.type === 'allowed_tools') invalid('tool_choice shape is not translatable', 'tool_choice');
  if (plainObject(choice) && choice.type === 'function' && cleanString(choice.function?.name)) return { type: 'function', name: choice.function.name };
  if (plainObject(choice) && choice.type === 'custom' && plainObject(choice.custom)) {
    exactKeys(choice, ['type', 'custom'], 'tool_choice');
    exactKeys(choice.custom, ['name'], 'tool_choice');
    if (!cleanString(choice.custom.name)) invalid('tool_choice shape is not translatable', 'tool_choice');
    return { type: 'custom', name: choice.custom.name };
  }
  if (plainObject(choice) && choice.type === 'custom') invalid('tool_choice shape is not translatable', 'tool_choice');
  return choice;
}

function chatTextOptions(payload) {
  const text = {};
  if (payload.response_format !== undefined) {
    const format = payload.response_format;
    if (!plainObject(format)) invalid('response_format is not translatable', 'response_format');
    if (format.type === 'json_object' || format.type === 'text') text.format = { type: format.type };
    else if (format.type === 'json_schema') {
      if (!plainObject(format.json_schema)) invalid('response_format json_schema must be an object', 'response_format');
      text.format = { ...format.json_schema, type: 'json_schema' };
    } else invalid('response_format is not translatable', 'response_format');
  }
  if (payload.verbosity !== undefined) text.verbosity = payload.verbosity.trim().toLowerCase();
  return text;
}

function normalizeInput(input, previousResponseId) {
  rejectReservedMetadata(input);
  if (previousResponseId !== undefined && (!cleanString(previousResponseId) || !Array.isArray(input))) invalid('previous_response_id requires a tool-output continuation', 'previous_response_id');
  if (input === undefined) return { input: undefined, instructions: [] };
  if (typeof input === 'string') return { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }], instructions: [] };
  if (!Array.isArray(input)) invalid('input must be a string or array', 'input');
  if (!input.length) invalid('input must be a non-empty string or array', 'input');
  const continuation = Boolean(cleanString(previousResponseId));
  const repaired = repairReplayCallIds(input);
  const normalized = repaired.filter((item) => continuation || item?.type !== 'reasoning').flatMap(normalizeInputItem);
  const hasToolResult = normalized.some((item) => TOOL_RESULT_TYPES.has(item.type));
  if (previousResponseId !== undefined && (!continuation || !hasToolResult)) invalid('previous_response_id requires a tool-output continuation', 'previous_response_id');
  for (const item of normalized) {
    if (item.type === 'item_reference' && (!continuation || !hasToolResult || Object.keys(item).length !== 2 || !cleanString(item.id))) invalid('input item shape is not translatable', 'input');
  }
  const lifted = liftInstructions(normalized);
  return { input: lifted.input, instructions: lifted.texts };
}

function normalizeInputItem(item) {
  if (!plainObject(item)) invalid('input item shape is not translatable', 'input');
  if (item.type === 'additional_tools') {
    if (item.role !== 'developer' || !Array.isArray(item.tools) || Object.keys(item).some((key) => !['type', 'role', 'tools', 'id'].includes(key))) invalid('input item shape is not translatable', 'input');
    if (item.tools.some((tool) => tool?.type === 'mcp')) invalid('remote MCP tools are not supported', 'input');
    return [item];
  }
  if (item.role === 'assistant' && Array.isArray(item.tool_calls)) return item.tool_calls.map(normalizeAssistantToolCall);
  if (item.role === 'tool') {
    const callId = cleanString(item.tool_call_id) || cleanString(item.call_id);
    if (!callId) invalid('input item shape is not translatable', 'input');
    return [{ type: 'function_call_output', call_id: callId, output: normalizeToolOutput(item.content), ...(plainObject(item.metadata) ? { metadata: item.metadata } : {}) }];
  }
  if (item.type === 'reasoning') {
    const allowed = ['type', 'id', 'summary', 'encrypted_content', 'metadata', 'internal_chat_message_metadata_passthrough'];
    if (Object.keys(item).some((key) => !allowed.includes(key)) || !Array.isArray(item.summary) || item.summary.some((part) => !plainObject(part) || part.type !== 'summary_text' || typeof part.text !== 'string' || Object.keys(part).some((key) => !['type', 'text'].includes(key))) || !(cleanString(item.id) || cleanString(item.encrypted_content))) invalid('input item shape is not translatable', 'input');
    return [item];
  }
  if (item.type === 'compaction') {
    if (!cleanString(item.encrypted_content) || Object.keys(item).some((key) => !['type', 'encrypted_content', 'id'].includes(key)) || item.id !== undefined && !cleanString(item.id)) invalid('input item shape is not translatable', 'input');
    return [item];
  }
  if (item.type === 'function_call') {
    const callId = cleanString(item.call_id) || cleanString(item.id);
    if (!callId || !cleanString(item.name) || typeof item.arguments !== 'string' || item.status !== undefined && !['completed', 'incomplete'].includes(item.status)) invalid('input item shape is not translatable', 'input');
    const result = { ...item, call_id: callId };
    delete result.status;
    if (Object.keys(result).some((key) => !['type', 'call_id', 'name', 'arguments', 'id', 'namespace', 'caller', 'metadata', 'internal_chat_message_metadata_passthrough'].includes(key))) invalid('input item shape is not translatable', 'input');
    if (result.namespace !== undefined && !cleanString(result.namespace) || !validReplayCaller(result.caller)) invalid('input item shape is not translatable', 'input');
    return [result];
  }
  if (item.type === 'function_call_output') {
    if (!cleanString(item.call_id) || !(Object.hasOwn(item, 'output') || Object.hasOwn(item, 'result')) || Object.keys(item).some((key) => !['type', 'call_id', 'output', 'result', 'id', 'caller', 'metadata', 'internal_chat_message_metadata_passthrough'].includes(key))) invalid('input item shape is not translatable', 'input');
    if (!validReplayCaller(item.caller)) invalid('input item shape is not translatable', 'input');
    const result = { ...item };
    if (Array.isArray(result.output)) result.output = result.output.map(normalizeFunctionOutputPart);
    return [result];
  }
  if (item.type === 'custom_tool_call') {
    if (!cleanString(item.call_id) || !cleanString(item.name) || !cleanString(item.input) || item.status !== undefined && !['completed', 'incomplete'].includes(item.status) || Object.keys(item).some((key) => !['type', 'call_id', 'name', 'input', 'id', 'status', 'namespace', 'metadata', 'internal_chat_message_metadata_passthrough'].includes(key))) invalid('input item shape is not translatable', 'input');
    return [item.status ? stripKey(item, 'status') : item];
  }
  if (item.type === 'custom_tool_call_output') {
    if (!cleanString(item.call_id) || !Object.hasOwn(item, 'output') || Object.keys(item).some((key) => !['type', 'call_id', 'output', 'id', 'name', 'metadata', 'internal_chat_message_metadata_passthrough'].includes(key))) invalid('input item shape is not translatable', 'input');
    return [item];
  }
  if (item.type === 'program') {
    if (![item.id, item.call_id, item.code, item.fingerprint].every((value) => typeof value === 'string') || Object.keys(item).some((key) => !['type', 'id', 'call_id', 'code', 'fingerprint'].includes(key))) invalid('input item shape is not translatable', 'input');
    return [item];
  }
  if (item.type === 'program_output') {
    if (![item.id, item.call_id, item.result].every((value) => typeof value === 'string') || !['completed', 'incomplete'].includes(item.status) || Object.keys(item).some((key) => !['type', 'id', 'call_id', 'result', 'status'].includes(key))) invalid('input item shape is not translatable', 'input');
    return [item];
  }
  if (item.type === 'shell_call' || item.type === 'shell_call_output') {
    validateHostedShellItem(item);
    return [item];
  }
  // Known native Codex replay items with no locally-owned semantics (see codex-rs
  // protocol::models::ResponseItem for the source of truth). Forwarded as-is.
  if (['tool_search_call', 'tool_search_output', 'local_shell_call', 'web_search_call', 'image_generation_call', 'context_compaction', 'agent_message', 'item_reference'].includes(item.type)) return [item];
  if (item.type === 'input_file') {
    if (!(cleanString(item.file_id) || typeof item.file_data === 'string')) invalid('input item shape is not translatable', 'input');
    return [item];
  }
  if (item.type === 'message' || item.type === undefined && (item.role !== undefined || item.content !== undefined)) return [normalizeResponseMessage(item)];
  // Anything else with a type tag we don't recognize yet: forward untranslated rather
  // than reject, so a newly added native Codex item type doesn't 400 until we get
  // around to adding an explicit case above. Deliberately blocked shapes (e.g. remote
  // MCP tools) are already rejected above/in additional_tools before this fallback.
  if (cleanString(item.type)) return [item];
  invalid('input item shape is not translatable', 'input');
}

function normalizeFunctionOutputPart(part) {
  if (plainObject(part) && part.type === 'input_image') {
    if (typeof part.image_url !== 'string' || Object.keys(part).some((key) => !['type', 'image_url', 'detail', 'prompt_cache_breakpoint'].includes(key))) invalid('input item shape is not translatable', 'input');
    return { type: 'input_image', image_url: part.image_url, ...(part.detail !== undefined ? { detail: part.detail } : {}), ...breakpoint(part) };
  }
  return part;
}

function validReplayCaller(caller) {
  if (caller === undefined) return true;
  if (!plainObject(caller)) return false;
  if (caller.type === 'direct') return Object.keys(caller).every((key) => key === 'type');
  return caller.type === 'program' && typeof caller.caller_id === 'string' && Object.keys(caller).every((key) => ['type', 'caller_id'].includes(key));
}

function normalizeResponseMessage(item) {
  const allowed = ['type', 'id', 'role', 'content', 'name', 'tool_call_id', 'status', 'metadata', 'internal_chat_message_metadata_passthrough'];
  const dropped = ['phase'];
  if (Object.keys(item).some((key) => !allowed.includes(key) && !dropped.includes(key))) invalid('message input item shape is not translatable', 'input');
  const role = item.role ?? 'user';
  if (!['system', 'user', 'assistant', 'developer', 'tool'].includes(role)) invalid('message input items require role and content', 'input');
  const normalizedRole = role === 'system' ? 'developer' : role;
  const message = Object.fromEntries(Object.entries(item).filter(([key]) => allowed.includes(key)));
  if (typeof item.content === 'string') return { ...message, type: 'message', role: normalizedRole, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: item.content }] };
  if (!Array.isArray(item.content) || !item.content.length) invalid('message content shape is not translatable', 'input');
  const content = item.content.map((part) => normalizeResponseContentPart(part, role)).filter(Boolean);
  if (!content.length) content.push({ type: 'output_text', text: '' });
  return { ...message, type: 'message', role: normalizedRole, content };
}

function normalizeResponseContentPart(part, role) {
  if (typeof part === 'string') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part };
  if (!plainObject(part)) invalid('message content part is not translatable', 'input');
  if (role === 'assistant') {
    if (part.type === 'output_text' && typeof part.text === 'string' && Object.keys(part).every((key) => ['type', 'text', 'annotations'].includes(key))) {
      if (part.annotations !== undefined) validateUrlCitations(part.annotations);
      return { type: 'output_text', text: part.text, ...(part.annotations !== undefined ? { annotations: part.annotations } : {}) };
    }
    if (part.type === 'text' && typeof part.text === 'string' && part.annotations === undefined && Object.keys(part).every((key) => ['type', 'text'].includes(key))) return { type: 'output_text', text: part.text };
    if (part.type === 'thinking' && typeof part.thinking === 'string') return null;
    invalid('message content part is not translatable', 'input');
  }
  if (['system', 'developer'].includes(role) && !['text', 'input_text'].includes(part.type)) invalid('message content part is not translatable', 'input');
  if (['text', 'input_text'].includes(part.type) && typeof part.text === 'string' && Object.keys(part).every((key) => ['type', 'text', 'prompt_cache_breakpoint'].includes(key))) return { type: 'input_text', text: part.text, ...breakpoint(part) };
  if (part.type === 'input_image' && typeof part.image_url === 'string' && Object.keys(part).every((key) => ['type', 'image_url', 'detail', 'prompt_cache_breakpoint'].includes(key))) return { ...part, ...breakpoint(part) };
  if (part.type === 'input_image' && cleanString(part.file_id) && Object.keys(part).every((key) => ['type', 'file_id', 'detail', 'prompt_cache_breakpoint'].includes(key))) return { ...part, ...breakpoint(part) };
  if (part.type === 'input_file' && cleanString(part.file_id) && Object.keys(part).every((key) => ['type', 'file_id', 'prompt_cache_breakpoint'].includes(key))) return { ...part, ...breakpoint(part) };
  if (part.type === 'input_file' && cleanString(part.file_url) && Object.keys(part).every((key) => ['type', 'file_url', 'prompt_cache_breakpoint'].includes(key))) return { ...part, ...breakpoint(part) };
  if (part.type === 'input_file' && cleanString(part.filename) && typeof part.file_data === 'string' && Object.keys(part).every((key) => ['type', 'filename', 'file_data', 'prompt_cache_breakpoint'].includes(key))) return { ...part, ...breakpoint(part) };
  if (part.type === 'input_audio') return normalizeAudioPart(part);
  invalid('message content part is not translatable', 'input');
}

function validateUrlCitations(annotations) {
  if (!Array.isArray(annotations)) invalid('input item shape is not translatable', 'input');
  for (const annotation of annotations) {
    if (!plainObject(annotation)) invalid('input item shape is not translatable', 'input');
    exactKeys(annotation, ['type', 'start_index', 'end_index', 'url', 'title'], 'input');
    if (annotation.type !== 'url_citation'
      || typeof annotation.start_index !== 'number' || !Number.isFinite(annotation.start_index)
      || typeof annotation.end_index !== 'number' || !Number.isFinite(annotation.end_index)
      || typeof annotation.url !== 'string' || typeof annotation.title !== 'string') {
      invalid('input item shape is not translatable', 'input');
    }
  }
}

function rejectReservedMetadata(input) {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (plainObject(item?.internal_chat_message_metadata_passthrough) && Object.hasOwn(item.internal_chat_message_metadata_passthrough, 'executed_tool_calls')) invalid('executed_tool_calls is reserved', 'input');
  }
}

function liftInstructions(input) {
  const kept = [];
  const texts = [];
  for (const item of input) {
    if (item.type !== 'message' || !['system', 'developer'].includes(item.role)) {
      kept.push(item);
      continue;
    }
    const residual = [];
    for (const part of item.content) {
      if (!part.prompt_cache_breakpoint && ['text', 'input_text'].includes(part.type) && typeof part.text === 'string') {
        const text = cleanString(part.text);
        if (text) texts.push(text);
      } else residual.push(part);
    }
    if (residual.length) kept.push({ ...item, role: 'developer', content: residual });
  }
  return { input: kept, texts };
}

function repairReplayCallIds(input) {
  const result = structuredClone(input);
  for (let i = 0; i + 1 < result.length; i += 1) {
    const call = result[i];
    const output = result[i + 1];
    if (call?.type === 'function_call' && output?.type === 'function_call_output' && !cleanString(output.call_id)) {
      const callId = cleanString(call.call_id) || cleanString(call.id);
      if (callId && cleanString(call.name) && typeof call.arguments === 'string' && (Object.hasOwn(output, 'output') || Object.hasOwn(output, 'result'))) {
        call.call_id = callId;
        output.call_id = callId;
        i += 1;
      }
    }
  }
  return result;
}

function lowerAndValidateTools(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) invalid('tools must be an array', 'tools');
  return tools.map((tool) => validateTool(lowerTool(tool)));
}

export function lowerNonStrictFunctionTools(tools) {
  return Array.isArray(tools) ? tools.map(lowerTool) : tools;
}

function lowerTool(tool) {
  if (!plainObject(tool)) return tool;
  if (tool.type === 'namespace' && Array.isArray(tool.tools)) return { ...tool, tools: tool.tools.map(lowerTool) };
  if (tool.type === 'function' && tool.strict !== true && (plainObject(tool.parameters) || typeof tool.parameters === 'boolean')) return { ...tool, parameters: lowerSchema(tool.parameters, true) };
  return tool;
}

function lowerSchema(schema, root = false) {
  if (typeof schema === 'boolean') return root ? { type: 'object', properties: {} } : {};
  if (!plainObject(schema)) return {};
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string' || key === 'description' && typeof value === 'string' || key === 'enum' && Array.isArray(value) || key === 'required' && Array.isArray(value) && value.every((v) => typeof v === 'string') || key === 'additionalProperties' && typeof value === 'boolean') out[key] = value;
    else if (key === 'type' && (typeof value === 'string' && value || Array.isArray(value) && value.length && value.every((v) => typeof v === 'string' && v))) out[key] = value;
    else if (key === 'properties' && plainObject(value)) out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, lowerSchema(child)]));
    else if (key === 'items' && (plainObject(value) || typeof value === 'boolean')) out.items = lowerSchema(value);
    else if (key === 'items' && Array.isArray(value)) out.items = value.map((child) => lowerSchema(child));
    else if (key === 'additionalProperties' && plainObject(value)) out.additionalProperties = lowerSchema(value);
    else if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(value)) out[key] = value.map((child) => lowerSchema(child));
    else if (['$defs', 'definitions'].includes(key) && plainObject(value)) out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, lowerSchema(child)]));
    else if (key === 'const') out.enum = [value];
  }
  if (!out.$ref && out.type === undefined) {
    if (out.properties !== undefined || out.required !== undefined || out.additionalProperties !== undefined) out.type = 'object';
    else if (out.items !== undefined) out.type = 'array';
  }
  if ((out.type === 'object' || Array.isArray(out.type) && out.type.includes('object')) && out.properties === undefined) out.properties = {};
  if ((out.type === 'array' || Array.isArray(out.type) && out.type.includes('array')) && out.items === undefined) out.items = {};
  if (root && !out.$ref) {
    if (out.type === undefined) out.type = 'object';
    if (out.type === 'object' && out.properties === undefined) out.properties = {};
  }
  return out;
}

function validateTool(tool) {
  if (!plainObject(tool)) invalid('tool shape is not translatable', 'tools');
  if (tool.type === 'function') {
    exactKeys(tool, ['type', 'name', 'description', 'parameters', 'strict', 'defer_loading', 'allowed_callers', 'output_schema'], 'tools');
    if (!cleanString(tool.name) || !plainObject(tool.parameters)) invalid('function tool requires flat name and parameters', 'tools');
    if (tool.strict === null) {
      delete tool.strict;
    } else {
      optionalBoolean(tool, 'strict', 'tools');
    }
    optionalBoolean(tool, 'defer_loading', 'tools');
    validateAllowedCallers(tool.allowed_callers);
    if (tool.output_schema !== undefined && !plainObject(tool.output_schema)) invalid('tool shape is not translatable', 'tools');
    return tool;
  }
  if (tool.type === 'namespace') {
    exactKeys(tool, ['type', 'name', 'description', 'tools'], 'tools');
    if (!cleanString(tool.name) || !cleanString(tool.description) || !Array.isArray(tool.tools) || !tool.tools.length) invalid('namespace tool requires function or custom tools', 'tools');
    if (tool.tools.some((child) => !['function', 'custom'].includes(child?.type))) invalid('namespace tool requires function or custom tools', 'tools');
    tool.tools.forEach(validateTool);
    return tool;
  }
  if (tool.type === 'custom') {
    exactKeys(tool, ['type', 'name', 'description', 'format', 'defer_loading', 'allowed_callers'], 'tools');
    if (!cleanString(tool.name)) invalid('custom tool requires a non-empty name', 'tools');
    if (tool.description !== undefined && typeof tool.description !== 'string') invalid('tool shape is not translatable', 'tools');
    optionalBoolean(tool, 'defer_loading', 'tools');
    validateAllowedCallers(tool.allowed_callers);
    if (tool.format !== undefined) validateCustomFormat(tool.format);
    return tool;
  }
  if (tool.type === 'mcp') invalid('remote MCP tools are not supported', 'tools');
  if (tool.type === 'shell') invalid('hosted shell tools are not supported', 'tools');
  if (['programmatic_tool_calling', 'web_search_preview'].includes(tool.type)) {
    exactKeys(tool, ['type'], 'tools');
    return tool;
  }
  if (tool.type === 'image_generation') return tool;
  if (tool.type === 'web_search') return validateWebSearch(tool);
  if (tool.type === 'tool_search') {
    exactKeys(tool, ['type', 'execution', 'description', 'parameters'], 'tools');
    if (!cleanString(tool.execution) || !cleanString(tool.description) || !plainObject(tool.parameters)) invalid('tool_search tool requires execution, description, and parameters', 'tools');
    return tool;
  }
  // Any other native tool declaration (remote MCP is already rejected above) is
  // forwarded untranslated instead of hand-listing every current and future Codex
  // built-in tool type here.
  if (cleanString(tool.type)) return tool;
  invalid('tool shape is not translatable', 'tools');
}

const ALLOWED_TOOLS_BUILTIN_TYPES = ['programmatic_tool_calling', 'web_search_preview', 'web_search', 'image_generation'];

function isAllowedToolDeclared(allowedTool, tools) {
  if (!plainObject(allowedTool) || !Array.isArray(tools)) return false;
  if (['function', 'custom'].includes(allowedTool.type)) {
    if (Object.keys(allowedTool).length !== 2 || !cleanString(allowedTool.name)) return false;
    return tools.some((t) => t?.type === allowedTool.type && t?.name === allowedTool.name && t?.defer_loading !== true);
  }
  if (ALLOWED_TOOLS_BUILTIN_TYPES.includes(allowedTool.type)) {
    if (Object.keys(allowedTool).length !== 1) return false;
    return tools.some((t) => t?.type === allowedTool.type);
  }
  return false;
}

function validateToolChoice(payload) {
  const choice = payload.tool_choice;
  if (choice === undefined || ['auto', 'none', 'required'].includes(choice)) return;
  if (!plainObject(choice)) invalid('tool_choice shape is not translatable', 'tool_choice');
  if (choice.type === 'allowed_tools') {
    exactKeys(choice, ['type', 'mode', 'tools'], 'tool_choice');
    if (!['auto', 'required'].includes(choice.mode)) invalid('tool_choice shape is not translatable', 'tool_choice');
    if (!Array.isArray(choice.tools) || choice.tools.length === 0) invalid('tool_choice shape is not translatable', 'tool_choice');
    if (!choice.tools.every((tool) => isAllowedToolDeclared(tool, payload.tools))) {
      invalid('tool_choice shape is not translatable', 'tool_choice');
    }
    return;
  }
  if (['image_generation', 'programmatic_tool_calling'].includes(choice.type)) {
    exactKeys(choice, ['type'], 'tool_choice');
    return;
  }
  if (['function', 'custom'].includes(choice.type)) {
    exactKeys(choice, ['type', 'name'], 'tool_choice');
    const name = cleanString(choice.name);
    if (!name) invalid(`tool_choice ${choice.type} requires a non-empty name`, 'tool_choice');
    const names = toolNames(payload.tools, choice.type);
    if (!names.includes(name)) invalid(`tool_choice references unknown ${choice.type} tool`, 'tool_choice');
    return;
  }
  if (cleanString(choice.type)) return;
  invalid('tool_choice shape is not translatable', 'tool_choice');
}

function toolNames(tools, type) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => tool?.type === type ? [tool.name] : tool?.type === 'namespace' ? toolNames(tool.tools, type) : []);
}

// Maps a custom tool's name to its declared namespace, so a public `custom_tool_call`
// output missing that field can be restored. Skips ambiguous names (same name used
// more than once, whether flat or inside another namespace).
export function customToolNamespaces(tools) {
  if (!Array.isArray(tools)) return {};
  const counts = new Map();
  const namespaceOf = new Map();
  const seen = (name) => counts.set(name, (counts.get(name) || 0) + 1);
  for (const tool of tools) {
    if (tool?.type === 'custom' && typeof tool.name === 'string') seen(tool.name);
    if (tool?.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const child of tool.tools) {
        if (child?.type === 'custom' && typeof child.name === 'string') {
          seen(child.name);
          namespaceOf.set(child.name, tool.name);
        }
      }
    }
  }
  return Object.fromEntries([...namespaceOf].filter(([name]) => counts.get(name) === 1));
}

function validateText(text) {
  if (text === undefined) return;
  if (!plainObject(text)) invalid('text must be an object', 'text');
  if (text.verbosity !== undefined && (typeof text.verbosity !== 'string' || !['low', 'medium', 'high'].includes(text.verbosity.trim().toLowerCase()))) invalid('verbosity is not supported', 'text.verbosity');
  if (text.format !== undefined) {
    if (!plainObject(text.format) || !cleanString(text.format.type)) invalid('text format is not supported', 'text.format');
    if (text.format.type === 'json_schema' && !plainObject(text.format.schema)) invalid('text format json_schema must include a schema object', 'text.format.schema');
  }
}

function validateStrictTargets(payload) {
  if (payload.text?.format?.type === 'json_schema' && payload.text.format.strict === true) validateStrictSchema(payload.text.format.schema, 'text.format.schema');
  for (const [index, tool] of (payload.tools || []).entries()) validateStrictTool(tool, `tools.${index}`);
}

function validateStrictTool(tool, path) {
  if (tool.type === 'function' && tool.strict === true) {
    try { validateStrictSchema(tool.parameters, `${path}.parameters`); }
    catch (error) {
      if (error instanceof AdapterError) {
        error.code = 'invalid_function_parameters';
        error.message = `Invalid schema for function '${tool.name}': ${error.message.replace(/^strict json_schema /, '')}`;
      }
      throw error;
    }
  }
  if (tool.type === 'namespace') tool.tools.forEach((child, index) => validateStrictTool(child, `${path}.tools.${index}`));
}

function validateStrictSchema(schema, param, root = schema, refs = new Set()) {
  if (!plainObject(schema)) invalid('strict json_schema schema must be an object', param, 'invalid_json_schema');
  if (schema === root) {
    if (Object.hasOwn(schema, '$ref')) invalid('strict json_schema root schema must not contain $ref', param, 'invalid_json_schema');
    if (schema.type !== 'object') invalid('strict json_schema root schema must have type object', param, 'invalid_json_schema');
    if (Object.hasOwn(schema, 'anyOf')) invalid('strict json_schema root schema must not contain anyOf', param, 'invalid_json_schema');
  }
  if (schema !== root && schema.type === undefined) {
    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) schema.type = 'object';
    else if (schema.items !== undefined) schema.type = 'array';
  }
  if (Object.hasOwn(schema, '$ref')) {
    if (Object.keys(schema).some((key) => key !== '$ref')) invalid('strict json_schema $ref schema nodes must contain only $ref', param, 'invalid_json_schema');
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) invalid('strict json_schema $ref must be a local JSON Pointer fragment', `${param}.$ref`, 'invalid_json_schema');
    const tokens = schema.$ref.slice(2).split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!['$defs', 'definitions'].includes(tokens[0]) || !tokens[1]) invalid('strict json_schema $ref must point into $defs or definitions', `${param}.$ref`, 'invalid_json_schema');
    if (refs.has(schema.$ref)) return;
    let target = root;
    for (const token of tokens) target = plainObject(target) && Object.hasOwn(target, token) ? target[token] : undefined;
    if (!plainObject(target)) invalid('strict json_schema $ref target could not be resolved', `${param}.$ref`, 'invalid_json_schema');
    return validateStrictSchema(target, param, root, new Set([...refs, schema.$ref]));
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length || types.some((type) => typeof type !== 'string' || !type)) invalid('strict json_schema type must be a string or a non-empty array of strings', `${param}.type`, 'invalid_json_schema');
  const objectSchema = types.includes('object') || schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined;
  if (objectSchema) {
    if (schema.additionalProperties !== false) invalid('strict json_schema object schemas must set additionalProperties to false', param, 'invalid_json_schema');
    if (schema.properties !== undefined && !plainObject(schema.properties)) invalid('strict json_schema properties must be an object', `${param}.properties`, 'invalid_json_schema');
    const properties = schema.properties || {};
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string')) invalid('strict json_schema required must be an array of property names', `${param}.required`, 'invalid_json_schema');
    const propertyNames = Object.keys(properties).sort();
    const required = [...schema.required].sort();
    if (propertyNames.join('\0') !== required.join('\0')) invalid('strict json_schema object schemas must list every property in required', `${param}.required`, 'invalid_json_schema');
    for (const [name, child] of Object.entries(properties)) validateStrictSchema(child, `${param}.properties.${name}`, root, refs);
  }
  for (const key of ['$defs', 'definitions']) {
    if (schema[key] !== undefined) {
      if (!plainObject(schema[key])) invalid('strict json_schema definitions must be an object', `${param}.${key}`, 'invalid_json_schema');
      for (const [name, child] of Object.entries(schema[key])) validateStrictSchema(child, `${param}.${key}.${name}`, root, refs);
    }
  }
  if (schema.items !== undefined) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const [index, child] of items.entries()) validateStrictSchema(child, `${param}.items${items.length > 1 ? `.${index}` : ''}`, root, refs);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key])) invalid(`strict json_schema ${key} must be an array of schemas`, `${param}.${key}`, 'invalid_json_schema');
      schema[key].forEach((child, index) => validateStrictSchema(child, `${param}.${key}.${index}`, root, refs));
    }
  }
}

function validateHostedShellItem(item) {
  const invalidItem = () => invalid('input item shape is not translatable', 'input');
  if (item.type === 'shell_call') {
    if (!exactObjectKeys(item, ['type', 'call_id', 'action', 'id', 'caller', 'status', 'environment'])
      || !boundedIdentifier(item.call_id)
      || !validShellAction(item.action)
      || !optionalNullable(item, 'id', (value) => typeof value === 'string')
      || !validShellCaller(item.caller)
      || !validShellStatus(item.status)
      || !validShellEnvironment(item.environment)) invalidItem();
    return;
  }
  if (!exactObjectKeys(item, ['type', 'call_id', 'output', 'id', 'caller', 'status', 'max_output_length'])
    || !boundedIdentifier(item.call_id)
    || !Array.isArray(item.output)
    || item.output.some((chunk) => !validShellOutputChunk(chunk))
    || !optionalNullable(item, 'id', (value) => typeof value === 'string')
    || !validShellCaller(item.caller)
    || !validShellStatus(item.status)
    || !optionalNullable(item, 'max_output_length', Number.isInteger)) invalidItem();
}

function validShellAction(action) {
  return exactObjectKeys(action, ['commands', 'timeout_ms', 'max_output_length'])
    && Array.isArray(action.commands)
    && action.commands.every((command) => typeof command === 'string')
    && optionalNullable(action, 'timeout_ms', Number.isInteger)
    && optionalNullable(action, 'max_output_length', Number.isInteger);
}

function validShellCaller(caller) {
  if (caller === undefined || caller === null) return true;
  if (caller?.type === 'direct') return exactObjectKeys(caller, ['type']);
  return caller?.type === 'program'
    && exactObjectKeys(caller, ['type', 'caller_id'])
    && boundedIdentifier(caller.caller_id);
}

function validShellStatus(status) {
  return status === undefined || status === null || ['in_progress', 'completed', 'incomplete'].includes(status);
}

function validShellEnvironment(environment) {
  if (environment === undefined || environment === null) return true;
  if (environment?.type === 'container_reference') {
    return exactObjectKeys(environment, ['type', 'container_id']) && typeof environment.container_id === 'string';
  }
  if (environment?.type !== 'local' || !exactObjectKeys(environment, ['type', 'skills'])) return false;
  if (environment.skills === undefined) return true;
  return Array.isArray(environment.skills)
    && environment.skills.length <= 200
    && environment.skills.every((skill) => exactObjectKeys(skill, ['name', 'description', 'path'])
      && [skill.name, skill.description, skill.path].every((value) => typeof value === 'string'));
}

function validShellOutputChunk(chunk) {
  return exactObjectKeys(chunk, ['stdout', 'stderr', 'outcome'])
    && typeof chunk.stdout === 'string'
    && typeof chunk.stderr === 'string'
    && codepointLength(chunk.stdout) <= 10_485_760
    && codepointLength(chunk.stderr) <= 10_485_760
    && (chunk.outcome?.type === 'timeout' && exactObjectKeys(chunk.outcome, ['type'])
      || chunk.outcome?.type === 'exit' && exactObjectKeys(chunk.outcome, ['type', 'exit_code']) && Number.isInteger(chunk.outcome.exit_code));
}

function exactObjectKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function optionalNullable(object, key, predicate) {
  return !Object.hasOwn(object, key) || object[key] === null || predicate(object[key]);
}

function boundedIdentifier(value) {
  const length = typeof value === 'string' ? codepointLength(value, 64) : 0;
  return length >= 1 && length <= 64;
}

function codepointLength(value, maximum = Infinity) {
  let count = 0;
  for (const _codepoint of value) {
    count += 1;
    if (count > maximum) break;
  }
  return count;
}

function validateMedia(value) {
  if (Array.isArray(value)) return value.forEach(validateMedia);
  if (!plainObject(value)) return;
  if (value.type === 'input_image') {
    if (value.file_id !== undefined && !cleanString(value.file_id)) mediaError('unsupported_input_image_format', 'Responses input_image values must use https image URLs or supported image data URLs, or nonblank file_id references; Codex sediment:// references are unsupported');
    if (typeof value.image_url === 'string' && !validImageReference(value.image_url)) mediaError('unsupported_input_image_format', 'Responses input_image values must use https image URLs or supported image data URLs, or nonblank file_id references; Codex sediment:// references are unsupported');
  }
  if (value.type === 'input_file' && typeof value.file_data === 'string' && !validDataUrl(value.file_data, FILE_MIMES)) mediaError('unsupported_input_file_format', 'Responses input_file file_data values must use supported PDF or text data URLs');
  for (const child of Object.values(value)) validateMedia(child);
}

function normalizeAudioPart(part) {
  const input = part.input_audio;
  if (!plainObject(input) || typeof input.data !== 'string' || !Object.hasOwn(AUDIO_MIMES, input.format) || Object.keys(part).some((key) => !['type', 'input_audio'].includes(key)) || Object.keys(input).some((key) => !['data', 'format'].includes(key))) invalid('message content part is not translatable', 'input');
  const compact = input.data.replace(/[ \t\r\n]/g, '');
  if (compact.length > 69_905_068) invalid('input_audio data must be 50 MiB or smaller', 'input');
  if (!validBase64(compact)) invalid('input_audio data must be base64', 'input');
  const decoded = Buffer.from(compact, 'base64');
  if (!decoded.length) invalid('input_audio data must be base64', 'input');
  if (decoded.length > 52_428_800) invalid('input_audio data must be 50 MiB or smaller', 'input');
  return { type: 'input_audio', audio_url: `data:${AUDIO_MIMES[input.format]};base64,${decoded.toString('base64')}` };
}

function validatePromptCacheOptions(options) {
  if (options === undefined) return;
  if (!plainObject(options)) invalid('prompt_cache_options must be an object', 'prompt_cache_options');
  for (const key of Object.keys(options)) if (!['mode', 'ttl'].includes(key)) invalid('prompt_cache_options field is not supported', `prompt_cache_options.${key}`);
  if (options.mode !== undefined && !['implicit', 'explicit'].includes(options.mode)) invalid('prompt_cache_options mode is not supported', 'prompt_cache_options.mode');
  if (options.ttl !== undefined && options.ttl !== '30m') invalid('prompt_cache_options ttl is not supported', 'prompt_cache_options.ttl');
}

function validateReasoning(reasoning) {
  if (reasoning === undefined) return;
  if (!plainObject(reasoning)) invalid('reasoning must be an object', 'reasoning');
  validateReasoningEffort(reasoning.effort, 'reasoning.effort');
  validateCompatibilityToken(reasoning.summary, 'reasoning summary is not supported', 'reasoning.summary');
  validateCompatibilityToken(reasoning.context, 'reasoning context is not supported', 'reasoning.context');
}

function validateReasoningEffort(value, param) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(value.trim()) || /__|--|_-|-_/.test(value.trim())) invalid('reasoning effort is not supported', param);
}

function validateModeration(moderation) {
  if (moderation === undefined) return;
  if (!plainObject(moderation)) invalid('moderation must be an object', 'moderation');
  exactKeys(moderation, ['model'], 'moderation');
  if (!cleanString(moderation.model)) invalid('moderation model is required', 'moderation.model');
}

function normalizeServiceTier(payload) {
  if (payload.service_tier === undefined) return;
  validateCompatibilityToken(payload.service_tier, 'service_tier is not supported', 'service_tier');
  const tier = payload.service_tier.trim().toLowerCase() === 'fast' ? 'priority' : payload.service_tier.trim().toLowerCase();
  payload.service_tier = tier;
}

function validateStreamOptions(options, allowedKey) {
  if (options === undefined) return;
  if (!plainObject(options)) invalid('stream_options must be an object', 'stream_options');
  if (options[allowedKey] !== undefined && typeof options[allowedKey] !== 'boolean') invalid(`stream_options.${allowedKey} must be a boolean`, `stream_options.${allowedKey}`);
}

function validatePositiveInteger(payload, field) {
  if (payload[field] !== undefined && (!Number.isInteger(payload[field]) || payload[field] <= 0)) invalid(`${field} must be a positive integer`, field);
}

function validateCompatibilityToken(value, message, param) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.trim())) invalid(message, param);
}

function validateWebSearch(tool) {
  exactKeys(tool, ['type', 'external_web_access', 'index_gated_web_access', 'filters', 'search_content_types'], 'tools');
  optionalBoolean(tool, 'external_web_access', 'tools');
  optionalBoolean(tool, 'index_gated_web_access', 'tools');
  if (tool.index_gated_web_access === false || tool.index_gated_web_access === true && tool.external_web_access === undefined || tool.index_gated_web_access === true && tool.external_web_access === false) invalid('tool shape is not translatable', 'tools');
  if (tool.filters !== undefined) {
    if (!plainObject(tool.filters) || !Object.keys(tool.filters).length) invalid('tool shape is not translatable', 'tools');
    exactKeys(tool.filters, ['allowed_domains', 'blocked_domains'], 'tools');
    for (const value of Object.values(tool.filters)) if (!Array.isArray(value) || !value.length || value.length > 100 || value.some((domain) => !cleanString(domain) || /^https?:\/\//i.test(domain.trim()))) invalid('tool shape is not translatable', 'tools');
  }
  if (tool.search_content_types !== undefined && (!Array.isArray(tool.search_content_types) || !tool.search_content_types.length || tool.search_content_types.some((type) => !cleanString(type)))) invalid('tool shape is not translatable', 'tools');
  return tool;
}

function validateCustomFormat(format) {
  if (!plainObject(format)) invalid('tool shape is not translatable', 'tools');
  if (format.type === 'text') return exactKeys(format, ['type'], 'tools');
  if (format.type === 'grammar' && cleanString(format.definition) && ['lark', 'regex'].includes(format.syntax)) return exactKeys(format, ['type', 'definition', 'syntax'], 'tools');
  if (cleanString(format.type)) return;
  invalid('tool shape is not translatable', 'tools');
}

function validateAllowedCallers(value) {
  if (value !== undefined && (!Array.isArray(value) || value.some((caller) => !['direct', 'programmatic'].includes(caller)))) invalid('tool shape is not translatable', 'tools');
}

function optionalBoolean(object, key, param) {
  if (object[key] !== undefined && typeof object[key] !== 'boolean') invalid('tool shape is not translatable', param);
}

function exactKeys(object, allowed, param) {
  if (Object.keys(object).some((key) => !allowed.includes(key))) invalid(param === 'moderation' ? 'moderation field is not supported' : 'tool shape is not translatable', param);
}

function rejectUnsupportedFields(payload, supported) {
  if (Object.hasOwn(payload, 'logprobs')) unsupported('logprobs');
  for (const field of Object.keys(payload)) if (!supported.has(field)) unsupported(field);
}

function requireModel(payload) {
  if (!cleanString(payload.model)) invalid('model is required', 'model');
}

function validImageReference(value) {
  const reference = value.trim();
  return /^https:\/\//i.test(reference) || validDataUrl(reference, IMAGE_MIMES);
}

function validDataUrl(value, mimes) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(value.trim());
  return Boolean(match && mimes.has(match[1].toLowerCase()) && validBase64(match[2].replace(/[ \t\r\n]/g, '')));
}

function validBase64(value) {
  return value.length >= 4 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function breakpoint(part) {
  if (part.prompt_cache_breakpoint === undefined) return {};
  if (!plainObject(part.prompt_cache_breakpoint) || part.prompt_cache_breakpoint.mode !== 'explicit') invalid('prompt_cache_breakpoint must be an explicit mode object', 'input.prompt_cache_breakpoint');
  const extra = Object.keys(part.prompt_cache_breakpoint).find((key) => key !== 'mode');
  if (extra) invalid('prompt_cache_breakpoint field is not supported', `input.prompt_cache_breakpoint.${extra}`);
  return { prompt_cache_breakpoint: part.prompt_cache_breakpoint };
}

function pick(object, fields) {
  return Object.fromEntries(Object.entries(object).filter(([key, value]) => fields.has(key) && value !== undefined));
}

function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function stripKey(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function unsupported(field) {
  invalid(`Unsupported parameter: ${field}`, field, 'unsupported_parameter');
}

function mediaError(code, message) {
  invalid(message, 'input', code);
}

function invalid(message, param = null, code = 'invalid_request') {
  throw new AdapterError(message, param, code);
}
