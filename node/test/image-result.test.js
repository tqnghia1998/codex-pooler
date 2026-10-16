import test from 'node:test';
import assert from 'node:assert/strict';
import { isEncodedImage } from '../src/image-result.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';

test('validates PNG chunks and CRCs, JPEG boundaries and WebP lengths', () => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 1, 2, 3, 4, 5, 255, 217]);
  const webp = Buffer.alloc(22);
  webp.write('RIFF'); webp.writeUInt32LE(14, 4); webp.write('WEBPVP8 ', 8); webp.writeUInt32LE(2, 16);
  for (const bytes of [Buffer.from(png, 'base64'), jpeg, webp]) {
    assert.equal(isEncodedImage(bytes.toString('base64')), true);
    assert.equal(isEncodedImage(bytes.subarray(0, -1).toString('base64')), false);
  }
  for (const offset of [16, 29, 45, 68]) {
    const corrupt = Buffer.from(png, 'base64');
    corrupt[offset] ^= 1;
    assert.equal(isEncodedImage(corrupt.toString('base64')), false);
  }
  for (const value of [null, 42, '', 'hello', 'https://example.test/image.png', 'data:image/png;base64,' + png,
    png + '\n', Buffer.from('not an image').toString('base64'), Buffer.from(png, 'base64').subarray(0, 33).toString('base64')]) {
    assert.equal(isEncodedImage(value), false);
  }
});
