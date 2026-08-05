import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

function authJson() {
  const token = `header.${Buffer.from(JSON.stringify({ email: 'native@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'native' } })).toString('base64url')}.signature`;
  return JSON.stringify({ tokens: { access_token: token, id_token: token } });
}

test('normalizes native Codex input without converting string input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-native-payload-'));
  const store = new Store(dir);
  const upstream = store.create({ type: 'codex', authJson: authJson() });
  store.setCap(upstream.id, { capDollars: 100 });
  let forwarded;
  const server = createServer(createApp({ store, apiKey: 'native-key', fetchImpl: async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'resp-native', output: [] }), { headers: { 'content-type': 'application/json' } });
  } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/backend-api/codex/responses`, {
      method: 'POST', headers: { authorization: 'Bearer native-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: [
        { type: 'message', id: 'plainid', content: 'keep' },
        { type: 'message', id: 'msg_keep', content: 'keep' },
        { type: 'reasoning', content: null, encrypted_content: 'cipher' },
        { type: 'item_reference', id: 'plain-reference' }
      ], previous_response_id: 'resp-drop', tools: [{ type: 'function', name: 'f', strict: false, parameters: { type: 'object', encrypted_content: true, properties: { x: { type: 'string', encrypted_content_marker: true } } } }] })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(forwarded.input, [
      { type: 'message', content: 'keep' },
      { type: 'message', id: 'msg_keep', content: 'keep' },
      { type: 'item_reference', id: 'plain-reference' }
    ]);
    assert.equal('previous_response_id' in forwarded, false);
    assert.deepEqual(forwarded.tools[0].parameters, { type: 'object', properties: { x: { type: 'string' } } });

    const stringResponse = await fetch(`http://127.0.0.1:${server.address().port}/backend-api/codex/responses`, {
      method: 'POST', headers: { authorization: 'Bearer native-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'native string input' })
    });
    assert.equal(stringResponse.status, 200);
    assert.equal(forwarded.input, 'native string input');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
