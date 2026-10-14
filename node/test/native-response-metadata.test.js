import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { attachWebSocketProxy } from '../src/proxy.js';

test('native metadata preserves observed reasoning presence and absence on each connection', { timeout: 5000 }, async (t) => {
  const store = new Store(null, { inMemory: true, encryptionKey: Buffer.alloc(32, 3) });
  const upstream = store.create({ type: 'codex', accessToken: 'synthetic' });
  store.setCap(upstream.id, { capDollars: 100 });
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let flag;
  target.on('headers', (headers) => {
    headers.push('openai-model: gpt-native');
    headers.push('x-provider-secret: private');
    if (flag !== undefined) headers.push(`x-reasoning-included: ${flag}`);
  });
  target.on('connection', (socket) => socket.on('message', () => socket.send(JSON.stringify({
    type: 'response.completed', response: { id: 'resp_native', status: 'completed', output: [] }
  }))));
  await new Promise((resolve) => target.once('listening', resolve));
  const fetchImpl = async () => new Response('{}');
  const server = createServer(createApp({ store, apiKey: 'metadata-key', fetchImpl }));
  const relay = attachWebSocketProxy(server, { store, apiKey: 'metadata-key', fetchImpl,
    websocketUrl: () => `ws://127.0.0.1:${target.address().port}` });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    relay.close();
    for (const socket of target.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => target.close(resolve));
    store.sqlite.close();
  });
  for (const value of ['false', undefined, '', 'x'.repeat(1025)]) {
    flag = value;
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/backend-api/codex/responses`, {
      headers: { authorization: 'Bearer metadata-key' }
    });
    t.after(() => client.terminate());
    let handshake;
    const metadata = await new Promise((resolve, reject) => {
      client.once('upgrade', (response) => { handshake = response.headers; });
      client.once('open', () => client.send('{"backend":true}'));
      client.once('message', (data) => resolve(JSON.parse(data.toString())));
      client.once('error', reject);
    });
    assert.equal(metadata.type, 'codex.response.metadata');
    assert.equal(metadata.headers['openai-model'], 'gpt-native');
    assert.equal(metadata.headers['x-reasoning-included'], value !== undefined && value.length <= 1024 ? 'true' : undefined);
    assert.equal(handshake['x-reasoning-included'], undefined);
    assert.equal(metadata.headers['x-provider-secret'], undefined);
    await new Promise((resolve) => { client.once('close', resolve); client.close(); });
  }
});
