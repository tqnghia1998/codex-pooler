import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';
import { createApp } from '../src/server.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'community-activity-'));
  const store = new Store(dir);
  const product = new ProductStore(dir);
  t.after(() => {
    product.sqlite.close();
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const account = (name) => product.upsertAccount({ email: `${name}@example.com`, name });
  const provider = (name) => {
    const owner = account(name);
    const upstream = store.create({ type: 'compass', projectId: name, projectKey: 'synthetic-test-key' });
    product.linkUpstream(owner.id, upstream.id);
    return { owner, upstream };
  };
  const offer = ({ owner, upstream }, options = {}) => product.createOffer(owner.id, {
    upstreamId: upstream.id, quotaDollars: 10, ...options
  }, store);
  const activity = (viewer, now = 0) => product.communityActivity(viewer.id, store, { now });
  return { store, product, account, provider, offer, activity };
}

test('community activity respects visibility, includes self, and deduplicates providers', (t) => {
  const f = fixture(t);
  const viewer = f.provider('viewer');
  const publicProvider = f.provider('public');
  const privateProvider = f.provider('private');
  const hiddenProvider = f.provider('hidden');
  f.offer(viewer);
  f.offer(publicProvider);
  f.offer(publicProvider);
  f.offer(privateProvider, { visibility: 'restricted', allowedEmails: [viewer.owner.email] });
  f.offer(hiddenProvider, { visibility: 'restricted', allowedEmails: ['someone-else@example.com'] });
  f.product.createQuotaRequest(viewer.owner.id, { quotaDollars: 5 });
  f.product.createQuotaRequest(publicProvider.owner.id, { quotaDollars: 5 });
  f.product.createQuotaRequest(privateProvider.owner.id, {
    quotaDollars: 5, visibility: 'restricted', allowedEmails: [viewer.owner.email]
  });
  f.product.createQuotaRequest(hiddenProvider.owner.id, {
    quotaDollars: 5, visibility: 'restricted', allowedEmails: ['someone-else@example.com']
  });
  const result = f.activity(viewer.owner);
  for (const group of Object.values(result)) {
    assert.equal(group.totalPeople, 3);
    assert.deepEqual(group.people.map(({ id }) => id).sort(), [viewer.owner.id, publicProvider.owner.id, privateProvider.owner.id].sort());
    for (const person of group.people) assert.deepEqual(Object.keys(person).sort(), ['displayName', 'email', 'id']);
  }
  const outsider = f.account('outsider');
  assert.equal(f.activity(outsider).requesting.totalPeople, 2);
  assert.equal(f.activity(outsider).sharing.totalPeople, 2);
  assert.throws(() => f.product.communityActivity('missing-account', f.store), /Not found/);
});

test('own activity remains visible when no one else is sharing or requesting', (t) => {
  const f = fixture(t);
  const viewer = f.provider('viewer');
  f.offer(viewer, { visibility: 'restricted', allowedEmails: ['friend@example.com'] });
  f.product.createQuotaRequest(viewer.owner.id, {
    quotaDollars: 5, visibility: 'restricted', allowedEmails: ['friend@example.com']
  });
  for (const group of Object.values(f.activity(viewer.owner))) {
    assert.equal(group.totalPeople, 1);
    assert.deepEqual(group.people.map(({ id }) => id), [viewer.owner.id]);
  }
});

test('community activity omits pending, paused, closed, unbacked, missing, and internal offers', (t) => {
  const f = fixture(t);
  const viewer = f.account('viewer');
  const source = f.provider('provider');
  const offer = f.offer(source);
  assert.equal(f.activity(viewer).sharing.totalPeople, 1);
  const ticket = f.product.createTicket(viewer.id, { offerId: offer.id }, f.store);
  assert.equal(f.activity(viewer).sharing.totalPeople, 0);
  const otherOffer = f.offer(source);
  assert.equal(f.activity(viewer).sharing.totalPeople, 1);
  f.product.updateOffer(source.owner.id, otherOffer.id, { status: 'closed' }, f.store);
  assert.equal(f.activity(viewer).sharing.totalPeople, 0);
  f.product.cancelTicket(viewer.id, ticket.id, f.store);
  assert.equal(f.activity(viewer).sharing.totalPeople, 1);
  f.product.setProviderSharing(source.owner.id, source.upstream.id, 'paused', f.store);
  assert.equal(f.activity(viewer).sharing.totalPeople, 0);
  f.product.setProviderSharing(source.owner.id, source.upstream.id, 'active', f.store);
  f.store.setQuota(source.upstream.id, { remainingDollars: 1, remainingPercent: 1, observedAt: new Date().toISOString() });
  assert.equal(f.activity(viewer).sharing.totalPeople, 0);
  f.store.setQuota(source.upstream.id, { remainingDollars: 20, remainingPercent: 100, observedAt: new Date().toISOString() });
  assert.equal(f.activity(viewer).sharing.totalPeople, 1);
  f.product.sqlite.prepare('UPDATE sharing_offers SET internal_only = 1 WHERE id = ?').run(offer.id);
  assert.equal(f.activity(viewer).sharing.totalPeople, 0);
  f.product.sqlite.prepare("UPDATE sharing_offers SET internal_only = 0, status = 'closed' WHERE id = ?").run(offer.id);
  assert.equal(f.activity(viewer).sharing.totalPeople, 0);
  f.product.sqlite.prepare("UPDATE sharing_offers SET status = 'active' WHERE id = ?").run(offer.id);
  f.product.sqlite.prepare("UPDATE sharing_offers SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(offer.id);
  f.product.lastExpiryCheckAt = Date.now();
  assert.equal(f.activity(viewer).sharing.totalPeople, 0);
  f.product.sqlite.prepare("UPDATE sharing_offers SET expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(offer.id);
  assert.equal(f.activity(viewer).sharing.totalPeople, 1);
  f.store.remove(source.upstream.id);
  assert.equal(f.activity(viewer).sharing.totalPeople, 0);
});

test('community requests retain partial grants and omit fulfilled, cancelled, and expired requests', (t) => {
  const f = fixture(t);
  const source = f.provider('provider');
  const requester = f.account('requester');
  const request = f.product.createQuotaRequest(requester.id, { quotaDollars: 10 });
  const partial = f.product.grantQuotaRequest(source.owner.id, request.id, {
    upstreamId: source.upstream.id, quotaDollars: 4
  }, f.store);
  assert.equal(f.activity(source.owner).requesting.totalPeople, 1);
  f.product.grantQuotaRequest(source.owner.id, partial.replacementQuotaRequest.id, {
    upstreamId: source.upstream.id, quotaDollars: 6
  }, f.store);
  assert.equal(f.activity(source.owner).requesting.totalPeople, 0);
  const cancelled = f.product.createQuotaRequest(requester.id, { quotaDollars: 5 });
  f.product.cancelQuotaRequest(requester.id, cancelled.id);
  assert.equal(f.activity(source.owner).requesting.totalPeople, 0);
  const expired = f.product.createQuotaRequest(requester.id, { quotaDollars: 5 });
  f.product.sqlite.prepare("UPDATE quota_requests SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(expired.id);
  f.product.lastExpiryCheckAt = Date.now();
  assert.equal(f.activity(source.owner).requesting.totalPeople, 0);
});

test('community activity bounds and rotates names while retaining accurate unique counts', (t) => {
  const f = fixture(t);
  const viewer = f.account('viewer');
  assert.deepEqual(f.activity(viewer), {
    requesting: { totalPeople: 0, people: [] },
    sharing: { totalPeople: 0, people: [] }
  });
  for (let index = 0; index < 7; index += 1) {
    const source = f.provider(`member-${index}`);
    f.offer(source);
    f.product.createQuotaRequest(source.owner.id, { quotaDollars: 5 });
  }
  for (const kind of ['requesting', 'sharing']) {
    const seen = new Set();
    for (let minute = 0; minute < 7; minute += 1) {
      const group = f.activity(viewer, minute * 60_000)[kind];
      assert.equal(group.totalPeople, 7);
      assert.equal(group.people.length, 3);
      assert.equal(new Set(group.people.map(({ id }) => id)).size, 3);
      group.people.forEach(({ id }) => seen.add(id));
    }
    assert.equal(seen.size, 7);
  }
  assert.deepEqual(f.activity(viewer, 0), f.activity(viewer, 59_999));
});

test('community activity API is authenticated, private, and independent of table query parameters', async (t) => {
  const f = fixture(t);
  const viewer = f.account('viewer');
  const source = f.provider('provider');
  f.offer(source);
  f.product.createQuotaRequest(source.owner.id, { quotaDollars: 5 });
  const session = f.product.createAccountSession(viewer.id);
  const server = createServer(createApp({ store: f.store, productStore: f.product }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/pool/community-activity`;
    assert.equal((await fetch(base)).status, 401);
    const headers = { cookie: `codex_pool_session=${session.token}` };
    const response = await fetch(`${base}?q=missing&offset=100&limit=1&includePast=true`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.requesting.totalPeople, 1);
    assert.equal(result.sharing.totalPeople, 1);
    assert.equal(JSON.stringify(result).includes('synthetic-test-key'), false);
    assert.deepEqual(result, await (await fetch(base, { headers })).json());
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
