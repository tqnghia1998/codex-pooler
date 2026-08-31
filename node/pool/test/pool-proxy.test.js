import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { attachWebSocketProxy } from '../../src/proxy.js';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function account(store, sub) {
  return store.upsertCodexAccount({ subject: sub, issuer: 'https://auth.openai.com', email: `${sub}@example.com`, name: sub });
}

async function running(store, sharingStore, fetchImpl) {
  const server = createServer(createApp({ store, productStore: sharingStore, fetchImpl }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('share keys hard-pin one upstream and exhaust after settled usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-proxy-'));
  const calls = [];
  try {
    const store = new Store(dir);
    const first = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'first@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'first' } }),
      id_token: jwt({ email: 'first@example.com' })
    }}) });
    const second = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'second@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'second' } }),
      id_token: jwt({ email: 'second@example.com' })
    }}) });
    store.setCap(first.id, { capDollars: 100 });
    store.setCap(second.id, { capDollars: 100 });

    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'provider');
    const consumer = account(sharingStore, 'consumer');
    sharingStore.linkUpstream(provider.id, first.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: first.id, quotaDollars: 1 }, store);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id, quotaDollars: 1 }, store);
    const session = sharingStore.approveTicket(provider.id, ticket.id, {}, store);
    const { apiKey } = sharingStore.revealSessionKey(consumer.id, session.id);

    const app = await running(store, sharingStore, async (url) => {
      calls.push(new URL(url).pathname);
      return new Response(JSON.stringify({
        id: 'resp-shared',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, price_cost_usd: 1 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      let response = await fetch(`${app.base}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-key', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'operator escape' })
      });
      assert.equal(response.status, 401);

      response = await fetch(`${app.base}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hello' })
      });
      assert.equal(response.status, 200);
      assert.deepEqual(calls, ['/backend-api/codex/responses']);
      assert.equal(sharingStore.session(session.id, consumer.id, store).status, 'exhausted');

      response = await fetch(`${app.base}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'again' })
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'share_session_exhausted');

      response = await fetch(`${app.base}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'x-upstream-id': second.id
        },
        body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'escape' })
      });
      assert.equal(response.status, 403);
      assert.equal(calls.length, 1);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('share keys expose only the granted provider model catalog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-models-'));
  try {
    const store = new Store(dir);
    const first = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'models-first@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'models-first' } }),
      id_token: jwt({ email: 'models-first@example.com' })
    }}) });
    const second = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'models-second@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'models-second' } }),
      id_token: jwt({ email: 'models-second@example.com' })
    }}) });
    store.setCap(first.id, { capDollars: 100 });
    store.setCap(second.id, { capDollars: 100 });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'model-provider');
    const consumer = account(sharingStore, 'model-consumer');
    sharingStore.linkUpstream(provider.id, first.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: first.id, quotaDollars: 5 }, store);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id, quotaDollars: 5 }, store);
    const session = sharingStore.approveTicket(provider.id, ticket.id, {}, store);
    const { apiKey } = sharingStore.revealSessionKey(consumer.id, session.id);
    const app = await running(store, sharingStore, async (url) => {
      const accountId = url.includes('client_version') ? null : null;
      assert.equal(new URL(url).pathname, '/backend-api/codex/models');
      return new Response(JSON.stringify({
        models: [{ slug: accountId || 'gpt-provider-only', input_modalities: ['text'] }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const response = await fetch(`${app.base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } });
      assert.equal(response.status, 200);
      const ids = (await response.json()).data.map((model) => model.id);
      assert.equal(ids.includes('gpt-provider-only'), true);
      assert.equal(ids.includes('claude-sonnet-5'), false);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rechecks share-session state before every WebSocket turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-websocket-'));
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => target.once('listening', resolve));
  let providerTurns = 0;
  target.on('connection', (socket) => socket.on('message', () => {
    providerTurns += 1;
    socket.send(JSON.stringify({ type: 'response.completed', response: { id: `shared-${providerTurns}`, status: 'completed', output: [] } }));
  }));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'websocket@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'websocket' } }),
      id_token: jwt({ email: 'websocket@example.com' })
    }}) });
    store.setCap(upstream.id, { capDollars: 100 });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'websocket-provider');
    const consumer = account(sharingStore, 'websocket-consumer');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 5 }, store);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id, quotaDollars: 5 }, store);
    const session = sharingStore.approveTicket(provider.id, ticket.id, {}, store);
    const { apiKey } = sharingStore.revealSessionKey(consumer.id, session.id);

    const gateway = createServer(createApp({ store, productStore: sharingStore }));
    const relay = attachWebSocketProxy(gateway, {
      store,
      sharingStore,
      shareKeysOnly: true,
      apiKey: null,
      websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
      fetchImpl: async () => new Response('{}')
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    try {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
        headers: { authorization: `Bearer ${apiKey}` }
      });
      const messages = [];
      await new Promise((resolve, reject) => {
        client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'first' })));
        client.on('message', (data) => {
          const message = JSON.parse(data.toString());
          messages.push(message);
          if (messages.length === 1) {
            sharingStore.updateSession(provider.id, session.id, { status: 'paused' }, store);
            client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'second' }));
          } else {
            client.close();
            resolve();
          }
        });
        client.once('error', reject);
      });
      assert.equal(messages[0].type, 'response.completed');
      assert.equal(messages[1].type, 'error');
      assert.equal(messages[1].error.code, 'share_session_paused');
      assert.equal(providerTurns, 1);

      const status = await new Promise((resolve, reject) => {
        const pausedClient = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, {
          headers: { authorization: `Bearer ${apiKey}` }
        });
        pausedClient.once('unexpected-response', (_request, response) => resolve(response.statusCode));
        pausedClient.once('error', reject);
      });
      assert.equal(status, 403);
    } finally {
      relay.close();
      await new Promise((resolve) => gateway.close(resolve));
    }
  } finally {
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settles native Codex WebSocket usage against the share grant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-native-websocket-'));
  const target = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => target.once('listening', resolve));
  let providerTurns = 0;
  target.on('connection', (socket) => socket.on('message', () => {
    providerTurns += 1;
    socket.send(JSON.stringify({
      type: 'response.completed',
      response: {
        id: `native-shared-${providerTurns}`,
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, price_cost_usd: 1 }
      }
    }));
  }));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'native-websocket@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'native-websocket' } }),
      id_token: jwt({ email: 'native-websocket@example.com' })
    }}) });
    store.setCap(upstream.id, { capDollars: 100 });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'native-websocket-provider');
    const consumer = account(sharingStore, 'native-websocket-consumer');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 1 }, store);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id, quotaDollars: 1 }, store);
    const session = sharingStore.approveTicket(provider.id, ticket.id, {}, store);
    const { apiKey } = sharingStore.revealSessionKey(consumer.id, session.id);

    const gateway = createServer(createApp({ store, productStore: sharingStore }));
    const relay = attachWebSocketProxy(gateway, {
      store,
      sharingStore,
      shareKeysOnly: true,
      apiKey: null,
      websocketUrl: () => `ws://127.0.0.1:${target.address().port}`,
      fetchImpl: async () => new Response('{}')
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    try {
      const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/backend-api/codex/responses`, {
        headers: { authorization: `Bearer ${apiKey}` }
      });
      const closeCode = await new Promise((resolve, reject) => {
        client.once('open', () => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'first' })));
        client.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (message.type !== 'response.completed') return;
          client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'second' }));
        });
        client.once('close', resolve);
        client.once('error', reject);
      });
      assert.equal(closeCode, 1008);
      assert.equal(providerTurns, 1);
      assert.equal(sharingStore.session(session.id, consumer.id, store).status, 'exhausted');
      assert.equal(sharingStore.session(session.id, consumer.id, store).consumedQuotaDollars, 1);
    } finally {
      relay.close();
      await new Promise((resolve) => gateway.close(resolve));
    }
  } finally {
    await new Promise((resolve) => target.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
