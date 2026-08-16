import { request } from 'node:http';

const family = process.argv[2];
const baseUrl = process.env.COMPATIBILITY_RELEASE_GATE_URL;
const body = family === 'codex'
  ? { model: 'private-model', input: 'private prompt', stream: true }
  : { model: 'private-model', messages: [{ role: 'user', content: 'private prompt' }], max_tokens: 32, stream: true };
const url = new URL(family === 'codex' ? '/v1/responses' : '/v1/messages', baseUrl);
const req = request(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(JSON.stringify(body)),
    authorization: 'Bearer private-credential',
    'anthropic-version': '2023-06-01'
  }
}, (res) => {
  res.resume();
  res.on('end', () => process.exit(0));
});
req.on('error', () => process.exit(1));
req.end(JSON.stringify(body));
