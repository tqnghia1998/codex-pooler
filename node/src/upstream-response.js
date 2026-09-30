import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { Decompress as ZstdDecompress } from 'fzstd';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

// Node fetch normally decodes declared content encodings, but custom fetch
// implementations and misbehaving upstreams can still expose compressed bytes.
// CPA sniffs those bytes before handing JSON/SSE to the Claude executor. Keep
// the same tolerance while leaving ordinary streaming responses untouched.
export async function decodeClaudeResponse(response, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!response?.body) return response;
  const encoding = response.headers.get('content-encoding') || '';
  const { reader, first } = await readFirstChunk(response);
  const prefix = first.done || !first.value ? Buffer.alloc(0) : Buffer.from(first.value).subarray(0, 512);
  if (!shouldDecode(prefix, encoding)) {
    if (first.done) {
      reader.releaseLock();
      return response;
    }
    return rebuildResponse(response, streamFromReader(reader, first));
  }
  const compressed = Buffer.from(await readResponseBody(reader, first, maxBytes));
  const decoded = decodeBytes(compressed, encoding, maxBytes);
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(decoded, { status: response.status, statusText: response.statusText, headers });
}

function rebuildResponse(response, body) {
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function streamFromReader(reader, first) {
  let pending = first;
  return new ReadableStream({
    async pull(controller) {
      if (pending) {
        const chunk = pending;
        pending = null;
        if (!chunk.done && chunk.value) controller.enqueue(chunk.value);
        if (chunk.done) controller.close();
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else if (next.value) controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    }
  });
}

async function readFirstChunk(response) {
  const reader = response.body.getReader();
  try {
    return { reader, first: await reader.read() };
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
}

function shouldDecode(prefix, encoding) {
  if (!prefix.length) return false;
  const normalized = encoding.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (normalized.length) return !looksPlain(prefix);
  return isGzip(prefix) || isZstd(prefix);
}

function looksPlain(bytes) {
  let index = 0;
  while (index < bytes.length && (bytes[index] === 9 || bytes[index] === 10 || bytes[index] === 13 || bytes[index] === 32)) index += 1;
  return [0x7b, 0x5b, 0x22, 0x64, 0x65, 0x3c].includes(bytes[index]);
}

function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isZstd(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
}

async function readResponseBody(reader, first, maxBytes) {
  const chunks = [];
  let size = 0;
  try {
    if (!first.done && first.value) {
      size = first.value.byteLength;
      if (size > maxBytes) throw Object.assign(new Error('Compressed upstream response is too large'), { statusCode: 502 });
      chunks.push(Buffer.from(first.value));
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) throw Object.assign(new Error('Compressed upstream response is too large'), { statusCode: 502 });
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

function decodeBytes(input, encoding, maxBytes) {
  let decoded = input;
  const encodings = encoding.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!encodings.length) encodings.push(isGzip(decoded) ? 'gzip' : 'zstd');
  for (let index = encodings.length - 1; index >= 0; index -= 1) {
    const name = encodings[index];
    try {
      decoded = name === 'gzip' ? gunzipSync(decoded, { maxOutputLength: maxBytes })
        : name === 'deflate' ? inflateDeflate(decoded, maxBytes)
          : name === 'br' ? brotliDecompressSync(decoded, { maxOutputLength: maxBytes })
              : name === 'zstd' ? decompressZstd(decoded)
                : name === 'compress' ? decompressUnixCompress(decoded, maxBytes)
                : name === 'identity' ? decoded
                : (() => { throw new Error(`unsupported content encoding ${name}`); })();
    } catch (error) {
      throw Object.assign(new Error(`Unable to decode Claude response (${name})`), { statusCode: 502, cause: error });
    }
    if (decoded.length > maxBytes) throw Object.assign(new Error('Decoded upstream response is too large'), { statusCode: 502 });
  }
  return decoded;
}

function inflateDeflate(input, maxBytes) {
  try {
    return inflateSync(input, { maxOutputLength: maxBytes });
  } catch {
    return inflateRawSync(input, { maxOutputLength: maxBytes });
  }
}

function decompressZstd(input, maxBytes) {
  const chunks = [];
  let size = 0;
  const decoder = new ZstdDecompress((chunk) => {
    const value = Buffer.from(chunk);
    if (size + value.length > maxBytes) throw new Error('Decoded upstream response is too large');
    chunks.push(value);
    size += value.length;
  });
  decoder.push(input, true);
  return Buffer.concat(chunks, size);
}

// Go's compress/lzw reader, which CPA uses for Content-Encoding: compress,
// reads the traditional Unix .Z container: a two-byte magic prefix followed
// by variable-width LZW codes. CPA uses MSB-first codes; accepting the common
// LSB-first Unix variant too keeps this boundary tolerant of older HTTP
// intermediaries without changing the normal Claude path.
function decompressUnixCompress(input, maxBytes) {
  const msb = readUnixCompressBits(input, 24, 9, true) === (1 << 8);
  return decodeUnixCompress(input, maxBytes, msb, 1 << 8, msb ? (1 << 8) + 2 : (1 << 8) + 1);
}

function decodeUnixCompress(input, maxBytes, msb, clearCode = 1 << 8, firstCode = clearCode + 1) {
  if (input.length < 3 || input[0] !== 0x1f || input[1] !== 0x9d) {
    throw new Error('invalid Unix compress header');
  }
  const flags = input[2];
  const maxBits = flags & 0x1f;
  const blockMode = (flags & 0x80) !== 0;
  if (maxBits < 9 || maxBits > 16 || (flags & 0x60) !== 0) {
    throw new Error('invalid Unix compress flags');
  }

  const prefix = new Int32Array(1 << maxBits);
  const suffix = new Uint8Array(1 << maxBits);
  let bitOffset = 24;
  let codeBits = 9;
  let nextCode = firstCode;
  let previousCode = -1;
  let finalByte = 0;
  const output = [];
  let outputSize = 0;

  const readCode = () => {
    if (bitOffset + codeBits > input.length * 8) return null;
    let value = 0;
    for (let index = 0; index < codeBits; index += 1) {
      const absoluteBit = bitOffset + index;
      const bit = msb
        ? (input[absoluteBit >> 3] >> (7 - (absoluteBit & 7))) & 1
        : (input[absoluteBit >> 3] >> (absoluteBit & 7)) & 1;
      value = msb ? (value << 1) | bit : value | (bit << index);
    }
    bitOffset += codeBits;
    return value;
  };

  const emitString = (code, reversed) => {
    let length = 0;
    let current = code;
    while (current >= clearCode) {
      if (current >= nextCode || length >= (1 << maxBits)) throw new Error('invalid Unix compress code');
      if (length >= maxBytes) throw new Error('Decoded upstream response is too large');
      reversed[length++] = suffix[current];
      current = prefix[current];
    }
    if (current < 0 || current >= clearCode) throw new Error('invalid Unix compress literal');
    if (length >= maxBytes) throw new Error('Decoded upstream response is too large');
    reversed[length++] = current;
    return { length, first: current };
  };

  while (true) {
    const code = readCode();
    if (code === null) break;
    // Go's lzw.Writer (used to produce CPA-compatible MSB streams) reserves
    // clear+1 as an explicit EOF code. Traditional Unix .Z streams do not.
    if (msb && code === clearCode + 1) break;
    if (blockMode && code === clearCode) {
      codeBits = 9;
      nextCode = firstCode;
      previousCode = -1;
      continue;
    }
    if (previousCode < 0) {
      if (code >= clearCode) throw new Error('invalid Unix compress first code');
      output.push(code);
      outputSize += 1;
      if (outputSize > maxBytes) throw new Error('Decoded upstream response is too large');
      finalByte = code;
      previousCode = code;
      continue;
    }

    const reversed = new Uint8Array(1 << maxBits);
    let decoded;
    if (code < nextCode) {
      decoded = emitString(code, reversed);
    } else if (code === nextCode) {
      decoded = emitString(previousCode, reversed);
      if (decoded.length >= maxBytes) throw new Error('Decoded upstream response is too large');
      reversed[decoded.length++] = finalByte;
    } else {
      throw new Error('invalid Unix compress code');
    }
    for (let index = decoded.length - 1; index >= 0; index -= 1) output.push(reversed[index]);
    outputSize += decoded.length;
    if (outputSize > maxBytes) throw new Error('Decoded upstream response is too large');
    if (nextCode < (1 << maxBits)) {
      prefix[nextCode] = previousCode;
      suffix[nextCode] = decoded.first;
      nextCode += 1;
      if (nextCode >= (1 << codeBits) && codeBits < maxBits) codeBits += 1;
    }
    finalByte = decoded.first;
    previousCode = code;
  }
  return Buffer.from(output);
}

function readUnixCompressBits(input, bitOffset, codeBits, msb) {
  if (bitOffset + codeBits > input.length * 8) return null;
  let value = 0;
  for (let index = 0; index < codeBits; index += 1) {
    const absoluteBit = bitOffset + index;
    const bit = msb
      ? (input[absoluteBit >> 3] >> (7 - (absoluteBit & 7))) & 1
      : (input[absoluteBit >> 3] >> (absoluteBit & 7)) & 1;
    value = msb ? (value << 1) | bit : value | (bit << index);
  }
  return value;
}
