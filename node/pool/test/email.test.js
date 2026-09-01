import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmailScheduler } from '../src/email.js';
import { ProductStore } from '../src/product-store.js';

function account(store, subject = 'mail-user') {
  return store.upsertCodexAccount({
    subject,
    issuer: 'https://auth.openai.com',
    email: `${subject}@example.com`,
    name: subject
  });
}

test('email outbox deduplicates events and marks delivered mail as sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-share-email-sent-'));
  try {
    const store = new ProductStore(dir);
    const user = account(store);

    const delivered = [];
    const scheduler = createEmailScheduler(store, {
      from: 'codex-share@example.com',
      transport: {
        async sendMail(message) {
          delivered.push(message);
        },
        close() {}
      }
    });
    try {
      assert.equal(store.notifyAccount(user.id, 'Quota ready', 'A friend shared quota.', 'quota-ready'), true);
      assert.equal(store.notifyAccount(user.id, 'Quota ready', 'A friend shared quota.', 'quota-ready'), false);
      const emailId = store.pendingEmails()[0].id;
      assert.deepEqual(await scheduler.run(), [{ id: emailId, status: 'sent' }]);
    } finally {
      scheduler.close();
    }

    assert.deepEqual(delivered, [{
      from: 'codex-share@example.com',
      to: 'mail-user@example.com',
      subject: 'Quota ready',
      text: 'A friend shared quota.'
    }]);
    assert.equal(store.pendingEmails().length, 0);
    assert.equal(store.sqlite.prepare('SELECT status FROM email_outbox').get().status, 'sent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed email delivery is sanitized and scheduled for retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-share-email-retry-'));
  try {
    const store = new ProductStore(dir);
    const user = account(store, 'retry-user');
    const before = Date.now();
    const scheduler = createEmailScheduler(store, {
      from: 'codex-share@example.com',
      logger: { warn() {} },
      transport: {
        async sendMail() {
          throw Object.assign(new Error('connection failed'), { code: 'SMTP\nFAILED' });
        },
        close() {}
      }
    });
    try {
      store.notifyAccount(user.id, 'Provider unavailable', 'Reconnect Codex.', 'provider-unavailable');
      const emailId = store.pendingEmails()[0].id;
      assert.deepEqual(await scheduler.run(), [{ id: emailId, status: 'failed' }]);
    } finally {
      scheduler.close();
    }

    const row = store.sqlite.prepare('SELECT * FROM email_outbox').get();
    assert.equal(row.status, 'pending');
    assert.equal(row.attempt_count, 1);
    assert.equal(row.last_error, 'SMTP FAILED');
    assert.ok(Date.parse(row.next_attempt_at) >= before + 29_000);
    assert.equal(store.pendingEmails().length, 0);
    assert.equal(store.pendingEmails(20, new Date(Date.parse(row.next_attempt_at) + 1)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('email notifications are skipped and pending mail is removed without SMTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-share-email-disabled-'));
  try {
    const store = new ProductStore(dir);
    const user = account(store, 'disabled-user');
    store.setEmailNotificationsEnabled(true);
    store.notifyAccount(user.id, 'Old notification', 'Previously queued.', 'old-notification');
    assert.equal(store.pendingEmails().length, 1);

    const scheduler = createEmailScheduler(store, { host: '', from: '' });
    try {
      assert.equal(scheduler.enabled, false);
      assert.equal(store.pendingEmails().length, 0);
      assert.equal(store.notifyAccount(user.id, 'New notification', 'Should be skipped.', 'new-notification'), false);
      assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS count FROM email_outbox').get().count, 0);
    } finally {
      scheduler.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
