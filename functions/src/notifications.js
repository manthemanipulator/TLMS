'use strict';

/**
 * Transactional emails: a receipt when a registration is confirmed and a
 * confirmation when a refund completes.
 *
 * Each email is sent at most once per registration attempt. A transaction
 * first records that the email is being sent (receiptSentAt /
 * refundEmailSentAt), so duplicate webhooks or a webhook racing the
 * reconciliation job cannot send it twice, and the provider idempotency key
 * backs that up. Email is never allowed to break registration: a failed send
 * is logged and the registration stands.
 */
const { FieldValue } = require('firebase-admin/firestore');

const money = (cents) => (cents ? `$${(cents / 100).toFixed(2)}` : 'Free');
/** "2026-10-18" -> "Sunday, October 18, 2026" (formatted in UTC so the date never shifts). */
const longDate = (iso) =>
  new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });

async function claimAndLoad(db, registrationId, flag) {
  const rRef = db.collection('registrations').doc(registrationId);
  return db.runTransaction(async (tx) => {
    const rSnap = await tx.get(rRef);
    if (!rSnap.exists || rSnap.data()[flag]) return null;
    const reg = rSnap.data();
    const [tSnap, pSnap] = await Promise.all([
      tx.get(db.collection('tournaments').doc(reg.tournamentId)),
      tx.get(db.collection('players').doc(reg.playerId)),
    ]);
    tx.update(rRef, { [flag]: FieldValue.serverTimestamp() });
    return { reg, t: tSnap.data(), player: pSnap.data() || {} };
  });
}

async function send(mailer, message) {
  try {
    await mailer.send(message);
    return true;
  } catch (err) {
    console.error(`Email failed (${message.subject}): ${err.message}`);
    return false;
  }
}

async function sendRegistrationReceipt(db, mailer, registrationId) {
  const data = await claimAndLoad(db, registrationId, 'receiptSentAt');
  if (!data || !data.player.email) return false;
  const { reg, t, player } = data;
  const lines = [
    `Hi ${player.name || 'there'},`,
    '',
    `You're registered for ${t.name}.`,
    `Date: ${longDate(t.date)}${t.venue ? ` at ${t.venue}` : ''}`,
    `Entry fee: ${money(t.entryFeeCents)}${reg.paymentReference && reg.paymentReference !== 'seeded' ? ` (payment ${reg.paymentReference})` : ''}`,
    '',
    t.entryFeeCents
      ? 'You can withdraw for a full refund until the roster closes.'
      : 'You can withdraw until the roster closes.',
  ];
  return send(mailer, {
    to: player.email,
    subject: `Registration confirmed: ${t.name}`,
    text: lines.join('\n'),
    html: lines.map((l) => (l ? `<p>${escapeHtml(l)}</p>` : '')).join(''),
    idempotencyKey: `receipt-${registrationId}-${reg.attempt || 1}`,
  });
}

async function sendRefundConfirmation(db, mailer, registrationId) {
  const data = await claimAndLoad(db, registrationId, 'refundEmailSentAt');
  if (!data || !data.player.email) return false;
  const { reg, t, player } = data;
  const lines = [
    `Hi ${player.name || 'there'},`,
    '',
    `Your ${money(t.entryFeeCents)} entry fee for ${t.name} has been refunded.`,
    'Refunds usually appear on your statement within 5 to 10 business days.',
  ];
  return send(mailer, {
    to: player.email,
    subject: `Refund processed: ${t.name}`,
    text: lines.join('\n'),
    html: lines.map((l) => (l ? `<p>${escapeHtml(l)}</p>` : '')).join(''),
    idempotencyKey: `refund-email-${registrationId}-${reg.attempt || 1}`,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { sendRegistrationReceipt, sendRefundConfirmation };
