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
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'x-upstream-id': second.id
        },
        body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'escape' })
      });
      assert.equal(response.status, 503);
      assert.equal(calls.length, 0);

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

    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manually budgeted AISwitch project serves a pinned Compass Messages share session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-aiswitch-share-proxy-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({
      type: 'compass',
      quotaSource: 'aiswitch',
      projectId: 'shared-aiswitch-project',
      projectKey: 'shared-aiswitch-key'
    });
    store.setCap(upstream.id, { capDollars: 100 });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'aiswitch-share-provider');
    const consumer = account(sharingStore, 'aiswitch-share-consumer');
    sharingStore.linkUpstream(provider.id, upstream.id);
    sharingStore.setManualShareBudget(provider.id, upstream.id, { quotaDollars: 3 }, store);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 3 }, store);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id }, store);
    const session = sharingStore.approveTicket(provider.id, ticket.id, {}, store);
    const { apiKey } = sharingStore.revealSessionKey(consumer.id, session.id);
    const calls = [];
    const app = await running(store, sharingStore, async (url, options) => {
      calls.push({ path: new URL(url).pathname, authorization: options.headers.authorization });
      return new Response(JSON.stringify({
        id: 'aiswitch-share-message',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'shared' }],
        usage: { price_cost_usd: 1 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const response = await fetch(`${app.base}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] })
      });
      assert.equal(response.status, 200);
      assert.deepEqual(calls, [{ path: '/compass-api/v1/messages', authorization: 'Bearer shared-aiswitch-key' }]);
      assert.equal(sharingStore.session(session.id, consumer.id, store).remainingQuotaDollars, 2);
      assert.equal(sharingStore.providerSummary(provider.id, upstream.id, store).commitment.actualQuotaDollars, 2);
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

test('Codex Share exposes Relaydeck compatibility routes with share-session file isolation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-share-compatibility-routes-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'compatibility@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'compatibility' } }),
      id_token: jwt({ email: 'compatibility@example.com' })
    }}) });
    store.setCap(upstream.id, { capDollars: 100 });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'compatibility-provider');
    const consumer = account(sharingStore, 'compatibility-consumer');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 10 }, store);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id }, store);
    const session = sharingStore.approveTicket(provider.id, ticket.id, {}, store);
    const { apiKey } = sharingStore.revealSessionKey(consumer.id, session.id);
    store.saveFile({
      id: 'shared-file',
      object: 'file',
      bytes: 1,
      filename: 'shared.txt',
      purpose: 'user_data',
      status: 'uploaded'
    }, `share-session:${session.id}`);
    store.saveFile({
      id: 'hidden-file',
      object: 'file',
      bytes: 1,
      filename: 'hidden.txt',
      purpose: 'user_data',
      status: 'uploaded'
    });

    const app = await running(store, sharingStore, async () => {
      throw new Error('These validation and file-list routes do not need an upstream request');
    });
    try {
      const headers = { authorization: `Bearer ${apiKey}` };
      let response = await fetch(`${app.base}/v1/files`, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data.map(({ id }) => id), ['shared-file']);

      response = await fetch(`${app.base}/v1/files/shared-file`, { headers });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).id, 'shared-file');

      response = await fetch(`${app.base}/v1/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: new FormData()
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.param, 'model');

      response = await fetch(`${app.base}/v1/images/generations`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.param, 'model');

      response = await fetch(`${app.base}/v1/images/edits`, {
        method: 'POST',
        headers,
        body: new FormData()
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.param, 'image');

      response = await fetch(`${app.base}/v1/embeddings`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 404);
      assert.deepEqual((await response.json()).error, {
        type: 'invalid_request_error',
        code: 'unsupported_endpoint',
        message: 'Unsupported OpenAI /v1 endpoint',
        param: null
      });
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex Share reuses streamed tool calls and public compaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-share-tools-compaction-'));
  const calls = [];
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'tools@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'tools' } }),
      id_token: jwt({ email: 'tools@example.com' })
    }}) });
    store.setCap(upstream.id, { capDollars: 100 });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'tools-provider');
    const consumer = account(sharingStore, 'tools-consumer');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 10 }, store);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id }, store);
    const session = sharingStore.approveTicket(provider.id, ticket.id, {}, store);
    const { apiKey } = sharingStore.revealSessionKey(consumer.id, session.id);
    const app = await running(store, sharingStore, async (url, options) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(options.body);
      calls.push({ path, body });
      if (body.input?.at(-1)?.type === 'compaction_trigger') {
        return new Response(JSON.stringify({
          id: 'resp-compact',
          output: [{ type: 'compaction', id: null, encrypted_content: 'compact-secret' }],
          usage: { input_tokens: 1, output_tokens: 1, price_cost_usd: 1 }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response([
        'event: response.output_item.done',
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: 'fc-1',
            type: 'function_call',
            call_id: 'call-1',
            name: 'lookup',
            arguments: '{"query":"Codex Share"}'
          }
        })}`,
        '',
        'event: response.completed',
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp-tools',
            status: 'completed',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, price_cost_usd: 1 }
          }
        })}`,
        '',
        'data: [DONE]',
        ''
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    try {
      const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
      let response = await fetch(`${app.base}/v1/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          input: 'Use the lookup tool',
          stream: true,
          tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } }]
        })
      });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.match(stream, /"type":"function_call"/);
      assert.match(stream, /"name":"lookup"/);

      response = await fetch(`${app.base}/v1/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarize this thread' }] },
            { type: 'compaction_trigger' }
          ]
        })
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).output, [{
        type: 'compaction',
        id: null,
        encrypted_content: 'compact-secret'
      }]);
      assert.deepEqual(calls.map(({ path }) => path), [
        '/backend-api/codex/responses',
        '/backend-api/codex/responses'
      ]);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('successful unpriced native streams release share reservations as successful activity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-share-unpriced-stream-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'unpriced-stream@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'unpriced-stream' } }),
      id_token: jwt({ email: 'unpriced-stream@example.com' })
    }}) });
    store.setCap(upstream.id, { capDollars: 100 });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'unpriced-stream-provider');
    const consumer = account(sharingStore, 'unpriced-stream-consumer');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 2 }, store);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id }, store);
    const session = sharingStore.approveTicket(provider.id, ticket.id, {}, store);
    const { apiKey } = sharingStore.revealSessionKey(consumer.id, session.id);
    const app = await running(store, sharingStore, async () => new Response(
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"unpriced","status":"completed","output":[]}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ));
    try {
      const response = await fetch(`${app.base}/backend-api/codex/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'unknown-unpriced-model', input: 'hello', stream: true })
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /response.completed/);
      const activity = sharingStore.session(session.id, consumer.id, store).activity;
      assert.equal(activity.requestCount, 1);
      assert.equal(activity.successCount, 1);
      assert.deepEqual(activity.recentFailures, []);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal keys rotate across active sessions and pin response continuations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-personal-proxy-'));
  const calls = [];
  try {
    const store = new Store(dir);
    const first = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'personal-first@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'personal-first' } }),
      id_token: jwt({ email: 'personal-first@example.com' })
    }}) });
    const second = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'personal-second@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'personal-second' } }),
      id_token: jwt({ email: 'personal-second@example.com' })
    }}) });
    store.setCap(first.id, { capDollars: 100 });
    store.setCap(second.id, { capDollars: 100 });
    const sharingStore = new ProductStore(dir);
    const firstProvider = account(sharingStore, 'personal-first-provider');
    const secondProvider = account(sharingStore, 'personal-second-provider');
    const consumer = account(sharingStore, 'personal-consumer');
    sharingStore.linkUpstream(firstProvider.id, first.id);
    sharingStore.linkUpstream(secondProvider.id, second.id);
    const firstOffer = sharingStore.createOffer(firstProvider.id, { upstreamId: first.id, quotaDollars: 1 }, store);
    const secondOffer = sharingStore.createOffer(secondProvider.id, { upstreamId: second.id, quotaDollars: 2 }, store);
    const firstTicket = sharingStore.createTicket(consumer.id, { offerId: firstOffer.id }, store);
    const secondTicket = sharingStore.createTicket(consumer.id, { offerId: secondOffer.id }, store);
    const firstSession = sharingStore.approveTicket(firstProvider.id, firstTicket.id, {}, store);
    const secondSession = sharingStore.approveTicket(secondProvider.id, secondTicket.id, {}, store);
    const { apiKey } = sharingStore.revealPersonalKey(consumer.id);
    const app = await running(store, sharingStore, async (_url, options) => {
      const accountId = options.headers['chatgpt-account-id'];
      calls.push(accountId);
      return new Response(JSON.stringify({
        id: `resp-${accountId}`,
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, price_cost_usd: 1 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      let response = await fetch(`${app.base}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'first' })
      });
      assert.equal(response.status, 200);
      const firstResponse = await response.json();
      assert.equal(calls.length, 1);
      assert.equal(sharingStore.session(secondSession.id, consumer.id, store).consumedQuotaDollars, 1);

      response = await fetch(`${app.base}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          previous_response_id: firstResponse.id,
          input: [{ type: 'function_call_output', call_id: 'call-personal', output: 'continue' }]
        })
      });
      assert.equal(response.status, 200, await response.text());
      assert.deepEqual(calls, ['personal-second', 'personal-second']);
      assert.equal(sharingStore.session(secondSession.id, consumer.id, store).status, 'exhausted');

      response = await fetch(`${app.base}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'new turn' })
      });
      assert.equal(response.status, 200);
      assert.equal(calls[2], 'personal-first');
      assert.equal(sharingStore.session(firstSession.id, consumer.id, store).status, 'exhausted');

      response = await fetch(`${app.base}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'blocked' })
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'personal_key_exhausted');
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal keys identify when every available provider needs to sign in again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pool-personal-reauth-'));
  try {
    const store = new Store(dir);
    const upstream = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: {
      access_token: jwt({ email: 'personal-reauth@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'personal-reauth' } }),
      id_token: jwt({ email: 'personal-reauth@example.com' })
    }}) });
    store.setCap(upstream.id, { capDollars: 100 });
    const sharingStore = new ProductStore(dir);
    const provider = account(sharingStore, 'personal-reauth-provider');
    const consumer = account(sharingStore, 'personal-reauth-consumer');
    sharingStore.linkUpstream(provider.id, upstream.id);
    const offer = sharingStore.createOffer(provider.id, { upstreamId: upstream.id, quotaDollars: 1 }, store);
    const ticket = sharingStore.createTicket(consumer.id, { offerId: offer.id }, store);
    sharingStore.approveTicket(provider.id, ticket.id, {}, store);
    const { apiKey } = sharingStore.revealPersonalKey(consumer.id);
    const admission = store.beginUpstreamAttempt(upstream.id, { routeClass: 'proxy_http', model: 'gpt-5.6-sol' });
    store.settleUpstreamAttempt(upstream.id, admission, { class: 'credential', retryable: true });
    const app = await running(store, sharingStore, async () => {
      throw new Error('A reauthentication-required upstream must not receive a request');
    });
    try {
      const response = await fetch(`${app.base}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hello' })
      });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error.code, 'share_provider_reauth_required');
      assert.match(body.error.message, /provider must sign in/i);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes cooled providers over WebSocket and rechecks share-session state before every turn', async () => {
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
    const cooldown = store.beginUpstreamAttempt(upstream.id, { routeClass: 'proxy_stream', model: 'gpt-5.6-sol' });
    store.settleUpstreamAttempt(upstream.id, cooldown, { class: 'quota', retryable: true, retryAfter: '60' });
    assert.equal(store.get(upstream.id).health.status, 'cooldown');
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
      disablePacing: true,
      ignoreQuotaCooldown: true,
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
      assert.equal(store.get(upstream.id).health, undefined);
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
