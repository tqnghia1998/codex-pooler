import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { admissionPolicy, clientIp, firewallAllowed } from '../src/admission.js';

async function running(ingress) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-admission-'));
  const server = createServer(createApp({ store: new Store(dir), apiKey: 'admission-key', ingress }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, async close() { await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); } };
}

test('applies runtime firewall rules only after trusted-proxy client extraction', async (t) => {
  const app = await running({ firewallAllowlist: ['198.51.100.0/24'], trustedProxies: ['127.0.0.1'] });
  t.after(() => app.close());
  const auth = { authorization: 'Bearer admission-key' };
  assert.equal((await fetch(`${app.base}/healthz`)).status, 200);
  assert.equal((await fetch(`${app.base}/v1/usage`, { headers: auth })).status, 403);
  assert.equal((await fetch(`${app.base}/v1/usage`, { headers: { ...auth, 'x-forwarded-for': '198.51.100.7, 127.0.0.1' } })).status, 200);
});

test('enforces the firewall for unrecognized runtime-shaped paths instead of falling through to a bare 404', async (t) => {
  const app = await running({ firewallAllowlist: ['198.51.100.0/24'], trustedProxies: ['127.0.0.1'] });
  t.after(() => app.close());
  const blocked = await fetch(`${app.base}/backend-api/codex/analytics-events/events`, { method: 'POST' });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, 'access_denied');
  const admitted = await fetch(`${app.base}/backend-api/codex/analytics-events/events`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(admitted.status, 404);
});

test('does not trust forwarded client headers from an untrusted peer', async (t) => {
  const app = await running({ firewallAllowlist: ['198.51.100.7'] });
  t.after(() => app.close());
  const response = await fetch(`${app.base}/v1/usage`, { headers: { authorization: 'Bearer admission-key', 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(response.status, 403);
});

test('matches IPv6 CIDRs and strips trusted proxy hops from forwarded chains', () => {
  const policy = admissionPolicy({ firewallAllowlist: ['2001:dead:abcd:12::/64'], trustedProxies: ['2001:db8::/32'] });
  const req = { socket: { remoteAddress: '2001:db8::1' }, headers: { 'x-forwarded-for': '2001:dead:abcd:12::9, 2001:db8::2' } };
  assert.equal(clientIp(req, policy), '2001:dead:abcd:12::9');
  assert.equal(firewallAllowed(req, policy), true);
});

test('normalizes IPv4-mapped IPv6 addresses for proxy and firewall rules', () => {
  const policy = admissionPolicy({ firewallAllowlist: ['198.51.100.0/24'], trustedProxies: ['127.0.0.1'] });
  const req = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '::ffff:198.51.100.7' } };
  assert.equal(clientIp(req, policy), '::ffff:198.51.100.7');
  assert.equal(firewallAllowed(req, policy), true);
});

test('allows explicitly configured deployment hosts and same-host browser origins', async (t) => {
  const app = await running({ allowedHosts: ['proxy.example'] });
  t.after(() => app.close());
  assert.equal((await requestWithHost(app.base, 'https://proxy.example', { id: 'external' }, true)).statusCode, 201);
  assert.equal((await requestWithHost(app.base, 'https://attacker.example', { id: 'blocked' }, true)).statusCode, 403);
  assert.equal((await requestWithHost(app.base, 'https://proxy.example', { id: 'unauthorized' })).statusCode, 401);
});

function requestWithHost(base, origin, body, authorized = false) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: '/api/scopes', method: 'POST', headers: { host: 'proxy.example', origin, 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer admission-key' } : {}) } }, (res) => resolve(res));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
