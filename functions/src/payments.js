'use strict';

/**
 * Payment state changes for registrations. These functions are shared by the
 * webhook handler, the withdrawal endpoint and the reconciliation job, so the
 * same rules apply no matter which path delivers the news.
 *
 * Registration paymentStatus values:
 *   pending_payment  seat held, waiting for Stripe
 *   paid             seat confirmed
 *   withdrawing      player withdrew; refund requested, waiting for Stripe
 *   refunded         refund confirmed; seat released
 *   released         unpaid hold expired or payment failed; seat released
 *   withdrawn        player withdrew before paying; seat released
 *   refund_due       paid after the hold expired and the event was full;
 *                    an automatic refund has been requested
 */
const { FieldValue } = require('firebase-admin/firestore');

const SEAT_RELEASED = ['refunded', 'released', 'withdrawn', 'refund_due'];

/**
 * Marks a registration paid. Safe to call more than once: if it is already
 * paid, nothing changes. If the hold had already expired and the seat was
 * released, the seat is retaken when one is still open; otherwise the
 * registration is marked refund_due and the caller must issue a refund.
 * Returns the resulting status.
 */
async function confirmPayment(db, registrationId, paymentIntentId) {
  const rRef = db.collection('registrations').doc(registrationId);
  return db.runTransaction(async (tx) => {
    const rSnap = await tx.get(rRef);
    if (!rSnap.exists) return 'unknown_registration';
    const reg = rSnap.data();
    const tRef = db.collection('tournaments').doc(reg.tournamentId);
    const tSnap = await tx.get(tRef);
    const t = tSnap.data();

    if (reg.paymentStatus === 'paid') return 'paid';
    if (reg.paymentStatus === 'pending_payment') {
      tx.update(rRef, { paymentStatus: 'paid', paymentReference: paymentIntentId, paidAt: FieldValue.serverTimestamp() });
      return 'paid';
    }
    if (reg.paymentStatus === 'released') {
      const seatOpen = t && t.status === 'open' && t.registeredCount < t.capacity;
      if (seatOpen) {
        tx.update(rRef, { paymentStatus: 'paid', paymentReference: paymentIntentId, paidAt: FieldValue.serverTimestamp() });
        tx.update(tRef, { registeredCount: FieldValue.increment(1) });
        return 'paid';
      }
      tx.update(rRef, { paymentStatus: 'refund_due', paymentReference: paymentIntentId });
      return 'refund_due';
    }
    // withdrawing / refunded / withdrawn / refund_due: a late success for a
    // registration that is already being unwound changes nothing.
    return reg.paymentStatus;
  });
}

/**
 * Releases the seat for an unpaid registration (payment failed, canceled or
 * the hold expired). Does nothing unless the registration is still pending.
 */
async function releaseSeat(db, registrationId, newStatus = 'released') {
  const rRef = db.collection('registrations').doc(registrationId);
  return db.runTransaction(async (tx) => {
    const rSnap = await tx.get(rRef);
    if (!rSnap.exists) return 'unknown_registration';
    const reg = rSnap.data();
    if (reg.paymentStatus !== 'pending_payment') return reg.paymentStatus;
    tx.update(rRef, { paymentStatus: newStatus });
    tx.update(db.collection('tournaments').doc(reg.tournamentId), { registeredCount: FieldValue.increment(-1) });
    return newStatus;
  });
}

/**
 * Finalizes a refund reported by Stripe. A withdrawing registration becomes
 * refunded and its seat is released in the same transaction, so a player can
 * never end up both refunded and still holding a seat.
 */
async function completeRefund(db, registrationId) {
  const rRef = db.collection('registrations').doc(registrationId);
  return db.runTransaction(async (tx) => {
    const rSnap = await tx.get(rRef);
    if (!rSnap.exists) return 'unknown_registration';
    const reg = rSnap.data();
    if (reg.paymentStatus === 'withdrawing') {
      tx.update(rRef, { paymentStatus: 'refunded', refundedAt: FieldValue.serverTimestamp() });
      tx.update(db.collection('tournaments').doc(reg.tournamentId), { registeredCount: FieldValue.increment(-1) });
      return 'refunded';
    }
    if (reg.paymentStatus === 'refund_due') {
      // The seat was never retaken, so there is no count to adjust.
      tx.update(rRef, { paymentStatus: 'refunded', refundedAt: FieldValue.serverTimestamp() });
      return 'refunded';
    }
    return reg.paymentStatus;
  });
}

/**
 * Records a webhook event ID so the same event is processed only once.
 * Returns false if the event was already recorded. Stripe can deliver the
 * same event more than once, and retries after a timeout are common.
 */
async function claimEvent(db, eventId, type) {
  const ref = db.collection('webhookEvents').doc(eventId);
  try {
    await ref.create({ type, receivedAt: FieldValue.serverTimestamp() });
    return true;
  } catch (err) {
    if (err.code === 6 /* ALREADY_EXISTS */) return false;
    throw err;
  }
}

/**
 * Reconciliation: finds registrations still pending after their hold expired
 * and settles each one from Stripe's own record of the payment. A delayed
 * or lost webhook therefore cannot cost a paying player their seat, and an
 * abandoned checkout cannot hold a seat forever.
 */
async function reconcilePending(db, payments, now = Date.now()) {
  const snap = await db.collection('registrations').where('paymentStatus', '==', 'pending_payment').get();
  const summary = { checked: 0, confirmed: 0, released: 0, stillProcessing: 0, refundsIssued: 0 };

  for (const doc of snap.docs) {
    const reg = doc.data();
    if (!reg.holdExpiresAt || reg.holdExpiresAt.toMillis() > now) continue;
    summary.checked++;

    if (!reg.paymentReference) {
      await releaseSeat(db, doc.id);
      summary.released++;
      continue;
    }
    const intent = await payments.retrievePaymentIntent(reg.paymentReference);
    if (intent.status === 'succeeded') {
      const status = await confirmPayment(db, doc.id, intent.id);
      if (status === 'refund_due') {
        await payments.refund({ paymentIntentId: intent.id, registrationId: doc.id, attempt: reg.attempt || 1 });
        summary.refundsIssued++;
      } else {
        summary.confirmed++;
      }
    } else if (intent.status === 'processing') {
      summary.stillProcessing++; // Bank transfer in flight; check next run.
    } else {
      if (intent.status !== 'canceled') await payments.cancelPaymentIntent(intent.id);
      await releaseSeat(db, doc.id);
      summary.released++;
    }
  }
  return summary;
}

module.exports = { confirmPayment, releaseSeat, completeRefund, claimEvent, reconcilePending, SEAT_RELEASED };
