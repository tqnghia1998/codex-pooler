import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductStore } from '../src/product-store.js';
import { Store } from '../../src/store.js';

function fixture(t) {
  const product = new ProductStore(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 1) });
  const store = new Store(undefined, { inMemory: true, encryptionKey: Buffer.alloc(32, 2) });
  t.after(() => { product.sqlite.close(); store.sqlite.close(); });
  const provider = product.upsertAccount({ email: 'provider@example.test' });
  const viewer = product.upsertAccount({ email: 'viewer@example.test' });
  const outsider = product.upsertAccount({ email: 'outsider@example.test' });
  const upstream = store.create({ type: 'compass', projectId: 'synthetic', projectKey: 'synthetic' });
  product.linkUpstream(provider.id, upstream.id);
  const insert = product.sqlite.prepare(`
    INSERT INTO sharing_offers (id, provider_account_id, upstream_id, quota_micros,
      visibility, allowed_emails, status, created_at, updated_at)
    VALUES (?, ?, ?, 1000000, ?, ?, 'active', ?, ?)
  `);
  const requests = product.sqlite.prepare(`
    INSERT INTO quota_requests (id, account_id, quota_micros, visibility, allowed_emails,
      status, created_at, updated_at)
    VALUES (?, ?, 1000000, ?, ?, 'active', ?, ?)
  `);
  for (let index = 0; index < 24; index++) {
    const id = String(index).padStart(2, '0');
    const visibility = index % 3 ? 'restricted' : 'public';
    const allowed = index % 3 === 1 ? JSON.stringify([viewer.email]) : '["someone@example.test"]';
    const now = new Date(Date.now() - index * 1000).toISOString();
    insert.run(id, provider.id, upstream.id, visibility, allowed, now, now);
    requests.run(id, provider.id, visibility, allowed, now, now);
  }
  // Imported malformed allowlists must remain invisible to non-owners.
  product.sqlite.prepare("UPDATE sharing_offers SET allowed_emails = 'not-json' WHERE id = '01'").run();
  product.sqlite.prepare("UPDATE quota_requests SET allowed_emails = '{}' WHERE id = '01'").run();
  return { product, store, provider, viewer, outsider, upstream };
}

test('SQL offer pagination counts only visible rows before applying offsets', (t) => {
  const { product, store, provider, viewer, outsider } = fixture(t);
  for (const account of [provider, viewer, outsider]) {
    const expected = product.listOffers(account.id, store).map(({ id }) => id).sort();
    const seen = [];
    for (let offset = 0; offset < expected.length; offset += 2) {
      const page = product.listOffersPage(account.id, store, {
        limit: 2, offset, includePast: false, query: ''
      });
      assert.equal(page.totalItems, expected.length);
      assert.equal(page.offers.length, Math.min(2, expected.length - offset));
      assert.equal(page.hasMore, offset + 2 < expected.length);
      seen.push(...page.offers.map(({ id }) => id));
    }
    assert.deepEqual(seen, expected);
  }
  assert.equal(product.listOffersPage(viewer.id, store, {
    limit: 2, offset: 0, role: 'mine', query: '', includePast: false
  }).totalItems, 0);
});

test('SQL quota-request pagination preserves owner and restricted visibility', (t) => {
  const { product, provider, viewer, outsider } = fixture(t);
  for (const account of [provider, viewer, outsider]) {
    const expected = product.listQuotaRequests(account.id).map(({ id }) => id).sort();
    const seen = [];
    for (let offset = 0; offset < expected.length; offset += 3) {
      const page = product.listQuotaRequestsPage(account.id, {
        limit: 3, offset, includePast: false, query: ''
      });
      assert.equal(page.totalItems, expected.length);
      seen.push(...page.quotaRequests.map(({ id }) => id));
    }
    assert.deepEqual(seen, expected);
  }
});

test('commitment and offer-allocation lookups have targeted indexes', (t) => {
  const { product } = fixture(t);
  for (const table of ['sharing_offers', 'sharing_sessions']) {
    const plan = product.sqlite.prepare(`EXPLAIN QUERY PLAN
      SELECT id FROM ${table} WHERE upstream_id = ? AND status IN ('active', 'paused')
      ORDER BY created_at, id
    `).all('synthetic');
    assert.ok(plan.some(({ detail }) => detail.includes(`${table}_upstream_idx`) && detail.includes('upstream_id=?')));
  }
  const plan = product.sqlite.prepare('EXPLAIN QUERY PLAN SELECT * FROM sharing_sessions WHERE offer_id = ?').all('synthetic');
  assert.ok(plan.some(({ detail }) => detail.includes('sharing_sessions_offer_idx')));
});
