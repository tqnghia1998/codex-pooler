import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { attachWebSocketProxy } from '../src/proxy.js';

function exchange(port, request) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let response = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('Response waited for an unfinished body')));
    socket.on('data', (data) => { response += data; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

test('rejects duplicate wire Host fields before auth, body parsing or websocket admission', { timeout: 10_000 }, async (t) => {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 1) });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('{}'); };
  const server = createServer(createApp({ store, apiKey: 'host-key', fetchImpl }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'host-key', fetchImpl });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { relay.close(); await new Promise((resolve) => server.close(resolve)); store.sqlite.close(); });
  const port = server.address().port;
  for (const target of ['/v1/responses', 'http://localhost/v1/responses']) {
    for (const framing of ['Content-Length: 999\r\n', 'Transfer-Encoding: chunked\r\n']) {
      const response = await exchange(port, `POST ${target} HTTP/1.1\r\nHost: localhost\r\nhOsT: second.invalid\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\n${framing}\r\n`);
      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.match(response, /Connection: close/i);
      assert.match(response, /Bad Request$/);
    }
    const upgrade = await exchange(port, `GET ${target} HTTP/1.1\r\nHost: localhost\r\nHOST: second.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    assert.match(upgrade, /^HTTP\/1\.1 400 /);
    const single = await exchange(port, `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    assert.match(single, /^HTTP\/1\.1 401 /);
  }
  const health = await exchange(port, 'GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  assert.match(health, /^HTTP\/1\.1 200 /);
  assert.equal(calls, 0);
});
