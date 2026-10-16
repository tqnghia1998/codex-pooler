// Match the provider image-result contract without downloading result URLs.
export function isEncodedImage(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return false;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0
      || crc32(bytes.subarray(12, 29)) !== bytes.readUInt32BE(29)) return false;
    let data = false;
    for (let offset = 33; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      const end = offset + size + 12;
      if (end > bytes.length) return false;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
      if (type === 'IEND') return size === 0 && data && end === bytes.length;
      if (type === 'IDAT' && size > 0) data = true;
      offset = end;
    }
    return false;
  }
  if (bytes.length > 11 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  }
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) {
    const size = bytes.readUInt32LE(16);
    return size > 0 && bytes.readUInt32LE(4) === bytes.length - 8 && bytes.length - 20 >= size;
  }
  return false;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
