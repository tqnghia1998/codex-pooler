import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { claudeRequestHeaders } from '../src/claude-protocol.js';

function tempStore(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-'));
  return { dir, store: new Store(dir, options) };
}

test('persists stabilized Claude device profiles without exposing them publicly', () => {
  const { dir, store } = tempStore({ allowLegacyClaudeApiKey: true });
  try {
    const created = store.create({ type: 'claude', projectKey: 'sk-ant-api-device-profile-test', metadata: { fingerprint_profile: 'claude-code-cli' } });
    const upstream = store.get(created.id);
    const sessionId = '22222222-3333-4444-8555-666666666666';
    const req = { headers: {
      'user-agent': 'claude-cli/2.1.220 (external, claude-vscode, agent-sdk/0.3.220)',
      'x-claude-code-session-id': sessionId,
      'x-stainless-package-version': '0.94.0',
      'x-stainless-runtime-version': 'v26.3.0',
      'x-stainless-os': 'Windows',
      'x-stainless-arch': 'x64',
      'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219'
    }};
    const body = { model: 'claude-sonnet-4', metadata: { user_id: JSON.stringify({ device_id: 'a'.repeat(64), account_uuid: '11111111-2222-4333-8444-555555555555', session_id: sessionId }) }, messages: [{ role: 'user', content: 'hello' }] };
    claudeRequestHeaders({ req, body, credentials: { projectKey: 'sk-ant-api-device-profile-test' }, upstream, claudeConfig: { claudeHeaderDefaults: { stabilizeDeviceProfile: true } } });
    assert.ok(upstream.claudeDeviceProfiles?.vscode);
    assert.equal(store.persistClaudeDeviceProfiles(created.id, upstream.claudeDeviceProfiles), true);
    assert.equal(store.getPublic(created.id).claudeDeviceProfiles, undefined);
    store.sqlite.close();
    const reopened = new Store(dir, { allowLegacyClaudeApiKey: true });
    assert.equal(reopened.get(created.id).claudeDeviceProfiles.vscode.userAgent, req.headers['user-agent']);
    reopened.sqlite.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persists CRUD while keeping credentials out of public records', () => {
  const { dir, store } = tempStore();
  try {
    const created = store.create({ type: 'compass', name: 'Compass one', projectId: 'project-1', projectKey: 'secret-key' });
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].hasCredentials, true);
    assert.equal(store.list()[0].projectId, 'project-1');
    assert.equal(store.credentials(created.id).projectKey, 'secret-key');
    const stored = store.sqlite.prepare("SELECT value FROM records WHERE collection = 'upstreams'").get().value;
    assert.match(stored, /v1:/);
    assert.doesNotMatch(stored, /secret-key/);
    store.update(created.id, { name: 'Renamed', projectId: 'project-2' });
    assert.equal(store.credentials(created.id).projectKey, 'secret-key');
    store.persistCredentials(created.id, { projectKey: 'rotated-key' }, '2030-01-01T00:00:00.000Z');
    assert.equal(store.credentials(created.id).projectKey, 'rotated-key');
    assert.equal(store.getPublic(created.id).accessTokenExpiresAt, '2030-01-01T00:00:00.000Z');
    store.remove(created.id);
    assert.equal(store.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routes legacy Claude OAuth records without auth metadata', () => {
  const { dir, store } = tempStore({ allowLegacyClaudeApiKey: true });
  try {
    const created = store.create({ type: 'claude', accessToken: 'legacy-oauth-token', accountId: 'legacy-account' });
    const saved = store.load().upstreams.find((upstream) => upstream.id === created.id);
    delete saved.metadata.auth_kind;
    saved.accessTokenExpiresAt = null;
    store.save(store.load());
    store.sqlite.close();

    const reopened = new Store(dir);
    reopened.setCap(created.id, { capDollars: 100 });
    assert.deepEqual(reopened.candidatePlan({ model: 'claude-sonnet-5' }).map(({ id }) => id), [created.id]);
    reopened.sqlite.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allows Codex accounts that share an organization account ID', () => {
  const { dir, store } = tempStore();
  try {
    const token = (email) => `e.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
    store.create({ type: 'codex', authJson: JSON.stringify({ tokens: { access_token: token('first@example.com'), id_token: token('first@example.com'), account_id: 'shared-account' } }) });
    store.create({ type: 'codex', authJson: JSON.stringify({ tokens: { access_token: token('second@example.com'), id_token: token('second@example.com'), account_id: 'shared-account' } }) });
    assert.equal(store.list().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changes the model catalog generation only when Codex access identity changes', () => {
  const { dir, store } = tempStore();
  try {
    const token = (value) => `header.${Buffer.from(JSON.stringify({ email: `${value}@example.com` })).toString('base64url')}.signature`;
    const upstream = store.create({ type: 'codex', authJson: JSON.stringify({ tokens: { access_token: token('first'), id_token: token('first') } }) });
    const initial = store.get(upstream.id);
    const initialCatalogEpoch = initial.modelCatalogEpoch;
    const credentials = store.credentials(upstream.id);
    store.persistCredentials(upstream.id, { ...credentials, cookie: 'session=one' }, initial.accessTokenExpiresAt);
    assert.equal(store.get(upstream.id).modelCatalogEpoch, initialCatalogEpoch);
    const changed = store.credentials(upstream.id);
    changed.accessToken = token('second');
    store.persistCredentials(upstream.id, changed, initial.accessTokenExpiresAt);
    assert.equal(store.get(upstream.id).modelCatalogEpoch, initialCatalogEpoch + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts a coalesced credential refresh already persisted by another caller', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({
      type: 'codex',
      authJson: JSON.stringify({ tokens: {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        id_token: 'old-id'
      } })
    });
    const first = store.credentials(upstream.id);
    const second = store.credentials(upstream.id);
    const refreshed = {
      ...first,
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      idToken: 'new-id'
    };
    assert.equal(store.persistCredentials(upstream.id, refreshed, '2030-01-01T00:00:00.000Z'), true);

    const coalesced = {
      ...second,
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      idToken: 'new-id',
      codexCookies: 'stale-cookie'
    };
    Object.defineProperty(coalesced, 'credentialEpoch', {
      value: second.credentialEpoch,
      enumerable: false
    });
    assert.equal(store.persistCredentials(upstream.id, coalesced, '2030-01-01T00:00:00.000Z'), true);
    assert.equal(coalesced.accessToken, 'new-access');
    assert.equal(coalesced.codexCookies, undefined);

    const competing = {
      ...second,
      accessToken: 'different-access',
      refreshToken: 'different-refresh'
    };
    Object.defineProperty(competing, 'credentialEpoch', {
      value: second.credentialEpoch,
      enumerable: false
    });
    assert.equal(store.persistCredentials(upstream.id, competing, '2030-01-01T00:00:00.000Z'), false);
    assert.equal(store.credentials(upstream.id).accessToken, 'new-access');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps routing within one loaded database snapshot', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({ type: 'compass', projectId: 'snapshot', projectKey: 'secret' });
    store.setCap(upstream.id, { capDollars: 1 });
    let reads = 0;
    const load = store.load.bind(store);
    store.load = () => { reads += 1; return load(); };
    assert.deepEqual(store.candidatePlan({ scopeId: 'default', preferredType: 'compass' }).map(({ id }) => id), [upstream.id]);
    assert.equal(reads, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persists routing policy and exposes dry-run diagnostics from the live planner', () => {
  const { dir, store } = tempStore();
  const now = Date.parse('2026-08-16T08:00:00Z');
  try {
    const first = store.create({ type: 'compass', projectId: 'first', projectKey: 'secret-one' });
    const second = store.create({ type: 'compass', projectId: 'second', projectKey: 'secret-two' });
    store.setCap(first.id, { capDollars: 10 });
    store.setCap(second.id, { capDollars: 10 });
    store.setQuota(first.id, { remainingPercent: 25, observedAt: new Date(now).toISOString() });
    store.setQuota(second.id, { remainingPercent: 75, observedAt: new Date(now).toISOString() });
    store.setRoutingPolicy({ strategy: 'most-remaining-quota' });

    const reopened = new Store(dir);
    assert.equal(reopened.routingPolicy().strategy, 'most-remaining-quota');
    const options = { preferredType: 'compass', requiredType: 'compass', now };
    const dryRun = reopened.routingDryRun(options);
    assert.deepEqual(dryRun.candidates.map(({ id }) => id), reopened.candidatePlan(options).map(({ id }) => id));
    assert.deepEqual(dryRun.candidates.map(({ quota }) => quota.status), ['known', 'known']);
    assert.equal(JSON.stringify(dryRun).includes('secret-one'), false);
    assert.throws(() => reopened.setRoutingPolicy({ strategy: 'fill-first' }), /strategy must be one of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persists normalized per-upstream pacing policies without runtime state', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({
      type: 'compass',
      projectId: 'paced-store',
      projectKey: 'secret',
      pacing: {
        enabled: true,
        minStartIntervalMs: 250,
        modelIntervals: [{ model: 'GPT-PACED', minStartIntervalMs: 500 }],
        maxQueueDepth: 4,
        maxQueueAgeMs: 2_000
      }
    });
    const reopened = new Store(dir);
    assert.deepEqual(reopened.getPublic(upstream.id).pacing, {
      enabled: true,
      minStartIntervalMs: 250,
      modelIntervals: [{ model: 'gpt-paced', minStartIntervalMs: 500 }],
      maxQueueDepth: 4,
      maxQueueAgeMs: 2_000
    });
    assert.equal(JSON.stringify(reopened.get(upstream.id)).includes('queueDepth'), false);
    assert.throws(() => reopened.update(upstream.id, { pacing: { maxQueueAgeMs: 99 } }), /maxQueueAgeMs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps only bounded terminal failure diagnostics on disk', () => {
  const { dir, store } = tempStore();
  try {
    const db = store.load();
    const day = new Date().toISOString().slice(0, 10);
    db.gatewayRequests = Array.from({ length: 102 }, (_, index) => ({ id: `failed-${index}`, status: 'failed', completedAt: '2026-01-01T00:00:00.000Z' }));
    db.gatewayRequests.push({ id: 'active', status: 'in_progress', completedAt: null });
    db.gatewayAttempts = db.gatewayRequests.map(({ id }) => ({ id: `attempt-${id}`, requestId: id, status: 'failed' }));
    db.gatewayUsage = [{ scopeId: 'default', apiKeyId: 'key', attemptId: 'attempt-legacy', startedAt: `${day}T12:00:00.000Z`, usage: { inputTokens: 2, outputTokens: 1 }, settledCostMicros: 400 }];
    store.save(db);
    const reopened = new Store(dir);
    assert.equal(reopened.load().gatewayRequests.length, 100);
    assert.equal(reopened.load().gatewayRequests[0].id, 'failed-2');
    assert.equal(reopened.load().gatewayAttempts.length, 100);
    assert.deepEqual(reopened.load().gatewayUsage, [{ scopeId: 'default', apiKeyId: 'key', day, requestCount: 1, totalTokens: 3, cachedInputTokens: 0, totalCostMicros: 400, priced: true, attemptIds: ['attempt-legacy'] }]);
    assert.equal(reopened.gatewayRequest('active'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scrubs legacy terminal failure identities and unsafe diagnostics on reopen', () => {
  const { dir, store } = tempStore();
  try {
    const db = store.load();
    db.gatewayRequests = [{
      id: 'legacy-failure',
      scopeId: 'private-scope',
      apiKeyId: 'private-key',
      model: 'private-model',
      endpoint: '/v1/responses',
      transport: 'http_json',
      status: 'failed',
      responseStatusCode: 999,
      lastErrorCode: 'unsafe error',
      exclusionReasons: ['quota_exhausted', 'unsafe reason'],
      retryCount: 0,
      completedAt: '2026-01-01T00:00:00.000Z'
    }];
    db.gatewayAttempts = [{
      id: 'legacy-attempt',
      requestId: 'legacy-failure',
      upstreamId: 'private-upstream',
      attemptNumber: 1,
      status: 'failed',
      responseStatusCode: 999,
      errorCode: 'unsafe error',
      timings: { queueWaitMs: 3, hostname: 'private.example' }
    }];
    store.save(db);

    const reopened = new Store(dir);
    const diagnostic = reopened.gatewayDiagnostics().failures[0];
    assert.equal(diagnostic.responseStatusCode, null);
    assert.equal(diagnostic.errorCode, null);
    assert.deepEqual(diagnostic.exclusionReasons, ['quota_exhausted']);
    assert.deepEqual(diagnostic.attempts[0].timings, { queueWaitMs: 3 });
    const persisted = reopened.sqlite.prepare('SELECT group_concat(value) AS result FROM records').get().result || '';
    for (const secret of ['private-scope', 'private-key', 'private-model', 'private-upstream', 'private.example', 'unsafe error', 'unsafe reason']) {
      assert.equal(persisted.includes(secret), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrates db.json into SQLite on first start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pooler-node-legacy-'));
  try {
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(join(dir, '.key'), randomBytes(32));
    writeFileSync(join(dir, 'db.json'), JSON.stringify({
      upstreams: [], files: [], sessions: {}, responsePins: {}, scopes: [{ id: 'default', status: 'active', models: [] }], apiKeys: [], gatewayRequests: [], gatewayAttempts: [],
      gatewayUsage: [{ scopeId: 'default', apiKeyId: 'key', attemptId: 'legacy', startedAt: `${day}T12:00:00.000Z`, usage: { inputTokens: 1, outputTokens: 2 } }]
    }));
    const store = new Store(dir);
    assert.equal(store.gatewayUsage('default', 'key').request_count, 1);
    assert.equal(existsSync(join(dir, 'db.json')), false);
    assert.equal(existsSync(join(dir, 'db.sqlite')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to replace a missing key for an existing database', () => {
  const { dir } = tempStore();
  try {
    unlinkSync(join(dir, '.key'));
    assert.throws(() => new Store(dir), /Stored credential key is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persists file metadata and upstream session pins', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({ type: 'compass', projectId: 'project-files', projectKey: 'secret' });
    store.pinSession('session-1', upstream.id);
    assert.throws(() => store.pinSession('x'.repeat(201), upstream.id), /at most 200/);
    store.saveFile({ id: 'file-1', object: 'file', bytes: 3, filename: 'a.txt', purpose: 'user_data', status: 'uploaded' });

    const reopened = new Store(dir);
    assert.equal(reopened.sessionUpstream('session-1'), upstream.id);
    assert.deepEqual(reopened.getFile('file-1'), { id: 'file-1', object: 'file', bytes: 3, filename: 'a.txt', purpose: 'user_data', status: 'uploaded' });
    assert.equal(reopened.listFiles().length, 1);
    reopened.remove(upstream.id);
    assert.equal(reopened.sessionUpstream('session-1'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persists account cooldowns, clears session affinity, and fences stale success', () => {
  const { dir, store } = tempStore();
  const now = Date.parse('2026-08-15T00:00:00Z');
  try {
    const upstream = store.create({ type: 'compass', projectId: 'cooldown', projectKey: 'secret' });
    store.setCap(upstream.id, { capDollars: 100 });
    store.pinSession('cooldown-session', upstream.id);
    store.pinResponse('resp_cooldown', upstream.id, 'default', 'key-cooldown');
    const scope = { routeClass: 'proxy_http', model: 'test' };
    const stale = store.beginUpstreamAttempt(upstream.id, scope, now);
    const quota = store.beginUpstreamAttempt(upstream.id, scope, now + 1);
    store.settleUpstreamAttempt(upstream.id, quota, { class: 'quota', retryable: true, retryAfter: '60' }, now + 2);
    assert.equal(store.sessionUpstream('cooldown-session'), null);
    assert.equal(store.responseUpstream('resp_cooldown', 'default', 'key-cooldown'), upstream.id);
    assert.equal(store.get(upstream.id).health.status, 'cooldown');
    store.settleUpstreamAttempt(upstream.id, stale, { class: 'success', retryable: false }, now + 3);
    assert.equal(store.get(upstream.id).health.status, 'cooldown');

    const reopened = new Store(dir);
    assert.equal(reopened.candidatePlan({ preferredType: 'compass', routeClass: 'proxy_http', now: now + 30_000 }).length, 0);
    assert.equal(reopened.clearUpstreamCooldown(upstream.id).health, null);
    assert.equal(reopened.candidatePlan({ preferredType: 'compass', routeClass: 'proxy_http', now: now + 30_000 }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude disable_cooling prevents account quota cooldowns', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({
      type: 'claude',
      authJson: JSON.stringify({ access_token: 'sk-ant-oat-store-test', disable_cooling: true })
    });
    const admission = store.beginUpstreamAttempt(upstream.id, { routeClass: 'proxy_http', model: 'claude-sonnet-4-6' });
    store.settleUpstreamAttempt(upstream.id, admission, { class: 'quota', retryable: true }, Date.now());
    assert.equal(store.get(upstream.id).health, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude model-scoped cooldown blocks only the rejected model', () => {
  const { dir, store } = tempStore();
  const now = Date.parse('2026-08-15T00:00:00Z');
  try {
    const upstream = store.create({
      type: 'claude',
      authJson: JSON.stringify({ access_token: 'sk-ant-oat-store-test', email: 'claude@example.com' })
    });
    store.setCap(upstream.id, { capDollars: 100 });
    const fable = store.beginUpstreamAttempt(upstream.id, { routeClass: 'proxy_http', model: 'claude-fable-5' }, now);
    store.settleUpstreamAttempt(upstream.id, fable, {
      class: 'neutral', retryable: true, modelScoped: true, model: 'claude-fable-5', retryAfter: '120'
    }, now);

    assert.equal(store.get(upstream.id).health, undefined);
    assert.equal(store.get(upstream.id).modelHealth['claude-fable-5'].nextEligibleAt, new Date(now + 120_000).toISOString());
    assert.deepEqual(store.candidatePlan({ model: 'claude-fable-5', now }).map(({ id }) => id), []);
    assert.deepEqual(store.candidatePlan({ model: 'claude-fable-5(8192)', now }).map(({ id }) => id), []);
    assert.deepEqual(store.candidatePlan({ model: 'claude-opus-5', now }).map(({ id }) => id), [upstream.id]);
    assert.equal(store.candidatePlanDetails({ model: 'claude-fable-5', now }).diagnostics.exclusions[0].code, 'upstream_model_cooldown');
    assert.deepEqual(store.candidatePlan({ model: 'claude-fable-5', ignoreQuotaCooldown: true, now }).map(({ id }) => id), [upstream.id]);
    const retry = store.beginUpstreamAttempt(upstream.id, { routeClass: 'proxy_http', model: 'claude-fable-5', ignoreQuotaCooldown: true }, now);
    store.settleUpstreamAttempt(upstream.id, retry, {
      class: 'neutral', retryable: true, modelScoped: true, model: 'claude-fable-5', retryAfter: '120'
    }, now);
    assert.equal(store.get(upstream.id).modelHealth, undefined);

    const sonnet = store.beginUpstreamAttempt(upstream.id, { routeClass: 'proxy_http', model: 'claude-sonnet-5' }, now);
    store.settleUpstreamAttempt(upstream.id, sonnet, {
      class: 'neutral', retryable: true, modelScoped: true, model: 'claude-sonnet-5', resetAt: String(now + 7 * 24 * 60 * 60_000)
    }, now);
    const sonnetNext = Date.parse(store.get(upstream.id).modelHealth['claude-sonnet-5'].nextEligibleAt);
    assert.ok(sonnetNext <= now + 15 * 60_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude model prefixes namespace credential routing', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({
      type: 'claude',
      authJson: JSON.stringify({ access_token: 'sk-ant-oat-store-test', email: 'prefixed@example.com', prefix: 'team-a' })
    });
    store.setCap(upstream.id, { capDollars: 100 });
    assert.deepEqual(store.candidatePlan({ model: 'team-a/claude-sonnet-5' }).map(({ id }) => id), [upstream.id]);
    assert.deepEqual(store.candidatePlan({ model: 'team-b/claude-sonnet-5' }), []);
    assert.deepEqual(store.candidatePlan({ model: 'claude-sonnet-5' }).map(({ id }) => id), [upstream.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude routing model restrictions accept thinking suffixes', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({
      type: 'claude',
      authJson: JSON.stringify({ access_token: 'sk-ant-oat-store-test', email: 'suffix-routing@example.com' }),
      routing: { models: ['claude-sonnet-5'] }
    });
    store.setCap(upstream.id, { capDollars: 100 });
    assert.deepEqual(store.candidatePlan({ model: 'claude-sonnet-5(8192)' }).map(({ id }) => id), [upstream.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude routing model restrictions accept OAuth aliases from global config', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({
      type: 'claude',
      authJson: JSON.stringify({ access_token: 'sk-ant-oat-no-exp-claim', email: 'alias-routing@example.com' }),
      routing: { models: ['claude-sonnet-5'] }
    });
    store.configureClaudeRuntime({
      oauthModelAlias: { claude: [{ name: 'claude-sonnet-5', alias: 'team-sonnet' }] }
    });
    store.setCap(upstream.id, { capDollars: 100 });
    assert.deepEqual(store.candidatePlan({ model: 'team-sonnet' }).map(({ id }) => id), [upstream.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ordinary concurrent success does not fence a later valid quota outcome', () => {
  const { dir, store } = tempStore();
  const now = Date.parse('2026-08-15T00:00:00Z');
  try {
    const upstream = store.create({ type: 'compass', projectId: 'concurrent-health', projectKey: 'secret' });
    store.setCap(upstream.id, { capDollars: 100 });
    const scope = { routeClass: 'proxy_http', model: '' };
    const success = store.beginUpstreamAttempt(upstream.id, scope, now);
    const quota = store.beginUpstreamAttempt(upstream.id, scope, now + 1);
    store.settleUpstreamAttempt(upstream.id, success, { class: 'success', retryable: false }, now + 2);
    store.settleUpstreamAttempt(upstream.id, quota, { class: 'quota', retryable: true }, now + 3);
    assert.equal(store.get(upstream.id).health.status, 'cooldown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credential replacement fences stale account-wide failures', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({ type: 'compass', projectId: 'credential-fence', projectKey: 'secret' });
    store.setCap(upstream.id, { capDollars: 100 });
    const admission = store.beginUpstreamAttempt(upstream.id, { routeClass: 'proxy_http', model: '' });
    store.persistCredentials(upstream.id, { projectKey: 'rotated' });
    store.settleUpstreamAttempt(upstream.id, admission, { class: 'credential', retryable: true });
    assert.equal(store.get(upstream.id).health, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allows one early reset-derived cooldown probe and never probes Retry-After early', () => {
  const { dir, store } = tempStore();
  const now = Date.parse('2026-08-15T00:00:00Z');
  try {
    const reset = store.create({ type: 'compass', projectId: 'reset-probe', projectKey: 'secret' });
    const explicit = store.create({ type: 'compass', projectId: 'explicit-probe', projectKey: 'secret' });
    store.setCap(reset.id, { capDollars: 100 });
    store.setCap(explicit.id, { capDollars: 100 });
    const scope = { routeClass: 'proxy_http', model: '' };

    const resetAttempt = store.beginUpstreamAttempt(reset.id, scope, now);
    store.settleUpstreamAttempt(reset.id, resetAttempt, { class: 'quota', retryable: true, resetAt: String(now + 15 * 60_000) }, now);
    assert.equal(store.beginUpstreamAttempt(reset.id, scope, now + 5 * 60_000 - 1), null);
    const probe = store.beginUpstreamAttempt(reset.id, scope, now + 5 * 60_000);
    assert.ok(probe);
    assert.equal(probe.accountProbe, true);
    assert.equal(store.beginUpstreamAttempt(reset.id, scope, now + 5 * 60_000 + 1), null);
    store.settleUpstreamAttempt(reset.id, probe, { class: 'success', retryable: false }, now + 5 * 60_000 + 2);
    assert.equal(store.get(reset.id).health, undefined);

    const explicitAttempt = store.beginUpstreamAttempt(explicit.id, scope, now);
    store.settleUpstreamAttempt(explicit.id, explicitAttempt, { class: 'quota', retryable: true, retryAfter: '600' }, now);
    assert.equal(store.beginUpstreamAttempt(explicit.id, scope, now + 5 * 60_000), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed reset-derived probes retain cooldown and stale probes cannot clear replacement state', () => {
  const { dir, store } = tempStore();
  const now = Date.parse('2026-08-15T00:00:00Z');
  try {
    const upstream = store.create({ type: 'compass', projectId: 'failed-probe', projectKey: 'secret' });
    store.setCap(upstream.id, { capDollars: 100 });
    const scope = { routeClass: 'proxy_http', model: '' };
    const initial = store.beginUpstreamAttempt(upstream.id, scope, now);
    store.settleUpstreamAttempt(upstream.id, initial, { class: 'quota', retryable: true, resetAt: String(now + 15 * 60_000) }, now);

    const failedProbe = store.beginUpstreamAttempt(upstream.id, scope, now + 5 * 60_000);
    store.settleUpstreamAttempt(upstream.id, failedProbe, { class: 'transient', retryable: true }, now + 5 * 60_000 + 1);
    assert.equal(store.get(upstream.id).health.status, 'cooldown');
    assert.equal(store.get(upstream.id).health.probeInFlight, false);
    assert.equal(store.beginUpstreamAttempt(upstream.id, scope, now + 10 * 60_000 - 1), null);

    const staleProbe = store.beginUpstreamAttempt(upstream.id, scope, now + 10 * 60_000);
    store.persistCredentials(upstream.id, { projectKey: 'replacement' });
    const replacement = store.beginUpstreamAttempt(upstream.id, scope, now + 10 * 60_000 + 1);
    store.settleUpstreamAttempt(upstream.id, replacement, { class: 'quota', retryable: true }, now + 10 * 60_000 + 2);
    store.settleUpstreamAttempt(upstream.id, staleProbe, { class: 'success', retryable: false }, now + 10 * 60_000 + 3);
    assert.equal(store.get(upstream.id).health.status, 'cooldown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clear cooldown leaves reauthentication-required state intact', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({ type: 'compass', projectId: 'reauth', projectKey: 'secret' });
    store.setCap(upstream.id, { capDollars: 100 });
    const admission = store.beginUpstreamAttempt(upstream.id, { routeClass: 'proxy_http', model: '' });
    store.settleUpstreamAttempt(upstream.id, admission, { class: 'credential', retryable: true });
    assert.equal(store.clearUpstreamCooldown(upstream.id).health.status, 'reauth_required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('successful quota refresh clears reauthentication-required state', () => {
  const { dir, store } = tempStore();
  try {
    const upstream = store.create({ type: 'compass', projectId: 'reauth', projectKey: 'secret' });
    const admission = store.beginUpstreamAttempt(upstream.id, { routeClass: 'proxy_http', model: '' });
    store.settleUpstreamAttempt(upstream.id, admission, { class: 'credential', retryable: true });
    store.setQuota(upstream.id, { source: 'compass', remainingPercent: 90 });
    assert.equal(store.get(upstream.id).health, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prevents creating duplicate upstreams within the same scope', () => {
  const { dir, store } = tempStore();
  try {
    store.create({ type: 'compass', name: 'First', projectId: 'p1', projectKey: 'k1' });
    assert.throws(
      () => store.create({ type: 'compass', name: 'Duplicate', projectId: 'p1', projectKey: 'k2' }),
      /compass upstream already exists/
    );

    store.create({ type: 'codex', accountId: 'acc1', email: 'user@example.com', accessToken: 'token1' });
    assert.throws(
      () => store.create({ type: 'codex', accountId: 'acc1', email: 'user@example.com', accessToken: 'token2' }),
      /codex upstream already exists/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sets caps in dollars, records priced usage, and applies bulk quota rules', () => {
  const { dir, store } = tempStore();
  try {
    const first = store.create({ type: 'compass', name: 'First', projectId: 'p1', projectKey: 'k1' });
    const second = store.create({ type: 'compass', name: 'Second', projectId: 'p2', projectKey: 'k2' });
    const ais = store.create({ type: 'compass', name: 'AIS', projectId: 'p3', projectKey: 'k3', quotaSource: 'ais' });
    const unknown = store.create({ type: 'compass', name: 'Unknown', projectId: 'p4', projectKey: 'k4' });
    store.setCap(first.id, { capDollars: 100 });
    const usage = store.addUsage(first.id, {
      attemptId: 'attempt-1',
      startedAt: new Date(Date.now() + 1).toISOString(),
      settledCostMicros: 1_000_000,
      costSource: 'upstream_reported'
    });
    assert.equal(usage.upstream.spending.capCredits, 2500);
    assert.equal(usage.upstream.spending.spentDollars, 1);

    store.setQuota(first.id, { remainingUnits: 15_000, remainingDollars: 1_500, remainingPercent: 75 });
    store.setQuota(second.id, { remainingUnits: 500, remainingDollars: 500, remainingPercent: 25 });
    const bulk = store.bulkCaps({ rules: [{ minQuotaLeft: 1_000, capDollars: 30 }, { minQuotaLeft: 0, capDollars: 10 }] });
    assert.equal(bulk.updated.length, 2);
    assert.equal(store.get(ais.id).spending.capCredits, 0);
    assert.equal(store.getPublic(first.id).spending.capDollars, 30);
    assert.equal(store.getPublic(first.id).spending.spentDollars, 0);
    assert.equal(store.getPublic(first.id).spending.settlementCount, 0);
    assert.equal(store.getPublic(second.id).spending.capDollars, 10);
    assert.equal(bulk.updated.some((item) => item.id === unknown.id), false);
    store.bulkCaps({ rules: [{ minQuotaLeft: 1_000, capDollars: 30 }, { minQuotaLeft: 0, capDollars: 10 }], unknownQuotaDollars: 5 });
    assert.equal(store.getPublic(unknown.id).spending.capDollars, 5);
    assert.equal(store.get(ais.id).spending.capCredits, 0);
    store.bulkCaps({ rules: [{ minQuotaLeft: 1_000, capDollars: 30 }, { minQuotaLeft: 0, capDollars: 10 }], unknownQuotaDollars: null });
    assert.equal(store.getPublic(unknown.id).spending.capDollars, 5);
    const all = store.bulkCaps({ target: 'all', capDollars: 999 });
    assert.equal(all.updated.some((item) => item.id === ais.id), false);
    assert.equal(store.get(ais.id).spending.capCredits, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
