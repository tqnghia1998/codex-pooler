import assert from 'node:assert/strict';
import test from 'node:test';
import { isCountStorageEvent, openCountTab, reconcileTabCounts, SHARING_COUNTS_STORAGE_KEY } from '../ui/tab-counts.js';

test('count storage writes do not trigger a workspace reload in other windows', () => {
  assert.equal(isCountStorageEvent({ type: 'storage', key: `${SHARING_COUNTS_STORAGE_KEY}:account-1` }), true);
  assert.equal(isCountStorageEvent({ type: 'storage', key: 'session' }), false);
  assert.equal(isCountStorageEvent({ type: 'storage', key: null }), false);
  assert.equal(isCountStorageEvent({ type: 'focus' }), false);
});

test('initial counts are read, while later increases on other tabs are unread', () => {
  const initial = reconcileTabCounts(null, { offers: 2, approvals: 1 }, 'offers');
  assert.deepEqual(initial, { totals: { offers: 2, approvals: 1 }, unread: {} });

  const changed = reconcileTabCounts(initial, { offers: 3, approvals: 2 }, 'offers');
  assert.deepEqual(changed, { totals: { offers: 3, approvals: 2 }, unread: { approvals: true } });
});

test('unread state survives count decreases and reloads until its tab is opened', () => {
  const previous = { totals: { approvals: 3 }, unread: { approvals: true } };
  const refreshed = reconcileTabCounts(previous, { approvals: 1 }, 'offers');
  assert.equal(refreshed.unread.approvals, true);
  assert.deepEqual(openCountTab(refreshed, 'approvals'), {
    totals: { approvals: 1 },
    unread: {}
  });
  assert.deepEqual(reconcileTabCounts(previous, { approvals: 4 }, 'approvals').unread, {});
});

test('new tabs and invalid stored totals do not generate false unread counts', () => {
  const result = reconcileTabCounts(
    { totals: { offers: '1' }, unread: { approvals: true } },
    { offers: 2, requests: 0 },
    'requests'
  );
  assert.deepEqual(result, { totals: { offers: 2, requests: 0 }, unread: {} });
});
