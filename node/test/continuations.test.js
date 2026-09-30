import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { attachWebSocketProxy } from '../src/proxy.js';

const KEY = 'continuation-key';

async function gateway() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-continuation-'));
  const store = new Store(dir);
  const upstream = store.create({ type: 'compass', projectId: 'project', projectKey: 'project-key' });
  store.setCap(upstream.id, { capDollars: 10 });
  const server = createServer(createApp({
    store, apiKey: KEY,
    fetchImpl: async () => new Response(JSON.stringify({ id: 'response-1', object: 'response', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }));
  attachWebSocketProxy(server, { store, apiKey: KEY });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    store, upstream, base: `http://127.0.0.1:${server.address().port}`,
    ws: `ws://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('uses Elixir session aliases in precedence order and requires an authenticated WebSocket upgrade', async (t) => {
  const fixture = await gateway();
  t.after(fixture.close);
  const response = await fetch(`${fixture.base}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`, 'content-type': 'application/json',
      'x-codex-window-id': 'winner', 'x-codex-session-id': 'loser'
    },
    body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
  });
  assert.equal(response.status, 200);
  assert.equal(fixture.store.sessionUpstream('winner', undefined, fixture.store.authenticateApiKey(KEY).id), fixture.upstream.id);
  assert.equal(fixture.store.sessionUpstream('loser'), null);

  const noUpgrade = await fetch(`${fixture.base}/v1/responses`, { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(noUpgrade.status, 400);
  assert.equal((await noUpgrade.json()).error.code, 'websocket_upgrade_required');
});

test('closes binary WebSocket frames with 1003 before contacting an upstream', async (t) => {
  const fixture = await gateway();
  t.after(fixture.close);
  const client = new WebSocket(`${fixture.ws}/v1/responses`, { headers: { authorization: `Bearer ${KEY}` } });
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  const closed = new Promise((resolve) => client.once('close', (code) => resolve(code)));
  client.send(Buffer.from([1, 2, 3]), { binary: true });
  assert.equal(await closed, 1003);
});
