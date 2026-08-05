import { createGunzip, createInflate } from 'node:zlib';
import { Decompress as ZstdDecompress } from 'fzstd';

export const DEFAULT_INGRESS_LIMITS = Object.freeze({
  maxCompressedBodyBytes: 32 * 1024 * 1024,
  maxDecompressedBodyBytes: 64 * 1024 * 1024,
  maxDecompressionRatio: 200,
  decompressionTimeoutMs: 10_000
});

export class HttpError extends Error {
  constructor(statusCode, code, message, type = 'invalid_request_error') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.type = type;
  }
}

export async function readRequestBody(req, options = {}) {
  const limits = { ...DEFAULT_INGRESS_LIMITS, ...options };
  const encoding = contentEncoding(req);
  if (encoding && !['gzip', 'deflate', 'zstd'].includes(encoding)) rejectRequest(req, new HttpError(415, 'unsupported_content_encoding', 'content encoding is not supported'));
  if (encoding) validateCompressedContentType(req);
  if (limits.decompressionTimeoutMs <= 0) rejectRequest(req, timeoutError());

  const deadline = Date.now() + limits.decompressionTimeoutMs;
  const maxInputBytes = encoding ? limits.maxCompressedBodyBytes : limits.maxDecompressedBodyBytes;
  const bytes = await readBounded(
    req,
    maxInputBytes,
    encoding ? 'compressed_request_too_large' : 'decompressed_request_too_large',
    encoding ? 'compressed request body is too large' : 'request body is too large',
    limits.decompressionTimeoutMs
  );
  if (!encoding) return bytes;

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw timeoutError();
  const decodeLimits = { ...limits, decompressionTimeoutMs: remainingMs };
  return encoding === 'zstd' ? decompressZstd(bytes, decodeLimits) : decompressZlib(bytes, encoding, decodeLimits);
}

function contentEncoding(req) {
  const value = req.headers['content-encoding'];
  if (value === undefined) return '';
  if (typeof value !== 'string') return 'unsupported';
  const encoding = value.trim().toLowerCase();
  return encoding === 'identity' ? '' : encoding;
}

function validateCompressedContentType(req) {
  const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].split(';', 1)[0].trim().toLowerCase() : '';
  if (contentType === 'application/json' || /^application\/[^/]+\+json$/.test(contentType)) return;
  const name = contentType || 'unknown';
  rejectRequest(req, new HttpError(415, 'unsupported_media_type', `compressed ${name} request bodies are not supported`));
}

function rejectRequest(req, error) {
  req.resume();
  throw error;
}

function readBounded(req, maxBytes, code, message, timeoutMs) {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume();
    return Promise.reject(new HttpError(413, code, message));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const timer = timeoutMs === null ? null : setTimeout(() => fail(timeoutError()), timeoutMs);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = (error) => {
      finish(reject, error);
      req.resume();
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) fail(new HttpError(413, code, message));
      else chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks, size));
    const onError = () => fail(new HttpError(400, 'invalid_request', 'request body could not be read'));
    const onAborted = () => onError();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

async function decompressZlib(compressed, encoding, limits) {
  const decoder = encoding === 'gzip' ? createGunzip() : createInflate();
  const chunks = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    decoder.destroy(timeoutError());
  }, limits.decompressionTimeoutMs);
  try {
    decoder.end(compressed);
    for await (const chunk of decoder) {
      size += chunk.length;
      validateOutput(compressed.length, size, limits);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (timedOut) throw timeoutError();
    throw invalidCompressedBodyError();
  } finally {
    clearTimeout(timer);
    decoder.destroy();
  }
}

function decompressZstd(compressed, limits) {
  validateZstdFrames(compressed, limits);
  const chunks = [];
  let size = 0;
  const deadline = Date.now() + limits.decompressionTimeoutMs;
  try {
    const decoder = new ZstdDecompress((chunk) => {
      if (Date.now() >= deadline) throw timeoutError();
      size += chunk.length;
      validateOutput(compressed.length, size, limits);
      chunks.push(Buffer.from(chunk));
    });
    decoder.push(compressed, true);
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidCompressedBodyError();
  }
}

