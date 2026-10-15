'use strict';

/**
 * Email adapter. The rest of the system calls mailer.send() and never knows
 * which provider is behind it. The design originally named SendGrid; when
 * SendGrid retired its free plan, this adapter let the project switch to
 * Resend without touching registration or payment code.
 *
 *   createResendMailer  sends through the Resend HTTP API
 *   createLogMailer     prints messages instead of sending (used when no
 *                       API key is configured, so the app still runs)
 */
const RESEND_URL = 'https://api.resend.com/emails';

function createResendMailer({ apiKey, from, redirectTo, fetchImpl = fetch }) {
  return {
    provider: 'resend',
    /**
     * Sends one message. `idempotencyKey` makes a retried send a no-op at
     * the provider. When `redirectTo` is set (for testing before a sending
     * domain is verified), every message goes to that address instead, with
     * the intended recipient noted in the subject.
     */
    async send({ to, subject, text, html, idempotencyKey }) {
      const recipient = redirectTo || to;
      const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from,
          to: [recipient],
          subject: redirectTo ? `[to ${to}] ${subject}` : subject,
          text,
          html,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Email provider returned ${res.status}: ${detail.slice(0, 200)}`);
      }
      return res.json();
    },
  };
}

function createLogMailer(log = console.log) {
  return {
    provider: 'log',
    async send({ to, subject }) {
      log(`[email not sent: no RESEND_API_KEY] to=${to} subject="${subject}"`);
      return { id: 'logged' };
    },
  };
}

module.exports = { createResendMailer, createLogMailer, RESEND_URL };
