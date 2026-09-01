import nodemailer from 'nodemailer';

export const EMAIL_DELIVERY_INTERVAL_MS = 15_000;

export function createEmailScheduler(productStore, {
  host = process.env.POOL_SMTP_HOST,
  port = Number(process.env.POOL_SMTP_PORT) || 587,
  secure = envBoolean(process.env.POOL_SMTP_SECURE, port === 465),
  user = process.env.POOL_SMTP_USER,
  pass = process.env.POOL_SMTP_PASS,
  from = process.env.POOL_SMTP_FROM,
  intervalMs = Number(process.env.POOL_EMAIL_DELIVERY_INTERVAL_MS) || EMAIL_DELIVERY_INTERVAL_MS,
  logger = console,
  transport = null
} = {}) {
  const mailer = transport || (host && from
    ? nodemailer.createTransport({
        host,
        port,
        secure,
        ...(user ? { auth: { user, pass: pass || '' } } : {})
      })
    : null);
  productStore.setEmailNotificationsEnabled(Boolean(mailer));
  let running = false;
  let closed = false;

  const run = async () => {
    if (!mailer || running || closed) return [];
    running = true;
    try {
      const results = [];
      for (const email of productStore.pendingEmails()) {
        try {
          await mailer.sendMail({
            from,
            to: email.recipient,
            subject: email.subject,
            text: email.text
          });
          productStore.markEmailSent(email.id);
          results.push({ id: email.id, status: 'sent' });
        } catch (error) {
          productStore.markEmailFailed(email.id, error);
          logger?.warn?.(`Codex Share email delivery failed: ${error?.code || error?.name || 'Error'}`);
          results.push({ id: email.id, status: 'failed' });
        }
      }
      return results;
    } finally {
      running = false;
    }
  };

  const timer = mailer ? setInterval(run, intervalMs) : null;
  timer?.unref?.();
  return {
    enabled: Boolean(mailer),
    run,
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      mailer?.close?.();
    }
  };
}

function envBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}
