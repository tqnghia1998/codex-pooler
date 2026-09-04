const CACHE_TTL_MS = 60 * 60_000;
const MAX_ENTRIES = 10_240;
const MAX_TURNS_PER_SESSION = 64;
const MAX_BLOCKS_PER_TURN = 512;
const MAX_BYTES_PER_SESSION = 8 << 20;
const MAX_TOTAL_BYTES = 256 << 20;
const MAX_RESPONSE_BYTES = MAX_BYTES_PER_SESSION + 1024;

const entries = new Map();
let totalBytes = 0;

export function getClaudeThinkingReplay(scope) {
  const key = scopeKey(scope);
  if (!key) return [];
  const entry = entries.get(key);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > CACHE_TTL_MS) {
    deleteEntry(key);
    return [];
  }
  entry.updatedAt = Date.now();
  touchEntry(key, entry);
  return entry.contents.map((content) => structuredClone(content));
}

export function cacheClaudeThinkingReplay(scope, content) {
  const key = scopeKey(scope);
  if (!key) return false;
  if (!replayableContent(content)) {
    clearClaudeThinkingReplay(scope);
    return false;
  }
  const serialized = JSON.stringify(content);
  if (Buffer.byteLength(serialized) > MAX_BYTES_PER_SESSION) return false;
  const now = Date.now();
  let entry = entries.get(key);
  if (!entry || now - entry.updatedAt > CACHE_TTL_MS) {
    if (entry) deleteEntry(key);
    entry = { contents: [], bytes: 0, updatedAt: now };
    entries.set(key, entry);
  }
  if (!entry.contents.some((candidate) => jsonEqual(candidate, content))) {
    entry.contents.push(structuredClone(content));
    entry.bytes += Buffer.byteLength(serialized);
    totalBytes += Buffer.byteLength(serialized);
  }
  entry.updatedAt = now;
  touchEntry(key, entry);
  while (entry.contents.length > MAX_TURNS_PER_SESSION || entry.bytes > MAX_BYTES_PER_SESSION) {
    const removed = entry.contents.shift();
    const bytes = Buffer.byteLength(JSON.stringify(removed));
    entry.bytes -= bytes;
    totalBytes -= bytes;
  }
  enforceLimits();
  return true;
}

export function clearClaudeThinkingReplay(scope) {
  const key = scopeKey(scope);
  if (key) deleteEntry(key);
}

export function restoreClaudeThinkingReplay(body, cachedContents) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) {
    return { body, restored: false };
  }
  let updated = structuredClone(body);
  let restored = false;
  for (const cached of Array.isArray(cachedContents) ? cachedContents : []) {
    const cachedParts = nonThinkingParts(cached);
    if (!cachedParts) continue;
    for (let index = updated.messages.length - 1; index >= 0; index -= 1) {
      const message = updated.messages[index];
      if (!message || String(message.role || '').trim().toLowerCase() !== 'assistant') continue;
      const currentContent = message.content;
      if (hasThinking(currentContent)) continue;
      const currentParts = nonThinkingParts(currentContent);
      if (!currentParts || !jsonEqual(currentParts, cachedParts)) continue;
      message.content = structuredClone(cached);
      restored = true;
      break;
    }
  }
  return { body: restored ? updated : body, restored };
}

export async function captureClaudeThinkingReplayResponse(scope, response) {
  if (!scope || !response) return false;
  try {
    const clone = response.clone();
    const bytes = await readBounded(clone);
    const content = claudeResponseContent(bytes);
    if (content) return cacheClaudeThinkingReplay(scope, content);
    if (scope.replayApplied) clearClaudeThinkingReplay(scope);
  } catch {
    if (scope.replayApplied) clearClaudeThinkingReplay(scope);
  }
  return false;
}

function scopeKey(scope) {
  return typeof scope === 'string' ? scope.trim() : String(scope?.key || '').trim();
}

function deleteEntry(key) {
  const entry = entries.get(key);
  if (!entry) return;
  totalBytes -= entry.bytes;
  entries.delete(key);
}

function touchEntry(key, entry) {
  entries.delete(key);
  entries.set(key, entry);
}

function enforceLimits() {
  while (entries.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) return;
    deleteEntry(oldestKey);
  }
}

function replayableContent(content) {
  if (!Array.isArray(content) || !content.length || content.length > MAX_BLOCKS_PER_TURN) return false;
  let signedThinking = false;
  let toolUse = false;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'thinking' && typeof part.signature === 'string' && part.signature.trim()) signedThinking = true;
    if (part.type === 'tool_use' && typeof part.id === 'string' && part.id.trim()) toolUse = true;
  }
  return signedThinking && toolUse;
}

function hasThinking(content) {
  return Array.isArray(content) && content.some((part) => part && ['thinking', 'redacted_thinking'].includes(String(part.type || '').trim()));
}

function nonThinkingParts(content) {
  if (!Array.isArray(content)) return null;
  return content.filter((part) => !part || !['thinking', 'redacted_thinking'].includes(String(part.type || '').trim()));
}

function jsonEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readBounded(response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel('Claude replay response exceeded cache limit');
        throw new Error('response too large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function claudeResponseContent(bytes) {
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.content)) return parsed.content;
  } catch {}
  return parseClaudeSseContent(text);
}

function parseClaudeSseContent(text) {
  const blocks = [];
  const finished = new Set();
  let observed = false;
  let complete = false;
  let abandoned = false;
  let event = '';
  let data = [];
  const flush = () => {
    if (!data.length) {
      event = '';
      return;
    }
    let parsed;
    try { parsed = JSON.parse(data.join('\n')); } catch { abandoned = true; data = []; event = ''; return; }
    const type = String(parsed.type || event || '');
    if (type === 'message_start') {
      observed = true;
    } else if (type === 'content_block_start' && Number.isInteger(parsed.index) && parsed.content_block && typeof parsed.content_block === 'object') {
      if (blocks[parsed.index] || blocks.length >= MAX_BLOCKS_PER_TURN) abandoned = true;
      blocks[parsed.index] = structuredClone(parsed.content_block);
    } else if (type === 'content_block_delta' && Number.isInteger(parsed.index) && parsed.delta && blocks[parsed.index]) {
      if (!applyDelta(blocks[parsed.index], parsed.delta)) abandoned = true;
    } else if (type === 'content_block_stop' && Number.isInteger(parsed.index) && blocks[parsed.index]) {
      finished.add(parsed.index);
    } else if (type === 'message_stop') {
      complete = true;
    } else if (type === 'error') {
      abandoned = true;
    }
    data = [];
    event = '';
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      flush();
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart());
    }
  }
  flush();
  if (!observed || !complete || abandoned || !blocks.length || !blocks.every(Boolean) || finished.size !== blocks.length) return null;
  return blocks.map((block) => {
    const { __partialInput, ...clean } = block;
    return clean;
  });
}

function applyDelta(block, delta) {
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') block.thinking = `${block.thinking || ''}${delta.thinking}`;
  if (delta.type === 'signature_delta' && typeof delta.signature === 'string') block.signature = `${block.signature || ''}${delta.signature}`;
  if (delta.type === 'text_delta' && typeof delta.text === 'string') block.text = `${block.text || ''}${delta.text}`;
  if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
    block.__partialInput = `${block.__partialInput || ''}${delta.partial_json}`;
    try { block.input = JSON.parse(block.__partialInput); } catch {}
  }
  return ['thinking_delta', 'signature_delta', 'text_delta', 'input_json_delta'].includes(delta.type);
}