function validateZstdFrames(bytes, limits) {
  let offset = 0;
  while (offset < bytes.length) {
    if (isSkippableZstdFrame(bytes, offset)) {
      if (offset + 8 > bytes.length) throw invalidCompressedBodyError();
      offset += 8 + readUint32(bytes, offset + 4);
      if (offset > bytes.length) throw invalidCompressedBodyError();
    } else {
      offset = validateZstdFrame(bytes, offset, limits);
    }
  }
}

function validateZstdFrame(bytes, offset, limits) {
  if (offset + 6 > bytes.length || bytes[offset] !== 0x28 || bytes[offset + 1] !== 0xb5 || bytes[offset + 2] !== 0x2f || bytes[offset + 3] !== 0xfd) throw invalidCompressedBodyError();
  const descriptor = bytes[offset + 4];
  if (descriptor & 0x08) throw invalidCompressedBodyError();
  const singleSegment = Boolean(descriptor & 0x20);
  const contentSizeFlag = descriptor >> 6;
  const dictionarySize = [0, 1, 2, 4][descriptor & 0x03];
  const contentSizeBytes = contentSizeFlag ? 1 << contentSizeFlag : singleSegment ? 1 : 0;
  const contentSizeOffset = offset + 5 + (singleSegment ? 0 : 1) + dictionarySize;
  if (contentSizeOffset + contentSizeBytes > bytes.length) throw invalidCompressedBodyError();
  const contentSize = readLittleEndian(bytes, contentSizeOffset, contentSizeBytes) + (contentSizeFlag === 1 ? 256n : 0n);
  const windowSize = singleSegment
    ? contentSize
    : BigInt(2 ** (10 + (bytes[offset + 5] >> 3)) + 2 ** (10 + (bytes[offset + 5] >> 3)) / 8 * (bytes[offset + 5] & 7));
  if (windowSize > BigInt(limits.maxDecompressedBodyBytes)) throw new HttpError(413, 'decompressed_request_too_large', 'decompressed request body is too large');

  let cursor = contentSizeOffset + contentSizeBytes;
  while (true) {
    if (cursor + 3 > bytes.length) throw invalidCompressedBodyError();
    const header = bytes[cursor] | bytes[cursor + 1] << 8 | bytes[cursor + 2] << 16;
    const lastBlock = Boolean(header & 1);
    const blockType = header >> 1 & 3;
    const blockSize = header >>> 3;
    if (blockType === 3) throw invalidCompressedBodyError();
    cursor += 3 + (blockType === 1 ? 1 : blockSize);
    if (cursor > bytes.length) throw invalidCompressedBodyError();
    if (lastBlock) break;
  }
  cursor += descriptor & 0x04 ? 4 : 0;
  if (cursor > bytes.length) throw invalidCompressedBodyError();
  return cursor;
}

function isSkippableZstdFrame(bytes, offset) {
  return offset + 4 <= bytes.length && bytes[offset] >= 0x50 && bytes[offset] <= 0x5f && bytes[offset + 1] === 0x2a && bytes[offset + 2] === 0x4d && bytes[offset + 3] === 0x18;
}

function readLittleEndian(bytes, offset, length) {
  let value = 0n;
  for (let index = 0; index < length; index += 1) value += BigInt(bytes[offset + index]) << BigInt(index * 8);
  return value;
}

function readUint32(bytes, offset) {
  return bytes[offset] + bytes[offset + 1] * 2 ** 8 + bytes[offset + 2] * 2 ** 16 + bytes[offset + 3] * 2 ** 24;
}

function validateOutput(compressedBytes, decompressedBytes, limits) {
  if (decompressedBytes > limits.maxDecompressedBodyBytes) {
    throw new HttpError(413, 'decompressed_request_too_large', 'decompressed request body is too large');
  }
  if (decompressedBytes > Math.max(compressedBytes, 1) * limits.maxDecompressionRatio) {
    throw new HttpError(413, 'decompression_ratio_exceeded', 'request body compression ratio is too large');
  }
}

function timeoutError() {
  return new HttpError(408, 'request_decompression_timeout', 'request body decompression timed out');
}

function invalidCompressedBodyError() {
  return new HttpError(400, 'invalid_request', 'compressed request body is invalid');
}
