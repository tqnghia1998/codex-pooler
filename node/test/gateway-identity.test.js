import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('gateway identity preserves both persisted Claude namespaces', () => {
  for (const [identity, expectedIdentity, userAgent] of [
    [undefined, 'codex-pooler', 'codex-pooler-node/0.1.0'],
    ['codex-share', 'codex-share', 'codex-share/0.1.0']
  ]) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { deriveClaudeAccountId } from './src/domain.js';
      import { claudeRequestHeaders } from './src/claude-protocol.js';
      console.log(JSON.stringify({
        id: deriveClaudeAccountId({ refreshToken: 'synthetic-refresh' }),
        agent: claudeRequestHeaders({
          req: { headers: {} },
          body: { model: 'claude-sonnet-4' },
          credentials: { projectKey: 'synthetic' },
          upstream: { type: 'claude', baseUrl: 'https://api.anthropic.com' }
        })['user-agent']
      }));
    `], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, CODEX_GATEWAY_IDENTITY: identity ?? '' },
      encoding: 'utf8'
    });
    const actual = JSON.parse(output);
    const hex = createHash('sha256').update(`${expectedIdentity}:claude-account-id\0`).update('synthetic-refresh').digest('hex').slice(0, 32);
    const bytes = hex.split('');
    bytes[12] = '4';
    bytes[16] = ['8', '9', 'a', 'b'][parseInt(bytes[16], 16) % 4];
    assert.equal(actual.id, `${bytes.slice(0, 8).join('')}-${bytes.slice(8, 12).join('')}-${bytes.slice(12, 16).join('')}-${bytes.slice(16, 20).join('')}-${bytes.slice(20).join('')}`);
    assert.equal(actual.agent, userAgent);
  }
});
