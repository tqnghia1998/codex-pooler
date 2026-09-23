import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ProductStore } from '../src/product-store.js';
import { exportAllData, importAllData } from '../../src/data-portability.js';

test('admin analytics records daily session usage and exposes safe operational detail', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quotahub-admin-'));
  const store = new Store(dir);
  const product = new ProductStore(dir);
  t.after(() => {
    product.sqlite.close();
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const account = product.upsertAccount({ email: 'provider@example.com', name: 'Provider' });
  const upstream = store.create({ type: 'compass', projectId: 'admin-project', projectKey: 'secret-project-key' });
  product.linkUpstream(account.id, upstream.id);
  product.observeProviders(store);
  const now = new Date();
  product.recordActivityStart('session', 'sample-session', { now });
  product.recordActivitySuccess('session', 'sample-session', 1_500_000, now);
  product.recordActivityStart('session', 'sample-session', { now });
  product.recordActivityFailure('session', 'sample-session', 'synthetic_failure', now);
  product.recordActivityStart('personal_key', 'sample-key', { now });
  product.sqlite.prepare(`
    INSERT INTO email_outbox
      (id, recipient, subject, body_text, status, next_attempt_at, created_at)
    VALUES ('queued', 'private@example.com', 'private subject', 'private body', 'pending', ?, ?)
  `).run(now.toISOString(), now.toISOString());
  product.event(account.id, 'offer', 'offer-123', 'created', { message: 'private message' });

  const analytics = product.adminAnalytics({ upstreamStore: store, eventQuery: 'offer-123' });
  assert.equal(analytics.providers.details.length, 1);
  assert.equal(analytics.providers.details[0].email, account.email);
  assert.equal(analytics.providers.details[0].issueCode, null);
  assert.equal(typeof analytics.providers.details[0].observedAt, 'string');
  assert.equal(analytics.email.pending, 1);
  assert.equal(analytics.email.failed, 0);
  assert.equal(analytics.dailyUsage.at(-1).day, now.toISOString().slice(0, 10));
  assert.deepEqual(analytics.dailyUsage.at(-1), {
    day: now.toISOString().slice(0, 10), requests: 2, successes: 1, failures: 1, settledMicros: 1_500_000
  });
  assert.equal(analytics.recentEvents.length, 1);
  assert.equal(analytics.recentEvents[0].entityId, 'offer-123');
  assert.equal(JSON.stringify(analytics).includes('private'), false);
  assert.equal(JSON.stringify(analytics).includes('secret-project-key'), false);
  assert.equal(product.adminAnalytics({ eventQuery: 'no-match' }).recentEvents.length, 0);
  assert.equal(product.adminAnalytics({ eventDays: 7 }).recentEvents.length > 0, true);
  product.sqlite.prepare(`
    INSERT INTO sharing_events (id, actor_account_id, entity_type, entity_id, action, detail_json, created_at)
    VALUES ('old-event', ?, 'offer', 'old-offer', 'created', '{}', '2000-01-01T00:00:00.000Z')
  `).run(account.id);
  assert.equal(product.adminAnalytics({ eventDays: 7 }).recentEvents.some(({ id }) => id === 'old-event'), false);
  assert.equal(product.adminAnalytics().recentEvents.some(({ id }) => id === 'old-event'), true);

  const snapshot = exportAllData({ store, productStore: product });
  assert.deepEqual(snapshot.product.admin_daily_usage, [{
    day: now.toISOString().slice(0, 10), requests: 2, successes: 1, failures: 1, settled_micros: 1_500_000
  }]);
  product.sqlite.prepare('DELETE FROM admin_daily_usage').run();
  importAllData({ store, productStore: product, data: snapshot });
  assert.equal(product.adminAnalytics().dailyUsage.at(-1).requests, 2);

  store.remove(upstream.id);
  assert.equal(product.adminAnalytics({ upstreamStore: store }).providers.details[0].issueCode, 'provider_unavailable');
});
